"""概念散歩ルート PoC（ローカル実行）

概念（例: ノスタルジー）と出発地を入れると、
1. Gemini が概念を「具体的な風景の特徴」と OSM タグに展開し
2. OpenStreetMap から近くの候補地を集め
3. Gemini が各候補を概念との合致度で採点し
4. 上位の地点を徒歩で回る周回ルートを作り
5. 地図 HTML に出力する

使い方:
  export GEMINI_API_KEY=...
  uv run poc.py --concept ノスタルジー --lat 35.0 --lon 135.0 --minutes 45
"""

import argparse
import json
import math
import os
import sys

import folium
import networkx as nx
import osmnx as ox
from google import genai
from google.genai import types
from pydantic import BaseModel

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
WALK_KMH = 4.8
MAX_CANDIDATES = 60
TOP_K = 6


# ---------- Gemini の出力スキーマ ----------

class OsmTag(BaseModel):
    key: str
    value: str  # "*" は値を問わない
    why: str


class Expansion(BaseModel):
    features: list[str]  # 概念を感じられる具体的な風景の特徴
    tags: list[OsmTag]


class Score(BaseModel):
    id: int
    score: int  # 0-10
    reason: str


class Scores(BaseModel):
    items: list[Score]


client = genai.Client()


def ask(prompt: str, schema):
    res = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0.4,
        ),
    )
    return res.parsed


# ---------- 1. 概念の展開 ----------

def expand_concept(concept: str) -> Expansion:
    prompt = f"""散歩で「{concept}」という概念を感じたい人がいる。
1. この概念を感じられる具体的な風景や場所の特徴を5〜8個挙げて。
2. それらに当てはまる場所を OpenStreetMap で探すためのタグを最大8個挙げて。
   - key は amenity, shop, historic, tourism, leisure, natural, man_made, craft など
   - value は具体的な値。値を問わない場合は "*"
   - building=* や highway=* のように広すぎるタグは使わない
   - why にはそのタグを選んだ理由を一言で書く
"""
    return ask(prompt, Expansion)


def to_osm_tags(tags: list[OsmTag]) -> dict:
    merged: dict = {}
    for t in tags:
        v = True if t.value == "*" else t.value
        if t.key not in merged:
            merged[t.key] = v
            continue
        cur = merged[t.key]
        if cur is True or v is True:
            merged[t.key] = True
        else:
            vals = cur if isinstance(cur, list) else [cur]
            merged[t.key] = sorted(set(vals + [v]))
    return merged


# ---------- 2. 候補地の収集 ----------

def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_candidates(lat, lon, radius, osm_tags) -> list[dict]:
    try:
        gdf = ox.features_from_point((lat, lon), tags=osm_tags, dist=radius)
    except Exception as e:  # 該当なしの場合も例外になる
        print(f"候補地が取得できませんでした: {e}")
        return []

    seen, cands = set(), []
    for _, row in gdf.iterrows():
        name = row.get("name")
        if not isinstance(name, str) or name in seen:
            continue
        seen.add(name)
        pt = row.geometry.representative_point()
        tag_info = {k: row[k] for k in osm_tags if k in row and isinstance(row[k], str)}
        cands.append({
            "name": name,
            "lat": pt.y,
            "lon": pt.x,
            "tags": tag_info,
            "dist": haversine_m(lat, lon, pt.y, pt.x),
        })
    cands.sort(key=lambda c: c["dist"])
    cands = cands[:MAX_CANDIDATES]
    for i, c in enumerate(cands):
        c["id"] = i
    return cands


# ---------- 3. 採点 ----------

def score_candidates(concept: str, features: list[str], cands: list[dict]) -> list[dict]:
    listing = [{"id": c["id"], "name": c["name"], "tags": c["tags"]} for c in cands]
    prompt = f"""散歩で「{concept}」を感じたい人のために、立ち寄り先を選んでいる。
この概念を感じられる風景の特徴: {", ".join(features)}

次の候補それぞれについて、名前とタグから「{concept}」をどれだけ感じられそうかを
0〜10で厳しめに採点し、理由を日本語で一言書いて。チェーン店らしいものは低くする。

{json.dumps(listing, ensure_ascii=False)}
"""
    scores = {s.id: s for s in ask(prompt, Scores).items}
    for c in cands:
        s = scores.get(c["id"])
        c["score"] = s.score if s else 0
        c["reason"] = s.reason if s else ""
    return sorted(cands, key=lambda c: c["score"], reverse=True)


# ---------- 4. 徒歩ルート ----------

