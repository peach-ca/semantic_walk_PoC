"""OSM の XML から、サーバーが読む api/data/places.json を作る。

使い方:
    uv run --env-file .env python scripts/build_osm_json.py
    （OSM_FILE 未設定なら data/area_poi.osm を読む）
    川（waterway=river/stream/canal）は、線を RIVER_STEP_M おきの点に分けて「〇〇川（川沿い）」として加える。
    川は OSM_RIVER_FILE（未設定なら data/area.osm、なければ OSM_FILE）から読む。

できたファイルは .gitignore 済み。© OpenStreetMap contributors（ODbL）
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import osmnx as ox

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(os.environ.get("OSM_FILE", ROOT / "data" / "area_poi.osm"))
OUT = ROOT / "api" / "data" / "places.json"
RIVER_SRC = Path(os.environ.get("OSM_RIVER_FILE", ROOT / "data" / "area.osm"))
RIVER_STEP_M = 200
RIVER_TAGS = {"waterway": ["river", "stream", "canal"]}

TAGS = {
    "historic": True,
    "tourism": ["attraction", "museum", "gallery", "artwork", "viewpoint"],
    "amenity": ["cafe", "place_of_worship", "public_bath", "library", "theatre", "arts_centre",
                "marketplace", "fountain", "bar", "pub", "restaurant", "fast_food", "clock"],
    "leisure": ["park", "garden", "playground"],
    "man_made": ["bridge", "tower", "water_tower", "lighthouse"],
    "railway": ["station"],
    "natural": ["water", "tree_row", "wood"],
    "craft": True,
    "shop": True,
}
KIND_KEYS = list(TAGS)


def main() -> None:
    if not SRC.is_absolute():
        src = ROOT / SRC
    else:
        src = SRC
    if not src.exists():
        sys.exit(f"{src} がありません（get_osm.sh で作ってください）")

    gdf = ox.features_from_xml(src, tags=TAGS)
    out, seen = [], set()
    for (element, osmid), row in gdf.iterrows():
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        key = value = None
        for k in KIND_KEYS:
            v = row.get(k)
            if isinstance(v, str) and v:
                if TAGS[k] is True or v in TAGS[k]:
                    key, value = k, v
                    break
        if key is None:
            continue
        pt = row.geometry.representative_point() if row.geometry.geom_type != "Point" else row.geometry
        pid = f"osm:{element}/{osmid}"
        if pid in seen:
            continue
        seen.add(pid)
        out.append({"id": pid, "name": name.strip(), "key": key, "value": value,
                    "lat": round(pt.y, 6), "lon": round(pt.x, 6)})

    rivers = river_points(RIVER_SRC if RIVER_SRC.exists() else src)
    out.extend(r for r in rivers if r["id"] not in seen)
    print(f"川沿いの点: {len(rivers)} 件")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"{len(out)} 件 → {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.1f} MB)")


def river_points(src: Path) -> list[dict]:
    """名前のある川の線を、RIVER_STEP_M おきの点に分ける（目的地・寄り道の候補にするため）。"""
    try:
        gdf = ox.features_from_xml(src, tags=RIVER_TAGS)
    except Exception as e:  # noqa: BLE001  川が1本もないファイルなど
        print(f"川を読めませんでした（{e}）")
        return []
    gdf = gdf[gdf["name"].notna() & gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    if gdf.empty:
        return []
    utm = gdf.estimate_utm_crs()
    proj = gdf.to_crs(utm)
    pts: list[dict] = []
    for (element, osmid), row in proj.iterrows():
        line = row.geometry
        n = max(1, int(line.length // RIVER_STEP_M))
        for k in range(n + 1):
            pt = line.interpolate(min(k * RIVER_STEP_M, line.length))
            pts.append({"id": f"osm:{element}/{osmid}#{k}", "name": f"{row['name']}（川沿い）",
                        "key": "waterway", "value": row["waterway"], "_x": pt.x, "_y": pt.y})
    if not pts:
        return []
    import geopandas as gpd
    from shapely.geometry import Point
    g = gpd.GeoDataFrame(pts, geometry=[Point(p["_x"], p["_y"]) for p in pts], crs=utm).to_crs(4326)
    return [{"id": r["id"], "name": r["name"], "key": r["key"], "value": r["value"],
             "lat": round(r.geometry.y, 6), "lon": round(r.geometry.x, 6)} for _, r in g.iterrows()]


if __name__ == "__main__":
    main()
