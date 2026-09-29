"""Audit/import Goyang facility daily water levels, 2020–2025.

FLOW_DAY.xls is an HTML export. Its heading says cm, but the data owner
confirmed the numeric readings are m. Missing '-' cells are never zero-filled.
"""

from __future__ import annotations

import argparse
import json
import os
import runpy
import sys
import urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path


helpers = runpy.run_path(str(Path(__file__).with_name('import-facility-snow-daily.py')))
TableParser = helpers['TableParser']
request_json = helpers['request_json']
KST = timezone(timedelta(hours=9))

# Source station name -> (facility ID, registered name, facility type).
STATIONS = {
    '일산대교': ('수위계-일산대교', '일산대교', '수위계'),
    '대선교': ('수위계-8', '대선교', '수위계'),
    '지축교': ('수위계-7', '지축교', '수위계'),
    '제2화전교': ('수위계-5', '제2화전교', '수위계'),
    '강매동세월교': ('자동음성통보설치-22', '강매동세월교', '자동음성통보'),
    '원당교': ('수위계-2', '원당교', '수위계'),
    '벽제교': ('수위계-10', '벽제교', '수위계'),
    '대장진교': ('수위계-9', '대장진교', '수위계'),
    '강매2교': ('수위계-6', '강매2교', '수위계'),
    '강매3교': ('자동음성통보설치-13', '강매3교', '자동음성통보'),
    '덕이교': ('자동음성통보설치-24', '덕이교', '자동음성통보'),
    '서촌교': ('수위계-4', '서촌교', '수위계'),
    '풍동2교': ('수위계-3', '풍동2교', '수위계'),
    '삼송저류지': ('자동음성통보설치-11', '삼송저류지', '자동음성통보'),
    '킨텍스 저류지': ('자동음성통보설치-12', '킨텍스저류지', '자동음성통보'),
    '덕이3교': ('수위계-11', '덕이3교', '수위계'),
    '향군의교': ('수위계-12', '향군의교', '수위계'),
    '산황1교': ('자동음성통보설치-14', '산황1교', '자동음성통보'),
    '원당3교': ('자동음성통보설치-23', '원당3교 경보', '자동음성통보'),
    '현천육갑문': ('자동음성통보설치-2', '현천육갑문', '자동음성통보'),
    '행주대교': ('수위계-행주대교', '행주대교', '수위계'),
}

NEW_GAUGES = {
    '일산대교': {'address': '경기도 고양시 일산서구 법곳동 740', 'district': '일산서구',
             'longitude': 126.71032916587222, 'latitude': 37.659077528578315,
             'sourceRow': 2, 'jibun': '740'},
    '행주대교': {'address': '경기도 고양시 덕양구 행주외동 227-13', 'district': '덕양구',
             'longitude': 126.81530555103663, 'latitude': 37.60376113852647,
             'sourceRow': 22, 'jibun': '227-13'},
}


def parse_file(path: Path):
    parser = TableParser()
    parser.feed(path.read_text(encoding='utf-8-sig'))
    if len(parser.tables) != 2 or len(parser.tables[1]) != 22:
        raise ValueError('Unexpected source table shape')
    title = parser.tables[0][0][0]
    if title != '수위 조회 결과 : 2020-01-01 ~ 2025-12-31 [단위 : cm] [수위 장비 수량 : 21대]':
        raise ValueError(f'Unexpected source title: {title}')
    header = parser.tables[1][0]
    if header[0] != '지역':
        raise ValueError('Unexpected source header')
    days = [date.fromisoformat(value) for value in header[1:]]
    if (len(days), days[0], days[-1]) != (2192, date(2020, 1, 1), date(2025, 12, 31)):
        raise ValueError('Unexpected date range')
    if any(b != a + timedelta(days=1) for a, b in zip(days, days[1:])):
        raise ValueError('Source dates are not consecutive')
    observations = []
    held = []
    missing = Counter()
    accepted = Counter()
    seen = set()
    for row_number, row in enumerate(parser.tables[1][1:], start=2):
        name = row[0]
        if name not in STATIONS or name in seen or len(row) != len(header):
            raise ValueError(f'Unknown/duplicate/malformed station row {row_number}: {name}')
        seen.add(name)
        for column_number, (day, raw_value) in enumerate(zip(days, row[1:]), start=2):
            if raw_value in ('-', ''):
                missing[name] += 1
                continue
            try:
                value = Decimal(raw_value)
            except InvalidOperation as error:
                raise ValueError(f'Non-numeric value at {row_number}:{column_number}') from error
            if not value.is_finite() or value < 0:
                raise ValueError(f'Invalid level at {row_number}:{column_number}')
            if value > 10:
                held.append({'station': name, 'date': day.isoformat(), 'valueM': str(value),
                             'sourceRow': row_number, 'sourceColumn': column_number,
                             'reason': 'Above 10 m; pending sensor-quality review'})
                continue
            accepted[name] += 1
            observations.append((name, day, value, row_number, column_number))
    if seen != set(STATIONS):
        raise ValueError(f'Station set changed: {seen ^ set(STATIONS)}')
    if len(observations) + len(held) + sum(missing.values()) != len(STATIONS) * len(days):
        raise ValueError('Source-cell reconciliation failed')
    return observations, {
        'file': path.name, 'sourceHeadingUnit': 'cm', 'userConfirmedUnit': 'm',
        'accepted': len(observations), 'missing': sum(missing.values()),
        'heldHighValues': held, 'stationAccepted': dict(accepted),
        'stationMissing': dict(missing),
    }


