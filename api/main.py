"""散歩アプリのサーバー。

起動（ローカル）:
    uv run --env-file .env uvicorn api.main:app --reload --port 8080

流れ（/api/route）:
    OSM の候補 → Gemini が番号で選ぶ（一言ヒント付き）
    → Places API で実在・営業を確認（結果は Gemini に渡さない）
    → ルールで除外 → 時間に収まる順番を決める → Routes API で歩くルートを1回取る
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import fallback, osm_data, places_check, route, selector
from .llm import LLMError
from .safety import BLOCK_MESSAGE, JST, RateLimiter, decide, is_crisis, static_ok

log = logging.getLogger("walk")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="walk api")


from fastapi.exceptions import RequestValidationError  # noqa: E402


@app.exception_handler(RequestValidationError)
async def _invalid(_req, exc):
    log.info("invalid request: %s", exc.errors()[:3])
    return JSONResponse({"error": "入力の形が正しくありません。長すぎる入力がないか確認してください。"}, status_code=422)
# /api/route は Places（有料）を呼ぶので厳しめ。上限は環境変数で変えられる
clarify_limiter = RateLimiter(per_ip_per_hour=20, global_per_day=200)
route_limiter = RateLimiter(per_ip_per_hour=int(os.environ.get("ROUTE_PER_IP_HOUR", "6")),
                            global_per_day=int(os.environ.get("ROUTE_DAILY_LIMIT", "30")))
MAX_VERIFY = 8  # Places で確認する場所の上限（1ルートあたりの呼び出し回数の上限）

ATTRIBUTIONS = ["© OpenStreetMap contributors"]
# 画面は data.blocked.message を見る。古い形（data.message）でも読めるよう両方入れる
BLOCKED = {"blocked": {"message": BLOCK_MESSAGE}, "message": BLOCK_MESSAGE}
SOURCES = [{"title": "OpenStreetMap", "uri": "https://www.openstreetmap.org/copyright"}]


# ---------- 共通 ----------
def client_ip(req: Request) -> str:
    fwd = req.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return req.client.host if req.client else "unknown"


def err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


def check_limit(req: Request, limiter: RateLimiter) -> JSONResponse | None:
    ok, msg = limiter.allow(client_ip(req))
    return None if ok else err(429, msg or "混み合っています")


# ---------- モデル ----------
class ClarifyReq(BaseModel):
    mood: str = Field(min_length=1, max_length=200)


class RouteReq(BaseModel):
    mood: str = Field(min_length=1, max_length=200)
    preference: str | None = Field(default=None, max_length=200)
    crowd: Literal["avoid", "neutral", "ok"] = "neutral"
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    minutes: int = Field(default=60, ge=15, le=120)
    exclude_ids: list[str] = Field(default_factory=list, max_length=200)
    include_ids: list[str] = Field(default_factory=list, max_length=5)


# ---------- エンドポイント ----------
@app.get("/api/health")
def health():
    return {"ok": True, "places": len(osm_data.all_places())}


@app.post("/api/clarify")
def clarify(body: ClarifyReq, req: Request):
    if is_crisis(body.mood):
        return {"question": "", "options": [], **BLOCKED}
    if (r := check_limit(req, clarify_limiter)) is not None:
        return r
    try:
        c = selector.clarify(body.mood)
    except LLMError as e:
        # Gemini が使えないときは、決まった問いかけで先に進めるようにする
        log.warning("clarify failed, using fallback: %s", e)
        return {**fallback.CLARIFY, "blocked": False, "fallback": True}
    return {"question": c.question, "options": [o.model_dump() for o in c.options], "blocked": False}


@app.post("/api/route")
def make_route(body: RouteReq, req: Request):
    if is_crisis(body.mood) or (body.preference and is_crisis(body.preference)):
        return {"places": [], **BLOCKED}
    if (r := check_limit(req, route_limiter)) is not None:
        return r

    t0 = time.time()
    start = (body.lat, body.lon)
    radius = route.search_radius(body.minutes)
    exclude = set(body.exclude_ids)

    candidates = osm_data.inventory(body.lat, body.lon, radius, exclude | set(body.include_ids))
    if len(candidates) < 3:
        if osm_data.haversine(body.lat, body.lon, *osm_data.AREA_CENTER) > osm_data.AREA_RADIUS_M:
            return err(404, "この場所は対応エリアの外です。いまは京都市中心部（四条烏丸から約5km）だけに対応しています。"
                            "出発地を京都大学（緯度 35.0262・経度 135.7808）などにして試してください")
        return err(404, "この近くには候補になる場所が少ないため、ルートを作れませんでした。出発地を少し動かすか、時間を長くしてみてください")

    # 1) Gemini が OSM の候補から選ぶ（使えないときはルールで選ぶ）
    used_fallback = False
    try:
        sel = selector.select(body.mood, body.preference, body.crowd, candidates, minutes=body.minutes)
    except LLMError as e:
        log.warning("select failed, using fallback: %s", e)
        sel = fallback.select(body.mood, body.preference, candidates)
        used_fallback = True
    picked = [{**candidates[p.index], "hint": p.hint} for p in sel.picks]

    # ユーザーが「入れたい」と言った場所
    for pid in body.include_ids:
        p = osm_data.by_id(pid)
        if p:
            d = osm_data.haversine(body.lat, body.lon, p["lat"], p["lon"])
            picked.insert(0, {**p, "dist": round(d), "hint": "あなたが選んだ場所", "_must": True})
    t1 = time.time()

    # 2) Google に聞かずに外せるものを先に外す
    now = datetime.now(JST)
    pool = [p for p in picked if p.get("_must") or static_ok(p, body.crowd, now)]
    must = {p["id"] for p in pool if p.get("_must")}

    # 3) 時間に収まる順番を決め、回る場所だけ Places で確認。外れて時間が余ったら、残りの候補で埋め直す
    #    （Places の呼び出しは 1ルート最大 MAX_VERIFY 回）
    checked_on = places_check.enabled()
    verified: dict[str, dict] = {}   # id -> 残った場所（warning 付き）
    rejected: set[str] = set()
    calls = 0
    for _ in range(3):
        cands = [verified.get(p["id"], p) for p in pool if p["id"] not in rejected]
        ordered = route.order_and_fit(start, cands, body.minutes, set(must))
        todo = [p for p in ordered if p["id"] not in verified][: MAX_VERIFY - calls]
        if not todo:
            break
        googles = places_check.lookup_many(todo, [osm_data.category(p) == "shop" for p in todo])
        calls += len(todo) if checked_on else 0
        for p, g in zip(todo, googles):
            keep, warning = (True, None) if p.get("_must") else decide(p, g, body.crowd, now, checked_on)
            if keep:
                verified[p["id"]] = {**p, "_google": g, "warning": warning}
            else:
                rejected.add(p["id"])
    kept = route.order_and_fit(start, list(verified.values()), body.minutes, set(must))
    t2 = time.time()
    if not kept:
        return err(404, "いま開いていて行ける場所が見つかりませんでした。時間や気分を変えてみてください")

    # 4) Routes API（1回）
    ordered = kept
    try:
        rt = route.compute(start, ordered, body.minutes)
    except Exception as e:  # noqa: BLE001
        log.warning("routes failed: %s", e)
        return err(502, "歩くルートを作れませんでした。もう一度お願いします")
    t3 = time.time()
    log.info("route: select %.1fs / places %.1fs (%d calls) / routes %.1fs, picked %d → kept %d, %d min, overlap %s",
             t1 - t0, t2 - t1, calls, t3 - t2, len(picked), len(ordered), rt["total_minutes"], rt.get("overlap"))

    places = []
    for p in ordered:
        g = p["_google"] or {}
        places.append({
            "id": p["id"],
            "place_id": g.get("id"),
            "name": p["name"],
            "kind": osm_data.label(p),
            "lat": p["lat"],
            "lon": p["lon"],
            "hint": p["hint"],
            "warning": p["warning"],
            "maps_uri": g.get("googleMapsUri"),
        })
    return {
        "interpretation": sel.interpretation,
        "places": places,
        "polyline": rt["polyline"],
        "total_minutes": rt["total_minutes"],
        "walk_minutes": rt.get("walk_minutes"),
        "stay_minutes": rt.get("stay_minutes"),
        "legs": rt.get("legs", []),
        "distance_m": rt["distance_m"],
        "sources": SOURCES,
        "attributions": ATTRIBUTIONS,
        "blocked": False,
        "fallback": used_fallback,
    }


# ---------- 画面（web/ があれば同じサーバーで配る） ----------
WEB = Path(__file__).resolve().parent.parent / "web"
if WEB.is_dir():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
