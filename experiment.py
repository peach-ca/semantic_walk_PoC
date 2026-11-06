"""無名の場所を選べるかの比較実験

比べるもの:
  データの取り方  grounding … Gemini + Grounding with Google Maps
                  places    … Places API（Text Search）で周辺とレビューを集め、Gemini が選ぶ
  Gemini の呼び方 aistudio  … Gemini API（APIキー。Maps グラウンディングは有料枠のみ）
                  vertex    … Vertex AI（GCP プロジェクト。ハッカソンのクレジット）
  ターゲット      観光地（清水寺周辺）と、住宅街（--home-lat/--home-lon で指定）

結果は results/ に Markdown で保存する。
※ Places API のデータ（場所名・レビュー件数）を含むので、評価が終わったら削除し、
  結論だけを残すこと（Maps Platform の保存制限への配慮）。

使い方:
  uv run --env-file .env experiment.py --home-lat 35.0 --home-lon 135.0
  uv run --env-file .env experiment.py --backends vertex --methods grounding   # 一部だけ

必要な環境変数（.env）:
  GEMINI_API_KEY        … aistudio を使う場合
  GOOGLE_CLOUD_PROJECT  … vertex を使う場合（gcloud auth application-default login 済みであること）
  GOOGLE_CLOUD_LOCATION … vertex のリージョン（既定 global）
  MAPS_API_KEY          … places 方式と、レビュー件数の評価に使う（Places API (New) を有効化したキー）
  EXP_MODEL             … 既定 gemini-3.5-flash
  FAMOUS_THRESHOLD      … これ以上のレビュー件数を「有名」とみなす（既定 3000）
"""

import argparse
import datetime
import json
import math
import os
import re
import time

import requests
from google import genai
from google.genai import errors, types

MODEL = os.environ.get("EXP_MODEL", "gemini-3.5-flash")
MAPS_KEY = os.environ.get("MAPS_API_KEY")
FAMOUS = int(os.environ.get("FAMOUS_THRESHOLD", "3000"))
RADIUS = 1200  # m

TOURIST = {
    "name": "観光地（清水寺周辺）",
    "lat": 34.9949,
    "lon": 135.7850,
    "prompts": [
        "清水寺みたいな静けさを感じたい。でも混んでいない所で",
        "伏見稲荷みたいな非日常感を味わいたい。でも人が少ない所で",
    ],
}
HOME_PROMPTS = ["緑に触れたい", "懐かしい雰囲気を感じたい"]

# places 方式で周辺を見渡すための固定の検索語（概念に関係なく同じ）
INVENTORY_QUERIES = ["寺", "神社", "公園", "庭園", "喫茶店", "商店街", "史跡", "美術館"]

PICK_INSTRUCTION = """
次の形式の JSON だけを返して（コードブロックや説明文は付けない）:
{"interpretation": "この場所での希望の解釈（2文程度）",
 "picks": [{"name": "場所の正式な名前", "reason": "なぜ希望に合うかを一言"}]}
立ち寄り先は4〜6か所。誰もが知る有名観光地より、地元の人に親しまれている場所を優先する。
"""


# ---------- 共通 ----------

def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def make_client(backend: str):
    if backend == "aistudio":
        return genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    if backend == "vertex":
        return genai.Client(
            vertexai=True,
            project=os.environ["GOOGLE_CLOUD_PROJECT"],
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
        )
    raise ValueError(backend)


def generate(client, contents, config):
    """429/503 のみ回数制限付きで再試行する"""
    for attempt in range(4):
        try:
            return client.models.generate_content(model=MODEL, contents=contents, config=config)
        except (errors.ServerError, errors.ClientError) as e:
            if e.code not in (429, 503) or attempt == 3:
                raise
            wait = 5 * (attempt + 1)
            print(f"    {e.code}。{wait}秒後に再試行")
            time.sleep(wait)


def parse_json(text: str):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


# ---------- Places API ----------

_inventory_cache: dict = {}
_count_cache: dict = {}


def places_text_search(query, lat, lon):
    r = requests.post(
        "https://places.googleapis.com/v1/places:searchText",
        headers={
            "X-Goog-Api-Key": MAPS_KEY,
            "X-Goog-FieldMask": "places.id,places.displayName,places.primaryTypeDisplayName,"
                                "places.userRatingCount,places.location,places.reviews",
        },
        json={
            "textQuery": query,
            "languageCode": "ja",
            "pageSize": 20,
            "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon},
                                        "radius": float(RADIUS)}},
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("places", [])


