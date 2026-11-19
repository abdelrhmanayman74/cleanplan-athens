"""Single-cleaner, single-day routing with OR-Tools (VRPTW with one vehicle and droppable stops).

Each (cleaner, day_key) is an independent problem because territories and day patterns are fixed
upstream, so the routes are solved in parallel in a process pool.

Determinism: PATH_CHEAPEST_ARC + GUIDED_LOCAL_SEARCH stopped by a *solution limit* (a count of
search steps, independent of machine speed). The 1 s wall-clock limit is only a safety net that
small daily routes (≈10 stops) never reach.
"""

from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from multiprocessing import get_context

import numpy as np
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

DROP_PENALTY = 10_000_000  # seconds-equivalent; only paid when a stop cannot fit in the shift
SOLUTION_LIMIT = 100
TIME_LIMIT_S = 1.0


@dataclass
class RouteTask:
    """Picklable routing problem. Index 0 of `seconds` is the depot; times are in seconds."""

    key: tuple[str, str]  # (cleaner_id, day_key)
    seconds: np.ndarray  # (n+1, n+1) walking seconds, depot first
    service: list[int]  # per stop, seconds
    windows: list[tuple[int, int] | None]  # per stop, service must start >= a and end <= b
    start: int  # shift start, seconds from midnight
    horizon_end: int  # latest return to depot (shift end minus break), seconds from midnight
    solution_limit: int = SOLUTION_LIMIT
    time_limit_s: float = TIME_LIMIT_S


def build_task(ds, key: tuple[str, str], depot: int, ids: list[str], horizon_minutes: float) -> RouteTask:
    """RouteTask for depot -> buildings `ids` -> depot with `horizon_minutes` of working time."""
    from app.domain import SHIFT_START

    nodes = [depot, *ds.building_nodes(ids)]
    bs = [ds.building_by_id[i] for i in ids]
    return RouteTask(
        key=key,
        seconds=ds.seconds[np.ix_(nodes, nodes)],
        service=[int(b["service_minutes"] * 60) for b in bs],
        windows=[(b["time_window"][0] * 60, b["time_window"][1] * 60) if b.get("time_window") else None for b in bs],
        start=SHIFT_START * 60,
        horizon_end=int((SHIFT_START + horizon_minutes) * 60),
    )


@dataclass
class RouteResult:
    key: tuple[str, str]
    order: list[int]  # stop indices (0-based into the task's stop list) in visiting order
    dropped: list[int]


def solve_route(task: RouteTask) -> RouteResult:
    n = len(task.service)
    if n == 0:
        return RouteResult(task.key, [], [])
    mgr = pywrapcp.RoutingIndexManager(n + 1, 1, 0)
    model = pywrapcp.RoutingModel(mgr)
    sec = task.seconds.astype(int)
    service = np.array([0, *task.service], dtype=int)
    # Matrix callbacks are evaluated in C++ (much faster than Python callbacks during local search).
    walk_idx = model.RegisterTransitMatrix(sec.tolist())
    time_idx = model.RegisterTransitMatrix((sec + service[:, None]).tolist())
    model.SetArcCostEvaluatorOfAllVehicles(walk_idx)
    horizon = task.horizon_end
    model.AddDimension(time_idx, horizon, horizon, False, "Time")
    time_dim = model.GetDimensionOrDie("Time")
    time_dim.CumulVar(model.Start(0)).SetRange(task.start, task.start)
    time_dim.CumulVar(model.End(0)).SetRange(task.start, horizon)
    for k, tw in enumerate(task.windows):
        idx = mgr.NodeToIndex(k + 1)
        lo, hi = (
            (task.start, horizon - task.service[k]) if tw is None else (max(tw[0], task.start), tw[1] - task.service[k])
        )
        if hi < lo:  # window can never be met: the stop will be dropped
            hi = lo
        time_dim.CumulVar(idx).SetRange(lo, hi)
        model.AddDisjunction([idx], DROP_PENALTY)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.solution_limit = task.solution_limit
    params.time_limit.FromMilliseconds(int(task.time_limit_s * 1000))
    sol = model.SolveWithParameters(params)
    if sol is None:
        return RouteResult(task.key, [], list(range(n)))
    order = []
    i = model.Start(0)
    while not model.IsEnd(i):
        node = mgr.IndexToNode(i)
        if node != 0:
            order.append(node - 1)
        i = sol.Value(model.NextVar(i))
    dropped = sorted(set(range(n)) - set(order))
    return RouteResult(task.key, order, dropped)


_POOL: ProcessPoolExecutor | None = None


def _pool() -> ProcessPoolExecutor:
    global _POOL
    if _POOL is None:
        workers = max(1, min(12, (os.cpu_count() or 2)))
        _POOL = ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn"))
    return _POOL


def solve_routes(tasks: list[RouteTask], parallel: bool = True) -> dict[tuple[str, str], RouteResult]:
    """Solve many independent routes; results are identical whether run in parallel or not."""
    nonempty = [t for t in tasks if t.service]
    out = {t.key: RouteResult(t.key, [], []) for t in tasks if not t.service}
    if parallel and len(nonempty) > 4:
        chunk = max(1, len(nonempty) // (4 * (os.cpu_count() or 2)))
        for r in _pool().map(solve_route, nonempty, chunksize=chunk):
            out[r.key] = r
    else:
        for t in nonempty:
            out[t.key] = solve_route(t)
    return out


def shutdown_pool() -> None:
    global _POOL
    if _POOL is not None:
        _POOL.shutdown(cancel_futures=True)
        _POOL = None
