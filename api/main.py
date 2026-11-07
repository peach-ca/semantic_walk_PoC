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
import re
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import osm_data, places_check, route, selector
from .llm import LLMError
from .safety import BLOCK_MESSAGE, JST, RateLimiter, decide, is_crisis, static_ok

log = logging.getLogger("walk")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="walk api")
# /api/route は Places（有料）を呼ぶので厳しめ。上限は環境変数で変えられる
clarify_limiter = RateLimiter(per_ip_per_hour=20, global_per_day=200)
route_limiter = RateLimiter(per_ip_per_hour=int(os.environ.get("ROUTE_PER_IP_HOUR", "6")),
                            global_per_day=int(os.environ.get("ROUTE_DAILY_LIMIT", "30")))
MAX_VERIFY = 8  # Places で確認する場所の上限（1ルートあたりの呼び出し回数の上限）

ATTRIBUTIONS = ["© OpenStreetMap contributors"]
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
    mood: str = Field(min_length=1, max_length=100)


class RouteReq(BaseModel):
    mood: str = Field(min_length=1, max_length=100)
    preference: str | None = Field(default=None, max_length=60)
    crowd: Literal["avoid", "neutral", "ok"] = "neutral"
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    minutes: int = Field(default=60, ge=15, le=120)
    exclude_ids: list[str] = Field(default_factory=list, max_length=50)
    include_ids: list[str] = Field(default_factory=list, max_length=5)


# ---------- エンドポイント ----------
@app.get("/api/health")
def health():
    return {"ok": True, "places": len(osm_data.all_places())}


@app.post("/api/clarify")
def clarify(body: ClarifyReq, req: Request):
    if is_crisis(body.mood):
        return {"question": "", "options": [], "blocked": True, "message": BLOCK_MESSAGE}
    if (r := check_limit(req, clarify_limiter)) is not None:
        return r
    try:
        c = selector.clarify(body.mood)
    except LLMError as e:
        log.warning("clarify failed: %s", e)
        return err(503, "いま考えるのに時間がかかっています。少ししてからもう一度お願いします")
    return {"question": c.question, "options": [o.model_dump() for o in c.options], "blocked": False}


@app.post("/api/route")
def make_route(body: RouteReq, req: Request):
    if is_crisis(body.mood) or (body.preference and is_crisis(body.preference)):
        return {"blocked": True, "message": BLOCK_MESSAGE, "places": []}
    if (r := check_limit(req, route_limiter)) is not None:
        return r

    t0 = time.time()
    start = (body.lat, body.lon)
    radius = route.search_radius(body.minutes)
    exclude = set(body.exclude_ids)

    candidates = osm_data.inventory(body.lat, body.lon, radius, exclude | set(body.include_ids))
    if len(candidates) < 3:
        return err(404, "この近くには、まだ案内できる場所のデータがありません")

    # 1) Gemini が OSM の候補から選ぶ
    try:
        sel = selector.select(body.mood, body.preference, body.crowd, candidates)
    except LLMError as e:
        log.warning("select failed: %s", e)
        return err(503, "いま考えるのに時間がかかっています。少ししてからもう一度お願いします")
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
        rt = route.compute(start, ordered)
    except Exception as e:  # noqa: BLE001
        log.warning("routes failed: %s", e)
        return err(502, "歩くルートを作れませんでした。もう一度お願いします")
    t3 = time.time()
    log.info("route: select %.1fs / places %.1fs (%d calls) / routes %.1fs, picked %d → kept %d, %d min",
             t1 - t0, t2 - t1, calls, t3 - t2, len(picked), len(ordered), rt["total_minutes"])

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
        "distance_m": rt["distance_m"],
        "sources": SOURCES,
        "attributions": ATTRIBUTIONS,
        "blocked": False,
    }


# ---------- 記録（Firestore） ----------
# ユーザーの区別は、ブラウザが作るランダムな ID（ヘッダー X-Device-Id、UUID）。ログインはない。
# 出発地の座標とルートの線は受け取らない・保存しない。
from fastapi import Header  # noqa: E402

from . import store  # noqa: E402

