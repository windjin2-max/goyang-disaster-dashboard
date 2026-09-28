"""Render Goyang local-river flood SHP archives as a web map raster overlay.

Required packages: pyshp, pyproj, Pillow
"""

from __future__ import annotations

import argparse
import json
import tempfile
import zipfile
from pathlib import Path

import shapefile
from PIL import Image, ImageDraw
from pyproj import Transformer


DEPTH_COLORS = {
    "N333": "#FDFBC7",
    "N332": "#E6FF99",
    "N330": "#38FEFD",
    "N331": "#CE9AFE",
    "N334": "#CE3F87",
}


def signed_ring_area(ring):
    return sum(
        x1 * y2 - x2 * y1
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])
    ) / 2


def iter_shape_records(archives: list[Path]):
    for archive in archives:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with zipfile.ZipFile(archive) as source:
                source.extractall(temp_dir)
            shp_path = next(Path(temp_dir).glob("*.shp"))
            with shapefile.Reader(str(shp_path), encoding="utf-8") as reader:
                fields = [field[0] for field in reader.fields[1:]]
                for shape_record in reader.iterShapeRecords():
                    properties = dict(zip(fields, shape_record.record))
                    if shape_record.shape.shapeType == shapefile.NULL:
                        continue
                    yield properties, shape_record.shape


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archives", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument("--width", type=int, default=4096)
    args = parser.parse_args()

    to_web_mercator = Transformer.from_crs("EPSG:5186", "EPSG:3857", always_xy=True)
    to_wgs84 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    records = list(iter_shape_records(args.archives))
    source_bounds = [
        min(item[1].bbox[0] for item in records),
        min(item[1].bbox[1] for item in records),
        max(item[1].bbox[2] for item in records),
        max(item[1].bbox[3] for item in records),
    ]
    west, south = to_web_mercator.transform(source_bounds[0], source_bounds[1])
    east, north = to_web_mercator.transform(source_bounds[2], source_bounds[3])
    height = max(1, round(args.width * (north - south) / (east - west)))
    image = Image.new("RGBA", (args.width, height), (0, 0, 0, 0))

    def pixel_points(points):
        source_x, source_y = zip(*points)
        projected_x, projected_y = to_web_mercator.transform(source_x, source_y)
        return [
            (
                round((x - west) / (east - west) * (args.width - 1)),
                round((north - y) / (north - south) * (height - 1)),
            )
            for x, y in zip(projected_x, projected_y)
        ]

    depth_order = {code: index for index, code in enumerate(("N333", "N332", "N330", "N331", "N334"), start=1)}
    point_count = 0
    ring_count = 0
    district_codes = set()
    for properties, source_shape in sorted(records, key=lambda item: depth_order[str(item[0]["SEG_CODE"])]):
        segment_code = str(properties["SEG_CODE"])
        district_codes.add(str(properties["SGG_CD"]))
        feature_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(feature_layer)
        pixels = pixel_points(source_shape.points)
        part_starts = list(source_shape.parts) + [len(source_shape.points)]
        rings = [
            source_shape.points[start:part_starts[part_index + 1]]
            for part_index, start in enumerate(part_starts[:-1])
        ]
        has_clockwise_outer = any(len(ring) >= 3 and signed_ring_area(ring) < 0 for ring in rings)
        for part_index, start in enumerate(part_starts[:-1]):
            ring = rings[part_index]
            if len(ring) < 3:
                continue
            pixel_ring = pixels[start:part_starts[part_index + 1]]
            is_hole = has_clockwise_outer and signed_ring_area(ring) > 0
            draw.polygon(pixel_ring, fill=(0, 0, 0, 0) if is_hole else DEPTH_COLORS[segment_code])
            point_count += len(ring)
            ring_count += 1
        image.alpha_composite(feature_layer)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output, format="PNG", optimize=True)
    west_lng, south_lat = to_wgs84.transform(west, south)
    east_lng, north_lat = to_wgs84.transform(east, north)
    metadata = {
        "name": "고양시 100년 빈도 지방하천 하천범람지도",
        "source": "홍수위험지도 정보제공포털",
        "sourceCrs": "EPSG:5186",
        "rasterCrs": "EPSG:3857",
        "frequencyYears": 100,
        "districtCodes": sorted(district_codes),
        "bounds": {"west": west_lng, "south": south_lat, "east": east_lng, "north": north_lat},
        "width": args.width,
        "height": height,
        "featureCount": len(records),
        "ringCount": ring_count,
        "pointCount": point_count,
        "image": args.output.name,
    }
    args.metadata.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**metadata, "bytes": args.output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
