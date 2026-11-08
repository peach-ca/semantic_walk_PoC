"""Gemini が使えないとき（混雑・障害）の代わり。AI を使わず、ルールだけで決める。

- 聞き返し: 決まった問いかけと選択肢を返す
- 場所選び: 気分の言葉と場所の種類をルールで対応づけ、近い順・種類が偏らないように選ぶ

ヒントは種類ごとの決まった一言で、事実（歴史・営業時間など）は書かない。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .osm_data import category, label

INTERPRETATION = "いまは AI が混み合っているため、近くの場所から種類が偏らないように選びました。"

CLARIFY = {
    "question": "いまの気分に、いちばん近いのは？",
    "options": [
        {"label": "静かに、ひとりになりたい", "crowd": "avoid"},
        {"label": "気分を切り替えたい", "crowd": "neutral"},
        {"label": "懐かしさにひたりたい", "crowd": "neutral"},
        {"label": "にぎやかさに混ざりたい", "crowd": "ok"},
    ],
}

# 気分の言葉 → 合いそうな場所の種類（key, value）。value が None なら key 全体
KEYWORDS: list[tuple[tuple[str, ...], set[tuple[str, str | None]]]] = [
    (("緑", "自然", "木", "森", "花", "草", "葉"),
     {("leisure", "park"), ("leisure", "garden"), ("natural", None)}),
    (("静", "落ち着", "ひとり", "一人", "泣", "癒", "ほっと", "穏やか", "疲れ"),
     {("amenity", "place_of_worship"), ("leisure", "garden"), ("amenity", "library"), ("leisure", "park")}),
    (("懐かし", "レトロ", "昭和", "昔", "ノスタルジ"),
     {("amenity", "public_bath"), ("amenity", "cafe"), ("amenity", "marketplace"), ("historic", None), ("shop", None)}),
    (("キラキラ", "にぎやか", "賑やか", "楽し", "わくわく", "ワクワク", "映え", "元気"),
     {("shop", None), ("amenity", "cafe"), ("amenity", "arts_centre"), ("tourism", "gallery"), ("amenity", "marketplace")}),
    (("歴史", "古", "和", "伝統", "時代"),
     {("historic", None), ("amenity", "place_of_worship"), ("tourism", "museum")}),
    (("アート", "芸術", "美", "作品", "絵"),
     {("tourism", "gallery"), ("tourism", "artwork"), ("tourism", "museum"), ("amenity", "arts_centre"), ("craft", None)}),
    (("水", "川", "池", "海", "涼"),
     {("natural", "water"), ("amenity", "fountain"), ("man_made", "bridge")}),
    (("食", "お腹", "甘", "コーヒー", "珈琲", "おやつ"),
     {("amenity", "cafe"), ("amenity", "restaurant"), ("amenity", "fast_food")}),
]

HINTS = {
    "shop": "ふらっと覗いて、街の空気にふれる",
    "worship": "静かに手を合わせて、ひと呼吸",
    "outdoor": "風や光を感じながら、ひと休み",
    "historic": "立ち止まって、時間の重なりを眺める",
    "other": "少し足を止めて、まわりを見渡す",
}
PER_KIND = 2


@dataclass
class Pick:
    index: int
    hint: str


@dataclass
class Selection:
    interpretation: str
    picks: list[Pick] = field(default_factory=list)


def _wanted(text: str) -> set[tuple[str, str | None]]:
    out: set[tuple[str, str | None]] = set()
    for words, kinds in KEYWORDS:
        if any(w in text for w in words):
            out |= kinds
    return out


def _matches(p: dict, wanted: set[tuple[str, str | None]]) -> bool:
    return (p["key"], p["value"]) in wanted or (p["key"], None) in wanted


def select(mood: str, preference: str | None, candidates: list[dict], n: int = 8) -> Selection:
    """気分に合う種類を優先し、同じ種類は PER_KIND 件まで、近い順に n 件選ぶ。"""
    wanted = _wanted(f"{mood} {preference or ''}")
    order = sorted(range(len(candidates)),
                   key=lambda i: (not _matches(candidates[i], wanted), candidates[i].get("dist", 0)))
    counts: dict[tuple[str, str], int] = {}
    picks: list[Pick] = []
    for i in order:
        p = candidates[i]
        kind = (p["key"], p["value"] if p["key"] != "shop" else "*")
        if counts.get(kind, 0) >= PER_KIND:
            continue
        counts[kind] = counts.get(kind, 0) + 1
        picks.append(Pick(index=i, hint=HINTS[category(p)]))
        if len(picks) >= n:
            break
    return Selection(interpretation=INTERPRETATION, picks=picks)


def describe(p: dict) -> str:
    return label(p)
