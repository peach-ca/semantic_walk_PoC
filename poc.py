"""概念散歩ルート PoC（ローカル実行）

周辺に実在する場所を先に集め、その中で概念を解釈して立ち寄り先を選ぶ。
1. OpenStreetMap から周辺の名前付きの場所を幅広く集める（場所ごとに固定の問い合わせ → キャッシュが効く）
2. 種類ごとに件数を抑えて偏りをなくす
3. Gemini が「この街ならではの概念の感じ方」を解釈し、合う場所を選んで理由を付ける（呼び出しは1回）
4. 選ばれた地点を徒歩で回る周回ルートを作る
5. 地図 HTML に出力する

使い方:
  uv run --env-file .env poc.py --concept ノスタルジー --lat 35.0 --lon 135.0 --minutes 45
"""

import argparse
import json
import math
import os
import sys
import time
from functools import lru_cache

import folium
import networkx as nx
import osmnx as ox
from google import genai
from google.genai import errors, types
from osmnx._errors import InsufficientResponseError
from pydantic import BaseModel

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
# 503（混雑）や 429（回数制限）のときに順に試すモデル。先頭が第一候補
MODELS = list(dict.fromkeys([
    MODEL,
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
]))

WALK_KMH = 4.8
PER_KIND = 6        # 1種類あたりの上限（飲食店などで埋め尽くされないように）
MAX_INVENTORY = 150  # Gemini に渡す最大件数

# Overpass（OSM のデータ取得）の公開サーバー。混雑していたら次を試す
OVERPASS_URLS = [
    "https://overpass-api.de/api",
    "https://maps.mail.ru/osm/tools/overpass/api",
    "https://overpass.kumi.systems/api",
]
ox.settings.overpass_rate_limit = False  # サーバー状態の確認による待機をしない
ox.settings.requests_timeout = 30

# ローカルの OSM ファイル（get_osm.sh で作成）。指定があればサーバーに問い合わせない
OSM_FILE = os.environ.get("OSM_FILE")            # 周辺の場所用（全データ）
OSM_WALK_FILE = os.environ.get("OSM_WALK_FILE")  # 道路網用（highway のみ）

# 周辺を見渡すための固定のタグ。概念に関係なく毎回同じなのでキャッシュが効く
INVENTORY_TAGS = {
    "historic": True,
    "tourism": ["attraction", "museum", "gallery", "artwork", "viewpoint"],
    "amenity": ["cafe", "place_of_worship", "public_bath", "library", "theatre",
                "arts_centre", "marketplace", "fountain", "bar", "pub",
                "restaurant", "fast_food", "clock"],
    "leisure": ["park", "garden", "playground"],
    "man_made": ["bridge", "tower", "water_tower", "lighthouse"],
    "railway": ["station"],
    "natural": ["water", "tree_row", "wood"],
    "craft": True,
    "shop": True,
}
KIND_KEYS = ["historic", "tourism", "amenity", "leisure", "man_made",
             "railway", "natural", "craft", "shop"]


# 毎回geminiの最初のモデルはエラー492でおちる
# ---------- Gemini ----------

class Pick(BaseModel):
    id: int
    score: int  # 0-10
    reason: str


class Selection(BaseModel):
    interpretation: str  # この街での概念の解釈
    picks: list[Pick]


client = genai.Client()


def ask(prompt: str, schema):
    """JSON で回答させ、Python 側でスキーマ検証する。

    入れ子のスキーマを response_schema で渡すと 503 が続いたため、
    スキーマはプロンプトに書き、検証は pydantic で行う。
    503（混雑）や 429（回数制限）のときは別のモデルに切り替える。
    """
    full_prompt = (
        prompt
        + "\n\n次の JSON Schema に従う JSON だけを返して。説明文やコードブロックは付けない。\n"
        + json.dumps(schema.model_json_schema(), ensure_ascii=False)
    )
    last_error = None
    for round_ in range(3):
        for model in MODELS:
            try:
                res = client.models.generate_content(
                    model=model,
                    contents=full_prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.4,
                    ),
                )
                print(f"  使用モデル: {model}")
                return schema.model_validate_json(res.text)
            except (errors.ServerError, errors.ClientError) as e:
                if e.code not in (429, 503):
                    raise
                last_error = e
                print(f"  {model} が {e.code}。次のモデルを試します")
        time.sleep(3 * (round_ + 1))  # 全モデルが失敗したら少し待って一巡し直す
    raise last_error


# ---------- 1-2. 周辺の場所を集める ----------

def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def overpass_call(fn, *args, **kwargs):
    """Overpass のサーバーを順に試す。該当データなしの例外はそのまま投げる"""
    last_error = None
    for url in OVERPASS_URLS:
        ox.settings.overpass_url = url
        try:
            return fn(*args, **kwargs)
        except InsufficientResponseError:
            raise
        except Exception as e:
            last_error = e
            print(f"  Overpass {url} が応答しません。次のサーバーを試します")
    raise last_error


