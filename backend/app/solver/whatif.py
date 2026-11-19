"""What-if operations on an existing plan, designed for minimal churn.

* absence: one cleaner is off on one day. Only that route's visits move, each by cheapest feasible
  insertion into a colleague working the same day (closest territories first), within the full
  shift. Only receiving routes are re-sequenced; every other route stays byte-identical.
* insert: a new customer. Every (cleaner, allowed pattern) is scored by cheapest insertion with
  Haversine travel-time *estimates* (the building is not in the OSRM matrix); commit inserts the
  visits without moving any existing building.
"""

from __future__ import annotations

import copy
import hashlib

import numpy as np

from app.data import Dataset
from app.domain import DAY_KEYS, PATTERNS, pattern_is_valid
from app.solver.insertion import best_insertion
from app.solver.plan import Params, kpis, make_route, route_signature, schedule_for, territories
from app.solver.routing import build_task, solve_route
from app.travel import haversine_m

MAX_RECEIVERS = 8  # absence: colleagues considered, closest territories first
MAX_INSERT_CLEANERS = 10  # insert: territories considered, closest first


def _territory_centroids(ds: Dataset, plan: dict) -> dict[str, np.ndarray]:
    pts: dict[str, list] = {}
    for a in plan["assignments"]:
        b = ds.building_by_id[a["building_id"]]
        pts.setdefault(a["cleaner_id"], []).append([b["lat"], b["lng"]])
    return {c: np.mean(v, axis=0) for c, v in pts.items()}


def _resequence(ds: Dataset, depot: int, ids: list[str], params: Params) -> list[str]:
    """OR-Tools re-sequencing within the full shift; keeps the given order if that is not better."""
    if len(ids) < 3:
        return ids
    task = build_task(ds, ("", ""), depot, ids, params.work_minutes)
    res = solve_route(task)
    if res.dropped:
        return ids
    new = [ids[i] for i in res.order]
    old_s = schedule_for(ds, depot, ids, params.shift_end, params.break_minutes)
    new_s = schedule_for(ds, depot, new, params.shift_end, params.break_minutes)
    return new if new_s.feasible and new_s.walk_minutes < old_s.walk_minutes else ids


def _change_result(
    ds: Dataset, before: dict, after: dict, params: Params, changes: list[dict], churn: int, message: str
) -> dict:
    sig_before = {(r["cleaner_id"], r["day_key"]): route_signature(r) for r in before["routes"]}
    untouched = sum(1 for r in after["routes"] if sig_before.get((r["cleaner_id"], r["day_key"])) == route_signature(r))
    return {
        "plan": after,
        "changes": changes,
        "churn": churn,
        "untouched_routes": untouched,
        "kpis_before": before["kpis"],
        "kpis_after": after["kpis"],
        "message": message,
    }


# ---------------------------------------------------------------------------------------------
def apply_absence(ds: Dataset, plan: dict, params: Params, cleaner_id: str, day_key: str) -> dict:
    if day_key not in DAY_KEYS:
        raise ValueError(f"unknown day_key {day_key}")
    cleaners = {c["id"]: c for c in plan["cleaners"]}
    if cleaner_id not in cleaners:
        raise ValueError(f"unknown cleaner {cleaner_id}")
    routes = {(r["cleaner_id"], r["day_key"]): r for r in plan["routes"]}
    absent = routes[(cleaner_id, day_key)]
    to_move = [s["building_id"] for s in absent["stops"]]

    cents = _territory_centroids(ds, plan)
    me = cents.get(cleaner_id, np.array([cleaners[cleaner_id]["start"]["lat"], cleaners[cleaner_id]["start"]["lng"]]))
    others = sorted(
        (c for c in cleaners if c != cleaner_id and c in cents), key=lambda c: (float(np.sum((cents[c] - me) ** 2)), c)
    )
    receivers = others[:MAX_RECEIVERS]
    work = {c: [s["building_id"] for s in routes[(c, day_key)]["stops"]] for c in receivers}

    # hardest visits first: time-windowed, then long service
    def difficulty(b: str) -> tuple:
        bb = ds.building_by_id[b]
        return (bb.get("time_window") is None, -bb["service_minutes"], b)

    changes, unassigned = [], []
    for b in sorted(to_move, key=difficulty):
        best = None
        for c in receivers:
            ins = best_insertion(ds, cleaners[c]["start"]["node"], work[c], b, params.shift_end, params.break_minutes)
            if ins and (best is None or ins.added_walk_minutes < best[1].added_walk_minutes):
                best = (c, ins)
        if best is None:
            unassigned.append(
                {"building_id": b, "day_key": day_key, "reason_code": "needs_overtime", "reason": "needs overtime"}
            )
            changes.append(
                {
                    "building_id": b,
                    "day_key": day_key,
                    "from_cleaner": cleaner_id,
                    "to_cleaner": None,
                    "added_walk": 0.0,
                }
            )
            continue
        c, ins = best
        work[c].insert(ins.position, b)
        changes.append(
            {
                "building_id": b,
                "day_key": day_key,
                "from_cleaner": cleaner_id,
                "to_cleaner": c,
                "added_walk": ins.added_walk_minutes,
            }
        )

    after = copy.deepcopy(plan)
    receiving = {ch["to_cleaner"] for ch in changes if ch["to_cleaner"]}
    new_routes = []
    for r in after["routes"]:
        key = (r["cleaner_id"], r["day_key"])
        if key == (cleaner_id, day_key):
            r = make_route(ds, cleaners[cleaner_id], day_key, [], params)
            r["absent"] = True  # extra field: this route's cleaner is off
        elif r["day_key"] == day_key and r["cleaner_id"] in receiving:
            ids = _resequence(ds, cleaners[r["cleaner_id"]]["start"]["node"], work[r["cleaner_id"]], params)
            r = make_route(ds, cleaners[r["cleaner_id"]], day_key, ids, params)
        new_routes.append(r)
    after["routes"] = new_routes
    after["unassigned"] = [*plan.get("unassigned", []), *unassigned]
    after["kpis"] = kpis(ds, after, params, plan["kpis"]["lower_bound_cleaners"])
    after["id"] = f"{plan['id']}+abs-{cleaner_id}-{day_key}"

    moved = sum(1 for ch in changes if ch["to_cleaner"])
    msg = (
        f"{cleaners[cleaner_id]['name']} absent on {day_key}: {moved} of {len(to_move)} visits reassigned to "
        f"{len(receiving)} colleague(s) working that day"
        + (f"; {len(unassigned)} need overtime" if unassigned else "")
        + ". All other routes unchanged."
    )
    return _change_result(ds, plan, after, params, changes, churn=len(changes), message=msg)


