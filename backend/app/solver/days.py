"""Day-pattern selection inside one territory (CP-SAT).

Each building picks exactly one allowed pattern for its frequency (so frequency rules hold by
construction). Two lexicographic objectives:

1. minimise the busiest day's estimated load (service + walk estimate) of the territory;
2. with the busiest day fixed (plus a small slack), keep same-day buildings close together: the
   territory is pre-split into 5 compact sub-areas ordered by angle, sub-area k "prefers" weekday k,
   and a pattern costs the circular distance between its weekdays and the preferred one.

Rough time-window feasibility: morning-only work per day is capped to what fits before 12:00.
Deterministic: single worker, fixed seed, deterministic time limit.
"""

from __future__ import annotations

import math

import numpy as np
from ortools.sat.python import cp_model

from app.domain import DAY_KEYS, PATTERNS, WEEKDAYS
from app.solver.territories import balanced_clusters, to_xy

SCALE = 10  # CP-SAT works on integers: tenths of a minute
DET_TIME = 0.15  # deterministic time limit per CP-SAT phase (reproducible, unlike wall-clock limits)


def preferred_weekday(latlng: np.ndarray, weights: np.ndarray, seed: int) -> np.ndarray:
    """Split a territory into 5 balanced compact sub-areas, numbered by angle around the centroid."""
    n = len(latlng)
    if n < 5:
        return np.arange(n) % 5
    labels = balanced_clusters(latlng, weights, 5, seed=seed, tol=0.15, iters=4)
    xy = to_xy(latlng)
    c = xy.mean(axis=0)
    ang = [math.atan2(*(xy[labels == k].mean(axis=0) - c)[::-1]) for k in range(5)]
    rank = np.empty(5, dtype=int)
    rank[np.argsort(ang)] = np.arange(5)
    return rank[labels]


def _circ(a: int, b: int) -> int:
    d = abs(a - b) % 5
    return min(d, 5 - d)


def assign_days(
    buildings: list[dict],
    walk_est: np.ndarray,
    morning_capacity: float,
    seed: int = 0,
    balance_slack: float = 0.05,
) -> dict[str, list[str]]:
    """Return {building_id: pattern (list of day_keys)}."""
    if not buildings:
        return {}
    latlng = np.array([[b["lat"], b["lng"]] for b in buildings])
    pref = preferred_weekday(latlng, np.array([b["service_minutes"] for b in buildings], dtype=float), seed)
    load = [int(round((b["service_minutes"] + w) * SCALE)) for b, w in zip(buildings, walk_est)]

    m = cp_model.CpModel()
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    day_terms: dict[str, list] = {d: [] for d in DAY_KEYS}
    morning_terms: dict[str, list] = {d: [] for d in DAY_KEYS}
    mismatch = []
    for i, b in enumerate(buildings):
        pats = PATTERNS[b["frequency"]]
        vs = []
        for p, days in enumerate(pats):
            v = m.NewBoolVar(f"x{i}_{p}")
            x[i, p] = v
            vs.append(v)
            for d in days:
                day_terms[d].append(load[i] * v)
                if b.get("time_window"):
                    morning_terms[d].append(int(b["service_minutes"] * SCALE) * v)
            weekdays = {WEEKDAYS.index(d.split("-")[1]) for d in days}
            cost = sum(_circ(int(pref[i]), wd) for wd in weekdays) * 10 // len(weekdays)
            if cost:
                mismatch.append(cost * v)
        m.AddExactlyOne(vs)

    total = sum(load[i] * len(PATTERNS[b["frequency"]][0]) for i, b in enumerate(buildings))
    peak = m.NewIntVar(0, total, "peak")
    for d in DAY_KEYS:
        if day_terms[d]:
            m.Add(sum(day_terms[d]) <= peak)
        if morning_terms[d]:
            m.Add(sum(morning_terms[d]) <= int(morning_capacity * SCALE))

    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = seed
    solver.parameters.max_deterministic_time = DET_TIME
    solver.parameters.max_time_in_seconds = 20.0

    m.Minimize(peak)
    status = solver.Solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # morning caps too tight for this territory: drop them rather than fail
        return assign_days([{**b, "time_window": None} for b in buildings], walk_est, 1e9, seed)
    best_peak = solver.Value(peak)
    m.Add(peak <= int(best_peak * (1 + balance_slack)) + SCALE)
    if mismatch:
        m.ClearObjective()
        m.Minimize(sum(mismatch))
        for v in x.values():
            m.AddHint(v, solver.BooleanValue(v))
        status = solver.Solve(m)

    out = {}
    for i, b in enumerate(buildings):
        pats = PATTERNS[b["frequency"]]
        p = next(p for p in range(len(pats)) if solver.BooleanValue(x[i, p]))
        out[b["id"]] = list(pats[p])
    return out
