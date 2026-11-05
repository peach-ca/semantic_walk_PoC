"""概念散歩ルート PoC のローカル UI

起動:
  uv run --env-file .env streamlit run app.py
ブラウザで http://localhost:8501 を開く
"""

import folium
import pandas as pd
import streamlit as st
from streamlit_folium import st_folium

import poc

st.set_page_config(page_title="概念散歩 PoC", page_icon="🚶", layout="wide")

if "start" not in st.session_state:
    st.session_state.start = (35.6812, 139.7671)  # 初期値（地図クリックで変更）
if "result" not in st.session_state:
    st.session_state.result = None


# ---------- 入力 ----------

with st.sidebar:
    st.header("散歩の条件")
    concept = st.text_input("摂取したい概念", "ノスタルジー")
    minutes = st.slider("散歩の時間（分）", 15, 120, 45, step=5)
    lat, lon = st.session_state.start
    st.caption(f"出発地: {lat:.5f}, {lon:.5f}")
    st.caption("地図をクリックすると出発地を変えられます")
    run = st.button("ルートを作る", type="primary", use_container_width=True)
    st.divider()
    st.caption(f"モデル: {poc.MODEL}")


# ---------- 実行 ----------

if run:
    max_m = minutes / 60 * poc.WALK_KMH * 1000
    radius = int(min(max(max_m / 3, 400), 1500))
    with st.status("ルートを作成中…", expanded=True) as status:
        try:
            st.write(f"「{concept}」を具体的な風景に展開中")
            exp = poc.expand_concept(concept)
            st.write("特徴: " + " / ".join(exp.features))

            st.write(f"半径{radius}mの候補地を取得中")
            cands = poc.fetch_candidates(lat, lon, radius, poc.to_osm_tags(exp.tags))
            if not cands:
                status.update(label="候補地が見つかりませんでした", state="error")
                st.stop()

            st.write(f"候補 {len(cands)} 件を採点中")
            ranked = poc.score_candidates(concept, exp.features, cands)
            stops = [c for c in ranked[: poc.TOP_K] if c["score"] >= 5]
            if not stops:
                status.update(label="合致度5以上の地点がありませんでした", state="error")
                st.stop()

            st.write("徒歩ルートを計算中")
            _, order, total, coords = poc.plan_route(lat, lon, radius, stops, max_m)
        except Exception as e:  # PoC なのでそのまま表示する
            status.update(label="エラーが発生しました", state="error")
            st.exception(e)
            st.stop()

        status.update(label="完了", state="complete", expanded=False)
        st.session_state.result = {
            "concept": concept,
            "exp": exp,
            "ranked": ranked,
            "order": order,
            "coords": coords,
            "total": total,
        }


# ---------- 表示 ----------

result = st.session_state.result
if result:
    km = result["total"] / 1000
    st.title(f"「{result['concept']}」を摂取する散歩")
    st.caption(f"約{km:.1f}km・{km / poc.WALK_KMH * 60:.0f}分・{len(result['order'])}地点")
else:
    st.title("概念散歩ルート PoC")
    st.caption("左で概念と時間を入れて「ルートを作る」を押してください")

col_map, col_info = st.columns([3, 2])

with col_map:
    m = folium.Map(location=st.session_state.start, zoom_start=16)
    folium.Marker(
        st.session_state.start, tooltip="出発地",
        icon=folium.Icon(color="gray", icon="home"),
    ).add_to(m)
    if result:
        if result["coords"]:
            folium.PolyLine(result["coords"], weight=5, opacity=0.7).add_to(m)
        for i, s in enumerate(result["order"], 1):
            html = f"<b>{i}. {s['name']}</b><br>合致度 {s['score']}/10<br>{s['reason']}"
            folium.Marker(
                [s["lat"], s["lon"]], tooltip=f"{i}. {s['name']}",
                popup=folium.Popup(html, max_width=260),
            ).add_to(m)

    out = st_folium(m, height=620, use_container_width=True, key="map",
                    returned_objects=["last_clicked"])
    clicked = (out or {}).get("last_clicked")
    if clicked:
        new_start = (clicked["lat"], clicked["lng"])
        if new_start != st.session_state.start:
            st.session_state.start = new_start
            st.session_state.result = None  # 出発地が変わったらルートは作り直し
            st.rerun()

with col_info:
    if result:
        st.subheader("立ち寄り先")
        for i, s in enumerate(result["order"], 1):
            st.markdown(f"**{i}. {s['name']}**　合致度 {s['score']}/10")
            st.caption(s["reason"])

        with st.expander("概念の展開（Gemini）"):
            st.write("**風景の特徴**")
            st.write(" / ".join(result["exp"].features))
            st.write("**探したOSMタグ**")
            for t in result["exp"].tags:
                st.write(f"- `{t.key}={t.value}` … {t.why}")

        with st.expander("候補地の採点（上位20）"):
            df = pd.DataFrame(
                [{"名前": c["name"], "合致度": c["score"], "理由": c["reason"]}
                 for c in result["ranked"][:20]]
            )
            st.dataframe(df, hide_index=True, use_container_width=True)
