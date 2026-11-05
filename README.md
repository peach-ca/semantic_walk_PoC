# semantic_walk_PoC

ユーザーが求める「概念」を摂取できる散歩ルートを作るアプリの PoC。

## セットアップ

```bash
uv sync
cp .env.example .env   # GEMINI_API_KEY を記入
```

## 実行

```bash
uv run --env-file .env poc.py --concept ノスタルジー --lat <緯度> --lon <経度> --minutes 45
```

`route_<概念>.html` が出力されます。

## 構成（PoC）

- 概念の展開と採点: Gemini API
- 場所と徒歩ルート: OpenStreetMap（osmnx）
- 地図表示: folium
