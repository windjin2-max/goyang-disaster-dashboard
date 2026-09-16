from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import openpyxl


SOURCE = Path(r"C:\Users\user\Downloads\시설물주소_수정.xlsx")
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "public" / "data"


def clean(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return value


def first(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = clean(row.get(key))
        if value != "":
            return str(value).strip()
    return ""


def to_float(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def district_from(address: str) -> str:
    for district in ("덕양구", "일산동구", "일산서구"):
        if district in address:
            return district
    return "미분류"


def normalize_sheet_name(name: str) -> str:
    return name.replace("설치", "").strip()


def main() -> None:
    workbook = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
    facilities: list[dict[str, Any]] = []

    for sheet in workbook.worksheets:
        values = list(sheet.iter_rows(values_only=True))
        if not values:
            continue
        headers = [str(value).strip() if value is not None else "" for value in values[0]]
        for excel_row, raw_values in enumerate(values[1:], start=2):
            if not any(value not in (None, "") for value in raw_values):
                continue
            row = {headers[index]: clean(value) for index, value in enumerate(raw_values) if index < len(headers) and headers[index]}
            name = first(row, "지점명", "지정명", "시설명")
            upper = first(row, "지번주소 상위부분")
            lower = first(row, "지번주소 하위부분")
            address = " ".join(part for part in (upper, lower) if part).strip()
            longitude = to_float(row.get("X좌표"))
            latitude = to_float(row.get("Y좌표"))
            agency = first(row, "관리부서", "관련과") or "미등록"
            installed_at = first(row, "설치년도", "설치연도")
            detail = first(row, "설치목적", "시설명", "하천명", "전광판 종류", "측정방식", "지목")
            facility_id = f"{sheet.title}-{excel_row}"
            facilities.append({
                "id": facility_id,
                "name": name or f"미등록 시설 {excel_row}",
                "type": normalize_sheet_name(sheet.title),
                "sourceType": sheet.title,
                "status": "운영중",
                "address": address,
                "district": district_from(address),
                "longitude": longitude,
                "latitude": latitude,
                "agency": agency,
                "installedAt": installed_at,
                "detail": detail,
                "pnu": first(row, "PNU코드"),
                "postalCode": first(row, "새우편번호"),
                "sourceSheet": sheet.title,
                "sourceRow": excel_row,
                "original": row,
            })

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    metadata = {
        "sourceFile": SOURCE.name,
        "generatedAt": "2026-09-16",
        "total": len(facilities),
        "facilities": facilities,
    }
    (OUTPUT_DIR / "facilities.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    features = []
    for facility in facilities:
        if facility["longitude"] is None or facility["latitude"] is None:
            continue
        features.append({
            "type": "Feature",
            "id": facility["id"],
            "geometry": {"type": "Point", "coordinates": [facility["longitude"], facility["latitude"]]},
            "properties": {key: value for key, value in facility.items() if key not in ("longitude", "latitude", "original")},
        })
    geojson = {"type": "FeatureCollection", "features": features}
    (OUTPUT_DIR / "facilities.geojson").write_text(json.dumps(geojson, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(json.dumps({"facilities": len(facilities), "geoFeatures": len(features)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
