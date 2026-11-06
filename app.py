"""起動: uv run --env-file .env streamlit run app.py"""
from html import escape

import folium
import pandas as pd
import streamlit as st
from streamlit_folium import st_folium

import poc

st.set_page_config(page_title="概念散歩 PoC", page_icon="🚶", layout="wide")
state = st.session_state
for key, value in {"start": (34.9858, 135.7588), "result": None,
                   "prepared": None, "map_version": 0}.items():
    if key not in state:
        state[key] = value

with st.sidebar:
    st.header("散歩の条件")
    concept = st.text_input("どんな気分を感じたい？", "ノスタルジー")
    minutes = st.slider("散歩の時間（分）", 15, 120, 45, step=5)
    lat, lon = state.start
    st.caption(f"出発地: {lat:.5f}, {lon:.5f}")
    st.caption("地図をクリックすると出発地を変えられます")
    st.caption("時間は出発地に戻るまでの徒歩の目安です。滞在・信号待ちは含みません。")
    prepare = st.button("周辺の場所と希望を確認", type="primary", use_container_width=True)

signature = (concept.strip(), minutes, lat, lon)
if state.get("signature") != signature:
    state.signature = signature
    state.prepared = None
    state.result = None
    for key in ("required", "excluded", "clarification_answer", "clarification_custom"):
        state.pop(key, None)

if prepare:
    state.result = None
    state.prepared = None
    for key in ("required", "excluded", "clarification_answer", "clarification_custom"):
        state.pop(key, None)
    if not concept.strip():
        st.warning("感じたい気分や希望を入力してください。")
    else:
        with st.status("周辺の場所と希望を確認中…", expanded=True) as status:
            try:
                radius = poc.search_radius(minutes)
                inventory = poc.fetch_inventory(lat, lon, radius, limit=False)
                if not inventory:
                    raise ValueError("周辺に名前付きの場所が見つかりません。出発地を変更してください。")
                st.write(f"周辺の場所を{len(inventory)}件取得しました。希望を確認しています。")
                clarification = poc.clarify_concept(concept.strip())
                state.prepared = {"inventory": inventory, "radius": radius,
                                  "clarification": clarification}
                status.update(label="場所と希望を選べます", state="complete", expanded=False)
            except Exception as e:
                status.update(label="確認できませんでした", state="error")
                st.error(str(e))

