"""Load Goyang flood-scenario SHP archives and calculate spatial exposure.

The script sends source rings to service-role-only Supabase RPCs in bounded
batches. Coordinates remain in the source EPSG:5186 CRS until PostGIS clips
and transforms the finalized feature to EPSG:4326.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import shapefile


DISTRICT_NAMES = {
    "41281": "덕양구",
    "41285": "일산동구",
    "41287": "일산서구",
}

DEPTH_CLASSES = {
    "N333": ("0.5m 이하", 0.5),
    "N332": ("0.5~1.0m", 1.0),
    "N330": ("1.0~2.0m", 2.0),
    "N331": ("2.0~5.0m", 5.0),
    "N334": ("5.0m 이상", 5.0),
}

LAYER_PATHS = {
    "national_river_flood": ("국가", "국가하천 하천범람지도"),
    "local_river_flood": ("지방", "지방하천 하천범람지도"),
    "urban_flood": ("도시", "도시침수지도"),
}


def signed_ring_area(ring):
    return sum(
        x1 * y2 - x2 * y1
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])
    ) / 2.0


class SupabaseRpc:
    def __init__(self, url: str, service_key: str):
        self.base_url = url.rstrip("/") + "/rest/v1/rpc/"
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }

    def call(self, function_name: str, payload: dict | None = None, retries: int = 3):
        body = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + function_name,
            data=body,
            headers=self.headers,
            method="POST",
        )
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(request, timeout=900) as response:
                    content = response.read().decode("utf-8")
                    return json.loads(content) if content else None
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")
                if error.code < 500 or attempt == retries - 1:
                    raise RuntimeError(f"{function_name} failed ({error.code}): {detail}") from error
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt == retries - 1:
                    raise RuntimeError(f"{function_name} failed: {error}") from error
            time.sleep(2 ** attempt)


def batch_rings(rings, max_points):
    batch = []
    point_count = 0
    for ring in rings:
        if len(ring) < 4:
            continue
        if ring[0] != ring[-1]:
            ring = list(ring) + [ring[0]]
        if batch and point_count + len(ring) > max_points:
            yield batch
            batch = []
            point_count = 0
        batch.append(ring)
        point_count += len(ring)
        if point_count >= max_points:
            yield batch
            batch = []
            point_count = 0
    if batch:
        yield batch


def extract_shape_archive(archive: Path):
    temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    with zipfile.ZipFile(archive) as source:
        source.extractall(temporary.name)
    shp_paths = list(Path(temporary.name).rglob("*.shp"))
    if len(shp_paths) != 1:
        temporary.cleanup()
        raise RuntimeError(f"Expected exactly one SHP in {archive}, found {len(shp_paths)}")
    return temporary, shp_paths[0]


def import_layer(rpc: SupabaseRpc, layer_code: str, archives: list[Path], max_points: int):
    rpc.call("clear_flood_scenario_import", {"p_layer_code": layer_code})
    layer_stats = {"features": 0, "rings": 0, "points": 0, "areaSquareKm": 0.0}
    seen_features = set()

    for archive in archives:
        temporary, shp_path = extract_shape_archive(archive)
        try:
            with shapefile.Reader(str(shp_path), encoding="utf-8") as reader:
                field_names = [field[0] for field in reader.fields[1:]]
                for record_number, shape_record in enumerate(reader.iterShapeRecords(), start=1):
                    source_shape = shape_record.shape
                    if source_shape.shapeType == shapefile.NULL:
                        continue
                    properties = dict(zip(field_names, shape_record.record))
                    district_code = str(properties.get("SGG_CD", ""))
                    depth_code = str(properties.get("SEG_CODE", ""))
                    if district_code not in DISTRICT_NAMES or depth_code not in DEPTH_CLASSES:
                        raise RuntimeError(
                            f"Unexpected SHP classification in {archive.name}: "
                            f"SGG_CD={district_code}, SEG_CODE={depth_code}"
                        )
                    feature_id = f"{district_code}-{depth_code}"
                    if feature_id in seen_features:
                        feature_id = f"{feature_id}-{record_number}"
                    seen_features.add(feature_id)
                    import_key = f"{layer_code}:{feature_id}"

                    part_starts = list(source_shape.parts) + [len(source_shape.points)]
                    rings = [
                        source_shape.points[start:part_starts[index + 1]]
                        for index, start in enumerate(part_starts[:-1])
                    ]
                    outer_rings = [ring for ring in rings if len(ring) >= 4 and signed_ring_area(ring) < 0]
                    hole_rings = [ring for ring in rings if len(ring) >= 4 and signed_ring_area(ring) > 0]
                    zero_rings = [ring for ring in rings if len(ring) >= 4 and signed_ring_area(ring) == 0]
                    outer_rings.extend(zero_rings)
                    if not outer_rings:
                        raise RuntimeError(f"No outer rings found for {import_key}")

                    depth_label, depth_m = DEPTH_CLASSES[depth_code]
                    frequency = int(properties.get("FLDLV_FREQ") or 100)
                    feature_area = 0.0
                    part_count = 0
                    for is_hole, selected_rings in ((False, outer_rings), (True, hole_rings)):
                        for part_number, batch in enumerate(batch_rings(selected_rings, max_points), start=1):
                            part_count += 1
                            part_id = f"{feature_id}-{'h' if is_hole else 'o'}-{part_number:04d}"
                            result = rpc.call(
                                "insert_flood_scenario_part",
                                {
                                    "p_layer_code": layer_code,
                                    "p_source_group_id": feature_id,
                                    "p_source_feature_id": part_id,
                                    "p_is_hole": is_hole,
                                    "p_frequency_years": frequency,
                                    "p_district_code": district_code,
                                    "p_district_name": DISTRICT_NAMES[district_code],
                                    "p_depth_code": depth_code,
                                    "p_depth_label": depth_label,
                                    "p_depth_m": depth_m,
                                    "p_geometry": {
                                        "type": "MultiPolygon",
                                        "coordinates": [[ring] for ring in batch],
                                    },
                                    "p_source_srid": 5186,
                                    "p_raw": {
                                        "sourceArchive": archive.name,
                                        "sourceCrs": "EPSG:5186",
                                        "sourceProperties": properties,
                                    },
                                },
                            )
                            if result.get("inserted"):
                                signed_area = float(result["areaSquareKm"])
                                feature_area += -signed_area if is_hole else signed_area
                    layer_stats["features"] += 1
                    layer_stats["rings"] += len(rings)
                    layer_stats["points"] += len(source_shape.points)
                    layer_stats["areaSquareKm"] += feature_area
                    print(
                        json.dumps(
                            {
                                "layer": layer_code,
                                "feature": feature_id,
                                "featuresComplete": layer_stats["features"],
                                "partCount": part_count,
                                "areaSquareKm": round(feature_area, 6),
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
        finally:
            temporary.cleanup()

    layer_stats["areaSquareKm"] = round(layer_stats["areaSquareKm"], 6)
    return layer_stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--downloads-root", type=Path, default=Path.home() / "Downloads")
    parser.add_argument("--max-points", type=int, default=12000)
    parser.add_argument(
        "--layers",
        nargs="+",
        choices=tuple(LAYER_PATHS),
        default=list(LAYER_PATHS),
        help="Layers to replace and import. Other previously loaded layers remain intact.",
    )
    parser.add_argument("--analyze-only", action="store_true")
    parser.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL"))
    args = parser.parse_args()
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not args.supabase_url or not service_key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")

    rpc = SupabaseRpc(args.supabase_url, service_key)
    all_stats = {}
    if not args.analyze_only:
        for layer_code in args.layers:
            folder_name, map_name = LAYER_PATHS[layer_code]
            source_dir = args.downloads_root / folder_name
            archives = sorted(source_dir.glob(f"*고양시*100년*{map_name}.zip"))
            if len(archives) != 3:
                raise RuntimeError(f"Expected three {layer_code} archives in {source_dir}; found {len(archives)}")
            all_stats[layer_code] = import_layer(rpc, layer_code, archives, args.max_points)

    analysis = rpc.call("calculate_flood_overlap_analysis")
    summary = rpc.call("get_flood_overlap_summary")
    print(json.dumps({"imports": all_stats, "analysis": analysis, "summary": summary}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