@lru_cache(maxsize=2)
def _local_features(path):
    """ローカルファイルの場所データ。一度読んだらプロセス内で使い回す"""
    print(f"  ローカルの OSM ファイルを読み込み中: {path}")
    return ox.features_from_xml(path, tags=INVENTORY_TAGS)


@lru_cache(maxsize=2)
def _local_graph(path):
    """ローカルファイルの道路網。一度読んだらプロセス内で使い回す"""
    print(f"  ローカルの道路網を読み込み中: {path}")
    return ox.graph_from_xml(path, bidirectional=True, simplify=True)


def fetch_inventory(lat, lon, radius) -> list[dict]:
    """周辺の名前付きの場所を集め、種類ごとに近い順で上限まで残す"""
    try:
        if OSM_FILE:
            gdf = _local_features(OSM_FILE)
        else:
            gdf = overpass_call(ox.features_from_point, (lat, lon), tags=INVENTORY_TAGS, dist=radius)
    except InsufficientResponseError:
        print("  周辺に名前付きの場所が見つかりませんでした")
        return []

    seen, items = set(), []
    for _, row in gdf.iterrows():
        name = row.get("name")
        if not isinstance(name, str) or name in seen:
            continue
        kind = None
        for key in KIND_KEYS:
            v = row.get(key)
            if isinstance(v, str):
                kind = f"{key}={v}"
                break
        if kind is None:
            continue
        pt = row.geometry.representative_point()
        dist = haversine_m(lat, lon, pt.y, pt.x)
        if dist > radius:  # ローカルファイルは広めに切り出しているので半径で絞る
            continue
        seen.add(name)
        items.append({
            "name": name,
            "kind": kind,
            "lat": pt.y,
            "lon": pt.x,
            "dist": dist,
        })

    items.sort(key=lambda it: it["dist"])
    counts, picked = {}, []
    for it in items:
        n = counts.get(it["kind"], 0)
        if n < PER_KIND:
            picked.append(it)
            counts[it["kind"]] = n + 1
    picked = picked[:MAX_INVENTORY]
    for i, it in enumerate(picked):
        it["id"] = i
    return picked


# ---------- 3. 概念を解釈して選ぶ ----------

def choose_places(concept: str, inventory: list[dict]):
    listing = [{"id": it["id"], "name": it["name"], "kind": it["kind"]} for it in inventory]
    prompt = f"""散歩で「{concept}」という概念を感じたい人がいる。
以下は出発地の周辺に実在する場所の一覧（名前と OpenStreetMap の種類）。

1. 一覧を眺めて、この街ならではの「{concept}」の感じ方を2〜3文で解釈して（interpretation）。
   定番の連想を押し付けず、この街に実際にあるものから考える。
2. その解釈に合う場所を最大8か所選び、0〜10で合致度を付け、
   なぜそう感じられるかを日本語で一言書いて（picks）。チェーン店らしいものは選ばない。

{json.dumps(listing, ensure_ascii=False)}
"""
    sel = ask(prompt, Selection)
    by_id = {it["id"]: it for it in inventory}
    ranked = []
    for p in sorted(sel.picks, key=lambda p: p.score, reverse=True):
        it = by_id.get(p.id)
        if it:
            ranked.append({**it, "score": p.score, "reason": p.reason})
    return sel.interpretation, ranked


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
    if OSM_WALK_FILE:
        G = _local_graph(OSM_WALK_FILE)
    else:
        G = overpass_call(ox.graph_from_point, (lat, lon), dist=radius + 300, network_type="walk")
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


def search_radius(minutes: int) -> int:
    max_m = minutes / 60 * WALK_KMH * 1000
    return int(min(max(max_m / 3, 400), 1500))


# ---------- 5. 地図出力（CLI 用） ----------

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
    radius = search_radius(args.minutes)

    print(f"[1/3] 半径{radius}mの周辺の場所を取得中")
    inventory = fetch_inventory(args.lat, args.lon, radius)
    print(f"  {len(inventory)} 件")
    if not inventory:
        sys.exit("周辺の場所がありません。出発地を変えて試してください。")

    print(f"[2/3] この街での「{args.concept}」を解釈して場所を選択中")
    interpretation, ranked = choose_places(args.concept, inventory)
    print(f"  解釈: {interpretation}")
    for c in ranked:
        print(f"  {c['score']:>2}  {c['name']}（{c['kind']}） - {c['reason']}")
    stops = [c for c in ranked if c["score"] >= 5]
    if not stops:
        sys.exit("合致度5以上の地点がありません。")

    print("[3/3] 徒歩ルートを計算中")
    start, order, total, coords = plan_route(args.lat, args.lon, radius, stops, max_m)
    out = f"route_{args.concept}.html"
    render(args.concept, start, order, coords, total, out)
    print(f"完了: {out}（{len(order)}地点・約{total / 1000:.1f}km）")


if __name__ == "__main__":
    main()