def ensure_facilities(base_url: str, key: str):
    existing = request_json(f'{base_url}/rest/v1/facilities?select=id,name,type,address,latitude,longitude', key)
    by_id = {row['id']: row for row in existing}
    inserts = []
    for name, loc in NEW_GAUGES.items():
        facility_id = STATIONS[name][0]
        for row in existing:
            if row['name'] == name and row['type'] == '수위계' and row['id'] != facility_id:
                raise RuntimeError(f'Another registered water gauge already has name {name}: {row["id"]}')
        if facility_id in by_id:
            row = by_id[facility_id]
            if row['name'] != name or row['type'] != '수위계' or row['address'] != loc['address']:
                raise RuntimeError(f'Existing facility ID conflicts: {facility_id}')
            continue
        inserts.append({
            'id': facility_id, 'name': name, 'type': '수위계', 'source_type': '수위계',
            'status': '운영중', 'address': loc['address'], 'district': loc['district'],
            'longitude': loc['longitude'], 'latitude': loc['latitude'],
            'agency': '재난대응과', 'detail': '일 수위 관측',
            'source_sheet': 'FLOW_DAY.xls', 'source_row': loc['sourceRow'],
            'original': {'sourceFile': 'FLOW_DAY.xls', 'sourceRow': loc['sourceRow'],
                         'addressProvidedByUser': True, 'locationSource': 'SGIS geocodewgs84',
                         'locationMatch': 'exact', 'geocodeAddressType': '6',
                         'jibun': loc['jibun'], 'sourceHeadingUnit': 'cm',
                         'userConfirmedUnit': 'm'},
        })
    if inserts:
        request_json(f'{base_url}/rest/v1/facilities', key, 'POST', inserts, 'return=minimal')
        request_json(f'{base_url}/rest/v1/facility_change_history', key, 'POST', [
            {'facility_id': row['id'], 'facility_name': row['name'], 'action': '일괄등록',
             'summary': 'FLOW_DAY.xls 수위 관측소 등록; 사용자 제공 주소와 SGIS 좌표 확인'}
            for row in inserts
        ], 'return=minimal')
    return len(inserts)


