"""Absence and insert must not disturb the rest of the plan."""

import copy

from app.domain import SHIFT_START
from app.solver.plan import route_signature
from app.solver.whatif import apply_absence, commit_insert, insert_candidates


def _busiest_route(plan):
    return max(plan["routes"], key=lambda r: (len(r["stops"]), r["cleaner_id"], r["day_key"]))


def test_absence_moves_only_that_route(ds, plan, params):
    before = copy.deepcopy(plan)
    absent = _busiest_route(plan)
    res = apply_absence(ds, plan, params, absent["cleaner_id"], absent["day_key"])
    assert plan == before, "input plan must not be mutated"
    after = res["plan"]
    moved = {ch["building_id"] for ch in res["changes"]}
    assert moved == {s["building_id"] for s in absent["stops"]}
    assert res["churn"] == len(absent["stops"])

    receivers = {ch["to_cleaner"] for ch in res["changes"] if ch["to_cleaner"]}
    old = {(r["cleaner_id"], r["day_key"]): r for r in before["routes"]}
    untouched = 0
    for r in after["routes"]:
        key = (r["cleaner_id"], r["day_key"])
        if key == (absent["cleaner_id"], absent["day_key"]):
            assert r["stops"] == []
        elif r["day_key"] == absent["day_key"] and r["cleaner_id"] in receivers:
            assert r["end_time"] <= SHIFT_START + params.daily_minutes + 1e-6
            assert r["feasible"]
            # receivers keep all their own visits
            assert {s["building_id"] for s in old[key]["stops"]} <= {s["building_id"] for s in r["stops"]}
        else:
            assert r == old[key], f"route {key} changed"
        untouched += route_signature(r) == route_signature(old[key])
    assert res["untouched_routes"] == untouched
    assert untouched >= len(after["routes"]) - 1 - len(receivers)
    # every visit of that day is still served exactly once or reported as needing overtime
    day_stops = [s["building_id"] for r in after["routes"] if r["day_key"] == absent["day_key"] for s in r["stops"]]
    unplaced = [u["building_id"] for u in after["unassigned"] if u["day_key"] == absent["day_key"]]
    assert sorted(day_stops + unplaced) == sorted(
        s["building_id"] for r in before["routes"] if r["day_key"] == absent["day_key"] for s in r["stops"]
    )
    assert all(u["reason"] == "needs overtime" for u in after["unassigned"])
    assert after["kpis"]["frequency_violations"] == 0


def test_insert_commit_moves_no_other_building(ds, plan, params):
    nb = {"lat": 37.9705, "lng": 23.7485, "frequency": "2w", "service_minutes": 35, "name": "Test", "time_window": None}
    cands = insert_candidates(ds, plan, params, nb)
    assert 1 <= len(cands) <= 3
    assert len({c["cleaner_id"] for c in cands}) == len(cands)
    best = cands[0]
    assert best["feasible"]

    def placement(p):
        return {(s["building_id"], r["day_key"], r["cleaner_id"]) for r in p["routes"] for s in r["stops"]}

    ds2, res = commit_insert(ds, plan, params, nb, best, "n001")
    after = res["plan"]
    new_visits = {v for v in placement(after) if v[0] == "n001"}
    assert placement(after) - new_visits == placement(plan)
    assert {(d, c) for _, d, c in new_visits} == {(d, best["cleaner_id"]) for d in best["day_keys"]}
    assert res["churn"] == 0
    changed = [r for r in after["routes"] if r not in plan["routes"]]
    assert {(r["cleaner_id"], r["day_key"]) for r in changed} == {(best["cleaner_id"], d) for d in best["day_keys"]}
    assert after["kpis"]["frequency_violations"] == 0
    assert len(ds2.buildings) == len(ds.buildings) + 1
