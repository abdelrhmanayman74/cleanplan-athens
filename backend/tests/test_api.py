"""API smoke tests against the cached default plan (startup must be instant)."""

import time

from fastapi.testclient import TestClient

from app.data import DATA_DIR
from app.main import app


def test_endpoints_respond():
    with TestClient(app) as c:
        t0 = time.perf_counter()
        plan = c.get("/api/plan/current").json()
        assert time.perf_counter() - t0 < 2
        assert {"id", "routes", "assignments", "territories", "kpis", "cleaners", "unassigned"} <= set(plan)
        meta = c.get("/api/meta").json()
        assert meta["day_keys"][0] == "A-Mon" and "synthetic" in meta["data_note"]
        assert meta["provider_compare"] is (DATA_DIR / "google_compare.json").exists()
        if not meta["provider_compare"]:
            assert c.get("/api/provider-compare").status_code == 404
        assert len(c.get("/api/buildings").json()) >= 1000
        base = c.get("/api/plan/baseline").json()
        assert base["kpis"]["cleaners"] == plan["kpis"]["cleaners"]
        wf = c.get("/api/workforce/estimate", params={"daily_minutes": 480, "target_utilization": 0.85}).json()
        assert wf["lower_bound"] <= wf["estimate"]
        cost = c.get("/api/cost-estimate").json()
        assert cost["naive_elements"] == cost["buildings"] ** 2 and cost["our_elements"] < cost["naive_elements"]
        r = plan["routes"][0]
        sheet = c.get(f"/api/route-sheet/{r['cleaner_id']}/{r['day_key']}").json()
        assert sheet["google_maps_urls"] and sheet["stops"][0]["building"]["id"] == r["stops"][0]["building_id"]
        sample = c.get("/api/import/sample")
        res = c.post("/api/import", files={"file": ("sample.xlsx", sample.content)}).json()
        # Greek headers and frequency labels; 12 of 13 rows match, the typo gets a suggestion
        assert (res["summary"]["total"], res["summary"]["matched"]) == (13, 12)
        assert all(r["frequency"] in ("3w", "2w", "1w", "biweekly") for r in res["rows"])
        codes = [i["code"] for row in res["rows"] for i in row.get("issues", [])]
        assert codes == ["street_suggestion"]
        absence = c.post("/api/plan/absence", json={"cleaner_id": r["cleaner_id"], "day_key": r["day_key"]}).json()
        assert absence["untouched_routes"] >= len(plan["routes"]) - 10
        assert c.post("/api/plan/reset").json()["id"] == plan["id"]
        assert c.get("/api/route-sheet/nobody/A-Mon").status_code == 404
        near = c.get("/api/geocode/reverse", params={"lat": 37.9705, "lng": 23.7485}).json()
        assert near["street"] and near["distance_m"] < 300


def test_schedule_export_has_one_sheet_per_week_and_every_visit():
    import io

    from openpyxl import load_workbook

    with TestClient(app) as c:
        plan = c.get("/api/plan/current").json()
        res = c.get("/api/plan/export.xlsx")
        assert res.status_code == 200
        wb = load_workbook(io.BytesIO(res.content))
        assert wb.sheetnames == ["Εβδομάδα Α", "Εβδομάδα Β"]
        stops = sum(1 for ws in wb for row in ws.iter_rows(min_row=2, values_only=True) if isinstance(row[2], int))
        assert stops == plan["kpis"]["visits"]