def suggest_absence(ds: Dataset, plan: dict, params: Params, day_key: str) -> dict | None:
    """A clear showcase for the one-click demo: an absence on `day_key` whose visits are all absorbed
    by 3-4 colleagues on real street geometry, with the least extra walking."""
    best = None
    for r in plan["routes"]:
        if r["day_key"] != day_key or len(r["stops"]) < 7:
            continue
        res = apply_absence(ds, plan, params, r["cleaner_id"], day_key)
        after = res["plan"]
        receivers = {ch["to_cleaner"] for ch in res["changes"]}
        changed = [x for x in after["routes"] if x["day_key"] == day_key and x["cleaner_id"] in receivers]
        if None in receivers or not 3 <= len(receivers) <= 4 or not all(x["geometry_exact"] for x in changed):
            continue
        key = (after["kpis"]["walk_minutes"] - plan["kpis"]["walk_minutes"], r["cleaner_id"])
        if best is None or key < best[0]:
            best = (key, {"cleaner_id": r["cleaner_id"], "day_key": day_key})
    return best[1] if best else None


# ---------------------------------------------------------------------------------------------
def new_building_record(ds: Dataset, nb: dict, building_id: str) -> dict:
    """A Building record for a what-if customer (fields the user did not give are placeholders)."""
    p = np.array([[nb["lat"], nb["lng"]]])
    bxy = np.array([[b["lat"], b["lng"]] for b in ds.buildings])
    d = haversine_m(p, bxy)[0]
    nearest = ds.buildings[int(np.argmin(d))]
    walk_s = np.sort(d)[:3] * ds.haversine.detour_factor / ds.haversine.speed_mps
    service = int(nb["service_minutes"])
    return {
        "id": building_id,
        "name": nb.get("name") or "Νέο κτίριο (what-if)",
        "street": "",
        "number": "",
        "postcode": None,
        "neighborhood": nearest["neighborhood"],
        "lat": float(nb["lat"]),
        "lng": float(nb["lng"]),
        "floors": int(max(2, min(8, round((service - 15) / 3.5)))),
        "has_lift": True,
        "service_minutes": service,
        "frequency": nb["frequency"],
        "time_window": list(nb["time_window"]) if nb.get("time_window") else None,
        "manager": {"name": "", "phone": ""},
        "access_note": "",
        "tasks": ["Σκάλες", "Είσοδος"],
        "isolated": bool(len(walk_s) >= 3 and walk_s[2] > 15 * 60),
        "estimated": True,  # extra field: travel times are Haversine estimates, not OSRM
    }


def _candidate_id(nb: dict) -> str:
    h = hashlib.sha1(f"{nb['lat']:.6f},{nb['lng']:.6f},{nb['frequency']},{nb['service_minutes']}".encode()).hexdigest()[
        :6
    ]
    return f"new-{h}"


