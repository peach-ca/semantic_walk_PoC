"""方式C：Gemini は希望から検索語を作るだけ。場所の照合は Places API の検索に任せ、
有名すぎる場所はアプリで除外する（Gemini は Maps のデータを読まない）。
experiment.py に方式 search として追加して実行する。"""
import requests

import experiment as ex

QUERY_INSTRUCTION = """
次の形式の JSON だけを返して（コードブロックや説明文は付けない）:
{"interpretation": "希望の解釈（2文程度）",
 "queries": [{"query": "Googleマップで検索する語（日本語、短く）", "intent": "この検索語で探したいもの"}]}
検索語は3〜5個。固有の施設名や有名観光地の名前は使わず、
「静かな寺」「苔の庭」「路地裏の稲荷」のように、場所の種類と雰囲気を組み合わせる。
"""
state = {"summary": True}


def search_places(query, lat, lon):
    fields = ("places.id,places.displayName,places.primaryTypeDisplayName,"
              "places.userRatingCount,places.location")
    for _ in range(2):
        mask = fields + (",places.reviewSummary,places.generativeSummary" if state["summary"] else "")
        r = requests.post(
            "https://places.googleapis.com/v1/places:searchText",
            headers={"X-Goog-Api-Key": ex.MAPS_KEY, "X-Goog-FieldMask": mask},
            json={"textQuery": query, "languageCode": "ja", "pageSize": 10,
                  "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon},
                                              "radius": float(ex.RADIUS)}}},
            timeout=30,
        )
        if r.status_code == 400 and state["summary"]:
            state["summary"] = False  # 要約の項目が使えない環境では外して再試行
            continue
        r.raise_for_status()
        return r.json().get("places", [])
    return []


def google_summary(p):
    s = ((p.get("reviewSummary") or {}).get("text") or {}).get("text") \
        or ((p.get("generativeSummary") or {}).get("overview") or {}).get("text")
    return (s or "")[:120]


def run_search(client, lat, lon, prompt):
    contents = ("散歩で次の希望を満たせる場所を、Googleマップの検索で探したい。\n"
                f"希望: {prompt}\n{QUERY_INSTRUCTION}")
    res = ex.generate(client, contents,
                      ex.types.GenerateContentConfig(response_mime_type="application/json", temperature=0.4))
    data = ex.parse_json(res.text) or {}
    queries = data.get("queries", [])[:5]

    seen, buckets = set(), []
    for q in queries:
        qs = q.get("query", "")
        found = []
        for p in search_places(qs, lat, lon):
            loc = p.get("location", {})
            if "latitude" not in loc or p["id"] in seen:
                continue
            if ex.haversine_m(lat, lon, loc["latitude"], loc["longitude"]) > ex.RADIUS:
                continue
            count = p.get("userRatingCount", 0)
            if count >= ex.FAMOUS:  # 有名すぎる場所はアプリの処理で除外
                continue
            seen.add(p["id"])
            ex._count_cache[p["id"]] = count
            summary = google_summary(p)
            reason = f"「{qs}」で検索（{q.get('intent', '')}）"
            if summary:
                reason += f" / Googleの要約: {summary}"
            found.append({"name": p["displayName"]["text"], "place_id": p["id"],
                          "reason": reason, "in_source": True})
        buckets.append(found)

    picks, i = [], 0  # 検索語ごとに1件ずつ順番に取り、最大6件
    while len(picks) < 6 and any(i < len(b) for b in buckets):
        for b in buckets:
            if i < len(b) and len(picks) < 6:
                picks.append(b[i])
        i += 1
    note = "検索語: " + "、".join(q.get("query", "") for q in queries)
    note += "（Googleの要約: " + ("取得可" if state["summary"] else "取得不可") + "）"
    return data.get("interpretation", ""), picks, note


ex.METHODS["search"] = run_search

if __name__ == "__main__":
    ex.main()