def inventory(lat, lon):
    """周辺の場所を固定の検索語で集める（同じ地点はメモリ上で使い回す）"""
    key = (lat, lon)
    if key in _inventory_cache:
        return _inventory_cache[key]
    seen = {}
    for q in INVENTORY_QUERIES:
        for p in places_text_search(q, lat, lon):
            loc = p.get("location", {})
            if "latitude" not in loc:
                continue
            if haversine_m(lat, lon, loc["latitude"], loc["longitude"]) > RADIUS or p["id"] in seen:
                continue
            reviews = [((rv.get("text") or {}).get("text") or "")[:120]
                       for rv in (p.get("reviews") or [])[:2]]
            seen[p["id"]] = {
                "place_id": p["id"],
                "name": p["displayName"]["text"],
                "type": (p.get("primaryTypeDisplayName") or {}).get("text", ""),
                "count": p.get("userRatingCount", 0),
                "reviews": reviews,
            }
            _count_cache[p["id"]] = p.get("userRatingCount", 0)
    _inventory_cache[key] = list(seen.values())
    return _inventory_cache[key]


def _norm(s: str) -> str:
    return re.sub(r"\s", "", s or "")


def resolve_place(name, lat, lon):
    """選ばれた場所の名前を Places API で検索し、実在を確かめる。
    戻り値: (place_id, 実在したか)。キーがなければ (None, None)"""
    if not MAPS_KEY or not name:
        return None, None
    try:
        r = requests.post(
            "https://places.googleapis.com/v1/places:searchText",
            headers={"X-Goog-Api-Key": MAPS_KEY,
                     "X-Goog-FieldMask": "places.id,places.displayName,places.userRatingCount,places.location"},
            json={"textQuery": name, "languageCode": "ja", "pageSize": 3,
                  "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon},
                                              "radius": 3000.0}}},
            timeout=30,
        )
        r.raise_for_status()
    except requests.RequestException:
        return None, None
    for p in r.json().get("places", []):
        dn = p["displayName"]["text"]
        loc = p.get("location", {})
        near = "latitude" in loc and haversine_m(lat, lon, loc["latitude"], loc["longitude"]) <= 3000
        if near and (_norm(name) in _norm(dn) or _norm(dn) in _norm(name)):
            _count_cache[p["id"]] = p.get("userRatingCount", 0)
            return p["id"], True
    return None, False


def rating_count(place_id):
    """評価用：レビュー件数を取得する（取れなければ None）"""
    if not place_id or not MAPS_KEY:
        return None
    pid = place_id.split("/")[-1]
    if pid in _count_cache:
        return _count_cache[pid]
    try:
        r = requests.get(
            f"https://places.googleapis.com/v1/places/{pid}",
            headers={"X-Goog-Api-Key": MAPS_KEY, "X-Goog-FieldMask": "userRatingCount"},
            timeout=30,
        )
        r.raise_for_status()
        _count_cache[pid] = r.json().get("userRatingCount", 0)
    except requests.RequestException:
        _count_cache[pid] = None
    return _count_cache[pid]


# ---------- 方式A：Maps グラウンディング ----------

def run_grounding(client, lat, lon, prompt):
    contents = (
        "出発地の徒歩圏（半径1km程度）で、散歩しながら次の希望を満たせる場所を選んで。"
        "Google マップのレビューから読み取れる雰囲気を根拠にすること。\n"
        f"希望: {prompt}\n{PICK_INSTRUCTION}"
    )
    config = types.GenerateContentConfig(
        tools=[types.Tool(google_maps=types.GoogleMaps())],
        tool_config=types.ToolConfig(retrieval_config=types.RetrievalConfig(
            lat_lng=types.LatLng(latitude=lat, longitude=lon))),
        temperature=0.4,
    )
    res = generate(client, contents, config)
    data = parse_json(res.text) or {}

    chunks = []
    gm = res.candidates[0].grounding_metadata if res.candidates else None
    for ch in (gm.grounding_chunks or []) if gm else []:
        if getattr(ch, "maps", None):
            chunks.append({"title": ch.maps.title or "",
                           "place_id": getattr(ch.maps, "place_id", None)})

    picks = []
    for p in data.get("picks", []):
        name = p.get("name", "")
        match = next((c for c in chunks if c["title"] and
                      (_norm(c["title"]) in _norm(name) or _norm(name) in _norm(c["title"]))), None)
        picks.append({**p, "place_id": match["place_id"] if match else None,
                      "in_source": match is not None})
    titles = "、".join(c["title"] for c in chunks[:8])
    return data.get("interpretation", ""), picks, f"Gemini が参照した場所 {len(chunks)} 件（{titles}）"


# ---------- 方式B：Places API + Gemini ----------

def run_places(client, lat, lon, prompt):
    inv = inventory(lat, lon)
    listing = [{"name": x["name"], "type": x["type"], "review_count": x["count"],
                "reviews": x["reviews"]} for x in inv]
    contents = (
        "以下は出発地の周辺に実在する場所の一覧（名前、種類、レビュー件数、レビューの抜粋）。"
        "この中から、散歩しながら次の希望を満たせる場所を選んで。"
        "レビューから読み取れる雰囲気を根拠にすること。\n"
        f"希望: {prompt}\n{PICK_INSTRUCTION}\n"
        f"{json.dumps(listing, ensure_ascii=False)}"
    )
    config = types.GenerateContentConfig(response_mime_type="application/json", temperature=0.4)
    res = generate(client, contents, config)
    data = parse_json(res.text) or {}
    by_name = {x["name"]: x for x in inv}
    picks = [{**p, "place_id": by_name.get(p.get("name"), {}).get("place_id"),
              "in_source": p.get("name") in by_name} for p in data.get("picks", [])]
    return data.get("interpretation", ""), picks, f"候補 {len(inv)} 件"


