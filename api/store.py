"""Firestore への保存（散歩の記録・訪れた場所・自分用メモ）。

データの形（ユーザーごとに分ける。ユーザー = ブラウザが作るランダムな ID）:

    users/{device_id}                      {last_seen}
    users/{device_id}/walks/{walk_id}      {started_at, finished_at, mood, preference, crowd,
                                            minutes, total_minutes, places:[{id,name,kind}]}
    users/{device_id}/visits/{auto}        {walk_id, place_id, name, visited_at, rating}
    users/{device_id}/comments/{auto}      {place_id, name, text, walk_id, created_at}

出発地の座標とルートの線は保存しない（出発地は自宅のことが多いため）。
保存するのは、名前のある公開の場所（OSM）と日時と気分だけ。
複合インデックスが要らないよう、絞り込みは「= 1つ」だけにして、並べ替えは Python で行う。
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

from google.cloud import firestore

from .osm_data import by_id, label
from .safety import JST

_db: firestore.Client | None = None


def db() -> firestore.Client:
    global _db
    if _db is None:
        _db = firestore.Client(
            project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
            database=os.environ.get("FIRESTORE_DATABASE", "(default)"),
        )
    return _db


class NotFound(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t) -> str | None:
    return t.astimezone(JST).isoformat(timespec="seconds") if t else None


def _user(device: str):
    return db().collection("users").document(device)


def _touch(device: str) -> None:
    _user(device).set({"last_seen": _now()}, merge=True)


def _place(pid: str) -> dict | None:
    p = by_id(pid)
    return {"id": p["id"], "name": p["name"], "kind": label(p)} if p else None


# ---------- 散歩 ----------
def create_walk(device: str, mood: str, preference: str | None, crowd: str,
                minutes: int, total_minutes: int | None, place_ids: list[str]) -> dict:
    places = [x for x in (_place(pid) for pid in place_ids) if x]
    now = _now()
    ref = _user(device).collection("walks").document()
    ref.set({
        "started_at": now, "finished_at": None,
        "mood": mood, "preference": preference, "crowd": crowd,
        "minutes": minutes, "total_minutes": total_minutes, "places": places,
    })
    _touch(device)
    return {"walk_id": ref.id, "started_at": _iso(now)}


def _walk_ref(device: str, walk_id: str):
    ref = _user(device).collection("walks").document(walk_id)
    if not ref.get().exists:
        raise NotFound("その散歩の記録が見つかりません")
    return ref


def finish_walk(device: str, walk_id: str) -> dict:
    ref = _walk_ref(device, walk_id)
    now = _now()
    ref.update({"finished_at": now})
    return {"walk_id": walk_id, "finished_at": _iso(now)}


def add_visit(device: str, walk_id: str, place_id: str, rating: int | None) -> dict:
    _walk_ref(device, walk_id)
    p = _place(place_id)
    if not p:
        raise NotFound("その場所が見つかりません")
    now = _now()
    ref = _user(device).collection("visits").document()
    ref.set({"walk_id": walk_id, "place_id": p["id"], "name": p["name"],
             "visited_at": now, "rating": rating})
    return {"visit_id": ref.id, "visited_at": _iso(now)}


def list_walks(device: str, limit: int = 20) -> list[dict]:
    walks = [(d.id, d.to_dict()) for d in _user(device).collection("walks").stream()]
    walks.sort(key=lambda w: w[1].get("started_at") or _now(), reverse=True)
    walks = walks[:limit]
    ids = {w for w, _ in walks}
    visits: dict[str, dict[str, dict]] = {}
    for d in _user(device).collection("visits").stream():
        v = d.to_dict()
        if v.get("walk_id") in ids:
            # 同じ場所に何度「着いた」を押しても、最後の1回を使う
            visits.setdefault(v["walk_id"], {})[v["place_id"]] = v
    out = []
    for wid, w in walks:
        vs = visits.get(wid, {})
        out.append({
            "walk_id": wid,
            "started_at": _iso(w.get("started_at")),
            "finished_at": _iso(w.get("finished_at")),
            "mood": w.get("mood"), "preference": w.get("preference"),
            "minutes": w.get("minutes"), "total_minutes": w.get("total_minutes"),
            "places": [{**p,
                        "visited_at": _iso(vs.get(p["id"], {}).get("visited_at")),
                        "rating": vs.get(p["id"], {}).get("rating")}
                       for p in w.get("places", [])],
        })
    return out


# ---------- 自分用メモ ----------
def add_comment(device: str, place_id: str, text: str, walk_id: str | None) -> dict:
    p = _place(place_id)
    if not p:
        raise NotFound("その場所が見つかりません")
    if walk_id:
        _walk_ref(device, walk_id)
    now = _now()
    ref = _user(device).collection("comments").document()
    ref.set({"place_id": p["id"], "name": p["name"], "text": text,
             "walk_id": walk_id, "created_at": now})
    _touch(device)
    return {"comment_id": ref.id, "created_at": _iso(now)}


def place_history(device: str, place_id: str) -> dict:
    """その場所について、自分のメモと訪れた日時。"""
    u = _user(device)
    comments = [{"comment_id": d.id, "text": c["text"], "walk_id": c.get("walk_id"),
                 "created_at": c["created_at"]}
                for d in u.collection("comments").where(filter=firestore.FieldFilter("place_id", "==", place_id)).stream()
                for c in [d.to_dict()]]
    visits = [{"visited_at": v["visited_at"], "walk_id": v.get("walk_id"), "rating": v.get("rating")}
              for d in u.collection("visits").where(filter=firestore.FieldFilter("place_id", "==", place_id)).stream()
              for v in [d.to_dict()]]
    comments.sort(key=lambda c: c["created_at"], reverse=True)
    visits.sort(key=lambda v: v["visited_at"], reverse=True)
    for c in comments:
        c["created_at"] = _iso(c["created_at"])
    for v in visits:
        v["visited_at"] = _iso(v["visited_at"])
    p = _place(place_id)
    return {"place": p, "comments": comments, "visits": visits}


def delete_comment(device: str, comment_id: str) -> None:
    ref = _user(device).collection("comments").document(comment_id)
    if not ref.get().exists:
        raise NotFound("そのメモが見つかりません")
    ref.delete()


def delete_all(device: str) -> None:
    """このブラウザの記録をすべて消す。"""
    db().recursive_delete(_user(device))
