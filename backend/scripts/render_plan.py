"""Visual sanity check of a plan: PNG (matplotlib) and a static Leaflet HTML, routes coloured by cleaner.

Usage:  uv run python scripts/render_plan.py [plan.json] [--day A-Mon] [--out data/plan_preview]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import polyline

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("plan", nargs="?", default=str(ROOT / "data" / "default_plan.json"))
    ap.add_argument("--day", default=None, help="only draw routes of this day_key")
    ap.add_argument("--out", default=str(ROOT / "data" / "plan_preview"))
    ap.add_argument("--bbox", default=None, help="lat0,lng0,lat1,lng1 zoom window for the PNG")
    args = ap.parse_args()

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plan = json.loads(Path(args.plan).read_text())
    buildings = {b["id"]: b for b in json.loads((ROOT / "data" / "buildings.json").read_text())}
    color = {c["id"]: c["color"] for c in plan["cleaners"]}
    owner = {a["building_id"]: a["cleaner_id"] for a in plan["assignments"]}

    fig, ax = plt.subplots(figsize=(14, 14), dpi=110)
    for t in plan["territories"]:
        if t["hull"]:
            ys, xs = zip(*t["hull"])
            ax.fill(xs, ys, color=color[t["cleaner_id"]], alpha=0.12, lw=0)
            ax.plot(xs, ys, color=color[t["cleaner_id"]], lw=0.6, alpha=0.6)
    for r in plan["routes"]:
        if not r["stops"] or (args.day and r["day_key"] != args.day):
            continue
        pts = polyline.decode(r["geometry"], 5)
        ys, xs = zip(*pts)
        ax.plot(xs, ys, color=color[r["cleaner_id"]], lw=1.2, alpha=0.9, ls="-" if r["geometry_exact"] else "--")
    for bid, b in buildings.items():
        if bid in owner:
            ax.scatter(b["lng"], b["lat"], s=6, color=color[owner[bid]], zorder=3)
    for c in plan["cleaners"]:
        ax.scatter(
            c["start"]["lng"], c["start"]["lat"], marker="*", s=120, color=color[c["id"]], edgecolor="k", zorder=4
        )
    if args.bbox:
        la0, ln0, la1, ln1 = map(float, args.bbox.split(","))
        ax.set_xlim(ln0, ln1)
        ax.set_ylim(la0, la1)
    ax.set_aspect(1 / 0.79)  # ~cos(38°)
    k = plan["kpis"]
    ax.set_title(
        f"{k['cleaners']} cleaners · walk {k['walk_minutes']:.0f} min · utilisation {k['utilization']:.0%}"
        + (f" · {args.day}" if args.day else " · all days")
    )
    out = Path(args.out + (f"_{args.day}" if args.day else "") + ".png")
    fig.savefig(out, bbox_inches="tight")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
