#!/usr/bin/env bash
# OSM データを手元に用意する（公開 Overpass サーバーに頼らないため）
#
# 使い方:
#   bash get_osm.sh <緯度> <経度> [切り出す半径km=3] [地方=kanto]
#   例: bash get_osm.sh 35.6812 139.7671 3 kanto
#
# 地方: hokkaido tohoku kanto chubu kansai chugoku shikoku kyushu
#
# 作るもの:
#   data/<地方>-latest.osm.pbf  … Geofabrik の地方データ（初回のみダウンロード）
#   data/area.osm               … 出発地の周辺を切り出したもの（場所用）
#   data/area_walk.osm          … その中の道路だけ（徒歩ルート用）
# そして .env に OSM_FILE / OSM_WALK_FILE を書き込む

set -euo pipefail

LAT="${1:?緯度を指定してください}"
LON="${2:?経度を指定してください}"
KM="${3:-3}"
REGION="${4:-kanto}"

cd "$(dirname "$0")"
mkdir -p data

if ! command -v osmium >/dev/null; then
  echo "== osmium-tool をインストールします"
  sudo apt-get install -y osmium-tool
fi

PBF="data/${REGION}-latest.osm.pbf"
if [ ! -f "$PBF" ]; then
  echo "== ${REGION} の OSM データをダウンロードします（数百MB、初回のみ）"
  wget -O "$PBF" "https://download.geofabrik.de/asia/japan/${REGION}-latest.osm.pbf"
fi

# 中心から ±KM の範囲を緯度経度に換算
read -r W S E N < <(awk -v lat="$LAT" -v lon="$LON" -v km="$KM" 'BEGIN {
  pi = atan2(0, -1)
  dlat = km / 111.0
  dlon = km / (111.0 * cos(lat * pi / 180))
  printf "%.6f %.6f %.6f %.6f\n", lon - dlon, lat - dlat, lon + dlon, lat + dlat
}')

echo "== 範囲 ${W},${S},${E},${N} を切り出します"
osmium extract -b "${W},${S},${E},${N}" "$PBF" -o data/area.osm --overwrite
osmium tags-filter data/area.osm w/highway -o data/area_walk.osm --overwrite

# .env に設定を書き込む（既存の行は置き換え）
touch .env
sed -i '/^OSM_FILE=/d; /^OSM_WALK_FILE=/d' .env
echo "OSM_FILE=data/area.osm" >> .env
echo "OSM_WALK_FILE=data/area_walk.osm" >> .env

echo
echo "== 完了"
ls -lh data/area.osm data/area_walk.osm
echo "出発地はこの範囲内（中心から ${KM}km 以内）で選んでください"
