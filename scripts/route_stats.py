"""本番（Cloud Run）のログから、ルート作成の処理時間などを集計する。発表やADRの数字に使う。

    uv run python scripts/route_stats.py              # 直近7日
    uv run python scripts/route_stats.py --days 2

必要: gcloud にログインしていること（ログの閲覧権限）。
集計するのは、サーバーが出している次の行だけ（気分や場所の名前は含まない）:
    route: select 9.8s / places 1.2s (5 calls) / routes 0.6s, picked 8 → kept 5, 55 min
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
from datetime import datetime, timedelta, timezone

PROJECT = "devfest-walk-1106"
SERVICE = "walk"
PATTERN = re.compile(
    r"route: select ([\d.]+)s / places ([\d.]+)s(?: \((\d+) calls\))? / routes ([\d.]+)s, "
    r"picked (\d+) → kept (\d+)(?:→\d+)?(?: places)?(?:, (\d+) min)?"
)


def fetch(days: int) -> list[str]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    flt = (f'resource.type="cloud_run_revision" AND resource.labels.service_name="{SERVICE}" '
           f'AND textPayload:"route: select" AND timestamp>="{since}"')
    out = subprocess.run(
        ["gcloud", "logging", "read", flt, "--project", PROJECT, "--limit", "1000", "--format", "json"],
        check=True, capture_output=True, text=True,
    ).stdout
    return [e.get("textPayload", "") for e in json.loads(out or "[]")]


def summary(name: str, xs: list[float], unit: str = "") -> str:
    if not xs:
        return f"{name}: データなし"
    xs = sorted(xs)
    p90 = xs[min(len(xs) - 1, int(len(xs) * 0.9))]
    return (f"{name}: 平均 {statistics.mean(xs):.1f}{unit} / 中央値 {statistics.median(xs):.1f}{unit} / "
            f"90% {p90:.1f}{unit} / 最大 {xs[-1]:.1f}{unit}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    args = ap.parse_args()

    rows = [m.groups() for line in fetch(args.days) if (m := PATTERN.search(line))]
    if not rows:
        print("集計できる行がありませんでした（期間内にルートが作られていない可能性）")
        return

    sel = [float(r[0]) for r in rows]
    plc = [float(r[1]) for r in rows]
    calls = [int(r[2]) for r in rows if r[2] is not None]
    rts = [float(r[3]) for r in rows]
    total = [a + b + c for a, b, c in zip(sel, plc, rts)]
    picked = [int(r[4]) for r in rows]
    kept = [int(r[5]) for r in rows]
    minutes = [int(r[6]) for r in rows if r[6] is not None]

    print(f"直近{args.days}日のルート作成: {len(rows)} 回")
    print(summary("合計（AI＋確認＋ルート）", total, "秒"))
    print(summary("  Gemini の選定", sel, "秒"))
    print(summary("  Places の確認", plc, "秒"))
    print(summary("  Routes", rts, "秒"))
    print(summary("Places の呼び出し回数", calls, "回"))
    print(summary("AIが選んだ数", picked, "か所"))
    print(summary("ルートに残った数", kept, "か所"))
    print(summary("所要時間（滞在込み）", minutes, "分"))


if __name__ == "__main__":
    main()
