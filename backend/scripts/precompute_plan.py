"""Step 5: solve and cache the default plan and its baseline (data/default_plan.json, data/baseline.json).

Usage:  uv run python scripts/precompute_plan.py [--force]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.data import DATA_DIR  # noqa: E402
from app.solver.routing import shutdown_pool  # noqa: E402
from app.state import PlanStore  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="ignore the cache and re-solve")
    args = ap.parse_args()
    if args.force:
        for name in ("default_plan.json", "baseline.json"):
            (DATA_DIR / name).unlink(missing_ok=True)
    store = PlanStore(DATA_DIR)
    plan, base = store.default_plan, store.baseline(store.default_state)
    print("plan KPIs:", json.dumps(plan["kpis"]))
    print("solve seconds:", plan["solve_seconds"])
    print("baseline KPIs:", json.dumps(base["kpis"]))
    exact = sum(r["geometry_exact"] for r in plan["routes"] if r["stops"])
    print(f"exact route geometries: {exact}/{sum(1 for r in plan['routes'] if r['stops'])}")
    shutdown_pool()


if __name__ == "__main__":
    main()