DEVICE_RE = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
ID_RE = r"^[A-Za-z0-9]{1,40}$"
write_limiter = RateLimiter(per_ip_per_hour=120, global_per_day=3000)


class WalkReq(BaseModel):
    mood: str = Field(min_length=1, max_length=100)
    preference: str | None = Field(default=None, max_length=60)
    crowd: Literal["avoid", "neutral", "ok"] = "neutral"
    minutes: int = Field(ge=15, le=120)
    total_minutes: int | None = Field(default=None, ge=0, le=300)
    place_ids: list[str] = Field(min_length=1, max_length=12)


class VisitReq(BaseModel):
    place_id: str = Field(max_length=60)
    rating: int | None = Field(default=None, ge=1, le=5)


class CommentReq(BaseModel):
    place_id: str = Field(max_length=60)
    text: str = Field(min_length=1, max_length=200)
    walk_id: str | None = Field(default=None, pattern=ID_RE)


Device = Header(alias="X-Device-Id", pattern=DEVICE_RE)


def _store_call(req: Request, fn, *args, write: bool = True):
    if write and (r := check_limit(req, write_limiter)) is not None:
        return r
    try:
        return fn(*args)
    except store.NotFound as e:
        return err(404, str(e))
    except Exception as e:  # noqa: BLE001
        log.warning("store failed: %s", e)
        return err(503, "記録の保存先につながりませんでした。少ししてからもう一度お願いします")


@app.post("/api/walks")
def start_walk(body: WalkReq, req: Request, device: str = Device):
    """「歩きはじめる」を押したときに呼ぶ。散歩の記録を作り walk_id を返す。"""
    return _store_call(req, store.create_walk, device, body.mood, body.preference, body.crowd,
                       body.minutes, body.total_minutes, body.place_ids)


@app.post("/api/walks/{walk_id}/visits")
def visit(walk_id: str, body: VisitReq, req: Request, device: str = Device):
    """「着いた」を押したとき（rating なし）、評価を選んだとき（rating 1〜5）に呼ぶ。"""
    if not re.fullmatch(ID_RE, walk_id):
        return err(400, "walk_id の形が正しくありません")
    return _store_call(req, store.add_visit, device, walk_id, body.place_id, body.rating)


@app.post("/api/walks/{walk_id}/finish")
def finish(walk_id: str, req: Request, device: str = Device):
    if not re.fullmatch(ID_RE, walk_id):
        return err(400, "walk_id の形が正しくありません")
    return _store_call(req, store.finish_walk, device, walk_id)


@app.get("/api/walks")
def walks(req: Request, device: str = Device):
    """これまでの散歩（新しい順に20件）と、それぞれの場所に着いた日時・評価。"""
    r = _store_call(req, store.list_walks, device, write=False)
    return r if isinstance(r, JSONResponse) else {"walks": r}


@app.post("/api/comments")
def add_comment(body: CommentReq, req: Request, device: str = Device):
    """その場所についての自分用メモ。本人にしか見えない。"""
    if is_crisis(body.text):
        return {"blocked": True, "message": BLOCK_MESSAGE}
    r = _store_call(req, store.add_comment, device, body.place_id, body.text, body.walk_id)
    return r if isinstance(r, JSONResponse) else {**r, "blocked": False}


@app.get("/api/comments")
def place_history(place_id: str, req: Request, device: str = Device):
    """その場所についての自分のメモと、訪れた日時。"""
    return _store_call(req, store.place_history, device, place_id, write=False)


@app.delete("/api/comments/{comment_id}")
def delete_comment(comment_id: str, req: Request, device: str = Device):
    if not re.fullmatch(ID_RE, comment_id):
        return err(400, "comment_id の形が正しくありません")
    r = _store_call(req, store.delete_comment, device, comment_id)
    return r if isinstance(r, JSONResponse) else {"deleted": True}


@app.delete("/api/me")
def delete_me(req: Request, device: str = Device):
    """このブラウザの記録をすべて消す。"""
    r = _store_call(req, store.delete_all, device)
    return r if isinstance(r, JSONResponse) else {"deleted": True}


# ---------- 画面（web/ があれば同じサーバーで配る） ----------
WEB = Path(__file__).resolve().parent.parent / "web"
if WEB.is_dir():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