def edge_len(G, a, b) -> float:
    return min(d["length"] for d in G.get_edge_data(a, b).values())


def greedy_order(start, stops):
    order, cur, rest = [], start, stops[:]
    while rest:
        nxt = min(rest, key=lambda s: haversine_m(cur["lat"], cur["lon"], s["lat"], s["lon"]))
        order.append(nxt)
        rest.remove(nxt)
        cur = nxt
    return order


def build_route(G, start, order):
    seq = [start] + order + [start]
    total, coords = 0.0, []
    for u, v in zip(seq, seq[1:]):
        path = nx.shortest_path(G, u["node"], v["node"], weight="length")
        total += sum(edge_len(G, a, b) for a, b in zip(path, path[1:]))
        coords += [(G.nodes[n]["y"], G.nodes[n]["x"]) for n in path]
    return total, coords


def plan_route(lat, lon, radius, stops, max_m):
    G = ox.graph_from_point((lat, lon), dist=radius + 300, network_type="walk")
    start = {"name": "出発地", "lat": lat, "lon": lon}
    pts = [start] + stops
    nodes = ox.distance.nearest_nodes(G, X=[p["lon"] for p in pts], Y=[p["lat"] for p in pts])
    for p, n in zip(pts, nodes):
        p["node"] = n

    stops = stops[:]
    while True:
        order = greedy_order(start, stops)
        try:
            total, coords = build_route(G, start, order)
        except nx.NetworkXNoPath:
            # たどり着けない地点を1つ外して再試行
            stops.remove(min(stops, key=lambda s: s["score"]))
            if not stops:
                return start, [], 0.0, []
            continue
        if total <= max_m or len(stops) <= 2:
            return start, order, total, coords
        stops.remove(min(stops, key=lambda s: s["score"]))


# ---------- 5. 地図出力 ----------

def render(concept, start, order, coords, total, out):
    m = folium.Map(location=[start["lat"], start["lon"]], zoom_start=16)
    folium.Marker(
        [start["lat"], start["lon"]], tooltip="出発地",
        icon=folium.Icon(color="gray", icon="home"),
    ).add_to(m)
    if coords:
        folium.PolyLine(coords, weight=5, opacity=0.7).add_to(m)
    for i, s in enumerate(order, 1):
        html = f"<b>{i}. {s['name']}</b><br>合致度 {s['score']}/10<br>{s['reason']}"
        folium.Marker(
            [s["lat"], s["lon"]], tooltip=f"{i}. {s['name']}",
            popup=folium.Popup(html, max_width=260),
        ).add_to(m)
    minutes = total / 1000 / WALK_KMH * 60
    title = f"「{concept}」を摂取する散歩 約{total / 1000:.1f}km・{minutes:.0f}分"
    m.get_root().html.add_child(folium.Element(
        f'<div style="position:fixed;top:10px;left:50px;z-index:9999;background:white;'
        f'padding:8px 12px;border-radius:6px;font-size:15px;">{title}</div>'
    ))
    m.save(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--concept", required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--minutes", type=int, default=45)
    args = ap.parse_args()

    max_m = args.minutes / 60 * WALK_KMH * 1000
    radius = int(min(max(max_m / 3, 400), 1500))

    print(f"[1/4] 概念を展開中: {args.concept}")
    exp = expand_concept(args.concept)
    print("  特徴:", " / ".join(exp.features))
    for t in exp.tags:
        print(f"  タグ: {t.key}={t.value}  ({t.why})")

    print(f"[2/4] 半径{radius}mの候補地を取得中")
    cands = fetch_candidates(args.lat, args.lon, radius, to_osm_tags(exp.tags))
    print(f"  候補 {len(cands)} 件")
    if not cands:
        sys.exit("候補地がありません。出発地か概念を変えて試してください。")

    print("[3/4] 合致度を採点中")
    ranked = score_candidates(args.concept, exp.features, cands)
    for c in ranked[:10]:
        print(f"  {c['score']:>2}  {c['name']}  - {c['reason']}")
    stops = [c for c in ranked[:TOP_K] if c["score"] >= 5]
    if not stops:
        sys.exit("合致度5以上の地点がありません。")

    print("[4/4] 徒歩ルートを計算中")
    start, order, total, coords = plan_route(args.lat, args.lon, radius, stops, max_m)
    out = f"route_{args.concept}.html"
    render(args.concept, start, order, coords, total, out)
    print(f"完了: {out}（{len(order)}地点・約{total / 1000:.1f}km）")


if __name__ == "__main__":
    main()