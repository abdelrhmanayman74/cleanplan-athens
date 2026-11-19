"""Counts route legs that would be drawn as straight lines (no cached OSRM geometry).

Runs every single-day absence on the default plan (one per non-empty route) and, optionally, full
re-plans with other shift lengths, then reports legs missing from data/legs.json.gz. Missing pairs
can be written to a file and fetched with scripts/fill_legs.py --pairs.

Usage:  uv run python scripts/check_geometry.py [--shifts 420 540] [--write-missing missing.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.data import DATA_DIR, Dataset, load_dataset  # noqa: E402
from app.solver.optimizer import solve_plan  # noqa: E402
from app.solver.plan import Params  # noqa: E402
from app.solver.routing import shutdown_pool  # noqa: E402
from app.solver.whatif import apply_absence  # noqa: E402


def missing_legs(ds: Dataset, plan: dict, routes: list[dict] | None = None) -> set[tuple[int, int]]:
    depots = {c["id"]: c["start"]["node"] for c in plan["cleaners"]}
    out = set()
    for r in routes if routes is not None else plan["routes"]:
        if not r["stops"]:
            continue
        nodes = [depots[r["cleaner_id"]], *(ds.node_of[s["building_id"]] for s in r["stops"]), depots[r["cleaner_id"]]]
        for a, b in zip(nodes, nodes[1:]):
            if a != b and f"{min(a, b)}-{max(a, b)}" not in ds.legs:
                out.add((min(a, b), max(a, b)))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shifts", type=int, nargs="*", default=[], help="also re-plan with these daily_minutes")
    ap.add_argument("--write-missing", type=Path)
    args = ap.parse_args()
    ds = load_dataset()
    plan = json.loads((DATA_DIR / "default_plan.json").read_text())
    params = Params.from_dict(plan["params"])

    missing = missing_legs(ds, plan)
    print(f"default plan: {len(missing)} legs without street geometry")
    absences = [(r["cleaner_id"], r["day_key"]) for r in plan["routes"] if r["stops"]]
    abs_missing: set[tuple[int, int]] = set()
    inexact_routes = 0
    for cid, day in absences:
        res = apply_absence(ds, plan, params, cid, day)
        changed = [r for r in res["plan"]["routes"] if r["day_key"] == day and r["stops"]]
        m = missing_legs(ds, res["plan"], changed)
        inexact_routes += sum(1 for r in changed if not r["geometry_exact"])
        abs_missing |= m
    print(
        f"{len(absences)} single-day absences: {len(abs_missing)} distinct legs without geometry, "
        f"{inexact_routes} inexact routes"
    )
    missing |= abs_missing

    for shift in args.shifts:
        p = solve_plan(load_dataset(), Params(daily_minutes=shift), log=lambda *_: None)
        m = missing_legs(ds, p)
        print(f"re-plan with {shift}-minute shift: {len(m)} legs without geometry")
        missing |= m
    shutdown_pool()

    if args.write_missing:
        args.write_missing.write_text(json.dumps(sorted(missing)))
        print(f"wrote {len(missing)} pairs to {args.write_missing}")


if __name__ == "__main__":
    main()