def _evaluate(ds: Dataset, plan: dict, params: Params, cleaner: dict, bid: str, pattern: list[str]) -> dict:
    routes = {(r["cleaner_id"], r["day_key"]): r for r in plan["routes"]}
    added, slack, feasible = 0.0, np.inf, True
    depot = cleaner["start"]["node"]
    for d in pattern:
        ids = [s["building_id"] for s in routes[(cleaner["id"], d)]["stops"]]
        ins = best_insertion(ds, depot, ids, bid, params.shift_end, params.break_minutes)
        if ins is None:
            # not feasible: report the cheapest position anyway and how much it would overrun
            feasible = False
            best = None
            base = schedule_for(ds, depot, ids, params.shift_end, params.break_minutes)
            for pos in range(len(ids) + 1):
                trial = [*ids[:pos], bid, *ids[pos:]]
                s = schedule_for(ds, depot, trial, params.shift_end, params.break_minutes)
                cand = (s.walk_minutes - base.walk_minutes, params.shift_end - s.end_time)
                if best is None or cand[0] < best[0]:
                    best = cand
            added += best[0]
            slack = min(slack, best[1])
        else:
            added += ins.added_walk_minutes
            slack = min(slack, ins.slack(params.shift_end))
    return {
        "cleaner_id": cleaner["id"],
        "day_keys": list(pattern),
        "added_walk_minutes": round(added, 1),
        "feasible": feasible,
        "slack_after": round(float(slack), 1),
    }


def insert_candidates(ds: Dataset, plan: dict, params: Params, nb: dict, top: int = 3, provider=None) -> list[dict]:
    """Top options (best pattern per cleaner, distinct cleaners) for a new building; plan unchanged."""
    bid = _candidate_id(nb)
    ds2 = ds.with_building(new_building_record(ds, nb, bid), provider)
    cents = _territory_centroids(ds, plan)
    p = np.array([nb["lat"], nb["lng"]])
    near = sorted(cents, key=lambda c: (float(np.sum((cents[c] - p) ** 2)), c))[:MAX_INSERT_CLEANERS]
    cleaners = {c["id"]: c for c in plan["cleaners"]}
    per_cleaner = []
    for c in near:
        options = [_evaluate(ds2, plan, params, cleaners[c], bid, pat) for pat in PATTERNS[nb["frequency"]]]
        per_cleaner.append(min(options, key=lambda o: (not o["feasible"], o["added_walk_minutes"], -o["slack_after"])))
    per_cleaner.sort(key=lambda o: (not o["feasible"], o["added_walk_minutes"], -o["slack_after"], o["cleaner_id"]))
    return per_cleaner[:top]


def commit_insert(
    ds: Dataset, plan: dict, params: Params, nb: dict, candidate: dict, building_id: str, provider=None
) -> tuple[Dataset, dict]:
    """Insert the new building's visits into the chosen cleaner's routes. Returns (dataset, ChangeResult)."""
    cleaners = {c["id"]: c for c in plan["cleaners"]}
    cid = candidate["cleaner_id"]
    days = list(candidate["day_keys"])
    if cid not in cleaners:
        raise ValueError(f"unknown cleaner {cid}")
    if not pattern_is_valid(nb["frequency"], days):
        raise ValueError(f"{days} is not an allowed pattern for frequency {nb['frequency']}")
    record = new_building_record(ds, nb, building_id)
    ds2 = ds.with_building(record, provider)

    after = copy.deepcopy(plan)
    changes = []
    overtime = []
    for i, r in enumerate(after["routes"]):
        if r["cleaner_id"] != cid or r["day_key"] not in days:
            continue
        ids = [s["building_id"] for s in r["stops"]]
        ins = best_insertion(
            ds2, cleaners[cid]["start"]["node"], ids, building_id, params.shift_end, params.break_minutes
        )
        if ins is None:  # user chose an infeasible option: cheapest position, route flagged as overtime
            path = [cleaners[cid]["start"]["node"], *ds2.building_nodes(ids), cleaners[cid]["start"]["node"]]
            x = ds2.node_of[building_id]
            deltas = [ds2.seconds[a, x] + ds2.seconds[x, b] - ds2.seconds[a, b] for a, b in zip(path, path[1:])]
            pos, added = int(np.argmin(deltas)), float(min(deltas)) / 60.0
            overtime.append(r["day_key"])
        else:
            pos, added = ins.position, ins.added_walk_minutes
        ids.insert(pos, building_id)
        after["routes"][i] = make_route(ds2, cleaners[cid], r["day_key"], ids, params)
        changes.append(
            {
                "building_id": building_id,
                "day_key": r["day_key"],
                "from_cleaner": None,
                "to_cleaner": cid,
                "added_walk": round(added, 2),
            }
        )
    after["assignments"].append({"building_id": building_id, "cleaner_id": cid, "pattern": days})
    after["territories"] = territories(ds2, after)
    after["kpis"] = kpis(ds2, after, params, plan["kpis"]["lower_bound_cleaners"])
    after["id"] = f"{plan['id']}+{building_id}"
    msg = (
        f"Added {record['name']} ({nb['frequency']}) to {cleaners[cid]['name']} on {', '.join(days)}; "
        f"no existing building changed cleaner or day. Travel times for the new address are estimates."
        + (f" Overtime needed on {', '.join(overtime)}." if overtime else "")
    )
    return ds2, _change_result(ds2, plan, after, params, changes, churn=0, message=msg)
