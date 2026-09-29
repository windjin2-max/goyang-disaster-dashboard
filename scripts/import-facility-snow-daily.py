"""Audit and import 2020–2025 daily depth from four Goyang snow gauges.

SNOW_DAY.xls is a UTF-8 HTML export. Source values are millimetres; the
historical snow_depth metric is centimetres. '-' is missing, not zero.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path


KST = timezone(timedelta(hours=9))
# Export name -> (registered facility ID, registered name).
STATIONS = {
    "고양시청": ("적설계-2", "고양시청"),
    "대화배수펌프": ("적설계-3", "대화배수펌프장"),
    "현천배수펌프": ("적설계-4", "현천배수펌프장"),
    "효자동적설": ("적설계-5", "효자동 행정복지센터"),
}


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.table = None
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in ("th", "td") and self.row is not None:
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("th", "td") and self.cell is not None:
            self.row.append("".join(self.cell).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None


def request_json(url, key, method="GET", payload=None, prefer=""):
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(request, timeout=120) as response:
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


def parse_file(path):
    parser = TableParser()
    parser.feed(path.read_text(encoding="utf-8-sig"))
    if len(parser.tables) != 2 or len(parser.tables[1]) != 5:
        raise ValueError(f"Unexpected table layout: {path.name}")
    title = parser.tables[0][0][0]
    if "적설 조회 결과 : 2020-01-01 ~ 2025-12-31 [단위 : mm] [적설 장비 수량 : 4대]" != title:
        raise ValueError(f"Unexpected title: {path.name}")
    header = parser.tables[1][0]
    if header[0] != "지역":
        raise ValueError(f"Unexpected first column: {path.name}")
    days = [date.fromisoformat(value) for value in header[1:]]
    if (days[0], days[-1]) != (date(2020, 1, 1), date(2025, 12, 31)) or any(
        current != previous + timedelta(days=1) for previous, current in zip(days, days[1:])
    ):
        raise ValueError(f"Unexpected or nonconsecutive dates: {path.name}")

    observations = []
    counts = Counter()
    missing = Counter()
    maxima = Counter()
    names = set()
    for row_number, row in enumerate(parser.tables[1][1:], start=2):
        name = row[0]
        if name not in STATIONS or name in names or len(row) != len(header):
            raise ValueError(f"Unknown, duplicate or malformed station row: {path.name}:{row_number}")
        names.add(name)
        for column_number, (day, raw_value) in enumerate(zip(days, row[1:]), start=2):
            if raw_value in ("-", ""):
                missing[(day.year, name)] += 1
                continue
            try:
                value_mm = Decimal(raw_value)
            except InvalidOperation as error:
                raise ValueError(f"Non-numeric snow depth: {path.name}:{row_number}:{column_number}") from error
            if not value_mm.is_finite() or value_mm < 0:
                raise ValueError(f"Invalid snow depth: {path.name}:{row_number}:{column_number}")
            counts[(day.year, name)] += 1
            maxima[(day.year, name)] = max(maxima[(day.year, name)], value_mm)
            observations.append((name, day, value_mm, row_number, column_number))
    if names != set(STATIONS) or len(observations) + sum(missing.values()) != 4 * len(days):
        raise ValueError(f"Station or cell count does not reconcile: {path.name}")
    summary = {
        "file": path.name,
        "unitInFile": "mm",
        "databaseMetric": "snow_depth",
        "databaseUnit": "cm",
        "accepted": len(observations),
        "missing": sum(missing.values()),
        "years": {
            str(year): {
                "accepted": sum(counts[(year, name)] for name in STATIONS),
                "missing": sum(missing[(year, name)] for name in STATIONS),
                "stations": {name: {"accepted": counts[(year, name)], "missing": missing[(year, name)],
                                    "maxMm": str(maxima[(year, name)])} for name in STATIONS},
            }
            for year in range(2020, 2026)
        },
    }
    return observations, summary


def register_stations(base_url, key):
    query = urllib.parse.urlencode({"select": "id,name,type,address,latitude,longitude", "type": "eq.적설계"})
    facilities = request_json(
        f"{base_url}/rest/v1/facilities?{query}", key
    )
    by_id = {row["id"]: row for row in facilities}
    if len(by_id) != len(STATIONS):
        raise RuntimeError(f"Expected four live snow gauges, found {len(by_id)}")
    payload = []
    for source_name, (facility_id, expected_name) in STATIONS.items():
        facility = by_id.get(facility_id)
        if not facility or facility["name"] != expected_name or facility["type"] != "적설계":
            raise RuntimeError(f"Snow gauge mapping changed: {source_name} -> {facility_id}")
        if not facility["address"].startswith("경기도 고양시"):
            raise RuntimeError(f"Snow gauge outside Goyang: {facility_id}")
        payload.append({
            "source": "facility_snow", "station_code": facility_id, "station_name": source_name,
            "facility_id": facility_id, "address": facility["address"],
            "latitude": facility["latitude"], "longitude": facility["longitude"],
            "district": "", "metrics": ["snow_depth"], "is_active": True,
            "raw": {"facilityId": facility_id, "fileStationName": source_name,
                    "sourceUnit": "mm", "storedUnit": "cm", "measurement": "daily snow depth"},
        })
    request_json(f"{base_url}/rest/v1/observation_stations?on_conflict=source,station_code",
                 key, "POST", payload, "resolution=merge-duplicates,return=minimal")
    stations = request_json(
        f"{base_url}/rest/v1/observation_stations?select=id,station_code,is_goyang&source=eq.facility_snow", key
    )
    station_ids = {row["station_code"]: row["id"] for row in stations if row["is_goyang"]}
    if set(station_ids) != {entry[0] for entry in STATIONS.values()}:
        raise RuntimeError(f"Registered snow gauges outside Goyang or missing: {stations}")
    return station_ids


def import_observations(base_url, key, observations, summary, station_ids, batch_size, workers):
    endpoint = f"{base_url}/rest/v1/historical_observations?on_conflict=station_id,observed_at,metric"

    def send_batch(offset):
        payload = []
        for name, day, value_mm, row_number, column_number in observations[offset:offset + batch_size]:
            facility_id, _ = STATIONS[name]
            payload.append({
                "station_id": station_ids[facility_id],
                "observed_at": datetime(day.year, day.month, day.day, 12, tzinfo=KST).isoformat(),
                "metric": "snow_depth", "value": float(value_mm / 10), "unit": "cm",
                "quality_code": "facility_snow_daily_xls_mm_to_cm",
                "raw": {"sourceFile": summary["file"], "sourceRow": row_number,
                        "sourceColumn": column_number, "sourceValueMm": str(value_mm),
                        "fileStationName": name, "facilityId": facility_id,
                        "dateOnly": True, "storedTimeConvention": "12:00 KST"},
            })
        request_json(endpoint, key, "POST", payload, "resolution=merge-duplicates,return=minimal")

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(send_batch, offset) for offset in range(0, len(observations), batch_size)]
        for future in as_completed(futures):
            future.result()
    request_json(f"{base_url}/rest/v1/ingestion_runs", key, "POST", {
        "source": "facility_snow_daily_xls", "scope_region_code": "41280",
        "period_start": "2020-01-01", "period_end": "2025-12-31",
        "status": "partial" if summary["missing"] else "complete",
        "accepted_count": summary["accepted"], "excluded_count": summary["missing"],
        "message": (f"Four Goyang snow gauges; source mm converted to cm; '-' is missing; "
                    f"snow-depth interpretation based on persistence across consecutive days. {summary['file']}"),
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }, "return=minimal")
    print(json.dumps({"imported": summary["accepted"], "missing": summary["missing"]}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path.home() / "Downloads" / "SNOW_DAY.xls")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000 or not 1 <= args.workers <= 8:
        raise ValueError("Batch size must be 1–1000 and workers must be 1–8")
    observations, summary = parse_file(args.source)
    print(json.dumps({"audit": summary}, ensure_ascii=False), flush=True)
    if args.audit_only:
        return
    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    station_ids = register_stations(base_url, key)
    import_observations(base_url, key, observations, summary, station_ids, args.batch_size, args.workers)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
