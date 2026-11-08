"""AI を使わない部分（安全のルール・時間に収める処理・線の変換・代わりの選び方）のテスト。

    uv run pytest -q

Google の API も Gemini も呼ばない。places.json も使わない。
"""
import math
from datetime import datetime

import pytest

from api import fallback, route, safety
from api.safety import JST

DAY = datetime(2026, 11, 8, 13, 0, tzinfo=JST)
NIGHT = datetime(2026, 11, 8, 19, 0, tzinfo=JST)
OPEN = {"businessStatus": "OPERATIONAL", "currentOpeningHours": {"openNow": True}, "types": []}


def place(name="場所", key="leisure", value="park", lat=35.0085, lon=135.7485, pid=None):
    return {"id": pid or f"osm:node/{abs(hash(name)) % 10**8}", "name": name,
            "key": key, "value": value, "lat": lat, "lon": lon}


# ---------- 危機的な言葉 ----------
@pytest.mark.parametrize("text", ["死にたい", "もう 消えたい", "じさつ", "生きていたくない"])
def test_crisis_detected(text):
    assert safety.is_crisis(text)


@pytest.mark.parametrize("text", ["泣きたい", "懐かしい雰囲気", "死ぬほど甘いものが食べたい気分"])
def test_ordinary_moods_pass(text):
    # 「死ぬほど」は止めない（「死にたい」「死ぬ方法」のような言い方だけを止める）
    assert not safety.is_crisis(text)


# ---------- 除外ルール ----------
def test_private_name_is_dropped():
    assert safety.decide(place("〇〇マンション", "historic", "memorial"), None, "neutral", DAY) == (False, None)


def test_closed_business_is_dropped():
    g = {**OPEN, "businessStatus": "CLOSED_PERMANENTLY"}
    assert safety.decide(place("喫茶A", "amenity", "cafe"), g, "neutral", DAY)[0] is False


def test_shop_closed_now_is_dropped():
    g = {**OPEN, "currentOpeningHours": {"openNow": False}}
    assert safety.decide(place("喫茶A", "amenity", "cafe"), g, "neutral", DAY)[0] is False


def test_shop_open_now_is_kept():
    assert safety.decide(place("喫茶A", "amenity", "cafe"), OPEN, "neutral", DAY) == (True, None)


def test_shop_not_found_on_maps_is_dropped():
    assert safety.decide(place("喫茶A", "amenity", "cafe"), None, "neutral", DAY)[0] is False


def test_outdoor_kept_by_day_dropped_at_night():
    park = place("〇〇公園")
    assert safety.decide(park, {"businessStatus": "OPERATIONAL"}, "neutral", DAY)[0] is True
    assert safety.decide(park, {"businessStatus": "OPERATIONAL"}, "neutral", NIGHT)[0] is False


def test_near_famous_dropped_only_when_avoiding_crowds():
    near_kiyomizu = place("成就院", "amenity", "place_of_worship", lat=34.9952, lon=135.7848)
    assert safety.decide(near_kiyomizu, None, "avoid", DAY)[0] is False
    assert safety.decide(near_kiyomizu, None, "neutral", DAY)[0] is True


def test_water_gets_warning():
    keep, warning = safety.decide(place("〇〇池", "natural", "water"), None, "neutral", DAY)
    assert keep and "水辺" in warning


def test_dev_mode_keeps_shops_with_notice():
    keep, warning = safety.decide(place("喫茶A", "amenity", "cafe"), None, "neutral", DAY, checked=False)
    assert keep and "開発モード" in warning


# ---------- 時間に収める ----------
def test_route_fits_in_time():
    start = (35.0085, 135.7485)
    places = [place(f"p{i}", lat=35.0085 + 0.002 * i, lon=135.7485, pid=f"osm:node/{i}") for i in range(1, 9)]
    ordered = route.order_and_fit(start, places, 30)
    assert ordered
    walk = route.estimate(start, ordered)
    assert walk["total_minutes"] <= 30 + route.STAY_MIN  # 最後の1か所ぶんの誤差まで


def test_must_place_is_kept():
    start = (35.0085, 135.7485)
    others = [place(f"p{i}", lat=35.0085 + 0.003 * math.cos(i), lon=135.7485 + 0.003 * math.sin(i),
                    pid=f"osm:node/{i}") for i in range(1, 9)]
    far = place("遠い", lat=35.0140, lon=135.7485, pid="osm:node/99")
    ordered = route.order_and_fit(start, others + [far], 30, {"osm:node/99"})
    assert "osm:node/99" in [p["id"] for p in ordered]


