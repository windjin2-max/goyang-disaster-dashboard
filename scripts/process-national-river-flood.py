"""Convert Goyang 100-year national-river flood SHP archives to web GeoJSON.

Required packages: pyshp, pyproj, shapely
"""

from __future__ import annotations

import argparse
import json
import tempfile
import zipfile
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform
from shapely.validation import make_valid


DISTRICT_NAMES = {
    "41281": "덕양구",
    "41285": "일산동구",
    "41287": "일산서구",
}

# 홍수위험지도 정보제공포털의 5단계 침수심 구간
DEPTH_CLASSES = {
    "N333": (1, "0.5m 이하", "#FDFBC7"),
    "N332": (2, "0.5~1.0m", "#E6FF99"),
    "N330": (3, "1.0~2.0m", "#38FEFD"),
    "N331": (4, "2.0~5.0m", "#CE9AFE"),
    "N334": (5, "5.0m 이상", "#CE3F87"),
}


def rounded_coordinates(value):
    if isinstance(value, (list, tuple)):
        if value and isinstance(value[0], (int, float)):
            return [round(float(value[0]), 6), round(float(value[1]), 6)]
        return [rounded_coordinates(item) for item in value]
    return value


def convert_archive(archive: Path, transformer: Transformer, tolerance: float, map_type: str):
    with tempfile.TemporaryDirectory() as temp_dir:
        with zipfile.ZipFile(archive) as source:
            source.extractall(temp_dir)
        shp_path = next(Path(temp_dir).glob("*.shp"))
        with shapefile.Reader(str(shp_path), encoding="utf-8") as reader:
            field_names = [field[0] for field in reader.fields[1:]]

            for shape_record in reader.iterShapeRecords():
                properties = dict(zip(field_names, shape_record.record))
                if shape_record.shape.shapeType == shapefile.NULL:
                    continue
                district_code = str(properties["SGG_CD"])
                segment_code = str(properties["SEG_CODE"])
                depth_order, depth_label, color = DEPTH_CLASSES[segment_code]

                geometry = shape(shape_record.shape.__geo_interface__)
                if not geometry.is_valid:
                    geometry = make_valid(geometry)
                geometry = geometry.simplify(tolerance, preserve_topology=True)
                geometry = transform(transformer.transform, geometry)
                geojson_geometry = mapping(geometry)

                yield {
                    "type": "Feature",
                    "properties": {
                        "source": "홍수위험지도 정보제공포털",
                        "mapType": map_type,
                        "districtCode": district_code,
                        "districtName": DISTRICT_NAMES[district_code],
                        "frequencyYears": int(properties["FLDLV_FREQ"]),
                        "segmentCode": segment_code,
                        "depthOrder": depth_order,
                        "depthLabel": depth_label,
                        "color": color,
                    },
                    "geometry": {
                        "type": geojson_geometry["type"],
                        "coordinates": rounded_coordinates(geojson_geometry["coordinates"]),
                    },
                }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archives", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--simplify-meters", type=float, default=0.0)
    parser.add_argument("--map-type", default="국가하천 하천범람지도")
    parser.add_argument("--collection-name", default="고양시 100년 빈도 국가하천 하천범람지도")
    args = parser.parse_args()

    transformer = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True)
    features = []
    for archive in args.archives:
        features.extend(convert_archive(archive, transformer, args.simplify_meters, args.map_type))

    features.sort(key=lambda feature: (
        feature["properties"]["depthOrder"],
        feature["properties"]["districtCode"],
    ))
    output = {
        "type": "FeatureCollection",
        "name": args.collection_name,
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "metadata": {
            "sourceCrs": "EPSG:5186",
            "targetCrs": "EPSG:4326",
            "frequencyYears": 100,
            "mapType": args.map_type,
            "districtCodes": sorted(DISTRICT_NAMES),
            "simplifyMeters": args.simplify_meters,
        },
        "features": features,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "features": len(features), "bytes": args.output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
