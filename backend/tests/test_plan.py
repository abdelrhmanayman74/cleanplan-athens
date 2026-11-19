"""Hard rules of the optimised plan: frequencies, shifts, time windows, territories, determinism."""

from collections import defaultdict

from app.domain import DAY_INDEX, PATTERNS, SHIFT_START, WEEKDAYS, min_gap_ok, pattern_is_valid
from app.solver.optimizer import solve_plan


def visits_by_building(plan):
    out = defaultdict(list)
    for r in plan["routes"]:
        for s in r["stops"]:
            out[s["building_id"]].append((r["day_key"], r["cleaner_id"]))
    return out


def test_every_visit_follows_its_pattern(ds, plan):
    assert plan["kpis"]["frequency_violations"] == 0
    assert plan["kpis"]["unassigned"] == 0
    visits = visits_by_building(plan)
    assignment = {a["building_id"]: a for a in plan["assignments"]}
    assert set(assignment) == {b["id"] for b in ds.buildings}
    for b in ds.buildings:
        a = assignment[b["id"]]
        days = sorted((d for d, _ in visits[b["id"]]), key=DAY_INDEX.__getitem__)
        assert pattern_is_valid(b["frequency"], a["pattern"]), b["id"]
        assert days == sorted(a["pattern"], key=DAY_INDEX.__getitem__), b["id"]
        assert len(days) == len(PATTERNS[b["frequency"]][0])
        # the same cleaner always visits the same building
        assert {c for _, c in visits[b["id"]]} == {a["cleaner_id"]}


def test_visits_at_least_two_days_apart(plan):
    visits = visits_by_building(plan)
    for bid, vs in visits.items():
        days = [d for d, _ in vs]
        assert min_gap_ok(days), (bid, days)
        for w in "AB":
            idx = sorted(WEEKDAYS.index(d[2:]) for d in days if d[0] == w)
            assert all(b - a >= 2 for a, b in zip(idx, idx[1:])), (bid, days)


def test_routes_respect_shift_break_and_time_windows(ds, plan, params):
    shift_end = SHIFT_START + params.daily_minutes
    for r in plan["routes"]:
        assert r["start_time"] >= SHIFT_START
        assert r["end_time"] <= shift_end + 1e-6, (r["cleaner_id"], r["day_key"], r["end_time"])
        if not r["stops"]:
            continue
        # planned work stays inside the planning budget (target utilisation of shift minus break)
        assert r["walk_minutes"] + r["service_minutes"] <= params.planning_budget + 1e-6
        # 30-minute break inside the shift, between stops
        b0, b1 = r["break"]
        assert b1 - b0 == params.break_minutes and SHIFT_START <= b0 and b1 <= shift_end
        prev_depart = r["start_time"]
        for s in r["stops"]:
            b = ds.building_by_id[s["building_id"]]
            assert s["arrival"] >= prev_depart + s["walk_from_prev"] - 0.02  # values are rounded to 0.01
            assert abs(s["depart"] - s["arrival"] - b["service_minutes"]) < 0.02
            assert not (b0 < s["depart"] and s["arrival"] < b1), "a visit overlaps the break"
            if b.get("time_window"):
                lo, hi = b["time_window"]
                assert s["arrival"] >= lo - 1e-6 and s["depart"] <= hi + 1e-6, (b["id"], s)
            prev_depart = s["depart"]


def test_territories_are_disjoint_and_balanced(plan):
    owners = defaultdict(set)
    for a in plan["assignments"]:
        owners[a["building_id"]].add(a["cleaner_id"])
    assert all(len(v) == 1 for v in owners.values())
    work = defaultdict(float)
    for r in plan["routes"]:
        work[r["cleaner_id"]] += r["walk_minutes"] + r["service_minutes"]
    assert len(work) == plan["kpis"]["cleaners"]
    assert max(work.values()) <= 10 * 382.5 + 1e-6


def test_lower_bound_is_not_above_solution(plan):
    k = plan["kpis"]
    assert k["lower_bound_cleaners"] <= k["cleaners"]


def test_same_seed_same_plan(ds, params, plan):
    again = solve_plan(ds, params, log=lambda *_: None)
    assert again["routes"] == plan["routes"]
    assert again["assignments"] == plan["assignments"]
    assert again["id"] == plan["id"]
