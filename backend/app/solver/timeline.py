"""Turns a stop sequence into a timed schedule (arrival / depart per stop, break placement).

Break model: the routing model plans the working time (walk + service) within
`shift - break`. The 30-minute break is then placed in the timeline as reserved slack: after the
first stop that ends at or after 11:30 and after every time-windowed stop (all windows in this
dataset end by 12:00), so it never pushes a windowed stop out of its window. If that position is
infeasible for some custom window, every other position is tried. This keeps the routing model a
plain VRPTW (fast, deterministic) while guaranteeing the break fits inside the shift.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

BREAK_EARLIEST = 11 * 60 + 30  # 11:30


@dataclass
class TimedStop:
    building_id: str
    arrival: float  # service start, minutes from midnight
    depart: float
    walk_from_prev: float


@dataclass
class Schedule:
    stops: list[TimedStop]
    walk_minutes: float
    service_minutes: float
    start_time: float
    end_time: float
    break_after: int | None  # index of the stop after which the break is taken
    feasible: bool
    overflow_minutes: float  # how far the end time exceeds the shift end (0 if it fits)

    @property
    def total_minutes(self) -> float:
        return self.end_time - self.start_time

    @property
    def work_minutes(self) -> float:
        return self.walk_minutes + self.service_minutes


def _simulate(walks, services, windows, start, break_after, break_minutes):
    t = start
    times = []
    ok = True
    for k, (w, s, tw) in enumerate(zip(walks[:-1], services, windows)):
        t += w
        if tw is not None:
            t = max(t, tw[0])
            if t + s > tw[1] + 1e-9:
                ok = False
        times.append((t, t + s))
        t += s
        if break_after == k:
            t += break_minutes
    end = t + walks[-1]
    return times, end, ok


def build_schedule(
    nodes: list[int],
    depot: int,
    building_ids: list[str],
    services: list[float],
    windows: list[tuple[float, float] | None],
    seconds: np.ndarray,
    start: float,
    shift_end: float,
    break_minutes: float,
) -> Schedule:
    """Schedule for depot -> nodes... -> depot. Times in minutes. `seconds` is the full node matrix."""
    path = [depot, *nodes, depot]
    walks = [float(seconds[a, b]) / 60.0 for a, b in zip(path, path[1:])]
    n = len(nodes)
    if n == 0:
        return Schedule([], 0.0, 0.0, start, start, None, True, 0.0)

    # preferred break position: after the first stop ending >= 11:30 and after the last windowed stop
    times0, _, _ = _simulate(walks, services, windows, start, None, 0)
    first_late = next((k for k, (_, d) in enumerate(times0) if d >= BREAK_EARLIEST), n - 1)
    last_win = max((k for k, tw in enumerate(windows) if tw is not None), default=-1)
    preferred = max(first_late, last_win)
    candidates = [preferred] + [k for k in range(n) if k != preferred]
    has_late_open = any(tw is not None and tw[0] > start for tw in windows)

    best = None
    for k in candidates:
        times, end, ok = _simulate(walks, services, windows, start, k, break_minutes)
        fits = ok and end <= shift_end + 1e-9
        if best is None or fits:
            best = (k, times, end, ok)
        if fits or (ok and not has_late_open):
            # windows hold but the shift is too long: without waiting, no other break slot is shorter
            break
    k, times, end, ok = best
    stops = [
        TimedStop(bid, round(a, 2), round(d, 2), round(w, 2)) for bid, (a, d), w in zip(building_ids, times, walks[:-1])
    ]
    overflow = max(0.0, end - shift_end)
    return Schedule(
        stops=stops,
        walk_minutes=round(sum(walks), 2),
        service_minutes=float(sum(services)),
        start_time=start,
        end_time=round(end, 2),
        break_after=k,
        feasible=ok and overflow <= 1e-9,
        overflow_minutes=round(overflow, 2),
    )
