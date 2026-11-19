"""Step 4 (optional, needs OSRM): add OSRM leg geometries so that routes draw on real streets:

* every pair inside each territory of the default plan and its neighbours (plus start point -> territory);
* every building pair within --walk-minutes of each other, and every start point -> building pair
  within --station-minutes, so absences and re-plans with other shift lengths are covered too;
* any extra pairs listed in --pairs (JSON [[i, j], ...]), e.g. found by scripts/check_geometry.py.

Legs that are still missing at runtime fall back to straight lines (geometry_exact=false).

Usage:  uv run python scripts/fill_legs.py [--osrm http://localhost:5000] [--walk-minutes 25]
Then:   uv run python scripts/precompute_plan.py --force   (re-draw the cached plan with the new legs)

osrm-routed answers each request on a new TCP connection; ~28k requests in a row can exhaust local
ephemeral ports (connection resets). Progress is saved per chunk: wait a minute and rerun.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from itertools import combinations
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.data import load_dataset  # noqa: E402
from app.travel import OSRMProvider  # noqa: E402
from scripts.build_matrix import fetch_legs, leg_key  # noqa: E402

DATA = ROOT / "data"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--osrm", default="http://localhost:5000")
    ap.add_argument("--neighbours", type=int, default=2, help="also pair with this many adjacent territories")
    ap.add_argument("--walk-minutes", type=float, default=25, help="all building pairs within this walk")
    ap.add_argument("--station-minutes", type=float, default=40, help="all start point -> building pairs within this")
    ap.add_argument("--pairs", type=Path, help="JSON file with extra [i, j] node pairs")
    args = ap.parse_args()
    ds = load_dataset()
    plan = json.loads((DATA / "default_plan.json").read_text())

    members: dict[str, list[int]] = {}
    for a in plan["assignments"]:
        members.setdefault(a["cleaner_id"], []).append(ds.node_of[a["building_id"]])
    cents = {c: ds.coords[m].mean(axis=0) for c, m in members.items()}
    pairs: set[tuple[int, int]] = set()
    for c in members:
        depot = next(x["start"]["node"] for x in plan["cleaners"] if x["id"] == c)
        near = sorted(members, key=lambda o: float(np.sum((cents[o] - cents[c]) ** 2)))[: 1 + args.neighbours]
        pool = sorted({n for o in near for n in members[o]})
        pairs.update((min(a, b), max(a, b)) for a, b in combinations(pool, 2))
        pairs.update((min(depot, n), max(depot, n)) for n in pool if n != depot)
    nb = len(ds.buildings)
    near = np.minimum(ds.seconds, ds.seconds.T)
    ii, jj = np.nonzero(np.triu(near[:nb, :nb] <= args.walk_minutes * 60, 1))
    pairs.update(zip(ii.tolist(), jj.tolist()))
    ss, bb = np.nonzero(near[nb:, :nb] <= args.station_minutes * 60)
    pairs.update((int(b), int(s) + nb) for s, b in zip(ss, bb))
    if args.pairs:
        pairs.update((min(a, b), max(a, b)) for a, b in json.loads(args.pairs.read_text()))
    with gzip.open(DATA / "legs.json.gz", "rt", encoding="utf-8") as f:
        legs = json.load(f)
    todo = sorted(p for p in pairs if leg_key(*p) not in legs)
    print(f"{len(pairs)} pairs needed, {len(todo)} missing")
    chunk = 4000
    for i in range(0, len(todo), chunk):  # fresh client per chunk, save progress as we go
        legs.update(fetch_legs(OSRMProvider(args.osrm), ds.coords, todo[i : i + chunk]))
        with gzip.open(DATA / "legs.json.gz", "wt", encoding="utf-8") as f:
            json.dump(legs, f)
        print(f"  {min(i + chunk, len(todo))}/{len(todo)}")
    print(f"legs.json.gz now has {len(legs)} geometries")


if __name__ == "__main__":
    main()
