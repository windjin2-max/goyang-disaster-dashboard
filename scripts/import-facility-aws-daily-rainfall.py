"""Audit and import 2020–2025 daily rainfall from Goyang facility AWS exports.

The .xls exports are UTF-8 HTML tables, not binary Excel workbooks. A '-' cell
means missing data and is never converted to zero. Run --audit-only first.
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
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path


KST = timezone(timedelta(hours=9))
FACILITIES = {
    "동산동": "AWS-6",
    "성석동": "AWS-7",
    "한뫼도서관": "AWS-3",
    "대화배수펌프장": "AWS-4",
    "현천배수펌프장": "AWS-2",
    "벽제수질복원센터": "AWS-5",
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
    if len(parser.tables) != 2 or len(parser.tables[1]) != 7:
        raise ValueError(f"Unexpected table layout: {path.name}")
    heading = parser.tables[0][0][0]
    if f"{year}-01-01" not in heading or "AWS 장비 수량 : 6대" not in heading:
        raise ValueError(f"Unexpected title: {path.name}")

    header = parser.tables[1][0]
    if header[0] != "지역":
        raise ValueError(f"Unexpected first column: {path.name}")
    dates = [date.fromisoformat(value) for value in header[1:]]
    if not dates or dates[0] != date(year, 1, 1) or any(
        current != previous + timedelta(days=1) for previous, current in zip(dates, dates[1:])
    ) or dates[-1].year != year:
        raise ValueError(f"Unexpected or nonconsecutive dates: {path.name}")

    observations = []
    missing = Counter()
    nonzero = Counter()
    maxima = Counter()
    station_names = set()
    for row_number, row in enumerate(parser.tables[1][1:], start=2):
        name = row[0]
        if name not in FACILITIES or name in station_names or len(row) != len(header):
            raise ValueError(f"Unexpected station row {row_number}: {path.name}, {name}")
        station_names.add(name)
        for column_number, (day, raw_value) in enumerate(zip(dates, row[1:]), start=2):
            if raw_value in ("-", ""):
                missing[name] += 1
                continue
            try:
                value = Decimal(raw_value)
            except InvalidOperation as error:
                raise ValueError(f"Non-numeric cell {path.name}:{row_number}:{column_number}") from error
            if not value.is_finite() or value < 0:
                raise ValueError(f"Invalid rainfall {path.name}:{row_number}:{column_number}")
            observations.append((name, day, value, row_number, column_number))
            nonzero[name] += value > 0
            maxima[name] = max(maxima[name], value)

    if station_names != set(FACILITIES):
        raise ValueError(f"Missing stations in {path.name}: {set(FACILITIES) - station_names}")
    summary = {
        "file": path.name,
        "year": year,
        "firstDate": dates[0].isoformat(),
        "lastDate": dates[-1].isoformat(),
        "coveredDays": len(dates),
        "missingDaysAtYearEnd": (date(year + 1, 1, 1) - dates[-1]).days - 1,
        "acceptedCells": len(observations),
        "missingCells": sum(missing.values()),
        "stations": {
            name: {"facilityId": FACILITIES[name], "accepted": len(dates) - missing[name],
                   "missing": missing[name], "rainyDays": nonzero[name], "maxDailyMm": str(maxima[name])}
            for name in FACILITIES
        },
    }
    return observations, summary


def register_stations(base_url, key):
    facilities = request_json(
        f"{base_url}/rest/v1/facilities?select=id,name,type,address,latitude,longitude&type=eq.AWS", key
    )
    by_id = {row["id"]: row for row in facilities}
    if len(by_id) != len(FACILITIES):
        raise RuntimeError(f"Expected six live AWS facilities, found {len(by_id)}")
    payload = []
    for name, facility_id in FACILITIES.items():
        facility = by_id.get(facility_id)
        if not facility or facility["name"] != name or facility["type"] != "AWS":
            raise RuntimeError(f"AWS facility mismatch: {facility_id} {name}")
        payload.append({
            "source": "facility_aws", "station_code": facility_id, "station_name": name,
            "facility_id": facility_id, "address": facility["address"],
            "latitude": facility["latitude"], "longitude": facility["longitude"],
            "district": "", "metrics": ["rainfall_daily"], "is_active": True,
            "raw": {"facilityId": facility_id, "dataSource": "고양시 AWS 강우 조회 결과"},
        })
    request_json(
        f"{base_url}/rest/v1/observation_stations?on_conflict=source,station_code",
        key, "POST", payload, "resolution=merge-duplicates,return=minimal",
    )
    query = urllib.parse.urlencode({"select": "id,station_code,is_goyang", "source": "eq.facility_aws"})
    stations = request_json(f"{base_url}/rest/v1/observation_stations?{query}", key)
    station_ids = {row["station_code"]: row["id"] for row in stations if row["is_goyang"]}
    if set(station_ids) != set(FACILITIES.values()):
        raise RuntimeError(f"Registered stations outside Goyang or missing: {stations}")
    return station_ids


def import_file(base_url, key, observations, summary, station_ids, batch_size):
    endpoint = f"{base_url}/rest/v1/historical_observations?on_conflict=station_id,observed_at,metric"
    for offset in range(0, len(observations), batch_size):
        payload = []
        for name, day, value, row_number, column_number in observations[offset:offset + batch_size]:
            observed_at = datetime(day.year, day.month, day.day, 12, tzinfo=KST)
            payload.append({
                "station_id": station_ids[FACILITIES[name]], "observed_at": observed_at.isoformat(),
                "metric": "rainfall_daily", "value": float(value), "unit": "mm",
                "quality_code": "facility_aws_daily_xls",
                "raw": {"sourceFile": summary["file"], "sourceRow": row_number,
                        "sourceColumn": column_number, "facilityId": FACILITIES[name]},
            })
        request_json(endpoint, key, "POST", payload, "resolution=merge-duplicates,return=minimal")
    request_json(f"{base_url}/rest/v1/ingestion_runs", key, "POST", {
        "source": "facility_aws_daily_xls", "scope_region_code": "41280",
        "period_start": summary["firstDate"], "period_end": summary["lastDate"],
        "status": "partial" if summary["missingCells"] or summary["missingDaysAtYearEnd"] else "complete",
        "accepted_count": summary["acceptedCells"], "excluded_count": summary["missingCells"],
        "message": (f"Six registered city AWS facilities; {summary['missingCells']} '-' cells excluded; "
                    f"{summary['missingDaysAtYearEnd']} year-end days absent. {summary['file']}"),
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }, "return=minimal")
    print(json.dumps({"imported": summary["year"], "count": len(observations)}, ensure_ascii=False), flush=True)


def main():
    args_parser = argparse.ArgumentParser()
    args_parser.add_argument("--downloads-root", type=Path, default=Path.home() / "Downloads")
    args_parser.add_argument("--audit-only", action="store_true")
    args_parser.add_argument("--batch-size", type=int, default=500)
    args = args_parser.parse_args()
    if not 1 <= args.batch_size <= 1000:
        raise ValueError("Batch size must be 1–1000")
    files = []
    for year in range(2020, 2026):
        observations, summary = parse_file(args.downloads_root / f"AWS_DAY_RAIN_{year}.xls", year)
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
        import_file(base_url, key, observations, summary, station_ids, args.batch_size)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
