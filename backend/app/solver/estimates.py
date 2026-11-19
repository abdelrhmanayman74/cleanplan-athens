"""Instant analytic estimates (no solve): workforce size and Google Routes matrix cost."""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np
from shapely.geometry import MultiPoint

from app.data import Dataset
from app.domain import DAY_KEYS, PATTERNS
from app.solver.plan import Params, lower_bound_cleaners
from app.solver.territories import to_xy

BHH_CONSTANT = 0.7124  # Beardwood-Halton-Hammersley constant for random uniform points (Euclidean TSP)

PRICE_PER_1000_USD = 5.0
FREE_ELEMENTS_PER_MONTH = 10_000
PRICE_DATE = "2026-11"


def balanced_day_loads(ds: Dataset) -> tuple[dict[str, float], dict[str, int]]:
    """Service minutes and visit counts per day_key after a greedy (LPT) spread of patterns."""
    load = {d: 0.0 for d in DAY_KEYS}
    count = {d: 0 for d in DAY_KEYS}
    for b in sorted(ds.buildings, key=lambda b: (-len(PATTERNS[b["frequency"]][0]) * b["service_minutes"], b["id"])):
        pat = min(PATTERNS[b["frequency"]], key=lambda p: (max(load[d] for d in p), sum(load[d] for d in p)))
        for d in pat:
            load[d] += b["service_minutes"]
            count[d] += 1
    return load, count


def _areas_km2(ds: Dataset) -> dict[str, tuple[float, int]]:
    """Convex-hull area (km²) and building count per neighbourhood."""
    pts = defaultdict(list)
    for b in ds.buildings:
        pts[b["neighborhood"]].append([b["lat"], b["lng"]])
    out = {}
    for hood, p in pts.items():
        xy = to_xy(np.array(p))
        area = MultiPoint([tuple(x) for x in xy]).convex_hull.area / 1e6 if len(p) >= 3 else 0.0
        out[hood] = (area, len(p))
    return out


def workforce_estimate(
    ds: Dataset, daily_minutes: int, target_utilization: float, break_minutes: int, solved: int | None
) -> dict:
    params = Params(daily_minutes=daily_minutes, target_utilization=target_utilization, break_minutes=break_minutes)
    load, count = balanced_day_loads(ds)
    areas = _areas_km2(ds)
    n_total = len(ds.buildings)
    speed_m_per_min = ds.haversine.speed_mps * 60
    detour = ds.haversine.detour_factor
    # median walk from a building to its nearest station: start/end legs of each daily route
    st = ds.station_nodes()
    bn = ds.building_nodes([b["id"] for b in ds.buildings])
    depot_leg = float(np.median(ds.seconds[np.ix_(st, bn)].min(axis=0))) / 60.0

    def walk_for_day(d: str, k: int) -> float:
        # BHH per neighbourhood: L ≈ 0.7124 * sqrt(n * A); split into k routes adds ~2 depot legs each
        m = 0.0
        for area, n_h in areas.values():
            n_d = count[d] * n_h / n_total
            m += BHH_CONSTANT * math.sqrt(max(n_d, 0) * area * 1e6) * detour / speed_m_per_min
        return m + k * 2 * depot_leg

    capacity = params.planning_budget
    k = max(1, math.ceil(max(load.values()) / capacity))
    for _ in range(5):  # fixed point: walking depends on the number of routes
        day_total = {d: load[d] + walk_for_day(d, k) for d in DAY_KEYS}
        k_new = math.ceil(max(day_total.values()) / capacity)
        if k_new == k:
            break
        k = k_new
    busiest = max(DAY_KEYS, key=lambda d: day_total[d])
    return {
        "daily_minutes": daily_minutes,
        "target_utilization": target_utilization,
        "total_service_minutes": round(sum(load.values()), 1),
        "est_walk_minutes": round(sum(walk_for_day(d, k) for d in DAY_KEYS), 1),
        "busiest_day": busiest,
        "busiest_day_load": round(day_total[busiest], 1),
        "lower_bound": lower_bound_cleaners(ds, params),
        "estimate": int(k),
        "solved": solved,
        "note": (
            "Estimates, not a solve: walking uses the Beardwood–Halton–Hammersley approximation "
            "0.7124·√(n·A) per neighbourhood plus start/end legs; lower bound = total service + "
            "shortest possible walk per visit, spread evenly, at the target utilisation."
        ),
    }


def cost_estimate(ds: Dataset, plan: dict) -> dict:
    sizes = defaultdict(int)
    for a in plan["assignments"]:
        sizes[a["cleaner_id"]] += 1
    n = len(ds.buildings)
    naive = n * n
    ours = int(sum(s * s for s in sizes.values()))

    def cost(elements: int) -> float:
        return round(max(0, elements - FREE_ELEMENTS_PER_MONTH) / 1000 * PRICE_PER_1000_USD, 2)

    return {
        "buildings": n,
        "naive_elements": naive,
        "our_elements": ours,
        "price_per_1000_usd": PRICE_PER_1000_USD,
        "free_elements_per_month": FREE_ELEMENTS_PER_MONTH,
        "naive_cost_usd": cost(naive),
        "our_cost_usd": cost(ours),
        "note": (
            f"List price as of {PRICE_DATE} (Routes API Compute Route Matrix, assumed $5 per 1,000 elements "
            "after 10,000 free elements per month), verify at developers.google.com/maps/billing-and-pricing/pricing. "
            "Cluster-first planning only needs the matrix inside each territory, so a full refresh costs "
            "Σ(territory size)² elements instead of N²."
        ),
    }
