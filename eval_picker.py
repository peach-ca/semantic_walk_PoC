"""picker.py の評価。決まった地域と希望で動かし、改善の効果を数字で残す。

使い方:
  uv run --env-file .env eval_picker.py                 # 全部（6ケース）
  uv run --env-file .env eval_picker.py --areas 清水寺   # 地域を絞って費用を節約

呼び出し回数の上限: 1ケースあたり Gemini 最大2回、Places API 最大で数十回。
結果は results/ に保存（Maps のデータを含むので、評価後は削除して結論だけ残す）。

前回までの実験（改善前）の基準値:
  Maps を参照した割合 9回中7回 / 実在の確認 一部で失敗（名称の不一致）/
  有名な場所の混入 あり（大谷本廟 4,033件など）/ 応答 17〜68秒
"""

import argparse
import datetime
import os

import picker

AREAS = {
    "清水寺": (34.9949, 135.7850),
    "嵐山": (35.0094, 135.6720),
    "伏見稲荷": (34.9671, 135.7727),
}
PROMPTS = [
    "静けさを感じたい。混んでいない所で",
    "昔ながらの京都の雰囲気を味わいたい。人が少ない所で",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--areas", default=",".join(AREAS))
    ap.add_argument("--radius", type=int, default=1000)
    args = ap.parse_args()

    rows = []
    for area in args.areas.split(","):
        lat, lon = AREAS[area]
        for prompt in PROMPTS:
            print(f"[{area}] {prompt}")
            try:
                r = picker.pick_places(prompt, lat, lon, args.radius)
                print(f"  使える場所 {len(r.places)} / 試行 {r.attempts} / 参照 {r.grounded_chunks} / "
                      f"除外 {r.dropped} / {r.seconds}秒")
                rows.append((area, prompt, r, None))
            except Exception as e:
                print(f"  失敗: {e}")
                rows.append((area, prompt, None, f"{type(e).__name__}: {str(e)[:200]}"))

    ok = [r for _, _, r, err in rows if r]
    lines = [f"# picker 評価 {datetime.datetime.now():%Y-%m-%d %H:%M}", "",
             f"- モデル: {picker.MODEL} / 半径 {args.radius}m / 有名の基準 {picker.FAMOUS}件",
             f"- 成功 {len(ok)}/{len(rows)} ケース",
             f"- 1回目でMapsを参照した割合: 計測は試行回数で判断（試行1=1回目で十分な場所が得られた）",
             f"- 使える場所が{picker.MIN_PLACES}か所以上: "
             f"{sum(1 for r in ok if len(r.places) >= picker.MIN_PLACES)}/{len(ok)}",
             "", "| 地域 | 希望 | 使える場所 | 試行 | 参照 | 除外の内訳 | 時間 |", "|---|---|---|---|---|---|---|"]
    for area, prompt, r, err in rows:
        if err:
            lines.append(f"| {area} | {prompt} | 失敗 | - | - | {err} | - |")
        else:
            drop = "、".join(f"{k}{v}" for k, v in r.dropped.items()) or "なし"
            lines.append(f"| {area} | {prompt} | {len(r.places)} | {r.attempts} | "
                         f"{r.grounded_chunks} | {drop} | {r.seconds}秒 |")
    lines += ["", "## 詳細", ""]
    for area, prompt, r, err in rows:
        if not r:
            continue
        lines += [f"### {area} / {prompt}", "", f"解釈: {r.interpretation}", "",
                  "| 場所 | レビュー件数 | 距離 | 理由 | 人の評価(1-3) |", "|---|---|---|---|---|"]
        for p in r.places:
            lines.append(f"| {p.name} | {p.count} | {p.dist:.0f}m | {p.reason} | |")
        lines.append("")

    os.makedirs("results", exist_ok=True)
    path = f"results/eval_{datetime.datetime.now():%Y%m%d_%H%M}.md"
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n保存しました: {path}")


if __name__ == "__main__":
    main()