def register_stations(base_url: str, key: str):
    facilities = request_json(
        f'{base_url}/rest/v1/facilities?select=id,name,type,address,latitude,longitude', key)
    by_id = {row['id']: row for row in facilities}
    payload = []
    for source_name, (facility_id, expected_name, expected_type) in STATIONS.items():
        row = by_id.get(facility_id)
        if not row or row['name'] != expected_name or row['type'] != expected_type:
            raise RuntimeError(f'Facility mapping changed: {source_name} -> {facility_id}')
        if not row['address'].startswith('경기도 고양시') or row['latitude'] is None or row['longitude'] is None:
            raise RuntimeError(f'Facility outside Goyang or without coordinates: {facility_id}')
        payload.append({
            'source': 'facility_level', 'station_code': facility_id,
            'station_name': source_name, 'facility_id': facility_id,
            'address': row['address'], 'latitude': row['latitude'], 'longitude': row['longitude'],
            'district': '', 'metrics': ['water_level'], 'is_active': True,
            'raw': {'facilityId': facility_id, 'fileStationName': source_name,
                    'facilityType': expected_type,
                    'coLocatedLevelSensor': expected_type == '자동음성통보',
                    'sourceHeadingUnit': 'cm', 'userConfirmedUnit': 'm'},
        })
    request_json(f'{base_url}/rest/v1/observation_stations?on_conflict=source,station_code',
                 key, 'POST', payload, 'resolution=merge-duplicates,return=minimal')
    stations = request_json(
        f'{base_url}/rest/v1/observation_stations?select=id,station_code,is_goyang&source=eq.facility_level', key)
    station_ids = {row['station_code']: row['id'] for row in stations if row['is_goyang']}
    if set(station_ids) != {entry[0] for entry in STATIONS.values()}:
        raise RuntimeError(f'Level station outside analysis boundary or missing: {stations}')
    return station_ids


def import_observations(base_url, key, observations, summary, station_ids, batch_size, workers):
    endpoint = f'{base_url}/rest/v1/historical_observations?on_conflict=station_id,observed_at,metric'

    def send_batch(offset):
        payload = []
        for name, day, value, row_number, column_number in observations[offset:offset + batch_size]:
            facility_id, _, facility_type = STATIONS[name]
            payload.append({
                'station_id': station_ids[facility_id],
                'observed_at': datetime(day.year, day.month, day.day, 12, tzinfo=KST).isoformat(),
                'metric': 'water_level', 'value': float(value), 'unit': 'm',
                'quality_code': 'facility_level_daily_user_confirmed_m',
                'raw': {'sourceFile': summary['file'], 'sourceRow': row_number,
                        'sourceColumn': column_number, 'sourceValue': str(value),
                        'fileStationName': name, 'facilityId': facility_id,
                        'coLocatedLevelSensor': facility_type == '자동음성통보',
                        'sourceHeadingUnit': 'cm', 'userConfirmedUnit': 'm',
                        'dateOnly': True, 'storedTimeConvention': '12:00 KST'},
            })
        request_json(endpoint, key, 'POST', payload, 'resolution=merge-duplicates,return=minimal')

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(send_batch, offset) for offset in range(0, len(observations), batch_size)]
        for future in as_completed(futures):
            future.result()
    request_json(f'{base_url}/rest/v1/ingestion_runs', key, 'POST', {
        'source': 'facility_level_daily_xls', 'scope_region_code': '41280',
        'period_start': '2020-01-01', 'period_end': '2025-12-31',
        'status': 'partial' if summary['missing'] or summary['heldHighValues'] else 'complete',
        'accepted_count': summary['accepted'],
        'excluded_count': summary['missing'] + len(summary['heldHighValues']),
        'message': (f'21 Goyang facility level sensors; source heading says cm but data owner confirmed m; '
                    f"'-' is missing; {len(summary['heldHighValues'])} readings >10 m held for quality review. "
                    f"{summary['file']}"),
        'finished_at': datetime.now(timezone.utc).isoformat(),
    }, 'return=minimal')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path.home() / 'Downloads' / 'FLOW_DAY.xls')
    parser.add_argument('--audit-only', action='store_true')
    parser.add_argument('--audit-output', type=Path)
    parser.add_argument('--batch-size', type=int, default=500)
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000 or not 1 <= args.workers <= 8:
        raise ValueError('Invalid batch size or workers')
    observations, summary = parse_file(args.source)
    if args.audit_output:
        args.audit_output.parent.mkdir(parents=True, exist_ok=True)
        args.audit_output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in summary.items() if key != 'heldHighValues'} |
                     {'heldHighCount': len(summary['heldHighValues'])}, ensure_ascii=True), flush=True)
    if args.audit_only:
        return
    base_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not base_url or not key:
        raise RuntimeError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
    inserted = ensure_facilities(base_url, key)
    station_ids = register_stations(base_url, key)
    import_observations(base_url, key, observations, summary, station_ids, args.batch_size, args.workers)
    print(json.dumps({'newFacilities': inserted, 'stations': len(station_ids),
                      'imported': len(observations), 'heldHigh': len(summary['heldHighValues'])}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
