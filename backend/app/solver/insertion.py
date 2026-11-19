"""Cheapest feasible insertion of one visit into an existing route (shared by repair, absence, insert)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.data import Dataset
from app.domain import SHIFT_START
from app.solver.plan import schedule_for
from app.solver.timeline import Schedule


@dataclass
class Insertion:
    position: int  # index in the stop list where the new stop goes
    added_walk_minutes: float
    schedule: Schedule

    def slack(self, shift_end: float) -> float:
        return shift_end - self.schedule.end_time


def best_insertion(
    ds: Dataset,
    depot: int,
    stop_ids: list[str],
    new_id: str,
    shift_end: float,
    break_minutes: float,
) -> Insertion | None:
    """Cheapest position (by added walking) at which `new_id` fits the shift and all time windows."""
    path = np.array([depot, *[ds.node_of[i] for i in stop_ids], depot])
    x = ds.node_of[new_id]
    sec = ds.seconds
    a, b = path[:-1], path[1:]
    delta = (sec[a, x].astype(float) + sec[x, b] - sec[a, b]) / 60.0
    # quick capacity check: with no waiting, end = start + walk + service + break
    walk = float(sec[a, b].sum()) / 60.0
    service = sum(float(ds.building_by_id[i]["service_minutes"]) for i in [*stop_ids, new_id])
    slack = shift_end - (SHIFT_START + walk + service + break_minutes)
    for pos in np.argsort(delta, kind="stable"):
        if delta[pos] > slack + 1e-9:
            break
        pos = int(pos)
        ids = [*stop_ids[:pos], new_id, *stop_ids[pos:]]
        sch = schedule_for(ds, depot, ids, shift_end, break_minutes)
        if sch.feasible:
            # estimated (Haversine) legs can break the triangle inequality: never report negative walk
            return Insertion(pos, round(max(0.0, float(delta[pos])), 2), sch)
    return None
