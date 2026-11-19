"""Full plan optimisation: workforce size -> territories -> day patterns -> routes -> repair.

    K (auto: smallest that fits)            app/solver/plan.py::lower_bound_cleaners
      └─ territories (balanced, compact)    app/solver/territories.py
           └─ day patterns per territory    app/solver/days.py        (CP-SAT)
                └─ one route per day        app/solver/routing.py     (OR-Tools, process pool)
                     └─ repair overflows    this module (re-pattern, move edge buildings)

Cluster-first / route-second keeps every sub-problem small (≈35 buildings, ≈10 stops a day), so the
whole 2-week plan for 1,000 buildings solves in seconds and is deterministic.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from app.data import Dataset
from app.domain import DAY_KEYS, MORNING_WINDOW, PATTERNS, SHIFT_START, VISITS_PER_HORIZON
from app.solver.cleaners import HOME_IF_STATION_FARTHER_THAN_S, choose_start, cleaner_colors, cleaner_names
from app.solver.days import assign_days
from app.solver.insertion import best_insertion
from app.solver.plan import Params, finalize, lower_bound_cleaners, make_route
from app.solver.routing import build_task, solve_routes
from app.solver.territories import balanced_clusters

GROUP_GAP_MIN = 6.0  # areas more than 6 minutes' walk apart never share a territory
SKIP_REPAIR_SHARE = 0.25  # if more routes than this overflow, add a cleaner instead of repairing
MORNING_FILL = 0.8  # share of the 07:00-12:00 window usable for morning-only service (rest: walking)
EDGE_CANDIDATES = 10  # edge buildings tried per overflowing route
DEPOT_LEG_FACTOR = 1.4  # daily start+end legs ≈ 1.4 x mean walk from the start point to the territory
WALK_EST_FACTOR = 1.6  # per-visit walk ≈ factor x mean walk to the 4 nearest buildings (calibrated on routes)


def walk_estimates(ds: Dataset, ids: list[str]) -> np.ndarray:
    """Per-visit walking estimate (minutes) from local building density."""
    nodes = ds.building_nodes(ids)
    sub = ds.seconds[np.ix_(nodes, nodes)].astype(float)
    np.fill_diagonal(sub, np.inf)
    near = np.sort(sub, axis=1)[:, :4].mean(axis=1) / 60.0
    return np.clip(near * WALK_EST_FACTOR, 1.0, 20.0)


@dataclass
class State:
    """Mutable working state of one optimisation attempt."""

    ds: Dataset
    params: Params
    cleaners: list[dict]
    owner: dict[str, str]  # building id -> cleaner id
    pattern: dict[str, list[str]]  # building id -> day keys
    stops: dict[tuple[str, str], list[str]]  # (cleaner id, day key) -> ordered building ids
    unassigned: list[dict] = field(default_factory=list)

    @property
    def cleaner_by_id(self) -> dict[str, dict]:
        return {c["id"]: c for c in self.cleaners}

    def depot(self, cid: str) -> int:
        return self.cleaner_by_id[cid]["start"]["node"]

    @property
    def plan_end(self) -> float:
        """Latest return to the start point allowed while planning (budget + break)."""
        return SHIFT_START + self.params.break_minutes + self.params.planning_budget


# ---------------------------------------------------------------------------------------------
def _route_all(st: State, keys: list[tuple[str, str]]) -> dict[tuple[str, str], list[str]]:
    """Re-sequence the given routes; returns the dropped building ids per route."""
    tasks = [build_task(st.ds, (c, d), st.depot(c), st.stops[(c, d)], st.params.planning_budget) for c, d in keys]
    results = solve_routes(tasks)
    dropped = {}
    for (c, d), r in results.items():
        ids = st.stops[(c, d)]
        st.stops[(c, d)] = [ids[i] for i in r.order]
        if r.dropped:
            dropped[(c, d)] = [ids[i] for i in r.dropped]
    return dropped


def _remove(st: State, bid: str) -> None:
    for d in st.pattern[bid]:
        ids = st.stops[(st.owner[bid], d)]
        if bid in ids:
            ids.remove(bid)


def _best_pattern(st: State, bid: str, cid: str, exclude_days: frozenset[str] = frozenset()):
    """Cheapest allowed pattern for `bid` (currently unrouted) inside territory `cid`, or None.

    Returns (added walk minutes, pattern, {day: insert position})."""
    best = None
    for pat in PATTERNS[st.ds.building_by_id[bid]["frequency"]]:
        if exclude_days & set(pat):
            continue
        total, pos = 0.0, {}
        for d in pat:
            ins = best_insertion(st.ds, st.depot(cid), st.stops[(cid, d)], bid, st.plan_end, st.params.break_minutes)
            if ins is None:
                break
            total += ins.added_walk_minutes
            pos[d] = ins.position
        else:
            if best is None or total < best[0]:
                best = (total, pat, pos)
    return best


def _place(st: State, bid: str, cid: str, found, touched: set) -> None:
    _, pat, pos = found
    for d in pat:
        st.stops[(cid, d)].insert(pos[d], bid)
        touched.add((cid, d))
    st.owner[bid] = cid
    st.pattern[bid] = list(pat)


def _place_anywhere(st: State, bid: str, territories: list[str], touched: set) -> bool:
    for cid in territories:
        found = _best_pattern(st, bid, cid)
        if found:
            _place(st, bid, cid, found, touched)
            return True
    return False


def _neighbour_territories(st: State, bid: str, k: int = 3) -> tuple[list[str], float]:
    """Territories of the nearest buildings owned by someone else, and the walk (s) to the nearest one."""
    ds = st.ds
    me = st.owner[bid]
    others = [b for b, c in st.owner.items() if c != me]
    if not others:
        return [], np.inf
    row = ds.seconds[ds.node_of[bid], ds.building_nodes(others)]
    out: list[str] = []
    for j in np.argsort(row, kind="stable"):
        c = st.owner[others[j]]
        if c not in out:
            out.append(c)
            if len(out) == k:
                break
    return out, float(row.min())


def _make_room(st: State, cid: str, day: str, touched: set) -> bool:
    """Free time on route (cid, day) by moving one visit off it: first another allowed pattern in the
    same territory, otherwise an edge building (closest to a neighbour) into a neighbouring territory."""
    unassigned = {u["building_id"] for u in st.unassigned}  # partly placed buildings stay where they are
    members = [b for b in st.stops[(cid, day)] if b not in unassigned]
    edge = sorted(members, key=lambda b: (_neighbour_territories(st, b)[1], b))
    for e in edge[:EDGE_CANDIDATES]:
        snapshot = {(cid, d): list(st.stops[(cid, d)]) for d in st.pattern[e]}
        _remove(st, e)
        found = _best_pattern(st, e, cid, exclude_days=frozenset({day}))
        if found:
            _place(st, e, cid, found, touched)
            touched.update(snapshot)
            return True
        for target in _neighbour_territories(st, e)[0]:
            found = _best_pattern(st, e, target)
            if found:
                _place(st, e, target, found, touched)
                touched.update(snapshot)
                return True
        st.stops.update(snapshot)  # nothing worked: put it back exactly where it was
    return False


def _repair(st: State, dropped: dict[tuple[str, str], list[str]]) -> set[tuple[str, str]]:
    """Place the visits the router could not fit; returns the routes that changed.

    A building keeps one cleaner and one pattern, so a dropped visit means re-placing the whole
    building: (1) another allowed pattern in its own territory; (2) make room on its busiest days
    by moving other visits (re-pattern or edge building to a neighbour) and retry; (3) move the
    building itself to a neighbouring territory; (4) keep the visits that fit and report the rest
    as unassigned.
    """
    touched: set[tuple[str, str]] = set()
    for bid in sorted({b for ids in dropped.values() for b in ids}):
        cid, pat_old = st.owner[bid], list(st.pattern[bid])
        _remove(st, bid)
        touched.update((cid, d) for d in pat_old)
        if _place_anywhere(st, bid, [cid], touched):
            continue
        placed = False
        for _ in range(EDGE_CANDIDATES):
            blocking = [
                d
                for d in pat_old
                if best_insertion(st.ds, st.depot(cid), st.stops[(cid, d)], bid, st.plan_end, st.params.break_minutes)
                is None
            ]
            if not blocking or not _make_room(st, cid, blocking[0], touched):
                break
            if _place_anywhere(st, bid, [cid], touched):
                placed = True
                break
        if placed or _place_anywhere(st, bid, _neighbour_territories(st, bid)[0], touched):
            continue
        for d in pat_old:
            ins = best_insertion(st.ds, st.depot(cid), st.stops[(cid, d)], bid, st.plan_end, st.params.break_minutes)
            if ins:
                st.stops[(cid, d)].insert(ins.position, bid)
            else:
                st.unassigned.append(
                    {
                        "building_id": bid,
                        "day_key": d,
                        "reason_code": "no_capacity",
                        "reason": "no capacity in territory or neighbours",
                    }
                )
        st.pattern[bid] = pat_old
    return touched


# ---------------------------------------------------------------------------------------------
def natural_groups(ds: Dataset, ids: list[str], loads: np.ndarray, min_share: float) -> list[list[str]]:
    """Split buildings into areas separated by more than GROUP_GAP_MIN of walking (single linkage).

    Territories never cross between groups, so no cleaner's territory bridges two neighbourhoods
    that are far apart. Groups too small to keep one cleaner busy (< `min_share` of a territory's
    load) are merged into the nearest group.
    """
    nodes = ds.building_nodes(ids)
    sec = ds.seconds[np.ix_(nodes, nodes)].astype(float)
    sym = np.maximum(sec, sec.T) / 60.0
    _, lab = connected_components(csr_matrix(sym <= GROUP_GAP_MIN), directed=False)
    while True:
        g_load = np.bincount(lab, weights=loads)
        small = [g for g in np.unique(lab) if g_load[g] < min_share]
        if not small or len(np.unique(lab)) == 1:
            break
        g = min(small, key=lambda g: (g_load[g], g))
        inside = lab == g
        nearest = np.argmin(np.where(inside[None, :], np.inf, sym[inside]).min(axis=0))
        lab[inside] = lab[nearest]
    groups: dict[int, list[str]] = {}
    for i, g in zip(ids, lab):
        groups.setdefault(int(g), []).append(i)
    return sorted(groups.values(), key=lambda m: m[0])


def _attempt(ds: Dataset, params: Params, ids: list[str], k: int, tag: str, quick_reject: bool = True) -> State:
    """Territories + day patterns + routes + repair for one group of buildings and `k` cleaners."""
    bs = [ds.building_by_id[i] for i in ids]
    walk = walk_estimates(ds, ids)
    workload = np.array([VISITS_PER_HORIZON[b["frequency"]] * (b["service_minutes"] + w) for b, w in zip(bs, walk)])
    latlng = np.array([[b["lat"], b["lng"]] for b in bs])
    station_nodes = np.array(ds.station_nodes())
    bnodes = np.array(ds.building_nodes(ids))

    def depot_overhead(labels: np.ndarray) -> np.ndarray:
        """2-week walking to/from the start point, per territory (see DEPOT_LEG_FACTOR)."""
        out = np.zeros(k)
        for c in range(k):
            m = bnodes[labels == c]
            if len(m):
                mean = ds.seconds[np.ix_(station_nodes, m)].mean(axis=1).min() / 60.0
                out[c] = min(mean, HOME_IF_STATION_FARTHER_THAN_S / 60.0) * DEPOT_LEG_FACTOR * len(DAY_KEYS)
        return out

    labels = balanced_clusters(latlng, workload, k, seed=params.seed, tol=0.04, overhead=depot_overhead)
    cleaners, owner, members = [], {}, {}
    for c in range(k):
        cid = f"{tag}{c:02d}"
        mem = [ids[i] for i in np.where(labels == c)[0]]
        members[cid] = mem
        owner.update({b: cid for b in mem})
        cleaners.append(
            {"id": cid, "start": choose_start(ds, ds.building_nodes(mem)), "daily_minutes": params.daily_minutes}
        )

    morning_cap = (MORNING_WINDOW[1] - SHIFT_START) * MORNING_FILL
    walk_of = dict(zip(ids, walk))

    def days_for(cid: str) -> dict[str, list[str]]:
        mem = members[cid]
        return assign_days(
            [ds.building_by_id[b] for b in mem], np.array([walk_of[b] for b in mem]), morning_cap, seed=params.seed
        )

    pattern: dict[str, list[str]] = {}
    with ThreadPoolExecutor(4) as ex:
        for res in ex.map(days_for, list(members)):
            pattern.update(res)

    stops = {(c["id"], d): [] for c in cleaners for d in DAY_KEYS}
    for b in ids:
        for d in pattern[b]:
            stops[(owner[b], d)].append(b)
    st = State(ds, params, cleaners, owner, pattern, stops)
    dropped = _route_all(st, list(stops))
    if quick_reject and len(dropped) > SKIP_REPAIR_SHARE * len(stops):
        # hopelessly over capacity: report and let the caller add a cleaner
        st.unassigned = [
            {"building_id": b, "day_key": d, "reason_code": "over_capacity", "reason": "over capacity"}
            for (c, d), ids_ in dropped.items()
            for b in ids_
        ]
        return st
    if dropped:
        touched = _repair(st, dropped)
        # re-sequence repaired routes; keep the insertion order if the re-solve would drop a stop
        keys = sorted(touched)
        before = {k_: list(st.stops[k_]) for k_ in keys}
        for k_ in _route_all(st, keys):
            st.stops[k_] = before[k_]
    return st


def _group_lower_bound(ds: Dataset, params: Params, ids: list[str]) -> int:
    """Smallest K worth trying for a group: busiest-day bound at the planning budget."""
    min_in = ds.min_incoming_minutes()
    load = sum(
        VISITS_PER_HORIZON[ds.building_by_id[i]["frequency"]]
        * (ds.building_by_id[i]["service_minutes"] + min_in[ds.node_of[i]])
        for i in ids
    )
    return max(1, int(np.ceil(load / len(DAY_KEYS) / params.planning_budget - 1e-9)))


def _allocate(k: int, loads: list[float]) -> list[int]:
    """Split a fixed number of cleaners over groups (largest remainder, at least one each)."""
    k = max(k, len(loads))
    quota = np.array(loads) / sum(loads) * k
    alloc = np.maximum(1, np.floor(quota)).astype(int)
    while alloc.sum() < k:
        alloc[int(np.argmax(quota - alloc))] += 1
    while alloc.sum() > k:
        alloc[int(np.argmax(np.where(alloc > 1, alloc - quota, -np.inf)))] -= 1
    return alloc.tolist()


def solve_plan(ds: Dataset, params: Params, log=print) -> dict:
    t0 = time.perf_counter()
    ids = [b["id"] for b in ds.buildings]
    walk = walk_estimates(ds, ids)
    loads = np.array(
        [VISITS_PER_HORIZON[b["frequency"]] * (b["service_minutes"] + w) for b, w in zip(ds.buildings, walk)]
    )
    groups = natural_groups(ds, ids, loads, min_share=0.6 * params.planning_budget * len(DAY_KEYS))
    load_of = dict(zip(ids, loads))
    g_loads = [sum(load_of[i] for i in g) for g in groups]
    log(f"{len(groups)} areas: {[len(g) for g in groups]} buildings")

    def solve_group(gi: int, k_fixed: int | None) -> State:
        g = groups[gi]
        ks = [k_fixed] if k_fixed else range(_group_lower_bound(ds, params, g), len(g) + 1)
        st = None
        for k in ks:
            st = _attempt(ds, params, g, k, tag=f"g{gi}-", quick_reject=k_fixed is None)
            log(f"  area {gi}: K={k} unassigned={len(st.unassigned)} ({time.perf_counter() - t0:.1f}s)")
            if not st.unassigned:
                break
        return st

    fixed = _allocate(int(params.num_cleaners), g_loads) if params.num_cleaners else [None] * len(groups)
    with ThreadPoolExecutor(len(groups)) as ex:
        states = list(ex.map(solve_group, range(len(groups)), fixed))
    merged = _merge(ds, params, states)
    return assemble(merged, lower_bound_cleaners(ds, params), time.perf_counter() - t0)


def _merge(ds: Dataset, params: Params, states: list[State]) -> State:
    """Combine per-area states and give cleaners stable ids (west->east), names and colours."""
    cleaners = [c for st in states for c in st.cleaners]
    cent = {}
    for st in states:
        for c in st.cleaners:
            mem = [b for b, o in st.owner.items() if o == c["id"]]
            cent[c["id"]] = np.mean([[ds.building_by_id[b]["lng"], ds.building_by_id[b]["lat"]] for b in mem], axis=0)
    cleaners.sort(key=lambda c: (round(cent[c["id"]][0] / 0.004), cent[c["id"]][1]))
    names, colors = cleaner_names(len(cleaners), params.seed), cleaner_colors(len(cleaners))
    rename = {c["id"]: f"c{i + 1:02d}" for i, c in enumerate(cleaners)}
    out_cleaners = [
        {
            "id": rename[c["id"]],
            "name": names[i],
            "color": colors[i],
            "start": c["start"],
            "daily_minutes": c["daily_minutes"],
        }
        for i, c in enumerate(cleaners)
    ]
    owner, pattern, stops, unassigned = {}, {}, {}, []
    for st in states:
        owner.update({b: rename[c] for b, c in st.owner.items()})
        pattern.update(st.pattern)
        stops.update({(rename[c], d): v for (c, d), v in st.stops.items()})
        unassigned += st.unassigned
    return State(ds, params, out_cleaners, owner, pattern, stops, unassigned)


def assemble(st: State, lower_bound: int, solve_seconds: float) -> dict:
    ds, params = st.ds, st.params
    by_id = st.cleaner_by_id
    routes = [make_route(ds, by_id[c], d, ids, params) for (c, d), ids in st.stops.items()]
    plan = {
        "cleaners": st.cleaners,
        "routes": routes,
        "assignments": [
            {"building_id": b, "cleaner_id": st.owner[b], "pattern": st.pattern[b]} for b in sorted(st.owner)
        ],
        "unassigned": st.unassigned,
    }
    return finalize(ds, plan, params, lower_bound, solve_seconds)
