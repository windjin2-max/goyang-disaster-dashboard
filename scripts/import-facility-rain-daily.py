"""Audit and import Goyang rain-gauge/voice-sensor daily rainfall, 2020–2025.

The supplied .xls files are UTF-8 HTML exports. A '-' cell is missing, not zero.
Unmatched or out-of-scope stations are held until their location is confirmed.
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
# Export name -> (registered facility ID, registered name, registered type).
# Aliases are explicit: they must never be matched by fuzzy name alone.
STATIONS = {
    "고양시청": ("강우량계-8", "고양시청강수", "강우량계"),
    "덕양구청": ("강우량계-2", "덕양구청", "강우량계"),
    "일산동구청": ("강우량계-3", "일산동구청", "강우량계"),
    "일산서구청": ("강우량계-4", "일산서구청", "강우량계"),
    "고양동": ("강우량계-7", "고양동", "강우량계"),
    "관산동": ("강우량계-5", "관산동", "강우량계"),
    "효자동": ("강우량계-6", "효자동", "강우량계"),
    "고봉동": ("강우량계-10", "고봉동", "강우량계"),
    "가좌도서관": ("강우량계-9", "가좌도서관", "강우량계"),
    "강매배수펌프장": ("자동음성통보설치-4", "강매배수펌프장", "자동음성통보"),
    "공릉천2교": ("자동음성통보설치-6", "공릉천2교 물놀이 장소", "자동음성통보"),
    "창릉교": ("자동음성통보설치-5", "창릉교 자전거 도로", "자동음성통보"),
    "행주산성 역사공원": ("자동음성통보설치-10", "행주역사공원", "자동음성통보"),
    "현천육갑문": ("자동음성통보설치-2", "현천육갑문", "자동음성통보"),
    "화전동마을회관": ("자동음성통보설치-3", "화전동 마을회관", "자동음성통보"),
}
HELD = {
    "삼송저류지": "등록된 자동음성통보 시설의 주소·좌표가 연천군으로 되어 있음",
    "필리핀참전비": "등록된 강우량계·자동음성통보 시설을 찾지 못함",
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


def parse_file(path, year):
    parser = TableParser()
    parser.feed(path.read_text(encoding="utf-8-sig"))
    if len(parser.tables) != 2 or len(parser.tables[1]) != 18:
        raise ValueError(f"Unexpected table layout: {path.name}")
    title = parser.tables[0][0][0]
    if f"{year}-01-01 ~ {year}-12-31" not in title or "강우 장비 수량 : 17대" not in title:
        raise ValueError(f"Unexpected title: {path.name}")
    header = parser.tables[1][0]
    if header[0] != "지역":
        raise ValueError(f"Unexpected first column: {path.name}")
    days = [date.fromisoformat(value) for value in header[1:]]
    if (days[0], days[-1]) != (date(year, 1, 1), date(year, 12, 31)) or any(
        current != previous + timedelta(days=1) for previous, current in zip(days, days[1:])
    ):
        raise ValueError(f"Unexpected or nonconsecutive dates: {path.name}")

    observations = []
    held_values = Counter()
    missing = Counter()
    nonzero = Counter()
    maxima = Counter()
    extreme_values = []
    names = set()
    for row_number, row in enumerate(parser.tables[1][1:], start=2):
        name = row[0]
        if name not in STATIONS and name not in HELD:
            raise ValueError(f"Unrecognized station in {path.name}:{row_number}: {name}")
        if name in names or len(row) != len(header):
            raise ValueError(f"Duplicate or malformed row in {path.name}:{row_number}: {name}")
        names.add(name)
        for column_number, (day, raw_value) in enumerate(zip(days, row[1:]), start=2):
            if raw_value in ("-", ""):
                missing[name] += 1
                continue
            try:
                value = Decimal(raw_value)
            except InvalidOperation as error:
                raise ValueError(f"Non-numeric cell {path.name}:{row_number}:{column_number}") from error
            if not value.is_finite() or value < 0:
                raise ValueError(f"Invalid rainfall {path.name}:{row_number}:{column_number}")
            if name in HELD:
                held_values[name] += 1
                continue
            if value >= 1000:
                extreme_values.append({"station": name, "date": day.isoformat(), "valueMm": str(value),
                                       "sourceRow": row_number, "sourceColumn": column_number})
                continue
            observations.append((name, day, value, row_number, column_number))
            nonzero[name] += value > 0
            maxima[name] = max(maxima[name], value)

    if names != set(STATIONS) | set(HELD):
        raise ValueError(f"Station list changed in {path.name}: {names}")
    summary = {
        "file": path.name,
        "year": year,
        "days": len(days),
        "accepted": len(observations),
        "missingCells": sum(missing.values()),
        "heldNumericCells": sum(held_values.values()),
        "held": dict(held_values),
        "stationCounts": {name: len(days) - missing[name] - sum(value["station"] == name for value in extreme_values)
                          for name in STATIONS},
        "maxDailyMm": {name: str(maxima[name]) for name in STATIONS},
        "extremeValuesHeldAtLeast1000Mm": extreme_values,
    }
    if summary["accepted"] + summary["missingCells"] + summary["heldNumericCells"] + len(extreme_values) != 17 * len(days):
        raise ValueError(f"Cell count does not reconcile: {path.name}")
    return observations, summary


def register_stations(base_url, key):
    query = urllib.parse.urlencode({"select": "id,name,type,address,latitude,longitude", "or": "(type.eq.강우량계,type.eq.자동음성통보)"})
    facilities = request_json(f"{base_url}/rest/v1/facilities?{query}", key)
    by_id = {row["id"]: row for row in facilities}
    payload = []
    for source_name, (facility_id, expected_name, expected_type) in STATIONS.items():
        facility = by_id.get(facility_id)
        if not facility or facility["name"] != expected_name or facility["type"] != expected_type:
            raise RuntimeError(f"Facility mapping changed: {source_name} -> {facility_id}")
        if not facility["address"].startswith("경기도 고양시"):
            raise RuntimeError(f"Facility outside Goyang: {facility_id}")
        payload.append({
            "source": "facility_rain", "station_code": facility_id, "station_name": source_name,
            "facility_id": facility_id, "address": facility["address"],
            "latitude": facility["latitude"], "longitude": facility["longitude"],
            "district": "", "metrics": ["rainfall_daily"], "is_active": True,
            "raw": {"facilityId": facility_id, "fileStationName": source_name,
                    "facilityType": expected_type, "coLocatedRainSensor": expected_type == "자동음성통보"},
        })
    request_json(f"{base_url}/rest/v1/observation_stations?on_conflict=source,station_code",
                 key, "POST", payload, "resolution=merge-duplicates,return=minimal")
    query = urllib.parse.urlencode({"select": "id,station_code,is_goyang", "source": "eq.facility_rain"})
    stations = request_json(f"{base_url}/rest/v1/observation_stations?{query}", key)
    station_ids = {row["station_code"]: row["id"] for row in stations if row["is_goyang"]}
    if set(station_ids) != {entry[0] for entry in STATIONS.values()}:
        raise RuntimeError(f"Registered rain stations outside Goyang or missing: {stations}")
    return station_ids


def import_file(base_url, key, observations, summary, station_ids, batch_size, workers):
    endpoint = f"{base_url}/rest/v1/historical_observations?on_conflict=station_id,observed_at,metric"

    def send_batch(offset):
        payload = []
        for name, day, value, row_number, column_number in observations[offset:offset + batch_size]:
            facility_id, _, facility_type = STATIONS[name]
            payload.append({
                "station_id": station_ids[facility_id],
                "observed_at": datetime(day.year, day.month, day.day, 12, tzinfo=KST).isoformat(),
                "metric": "rainfall_daily", "value": float(value), "unit": "mm",
                "quality_code": "facility_rain_daily_xls",
                "raw": {"sourceFile": summary["file"], "sourceRow": row_number,
                        "sourceColumn": column_number, "fileStationName": name,
                        "facilityId": facility_id, "coLocatedRainSensor": facility_type == "자동음성통보"},
            })
        request_json(endpoint, key, "POST", payload, "resolution=merge-duplicates,return=minimal")

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(send_batch, offset) for offset in range(0, len(observations), batch_size)]
        for future in as_completed(futures):
            future.result()

    request_json(f"{base_url}/rest/v1/ingestion_runs", key, "POST", {
        "source": "facility_rain_daily_xls", "scope_region_code": "41280",
        "period_start": f"{summary['year']}-01-01", "period_end": f"{summary['year']}-12-31",
        "status": "partial", "accepted_count": summary["accepted"],
        "excluded_count": summary["missingCells"] + summary["heldNumericCells"] + len(summary["extremeValuesHeldAtLeast1000Mm"]),
        "message": (f"15 mapped rain sensors; '-' cells excluded; 삼송저류지 and 필리핀참전비 held "
                    f"pending location confirmation; values >=1000 mm held as anomalies. {summary['file']}"),
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }, "return=minimal")
    print(json.dumps({"imported": summary["year"], "count": summary["accepted"]}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--downloads-root", type=Path, default=Path.home() / "Downloads")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--start-year", type=int, default=2020)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000:
        raise ValueError("Batch size must be 1–1000")
    if not 1 <= args.workers <= 8 or not 2020 <= args.start_year <= 2025:
        raise ValueError("Workers must be 1–8 and start year must be 2020–2025")
    files = []
    for year in range(2020, 2026):
        observations, summary = parse_file(args.downloads_root / f"RAIN_DAY_{year}.xls", year)
        files.append((observations, summary))
        print(json.dumps({"audit": summary}, ensure_ascii=False), flush=True)
    if args.audit_only:
        return
    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    station_ids = register_stations(base_url, key)
    for observations, summary in files:
        if summary["year"] >= args.start_year:
            import_file(base_url, key, observations, summary, station_ids, args.batch_size, args.workers)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
