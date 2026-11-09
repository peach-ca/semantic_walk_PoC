#!/usr/bin/env bash
# Google Cloud の公式アイコンをダウンロードし、アーキテクチャ図（gcp-arch.html）が読む名前で icons/ に置く。
# 使い方: gcp-arch.html と同じフォルダで  bash fetch_icons.sh
# 出典: https://cloud.google.com/icons （利用前に https://services.google.com/fh/files/misc/google-cloud-product-icons.pdf のガイドを確認）
set -euo pipefail

SRC=icons_src
mkdir -p "$SRC" icons

for name in core-products-icons category-icons google-cloud-legacy-icons; do
  zip="$SRC/$name.zip"
  if [ ! -s "$zip" ]; then
    echo "ダウンロード: $name.zip"
    curl -fL --retry 2 -o "$zip" "https://services.google.com/fh/files/misc/$name.zip"
  fi
  unzip -oq "$zip" -d "$SRC/$name"
done

# 図の中の名前 → ファイル名の探し方（大文字小文字は区別しない。上の候補から順に試す）
declare -A PATTERNS=(
  [cloud_run]="*cloud*run*"
  [vertex_ai]="*vertex*ai* *vertexai*"
  [cloud_build]="*cloud*build*"
  [artifact_registry]="*artifact*registry*"
  [cloud_logging]="*cloud*logging* *logging*"
  [places]="*places*"
  [routes]="*routes* *directions*"
  [maps_js]="*maps*javascript* *maps*api* *google*maps*"
)

pick() {  # $1 = パターン群。SVGを優先し、新しいアイコン（core, category）を古いもの（legacy）より優先する
  local pat
  for ext in svg png; do
    for dir in "$SRC/core-products-icons" "$SRC/category-icons" "$SRC/google-cloud-legacy-icons"; do
      for pat in $1; do
        f=$(find "$dir" -type f -iname "$pat.$ext" ! -path '*__MACOSX*' 2>/dev/null | sort | head -n1)
        [ -n "$f" ] && { echo "$f"; return 0; }
      done
    done
  done
  return 1
}

echo
for key in cloud_run vertex_ai cloud_build artifact_registry cloud_logging places routes maps_js; do
  if f=$(pick "${PATTERNS[$key]}"); then
    ext="${f##*.}"; rm -f "icons/$key.svg" "icons/$key.png"
    cp "$f" "icons/$key.$ext"
    printf "✓ %-18s ← %s\n" "$key" "${f#$SRC/}"
  else
    printf "✗ %-18s 見つからない（点線の枠のまま。手で icons/%s.svg を置けば反映される）\n" "$key" "$key"
  fi
done

echo
echo "選ばれたファイルが正しいか、icons/ の中を目で確認してください。"
echo "違っていたら、正しいファイルを icons/<名前>.svg として上書きすれば図に反映されます。"
echo "図を開く: ブラウザで gcp-arch.html を開く（同じフォルダに icons/ があること）"
