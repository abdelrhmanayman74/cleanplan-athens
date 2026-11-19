"""Per-visitor state: what one visitor does must never change what another one sees."""

import time

from fastapi.testclient import TestClient

from app import main
from app.data import DATA_DIR
from app.state import PlanStore

A = {"X-Session-Id": "aaaaaaaa-0000-4000-8000-000000000001"}
B = {"X-Session-Id": "bbbbbbbb-0000-4000-8000-000000000002"}


def _busiest(plan):
    return max(plan["routes"], key=lambda r: (len(r["stops"]), r["cleaner_id"], r["day_key"]))


def test_two_sessions_are_isolated():
    with TestClient(main.app) as c:
        default = c.get("/api/plan/current").json()
        r = _busiest(default)

        res = c.post("/api/plan/absence", json={"cleaner_id": r["cleaner_id"], "day_key": r["day_key"]}, headers=A)
        assert res.status_code == 200
        changed = res.json()["plan"]
        assert changed["id"] != default["id"]

        # A sees its own change, B and visitors without a session still see the default plan
        assert c.get("/api/plan/current", headers=A).json()["id"] == changed["id"]
        assert c.get("/api/plan/current", headers=B).json()["id"] == default["id"]
        assert c.get("/api/plan/current").json()["id"] == default["id"]
        sheet_a = c.get(f"/api/route-sheet/{r['cleaner_id']}/{r['day_key']}", headers=A).json()
        sheet_b = c.get(f"/api/route-sheet/{r['cleaner_id']}/{r['day_key']}", headers=B).json()
        assert sheet_a["stops"] == [] and len(sheet_b["stops"]) == len(r["stops"])

        # a new building in B does not appear for A
        nb = {"lat": 37.9705, "lng": 23.7485, "frequency": "1w", "service_minutes": 30}
        cand = c.post("/api/plan/insert-candidates", json=nb, headers=B).json()["candidates"][0]
        assert c.post("/api/plan/insert-commit", json={"building": nb, "candidate": cand}, headers=B).status_code == 200
        n_default = len(default["assignments"])
        assert len(c.get("/api/buildings", headers=B).json()) == len(c.get("/api/buildings", headers=A).json()) + 1
        assert len(c.get("/api/plan/current", headers=B).json()["assignments"]) == n_default + 1
        assert len(c.get("/api/plan/current", headers=A).json()["assignments"]) == n_default

        # reset only affects the caller
        assert c.post("/api/plan/reset", headers=A).json()["id"] == default["id"]
        assert len(c.get("/api/plan/current", headers=B).json()["assignments"]) == n_default + 1
        c.post("/api/plan/reset", headers=B)


def test_unknown_session_falls_back_to_default_and_bad_ids_are_rejected():
    with TestClient(main.app) as c:
        default = c.get("/api/plan/current").json()
        expired = {"X-Session-Id": "cccccccc-0000-4000-8000-00000000dead"}
        assert c.get("/api/plan/current", headers=expired).json()["id"] == default["id"]
        r = default["routes"][0]
        assert c.get(f"/api/route-sheet/{r['cleaner_id']}/{r['day_key']}", headers=expired).status_code == 200
        bad = c.get("/api/plan/current", headers={"X-Session-Id": "../etc"})
        assert bad.status_code == 400 and bad.json()["detail"]["code"] == "invalid_session"


def test_only_one_solve_at_a_time():
    with TestClient(main.app) as c:
        lock = main.store._solve_lock
        assert lock.acquire(blocking=False)
        try:
            res = c.post("/api/plan", json={"daily_minutes": 420}, headers=A)
        finally:
            lock.release()
        assert res.status_code == 429
        assert res.json()["detail"]["code"] == "solver_busy" and res.headers["retry-after"]


def test_session_registry_is_bounded_and_expires(monkeypatch):
    store = PlanStore(DATA_DIR, log=lambda *_: None, max_sessions=2, ttl_seconds=60)
    s1 = store.session("session-1")
    store.session("session-2")
    store.session("session-3")  # evicts the least recently used one
    assert store.session_count == 2 and store.view("session-1") is store.default_state
    assert store.session("session-1") is not s1

    # no header: an ephemeral session that is never stored
    assert store.session(None).id is None and store.session_count == 2

    real = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real() + 120)  # both sessions idle past the TTL
    assert store.view("session-3") is store.default_state
    assert store.session_count == 0
