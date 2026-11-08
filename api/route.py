"""時間内に回れる順番を決めて、Routes API で歩くルートを1回だけ取る部分。"""
from __future__ import annotations

import math
import os

import requests

from .osm_data import haversine

WALK_M_PER_MIN = 70
DETOUR = 1.3  # 直線距離 → 道のりのおおよその倍率
STAY_MIN = 0  # 「〇分」は歩く時間。立ち寄った場所で過ごす時間は含めない
MIN_PER_STOP = 12  # 立ち寄りは「時間 ÷ 12分」か所まで（60分なら5か所）。歩く時間を主役にする
URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELDS = "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline"


def search_radius(minutes: int) -> float:
    """候補を集める半径（m）。出発地に戻る輪の形なので、歩ける距離の1/3程度。"""
    return min(max(minutes * WALK_M_PER_MIN / 3, 400), 1500)


def max_stops(minutes: int) -> int:
    return max(2, minutes // MIN_PER_STOP)


def _walk_min(a: tuple[float, float], b: tuple[float, float]) -> float:
    return haversine(a[0], a[1], b[0], b[1]) * DETOUR / WALK_M_PER_MIN


def loop_minutes(start: tuple[float, float], route: list[dict]) -> float:
    """出発地 → 場所たち → 出発地 の概算（歩く時間＋立ち寄り）。"""
    pts = [start] + [(p["lat"], p["lon"]) for p in route] + [start]
    return sum(_walk_min(a, b) for a, b in zip(pts, pts[1:])) + STAY_MIN * len(route)


def target_radius(minutes: int) -> float:
    """その時間で出発地に戻る輪を描くときの、出発地からのおおよその距離（m）。
    歩ける直線距離 ÷ (2 + π)（行き・帰りの2本と、半円ぶんの弧）。"""
    walk_min = max(minutes - STAY_MIN * max_stops(minutes), minutes * 0.4)
    return walk_min * WALK_M_PER_MIN / DETOUR / (2 + math.pi)


def _insert_cost(start, route, p) -> tuple[float, int]:
    """p を route のどこに入れると一番時間が増えないか（増える分, 位置）。"""
    pts = [start] + [(q["lat"], q["lon"]) for q in route] + [start]
    pos = (p["lat"], p["lon"])
    best = min(range(len(pts) - 1),
               key=lambda i: _walk_min(pts[i], pos) + _walk_min(pos, pts[i + 1]) - _walk_min(pts[i], pts[i + 1]))
    added = _walk_min(pts[best], pos) + _walk_min(pos, pts[best + 1]) - _walk_min(pts[best], pts[best + 1])
    return added + STAY_MIN, best


def order_and_fit(start: tuple[float, float], places: list[dict], minutes: int, must: set[str] | None = None) -> list[dict]:
    """出発地に戻る輪を、時間（minutes）を使い切るように作る。

    いちばん近い場所から順にたどると、出発地のまわりを小さく回って時間が余る。
    そこで、残りの時間を残りの立ち寄り枠で割った「1か所あたりの目安」に、
    差し込んだときの増える時間が一番近い場所を選んで、輪の一番よい位置に差し込んでいく。
    最後に、余った時間があれば、もっと時間を使う場所との入れ替えを試す。
    must（ユーザーが入れたい場所）は最初に入れる。"""
    must = set(must or set())
    rest = list(places)
    route: list[dict] = []
    limit = max_stops(minutes)

    def fits(p) -> tuple[float, int] | None:
        added, i = _insert_cost(start, route, p)
        return (added, i) if loop_minutes(start, route) + added <= minutes else None

    for p in [q for q in rest if q["id"] in must]:
        if (f := fits(p)) or not route:
            route.insert(f[1] if f else 0, p)
            rest.remove(p)

    while rest and len(route) < limit:
        left = minutes - loop_minutes(start, route)
        ideal = left / (limit - len(route))
        options = [(p, f) for p in rest if (f := fits(p))]
        if not options:
            break
        p, (added, i) = min(options, key=lambda o: abs(o[1][0] - ideal))
        route.insert(i, p)
        rest.remove(p)

    # 時間が余っていたら、1か所ずつ「もっと時間を使う場所」との入れ替えを試す（輪が広がる）
    for _ in range(len(route)):
        now = loop_minutes(start, route)
        best = None
        for j, old in enumerate(route):
            if old["id"] in must:
                continue
            base = route[:j] + route[j + 1:]
            for p in rest:
                added, i = _insert_cost(start, base, p)
                total = loop_minutes(start, base) + added
                if now < total <= minutes and (best is None or total > best[0]):
                    best = (total, j, i, p)
        if not best:
            break
        _, j, i, p = best
        old = route.pop(j)
        route.insert(i, p)
        rest.remove(p)
        rest.append(old)

    if not route and places:  # どれも時間に収まらないときは、一番近い1か所だけ
        route = [min(places, key=lambda q: _walk_min(start, (q["lat"], q["lon"])))]
    return route


def _ll(lat: float, lon: float) -> dict:
    return {"location": {"latLng": {"latitude": lat, "longitude": lon}}}


def compute(start: tuple[float, float], ordered: list[dict], minutes: int | None = None) -> dict:
    """出発地 → 場所たち → 出発地 の歩くルート。polyline と所要時間（分、滞在込み）を返す。

    行きと帰りで同じ道を通らないようにする:
      1. まず普通にルートを取り、実際の道で「前に通った道をもう一度通る割合」（overlap）を測る
      2. OVERLAP_LIMIT を超えていたら、重なっている区間の途中に「通過するだけの地点」（経由点）を
         重なりと反対側にずらして置き、もう一度取る（Routes API は2回まで）
      3. 重なりが減り、時間も指定の1.15倍以内なら、2回目を使う
    """
    key = os.environ.get("MAPS_API_KEY")
    if not key:
        return estimate(start, ordered)  # キーがない環境（相方の実験など）では直線距離で概算

    first = _request(key, start, ordered, vias={})
    best = first
    if first["overlap"] > OVERLAP_LIMIT and first["legs"]:
        vias = _detour_vias(start, ordered, first["legs"])
        if vias:
            try:
                second = _request(key, start, ordered, vias)
                limit = (minutes or 0) * 1.15
                if second["overlap"] < first["overlap"] and (not minutes or second["total_minutes"] <= limit):
                    best = second
            except RuntimeError:
                pass  # 2回目が失敗しても、1回目のルートで続ける
    best = dict(best)
    best.pop("legs", None)
    best["overlap"] = round(best["overlap"], 2)
    return best


OVERLAP_LIMIT = 0.2  # 道のりの2割以上が「同じ道をもう一度」なら、経由点で回り道させる
MAX_INTERMEDIATES = 10  # これを超えると Routes API の料金区分が上がる


def _request(key: str, start, ordered: list[dict], vias: dict[int, tuple[float, float]]) -> dict:
    """vias: {区間の番号: 経由点}。区間 k は「k 番目の地点 → 次の地点」（0 は出発地から）。"""
    stops = [start] + [(p["lat"], p["lon"]) for p in ordered] + [start]
    intermediates = []
    for k in range(len(stops) - 1):
        if k > 0:
            intermediates.append(_ll(*stops[k]))
        if k in vias:
            intermediates.append({"via": True, **_ll(*vias[k])})
    body = {
        "origin": _ll(*start),
        "destination": _ll(*start),
        "intermediates": intermediates,
        "travelMode": "WALK",
        "languageCode": "ja-JP",
        "units": "METRIC",
    }
    fields = FIELDS + ",routes.legs.polyline.encodedPolyline"
    r = requests.post(URL, json=body, headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": fields}, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f"Routes API {r.status_code}: {r.text[:300]}")
    routes = r.json().get("routes") or []
    if not routes:
        raise RuntimeError("歩くルートが見つかりませんでした")
    rt = routes[0]
    walk = round(int(str(rt.get("duration", "0s")).rstrip("s") or 0) / 60)
    stay = STAY_MIN * len(ordered)
    poly = rt.get("polyline", {}).get("encodedPolyline", "")
    legs = [decode_polyline(leg.get("polyline", {}).get("encodedPolyline", "")) for leg in rt.get("legs", [])]
    return {
        "polyline": poly,
        "distance_m": rt.get("distanceMeters", 0),
        "total_minutes": walk + stay,
        "walk_minutes": walk,
        "stay_minutes": stay,
        "overlap": overlap_ratio(decode_polyline(poly)),
        "legs": legs,
    }


# ---------- 重なりの測定と、回り道のための経由点 ----------
_M_PER_DEG_LAT = 111_320.0


def _to_xy(p, ref):
    """緯度経度 → 基準点からの平面座標（m）。数km の範囲なら十分な精度。"""
    return ((p[1] - ref[1]) * _M_PER_DEG_LAT * math.cos(math.radians(ref[0])),
            (p[0] - ref[0]) * _M_PER_DEG_LAT)


def _to_ll(xy, ref):
    return (ref[0] + xy[1] / _M_PER_DEG_LAT,
            ref[1] + xy[0] / (_M_PER_DEG_LAT * math.cos(math.radians(ref[0]))))


def _resample(pts: list[tuple[float, float]], step: float = 10.0) -> list[tuple[float, float]]:
    """線を約 step m おきの点に並べ直す（平面座標で返す）。"""
    if len(pts) < 2:
        return []
    ref = pts[0]
    xy = [_to_xy(p, ref) for p in pts]
    out = [xy[0]]
    carry = 0.0
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        seg = math.hypot(x1 - x0, y1 - y0)
        d = step - carry
        while d <= seg:
            t = d / seg
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
            d += step
        carry = (carry + seg) % step
    return out


def overlap_ratio(pts: list[tuple[float, float]], step: float = 10.0, near: float = 15.0,
                  skip: float = 150.0) -> float:
    """道のりのうち「すでに通った道（near m 以内）をもう一度通っている」割合。
    直前 skip m 以内は比べない（同じ道を進んでいるだけのため）。"""
    xy = _resample(pts, step)
    if len(xy) < 3:
        return 0.0
    lag = int(skip / step)
    grid: dict[tuple[int, int], list[int]] = {}
    reused = 0
    for i, (x, y) in enumerate(xy):
        cx, cy = int(x // near), int(y // near)
        hit = False
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for j in grid.get((gx, gy), ()):
                    if j < i - lag and math.hypot(xy[j][0] - x, xy[j][1] - y) <= near:
                        hit = True
                        break
                if hit:
                    break
            if hit:
                break
        reused += hit
        grid.setdefault((cx, cy), []).append(i)
    return reused / len(xy)


def _detour_vias(start, ordered: list[dict], legs: list[list[tuple[float, float]]]) -> dict[int, tuple[float, float]]:
    """前の区間と重なっている区間ごとに、重なりと反対側へずらした経由点を1つ作る。"""
    stops = [start] + [(p["lat"], p["lon"]) for p in ordered] + [start]
    ref = start
    leg_xy = [[_to_xy(p, ref) for p in leg] for leg in legs]
    budget = MAX_INTERMEDIATES - len(ordered)
    vias: dict[int, tuple[float, float]] = {}
    for k in range(1, min(len(leg_xy), len(stops) - 1)):
        if budget <= 0:
            break
        earlier = [pt for leg in leg_xy[:k] for pt in leg]
        mine = leg_xy[k]
        if not earlier or len(mine) < 2:
            continue
        shared = [pt for pt in mine if min(math.hypot(pt[0] - e[0], pt[1] - e[1]) for e in earlier[::3]) <= 20]
        if len(shared) / len(mine) < 0.3:
            continue
        a, b = _to_xy(stops[k], ref), _to_xy(stops[k + 1], ref)
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if length < 60:
            continue
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length  # 区間に直角な向き
        cx = sum(p[0] for p in shared) / len(shared)
        cy = sum(p[1] for p in shared) / len(shared)
        side = 1 if (mid[0] + nx - cx) ** 2 + (mid[1] + ny - cy) ** 2 >= (mid[0] - nx - cx) ** 2 + (mid[1] - ny - cy) ** 2 else -1
        off = min(max(0.35 * length, 120), 300)
        vias[k] = _to_ll((mid[0] + side * nx * off, mid[1] + side * ny * off), ref)
        budget -= 1
    return vias


def decode_polyline(s: str) -> list[tuple[float, float]]:
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat += vals[0]
        lon += vals[1]
        pts.append((lat / 1e5, lon / 1e5))
    return pts


def estimate(start: tuple[float, float], ordered: list[dict]) -> dict:
    """Routes API を使わない概算。polyline は空、時間は直線距離×1.3÷70m/分＋滞在。"""
    pts = [start] + [(p["lat"], p["lon"]) for p in ordered] + [start]
    walk = round(sum(_walk_min(a, b) for a, b in zip(pts, pts[1:])))
    dist = sum(haversine(a[0], a[1], b[0], b[1]) * DETOUR for a, b in zip(pts, pts[1:]))
    stay = STAY_MIN * len(ordered)
    return {"polyline": encode_polyline(pts), "distance_m": round(dist),
            "total_minutes": walk + stay, "walk_minutes": walk, "stay_minutes": stay}


def encode_polyline(points: list[tuple[float, float]]) -> str:
    """Google の encoded polyline 形式（直線をつないだだけ。道に沿ってはいない）。"""
    out, plat, plon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for d in (ilat - plat, ilon - plon):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)
