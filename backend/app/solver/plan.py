"""Plan assembly helpers shared by the optimiser, the baseline and the what-if operations.

A plan is kept as plain JSON-ready dicts shaped exactly like the contract's `Plan` type, so it can
be cached to disk and served without conversion.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

import numpy as np
from shapely.geometry import MultiPoint

from app.data import Dataset
from app.domain import (
    DAY_KEYS,
    DEFAULT_BREAK_MINUTES,
    DEFAULT_DAILY_MINUTES,
    DEFAULT_TARGET_UTILIZATION,
    SHIFT_START,
    min_gap_ok,
    pattern_is_valid,
)
from app.solver.timeline import Schedule, build_schedule


@dataclass(frozen=True)
class Params:
    daily_minutes: int = DEFAULT_DAILY_MINUTES
    break_minutes: int = DEFAULT_BREAK_MINUTES
    target_utilization: float = DEFAULT_TARGET_UTILIZATION
    num_cleaners: int | None = None
    seed: int = 0

    @classmethod
    def from_dict(cls, d: dict | None) -> Params:
        d = {k: v for k, v in (d or {}).items() if v is not None and k in cls.__dataclass_fields__}
        return cls(**d)

    @property
    def work_minutes(self) -> float:
        """Working time available per shift (shift minus break)."""
        return float(self.daily_minutes - self.break_minutes)

    @property
    def planning_budget(self) -> float:
        """Working time the optimiser may fill; the rest is a buffer for absences and new customers."""
        return self.work_minutes * self.target_utilization

    @property
    def shift_end(self) -> float:
        return float(SHIFT_START + self.daily_minutes)

    def public(self) -> dict:
        d = asdict(self)
        d.pop("seed")
        return d


def schedule_for(ds: Dataset, depot: int, stop_ids: list[str], shift_end: float, break_minutes: float) -> Schedule:
    """Timed schedule of depot -> stops -> depot; `feasible` means it ends by `shift_end` and meets windows."""
    bs = [ds.building_by_id[i] for i in stop_ids]
    return build_schedule(
        nodes=[ds.node_of[i] for i in stop_ids],
        depot=depot,
        building_ids=stop_ids,
        services=[float(b["service_minutes"]) for b in bs],
        windows=[tuple(b["time_window"]) if b.get("time_window") else None for b in bs],
        seconds=ds.seconds,
        start=float(SHIFT_START),
        shift_end=shift_end,
        break_minutes=break_minutes,
    )


def make_route(ds: Dataset, cleaner: dict, day_key: str, stop_ids: list[str], params: Params) -> dict:
    depot = cleaner["start"]["node"]
    sch = schedule_for(ds, depot, stop_ids, params.shift_end, float(params.break_minutes))
    nodes = [depot, *[ds.node_of[i] for i in stop_ids], depot]
    geometry, exact = ds.path(nodes) if stop_ids else ("", True)
    exact = exact and not any(ds.node_of[i] in ds.estimated_nodes for i in stop_ids)
    brk = None
    if sch.stops and sch.break_after is not None:
        b0 = sch.stops[sch.break_after].depart
        brk = [b0, b0 + params.break_minutes]
    return {
        "cleaner_id": cleaner["id"],
        "day_key": day_key,
        "stops": [s.__dict__ for s in sch.stops],
        "walk_minutes": sch.walk_minutes,
        "service_minutes": sch.service_minutes,
        "total_minutes": round(sch.total_minutes, 2),
        "start_time": sch.start_time,
        "end_time": sch.end_time,
        "geometry": geometry,
        "geometry_exact": bool(exact),
        "break": brk,  # extra field: [start, end] of the 30-minute break, minutes from midnight
        "feasible": sch.feasible,  # extra field: fits shift and time windows
    }


def hull(ds: Dataset, building_ids: list[str]) -> list[list[float]]:
    pts = [(ds.building_by_id[i]["lng"], ds.building_by_id[i]["lat"]) for i in building_ids]
    if not pts:
        return []
    g = MultiPoint(pts).convex_hull
    if g.geom_type != "Polygon":
        g = g.buffer(0.0008)
    return [[round(lat, 6), round(lng, 6)] for lng, lat in g.exterior.coords]


def territories(ds: Dataset, plan: dict) -> list[dict]:
    members: dict[str, list[str]] = {c["id"]: [] for c in plan["cleaners"]}
    for a in plan["assignments"]:
        members.setdefault(a["cleaner_id"], []).append(a["building_id"])
    return [{"cleaner_id": c, "hull": hull(ds, ids)} for c, ids in members.items()]


def frequency_violations(ds: Dataset, plan: dict) -> int:
    """Buildings whose routed visits (plus visits reported as unassigned) differ from an allowed pattern."""
    seen: dict[str, list[str]] = {b["id"]: [] for b in ds.buildings}
    for r in plan["routes"]:
        for s in r["stops"]:
            seen.setdefault(s["building_id"], []).append(r["day_key"])
    for u in plan.get("unassigned", []):
        seen.setdefault(u["building_id"], []).append(u["day_key"])
    pattern_of = {a["building_id"]: a["pattern"] for a in plan["assignments"]}
    bad = 0
    for b in ds.buildings:
        days = seen.get(b["id"], [])
        pat = pattern_of.get(b["id"])
        ok = (
            pat is not None
            and pattern_is_valid(b["frequency"], pat)
            and sorted(days) == sorted(pat)
            and min_gap_ok(days)
        )
        bad += not ok
    return bad


def kpis(ds: Dataset, plan: dict, params: Params, lower_bound: int) -> dict:
    routes = plan["routes"]
    visits = sum(len(r["stops"]) for r in routes)
    walk = sum(r["walk_minutes"] for r in routes)
    service = sum(r["service_minutes"] for r in routes)
    k = len(plan["cleaners"])
    available = k * len(DAY_KEYS) * params.work_minutes
    return {
        "cleaners": k,
        "lower_bound_cleaners": int(lower_bound),
        "visits": visits,
        "walk_minutes": round(walk, 1),
        "service_minutes": round(service, 1),
        "utilization": round((walk + service) / available, 4) if available else 0.0,
        "avg_walk_per_visit": round(walk / visits, 2) if visits else 0.0,
        "max_route_minutes": round(max((r["total_minutes"] for r in routes), default=0.0), 1),
        "frequency_violations": frequency_violations(ds, plan),
        "unassigned": len(plan.get("unassigned", [])),
    }


def route_signature(r: dict) -> str:
    return json.dumps([r["cleaner_id"], r["day_key"], [s["building_id"] for s in r["stops"]]])


def finalize(ds: Dataset, plan: dict, params: Params, lower_bound: int, solve_seconds: float) -> dict:
    plan["territories"] = territories(ds, plan)
    plan["kpis"] = kpis(ds, plan, params, lower_bound)
    plan["solve_seconds"] = round(solve_seconds, 2)
    plan["params"] = params.public()
    digest = hashlib.sha1("".join(route_signature(r) for r in plan["routes"]).encode()).hexdigest()[:10]
    plan["id"] = f"plan-{digest}"
    plan["created_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    plan["routes"].sort(key=lambda r: (r["cleaner_id"], DAY_KEYS.index(r["day_key"])))
    return plan


def lower_bound_cleaners(ds: Dataset, params: Params) -> int:
    """Lower bound on cleaners: all 2-week service plus the cheapest possible incoming walk of every
    visit, spread perfectly evenly over the 10 days, divided by the planning budget of one shift
    (shift minus break, times the target utilisation). No plan under these rules can use fewer."""
    from app.domain import VISITS_PER_HORIZON

    min_in = ds.min_incoming_minutes()
    total = sum(
        VISITS_PER_HORIZON[b["frequency"]] * (b["service_minutes"] + min_in[ds.node_of[b["id"]]]) for b in ds.buildings
    )
    return int(np.ceil(total / len(DAY_KEYS) / params.planning_budget - 1e-9))
