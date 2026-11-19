"""Naive baseline for comparison: what a planner would do by hand / with a spreadsheet.

* territories: plain k-means on coordinates with the same number of cleaners (balances nothing);
* days: round-robin over the allowed patterns (frequency rules still respected);
* routes: nearest-neighbour from the same start point, no shift limit (overtime shows up in KPIs).
"""

from __future__ import annotations

import numpy as np
from sklearn.cluster import KMeans

from app.data import Dataset
from app.domain import DAY_KEYS, PATTERNS
from app.solver.cleaners import choose_start
from app.solver.plan import Params, kpis, make_route

DESCRIPTION = (
    "Naive baseline on the same buildings and the same number of cleaners: k-means territories by "
    "building count (no workload balancing), round-robin day patterns that still respect each "
    "building's frequency, and nearest-neighbour walking routes from the same kind of start point."
)


def _nearest_neighbour(ds: Dataset, depot: int, ids: list[str]) -> list[str]:
    left = list(ids)
    order, cur = [], depot
    while left:
        nxt = min(left, key=lambda b: (ds.seconds[cur, ds.node_of[b]], b))
        order.append(nxt)
        left.remove(nxt)
        cur = ds.node_of[nxt]
    return order


def solve_baseline(ds: Dataset, params: Params, k: int, lower_bound: int) -> dict:
    ids = [b["id"] for b in ds.buildings]
    xy = np.array([[b["lat"], b["lng"] * 0.79] for b in ds.buildings])
    labels = KMeans(n_clusters=k, n_init=4, random_state=params.seed).fit_predict(xy)

    cleaners, assignments = [], []
    stops: dict[tuple[str, str], list[str]] = {}
    for c in range(k):
        cid = f"c{c + 1:02d}"
        mem = [ids[i] for i in np.where(labels == c)[0]]
        cleaners.append(
            {
                "id": cid,
                "name": cid,
                "color": "#888888",
                "start": choose_start(ds, ds.building_nodes(mem)),
                "daily_minutes": params.daily_minutes,
            }
        )
        counters = {f: 0 for f in PATTERNS}
        for b in mem:
            f = ds.building_by_id[b]["frequency"]
            pat = PATTERNS[f][counters[f] % len(PATTERNS[f])]
            counters[f] += 1
            assignments.append({"building_id": b, "cleaner_id": cid, "pattern": pat})
            for d in pat:
                stops.setdefault((cid, d), []).append(b)

    by_id = {c["id"]: c for c in cleaners}
    routes = []
    for c in cleaners:
        for d in DAY_KEYS:
            order = _nearest_neighbour(ds, c["start"]["node"], stops.get((c["id"], d), []))
            routes.append(make_route(ds, by_id[c["id"]], d, order, params))
    plan = {"cleaners": cleaners, "routes": routes, "assignments": assignments, "unassigned": []}
    out = kpis(ds, plan, params, lower_bound)
    over = [r for r in routes if r["end_time"] > params.shift_end + 1e-6]
    return {
        "kpis": out,
        "description": DESCRIPTION,
        # extra fields (not in the contract's minimum shape): how often the naive plan breaks the shift
        "overtime_routes": len(over),
        "overtime_minutes": round(sum(r["end_time"] - params.shift_end for r in over), 1),
        "time_window_violations": sum(
            1
            for r in routes
            for s in r["stops"]
            if (tw := ds.building_by_id[s["building_id"]].get("time_window")) and s["depart"] > tw[1] + 1e-6
        ),
    }