st.title("気分に合う散歩を見つける")
prepared = state.prepared
if prepared:
    clarification = prepared["clarification"]
    preference = ""
    if clarification.needs_clarification:
        st.subheader("もう少し希望を教えてください")
        custom_option = "自分の言葉で指定する"
        options = list(dict.fromkeys(clarification.options + [custom_option, "おまかせ"]))
        answer = st.radio(clarification.question, options, index=None, key="clarification_answer")
        if answer == custom_option:
            preference = st.text_input("具体的に感じたいこと", key="clarification_custom").strip()
        elif answer:
            preference = answer
    else:
        st.caption("希望が具体的なので、追加の質問はありません。")

    inventory = prepared["inventory"]
    by_id = {p["id"]: p for p in inventory}

    def place_label(place_id):
        p = by_id[place_id]
        return f"{p['name']}（{p['kind']}・直線約{p['dist']:.0f}m）"

    st.subheader("行きたい場所・外したい場所")
    st.caption("周辺の場所を名前で絞り込んで選べます。必須地点も徒歩での往復時間を確認します。")
    required = st.multiselect("必ず行きたい場所（最大8か所）", list(by_id),
                              format_func=place_label, max_selections=8, key="required")
    excluded = st.multiselect("候補から外す場所", list(by_id),
                              format_func=place_label, key="excluded")
    conflict = set(required) & set(excluded)
    if conflict:
        st.warning("同じ場所が必須と除外の両方に選ばれています。どちらか一方にしてください。")
    unanswered = clarification.needs_clarification and not preference
    if unanswered:
        st.caption("上の質問に回答するとルートを作れます。「おまかせ」も選べます。")
    selection_signature = (tuple(required), tuple(excluded), preference)
    if state.get("selection_signature") != selection_signature:
        state.selection_signature = selection_signature
        state.result = None
    if st.button("選んだ条件でルートを作る", type="primary", disabled=bool(conflict or unanswered)):
        state.result = None
        with st.status("希望に合うルートを作成中…", expanded=True) as status:
            try:
                eligible = [p for p in inventory if p["id"] not in excluded]
                if not eligible:
                    raise ValueError("すべての場所が除外されています。除外する場所を減らしてください。")
                candidates = poc.sample_inventory(eligible)
                candidate_ids = {p["id"] for p in candidates}
                candidates += [by_id[i] for i in required if i not in candidate_ids]
                st.write("希望と除外条件をもとに、立ち寄り先を選んでいます。")
                interpretation, ranked = poc.choose_places(concept.strip(), candidates, preference)
                stops = {p["id"]: p for p in ranked if p["score"] >= 5}
                ranked_by_id = {p["id"]: p for p in ranked}
                for i in required:
                    stops[i] = ranked_by_id.get(i, {**by_id[i], "score": 0,
                                                    "reason": "ユーザー指定の必須地点"})
                if not stops:
                    raise ValueError("希望に合う候補がありません。希望を変えるか必須地点を指定してください。")
                st.write("必須地点と徒歩での往復時間を確認しています。")
                _, order, total, coords = poc.plan_route(
                    lat, lon, prepared["radius"], list(stops.values()),
                    minutes / 60 * poc.WALK_KMH * 1000, required_ids=required)
                state.result = {"interpretation": interpretation, "ranked": ranked,
                                "order": order, "coords": coords, "total": total}
                status.update(label="ルートができました", state="complete", expanded=False)
            except Exception as e:
                status.update(label="条件を見直してください", state="error")
                st.error(str(e))
else:
    st.caption("左で気分と時間を入力し、「周辺の場所と希望を確認」を押してください。")

result = state.result
if result:
    km = result["total"] / 1000
    st.subheader(f"「{concept.strip()}」を感じる散歩")
    st.caption(f"約{km:.1f}km・徒歩約{km / poc.WALK_KMH * 60:.0f}分・{len(result['order'])}地点・出発地に戻ります")
    st.info(result["interpretation"])

col_map, col_info = st.columns([3, 2])
with col_map:
    m = folium.Map(location=state.start, zoom_start=16)
    folium.Marker(state.start, tooltip="出発地", icon=folium.Icon(color="gray", icon="home")).add_to(m)
    if result:
        folium.PolyLine(result["coords"], weight=5, opacity=0.7).add_to(m)
        for i, p in enumerate(result["order"], 1):
            label = "必須" if p["id"] in state.get("required", []) else f"合致度 {p['score']}/10"
            html = f"<b>{i}. {escape(p['name'])}</b><br>{label}<br>{escape(p['reason'])}"
            folium.Marker([p["lat"], p["lon"]], tooltip=f"{i}. {p['name']}",
                          popup=folium.Popup(html, max_width=260)).add_to(m)
        m.fit_bounds(result["coords"])
    out = st_folium(m, height=620, use_container_width=True,
                    key=f"map_{state.map_version}", returned_objects=["last_clicked"])
    clicked = (out or {}).get("last_clicked")
    if clicked and (clicked["lat"], clicked["lng"]) != state.start:
        state.start = (clicked["lat"], clicked["lng"])
        state.map_version += 1
        st.rerun()

with col_info:
    if result:
        st.subheader("立ち寄り先")
        for i, p in enumerate(result["order"], 1):
            label = "必須地点" if p["id"] in state.get("required", []) else f"合致度 {p['score']}/10"
            st.markdown(f"**{i}. {p['name']}**　{label}")
            st.caption(p["reason"])
        st.caption("行きたくない場所は上の「候補から外す場所」で選び、ルートを作り直せます。")
        with st.expander("AIが選んだ候補を確認"):
            st.dataframe(pd.DataFrame([{"名前": p["name"], "種類": p["kind"],
                                        "合致度": p["score"], "理由": p["reason"]}
                                       for p in result["ranked"]]), hide_index=True)