METHODS = {"grounding": run_grounding, "places": run_places}


# ---------- 実行と記録 ----------

def run_case(backend, method, area, prompt):
    row = {"backend": backend, "method": method, "area": area["name"], "prompt": prompt}
    t = time.time()
    try:
        client = make_client(backend)
        interp, picks, note = METHODS[method](client, area["lat"], area["lon"], prompt)
        for p in picks:
            if p.get("place_id"):
                p["exists"] = True
            else:
                p["place_id"], p["exists"] = resolve_place(p.get("name"), area["lat"], area["lon"])
            p["count"] = rating_count(p.get("place_id"))
            p["famous"] = p["count"] is not None and p["count"] >= FAMOUS
        row.update(ok=True, interpretation=interp, picks=picks, note=note)
    except Exception as e:  # 使えるかどうかの確認も目的なので、失敗も結果として残す
        row.update(ok=False, error=f"{type(e).__name__}: {str(e)[:300]}")
    row["seconds"] = round(time.time() - t, 1)
    return row


def summarize(row):
    if not row["ok"]:
        return "失敗", "-", "-", "-"
    picks = row["picks"]
    matched = sum(1 for p in picks if p.get("exists"))
    unknown = sum(1 for p in picks if p["count"] is not None and not p["famous"])
    return str(len(picks)), str(matched), str(unknown), f"{row['seconds']}秒"


def write_report(rows, path):
    lines = [f"# 実験結果 {datetime.datetime.now():%Y-%m-%d %H:%M}", "",
             f"- モデル: {MODEL}",
             f"- 有名の基準: レビュー {FAMOUS} 件以上",
             "- 「実在」= 選ばれた名前で Places API を検索し、出発地から3km以内に同名の場所が見つかった数",
             "- 「有名でない」= レビュー件数が取得でき、基準未満だった数",
             "", "## 一覧", "",
             "| 呼び方 | 方式 | 場所 | 希望 | 選定数 | 実在 | 有名でない | 時間 |",
             "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        n, m, u, s = summarize(r)
        lines.append(f"| {r['backend']} | {r['method']} | {r['area']} | {r['prompt']} | {n} | {m} | {u} | {s} |")

    lines += ["", "## 詳細", ""]
    for r in rows:
        lines.append(f"### {r['backend']} / {r['method']} / {r['area']} / {r['prompt']}")
        if not r["ok"]:
            lines += ["", f"**失敗**: `{r['error']}`", ""]
            continue
        lines += ["", f"- {r['note']}、{r['seconds']}秒", f"- 解釈: {r['interpretation']}", "",
                  "| 場所 | レビュー件数 | 有名 | 実在 | 参照元と一致 | 理由 | 人の評価(1-3) |",
                  "|---|---|---|---|---|---|---|"]
        for p in r["picks"]:
            cnt = "-" if p["count"] is None else p["count"]
            exists = {True: "○", False: "×", None: "未確認"}[p.get("exists")]
            lines.append(f"| {p.get('name','')} | {cnt} | {'○' if p['famous'] else ''} | "
                         f"{exists} | {'○' if p.get('in_source') else '×'} | {p.get('reason','')} | |")
        lines.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home-lat", type=float)
    ap.add_argument("--home-lon", type=float)
    ap.add_argument("--backends", default="aistudio,vertex")
    ap.add_argument("--methods", default="grounding,places")
    args = ap.parse_args()

    areas = [TOURIST]
    if args.home_lat is not None and args.home_lon is not None:
        areas.append({"name": "住宅街", "lat": args.home_lat, "lon": args.home_lon,
                      "prompts": HOME_PROMPTS})
    else:
        print("住宅街の座標が未指定なので、観光地のみで実験します")

    methods = args.methods.split(",")
    if "places" in methods and not MAPS_KEY:
        print("MAPS_API_KEY がないので places 方式はスキップします")
        methods.remove("places")

    rows = []
    for backend in args.backends.split(","):
        for method in methods:
            for area in areas:
                for prompt in area["prompts"]:
                    print(f"[{backend} / {method}] {area['name']}：{prompt}")
                    row = run_case(backend, method, area, prompt)
                    print("  " + (f"{summarize(row)}" if row["ok"] else row["error"]))
                    rows.append(row)

    os.makedirs("results", exist_ok=True)
    path = f"results/exp_{datetime.datetime.now():%Y%m%d_%H%M}.md"
    write_report(rows, path)
    print(f"\n保存しました: {path}")


if __name__ == "__main__":
    main()