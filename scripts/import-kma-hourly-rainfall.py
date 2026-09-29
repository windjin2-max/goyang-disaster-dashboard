"""Audit and import KMA AWS hourly rainfall CSVs for Goyang (2020–2025).

Source files use CP949 and timestamps in Korea Standard Time. The importer
only upserts rainfall_1h for previously registered Goyang AWS stations.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path


KST = timezone(timedelta(hours=9))
EXPECTED_STATIONS = {"450": "주교", "540": "고양", "589": "고양고봉"}
EXPECTED_HEADER = ["지점", "지점명", "일시", "강수량(mm)"]


def request_json(url: str, key: str, method: str = "GET", payload=None, prefer: str = ""):
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    for attempt in range(4):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, data=body, headers=headers, method=method),
                timeout=120,
            ) as response:
                data = response.read()
                return json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            if error.code < 500 or attempt == 3:
                raise RuntimeError(f"Supabase HTTP {error.code}: {detail[:500]}") from error
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 3:
                raise RuntimeError(f"Supabase request failed: {error}") from error
        time.sleep(2 ** attempt)


def parse_file(path: Path, year: int):
    observations = []
    seen = set()
    counts = Counter()
    nonzero = Counter()
    min_time = {}
    max_time = {}
    max_rain = {}

    with path.open("r", encoding="cp949", newline="") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != EXPECTED_HEADER:
            raise ValueError(f"Unexpected CSV header in {path.name}: {reader.fieldnames}")
        for row_number, row in enumerate(reader, start=2):
            station_code = row["지점"].strip()
            station_name = row["지점명"].strip()
            if EXPECTED_STATIONS.get(station_code) != station_name:
                raise ValueError(f"Unexpected station at {path.name}:{row_number}: {station_code} {station_name}")
            timestamp = datetime.strptime(row["일시"].strip(), "%Y-%m-%d %H:%M").replace(tzinfo=KST)
            if timestamp.year != year or timestamp.minute != 0:
                raise ValueError(f"Unexpected observation time at {path.name}:{row_number}: {timestamp}")
            try:
                rainfall = Decimal(row["강수량(mm)"].strip())
            except InvalidOperation as error:
                raise ValueError(f"Non-numeric rainfall at {path.name}:{row_number}") from error
            if not rainfall.is_finite() or rainfall < 0:
                raise ValueError(f"Invalid rainfall at {path.name}:{row_number}: {rainfall}")
            key = (station_code, timestamp)
            if key in seen:
                raise ValueError(f"Duplicate station and time at {path.name}:{row_number}")
            seen.add(key)
            counts[station_code] += 1
            nonzero[station_code] += rainfall > 0
            min_time[station_code] = min(min_time.get(station_code, timestamp), timestamp)
            max_time[station_code] = max(max_time.get(station_code, timestamp), timestamp)
            max_rain[station_code] = max(max_rain.get(station_code, rainfall), rainfall)
            observations.append((station_code, timestamp, rainfall, row_number))

    if set(counts) != set(EXPECTED_STATIONS):
        raise ValueError(f"Expected all three Goyang stations in {path.name}; found {sorted(counts)}")
    annual_hours = int((datetime(year + 1, 1, 1, tzinfo=KST) - datetime(year, 1, 1, tzinfo=KST)).total_seconds() / 3600)
    summary = {
        "year": year,
        "file": path.name,
        "rows": len(observations),
        "annualHoursPerStation": annual_hours,
        "stations": {
            code: {
                "name": EXPECTED_STATIONS[code],
                "rows": counts[code],
                "missingHoursAgainstFullYear": annual_hours - counts[code],
                "first": min_time[code].isoformat(),
                "last": max_time[code].isoformat(),
                "nonzeroHours": nonzero[code],
                "maxRainfall1hMm": str(max_rain[code]),
            }
            for code in sorted(counts)
        },
    }
    return observations, summary


def get_station_ids(base_url: str, service_key: str):
    query = urllib.parse.urlencode({
        "select": "id,station_code,station_name,is_goyang,is_active",
        "source": "eq.kma_aws",
        "is_goyang": "eq.true",
        "is_active": "eq.true",
    })
    rows = request_json(f"{base_url}/rest/v1/observation_stations?{query}", service_key)
    station_ids = {}
    for row in rows:
        code = row["station_code"]
        if code in EXPECTED_STATIONS and row["station_name"] == EXPECTED_STATIONS[code]:
            station_ids[code] = row["id"]
    if set(station_ids) != set(EXPECTED_STATIONS):
        raise RuntimeError(f"Registered Goyang AWS station IDs do not match CSV: {sorted(station_ids)}")
    return station_ids


def import_year(base_url: str, service_key: str, year: int, observations, station_ids, batch_size: int, workers: int):
    endpoint = f"{base_url}/rest/v1/historical_observations?on_conflict=station_id,observed_at,metric"
    def send_batch(offset):
        payload = [
            {
                "station_id": station_ids[station_code],
                "observed_at": timestamp.isoformat(),
                "metric": "rainfall_1h",
                "value": float(rainfall),
                "unit": "mm",
                "quality_code": "kma_aws_hourly_csv",
                "raw": {"sourceFile": f"AWS_시간별 강수량_{year}.csv", "sourceRow": row_number},
            }
            for station_code, timestamp, rainfall, row_number
            in observations[offset:offset + batch_size]
        ]
        request_json(endpoint, service_key, "POST", payload, "resolution=merge-duplicates,return=minimal")
        return len(payload)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(send_batch, offset) for offset in range(0, len(observations), batch_size)]
        sent = 0
        for future in as_completed(futures):
            sent += future.result()
            print(json.dumps({"year": year, "sent": sent, "total": len(observations)}), flush=True)

    request_json(
        f"{base_url}/rest/v1/ingestion_runs", service_key, "POST",
        {
            "source": "kma_aws_hourly_csv",
            "scope_region_code": "41280",
            "period_start": f"{year}-01-01",
            "period_end": f"{year}-12-31",
            "status": "complete",
            "accepted_count": len(observations),
            "excluded_count": 0,
            "message": f"Three Goyang AWS stations; source files preserve missing hours as gaps. {year} CSV.",
            "finished_at": datetime.now(timezone.utc).isoformat(),
        },
        "return=minimal",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--downloads-root", type=Path, default=Path.home() / "Downloads")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if args.batch_size < 1 or args.batch_size > 2000:
        raise ValueError("Batch size must be between 1 and 2000")
    if args.workers < 1 or args.workers > 8:
        raise ValueError("Workers must be between 1 and 8")

    all_files = []
    for year in range(2020, 2026):
        path = args.downloads_root / f"AWS_시간별 강수량_{year}.csv"
        observations, summary = parse_file(path, year)
        all_files.append((year, observations, summary))
        print(json.dumps({"audit": summary}, ensure_ascii=False), flush=True)

    if args.audit_only:
        return

    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not service_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    station_ids = get_station_ids(base_url, service_key)
    for year, observations, _ in all_files:
        import_year(base_url, service_key, year, observations, station_ids, args.batch_size, args.workers)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