def test_route_uses_the_time_and_spreads_out():
    """60分の指定で、歩く時間が半分以上を占め、立ち寄りは上限まで。"""
    start = (35.0262, 135.7808)
    ring = [place(f"r{i}", lat=start[0] + 0.004 * math.cos(i * 0.7), lon=start[1] + 0.005 * math.sin(i * 0.7),
                  pid=f"osm:node/{i}") for i in range(9)]
    close = [place(f"c{i}", lat=start[0] + 0.0004 * i, lon=start[1], pid=f"osm:node/c{i}") for i in range(1, 4)]
    ordered = route.order_and_fit(start, ring + close, 60)
    est = route.estimate(start, ordered)
    assert len(ordered) <= route.max_stops(60)
    assert est["total_minutes"] <= 60 + 2
    assert est["walk_minutes"] >= 30


# ---------- 線の変換（Google の仕様書の例） ----------
def test_encode_polyline_matches_google_example():
    pts = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
    assert route.encode_polyline(pts) == "_p~iF~ps|U_ulLnnqC_mqNvxq`@"


def test_estimate_returns_a_line():
    start = (35.0085, 135.7485)
    r = route.estimate(start, [place("A", lat=35.009, lon=135.747)])
    assert len(r["polyline"]) > 4 and r["total_minutes"] > route.STAY_MIN


# ---------- Gemini が使えないときの代わり ----------
def candidates():
    kinds = [("leisure", "park"), ("leisure", "garden"), ("amenity", "cafe"), ("amenity", "cafe"),
             ("amenity", "cafe"), ("amenity", "place_of_worship"), ("shop", "bakery"), ("historic", "memorial")]
    return [{**place(f"{v}{i}", k, v, pid=f"osm:node/{i}"), "dist": 100 * (i + 1)} for i, (k, v) in enumerate(kinds)]


def test_fallback_prefers_matching_kinds():
    sel = fallback.select("緑に触れたい", None, candidates(), n=3)
    kinds = {candidates()[p.index]["value"] for p in sel.picks[:2]}
    assert kinds == {"park", "garden"}


def test_fallback_limits_same_kind_and_has_no_duplicates():
    sel = fallback.select("懐かしい", None, candidates(), n=8)
    idx = [p.index for p in sel.picks]
    assert len(idx) == len(set(idx))
    cafes = [i for i in idx if candidates()[i]["value"] == "cafe"]
    assert len(cafes) <= fallback.PER_KIND
    assert all(len(p.hint) <= 30 for p in sel.picks)


def test_fallback_clarify_shape():
    assert len(fallback.CLARIFY["options"]) >= 3
    assert all(o["crowd"] in ("avoid", "neutral", "ok") for o in fallback.CLARIFY["options"])


# ---------- アクセス数の上限 ----------
def test_rate_limiter_per_ip():
    rl = safety.RateLimiter(per_ip_per_hour=2, global_per_day=100)
    assert [rl.allow("a")[0] for _ in range(3)] == [True, True, False]
    assert rl.allow("b")[0] is True


# ---------- 行きと帰りで同じ道を通らない ----------
def test_decode_is_inverse_of_encode():
    pts = [(35.0262, 135.7808), (35.0301, 135.7790), (35.0285, 135.7752)]
    got = route.decode_polyline(route.encode_polyline(pts))
    assert all(abs(a[0] - b[0]) < 1e-5 and abs(a[1] - b[1]) < 1e-5 for a, b in zip(got, pts))


def test_out_and_back_has_high_overlap_and_loop_has_low():
    s, far = (35.0262, 135.7808), (35.0352, 135.7808)        # 北へ約1km
    out_and_back = [s, far, s]
    loop = [s, far, (35.0352, 135.7918), (35.0262, 135.7918), s]  # 四角く1周
    assert route.overlap_ratio(out_and_back) > 0.4
    assert route.overlap_ratio(loop) < 0.05


def test_detour_via_is_placed_off_the_shared_road():
    s = (35.0262, 135.7808)
    stop = {"id": "x", "lat": 35.0352, "lon": 135.7808}
    go = [s, (35.0307, 135.7808), (35.0352, 135.7808)]
    back = list(reversed(go))                                  # 同じ道で帰ってくる
    vias = route._detour_vias(s, [stop], [go, back])
    assert 1 in vias                                            # 帰りの区間に経由点
    lat, lon = vias[1]
    assert abs(lon - 135.7808) > 0.001                          # 来た道（経度一定）から横にずれている


def test_clustered_places_are_stretched_to_fill_the_time():
    """選ばれた場所が出発地のすぐ近くに固まっていても、経由点で輪を広げて指定時間に近づける。"""
    start = (35.0262, 135.7808)
    near = [place(f"n{i}", lat=start[0] + 0.0012 * math.cos(i * 1.5), lon=start[1] + 0.0015 * math.sin(i * 1.5),
                  pid=f"osm:node/n{i}") for i in range(5)]
    ordered = route.order_and_fit(start, near, 60)
    est = route.estimate(start, ordered, 60)
    assert est["total_minutes"] >= 60 * 0.85
    assert est["total_minutes"] <= 60 + 5
    assert len(est["legs"]) == len(ordered) + 1
