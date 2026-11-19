"""CleanPlan demo API (FastAPI). See CONTRACT.md for the endpoint and type definitions."""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app.data import DATA_DIR
from app.domain import DAY_KEYS, FREQUENCIES, PATTERNS
from app.export import schedule_workbook
from app.importer import TableError, import_rows, read_table, sample_workbook
from app.routesheet import route_sheet
from app.solver.estimates import cost_estimate, workforce_estimate
from app.solver.plan import Params
from app.solver.routing import shutdown_pool
from app.solver.whatif import apply_absence, commit_insert, insert_candidates
from app.state import PlanState, PlanStore, Session, SolverBusy

GOOGLE_COMPARE = DATA_DIR / "google_compare.json"
FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
DATA_NOTE = (
    "Addresses and building locations are real (© OpenStreetMap contributors, ODbL). All customer data — "
    "managers, phone numbers, frequencies, service times, access notes, cleaners — is synthetic. "
    "Walking times: OSRM foot profile on OSM data, precomputed offline."
)

store: PlanStore | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global store
    store = PlanStore(DATA_DIR)
    yield
    shutdown_pool()


app = FastAPI(title="CleanPlan demo API", version="1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def api_error(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> HTTPException:
    """Errors carry a stable `code` (translated by the frontend) next to the English message."""
    return HTTPException(status, {"code": code, "message": message}, headers=headers)


def S() -> PlanStore:
    if store is None:
        raise api_error(503, "starting_up", "starting up")
    return store


# ---- per-visitor state (see app/state.py) -----------------------------------------------------
def session_id(x_session_id: Annotated[str | None, Header()] = None) -> str | None:
    if x_session_id is not None and not PlanStore.valid_session_id(x_session_id):
        raise api_error(400, "invalid_session", "X-Session-Id must be 8-64 letters, digits or dashes")
    return x_session_id


def current_view(sid: Annotated[str | None, Depends(session_id)]) -> PlanState:
    """Read-only state: the session's plan, or the default plan for unknown or missing sessions."""
    return S().view(sid)


def current_session(sid: Annotated[str | None, Depends(session_id)]) -> Session:
    """Writable session, created on first use (ephemeral when no header is sent)."""
    return S().session(sid)


View = Annotated[PlanState, Depends(current_view)]
Sess = Annotated[Session, Depends(current_session)]


# ---- request models ---------------------------------------------------------------------------
class PlanParamsIn(BaseModel):
    daily_minutes: int | None = Field(None, ge=240, le=600)
    break_minutes: int | None = Field(None, ge=0, le=90)
    target_utilization: float | None = Field(None, ge=0.5, le=1.0)
    num_cleaners: int | None = Field(None, ge=1, le=200)


class AbsenceIn(BaseModel):
    cleaner_id: str
    day_key: str


class NewBuildingIn(BaseModel):
    lat: float = Field(..., ge=37.8, le=38.2)
    lng: float = Field(..., ge=23.5, le=24.0)
    frequency: Literal["3w", "2w", "1w", "biweekly"]
    service_minutes: int = Field(..., ge=5, le=180)
    name: str | None = None
    time_window: tuple[int, int] | None = None


class InsertCandidateIn(BaseModel):
    cleaner_id: str
    day_keys: list[str]
    added_walk_minutes: float | None = None
    feasible: bool | None = None
    slack_after: float | None = None


class InsertCommitIn(BaseModel):
    building: NewBuildingIn
    candidate: InsertCandidateIn


# ---- endpoints --------------------------------------------------------------------------------
@app.get("/api/meta")
def meta():
    s = S()
    return {
        "day_keys": DAY_KEYS,
        "frequencies": FREQUENCIES,
        "patterns": PATTERNS,
        "neighborhoods": sorted({b["neighborhood"] for b in s.base_ds.buildings}),
        "data_note": DATA_NOTE,
        "provider_compare": GOOGLE_COMPARE.exists(),  # false: the client skips /api/provider-compare
        "demo_absence": s.default_plan.get("demo_absence"),  # one-click example on the default plan
        "travel_provider": s.base_ds.provider.name
        + ("; new addresses: " + s.new_point_provider.name + (" (estimate)" if not s.new_point_provider.exact else "")),
        "stations": [{k: st[k] for k in ("id", "name", "kind", "lat", "lng")} for st in s.base_ds.stations],
        "dataset": {
            k: s.base_ds.meta.get(k)
            for k in ("buildings", "stations", "haversine_detour_factor", "osm_extract", "osrm_profile", "built_at")
        },
    }


@app.get("/api/buildings")
def buildings(v: View):
    return v.ds.public_buildings()


@app.get("/api/cleaners")
def cleaners(v: View):
    return v.plan["cleaners"]


@app.get("/api/plan/current")
def plan_current(v: View):
    return v.plan


@app.post("/api/plan")
def plan_solve(p: PlanParamsIn, s: Sess):
    try:
        return S().solve(s, Params.from_dict(p.model_dump())).plan
    except SolverBusy as e:
        raise api_error(
            429,
            "solver_busy",
            "Another visitor is re-planning right now; please try again in a few seconds.",
            headers={"Retry-After": "10"},
        ) from e


@app.get("/api/plan/baseline")
def plan_baseline(v: View):
    return S().baseline(v)


@app.post("/api/plan/absence")
def plan_absence(body: AbsenceIn, s: Sess):
    with s.lock:
        st = s.state
        try:
            res = apply_absence(st.ds, st.plan, st.params, body.cleaner_id, body.day_key)
        except (ValueError, KeyError) as e:
            raise api_error(422, "invalid_request", str(e)) from e
        s.state = PlanState(st.ds, res["plan"], st.params)
        return res


@app.post("/api/plan/insert-candidates")
def plan_insert_candidates(nb: NewBuildingIn, s: Sess):
    st = s.state
    return {
        "candidates": insert_candidates(st.ds, st.plan, st.params, nb.model_dump(), provider=S().new_point_provider)
    }


@app.post("/api/plan/insert-commit")
def plan_insert_commit(body: InsertCommitIn, s: Sess):
    with s.lock:
        st = s.state
        try:
            ds2, res = commit_insert(
                st.ds,
                st.plan,
                st.params,
                body.building.model_dump(),
                body.candidate.model_dump(),
                s.next_building_id(),
                provider=S().new_point_provider,
            )
        except (ValueError, KeyError) as e:
            raise api_error(422, "invalid_request", str(e)) from e
        s.state = PlanState(ds2, res["plan"], st.params)
        return res


@app.post("/api/plan/reset")
def plan_reset(s: Sess):
    return S().reset(s).plan


@app.get("/api/workforce/estimate")
def workforce(
    v: View,
    daily_minutes: int = Query(480, ge=240, le=600),
    target_utilization: float = Query(0.85, ge=0.5, le=1.0),
):
    return workforce_estimate(
        v.ds, daily_minutes, target_utilization, v.params.break_minutes, solved=v.plan["kpis"]["cleaners"]
    )


@app.get("/api/route-sheet/{cleaner_id}/{day_key}")
def sheet(cleaner_id: str, day_key: str, v: View):
    try:
        return route_sheet(v.ds, v.plan, cleaner_id, day_key)
    except KeyError as e:
        raise api_error(404, "route_not_found", str(e)) from e


@app.get("/api/cost-estimate")
def cost(v: View):
    return cost_estimate(v.ds, v.plan)


@app.get("/api/plan/export.xlsx")
def plan_export(v: View):
    return Response(
        schedule_workbook(v.ds, v.plan),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="cleanplan_schedule.xlsx"'},
    )


@app.get("/api/geocode/reverse")
def reverse_geocode(lat: float = Query(..., ge=37.8, le=38.2), lng: float = Query(..., ge=23.5, le=24.0)):
    """Nearest known address (offline OSM index), e.g. to label a new-building pin."""
    return S().address_index.nearest(lat, lng)


@app.post("/api/import")
async def import_file(file: UploadFile = File(...)):  # noqa: B008 (FastAPI idiom)
    content = await file.read()
    if len(content) > 5_000_000:
        raise api_error(413, "file_too_large", "file too large (max 5 MB)")
    try:
        df = read_table(file.filename or "", content)
    except TableError as e:
        raise api_error(422, e.code, str(e)) from e
    except Exception as e:  # unreadable spreadsheet
        raise api_error(422, "unreadable_file", f"could not read file: {e}") from e
    return import_rows(df, S().address_index)


@app.get("/api/import/sample")
def import_sample():
    data = sample_workbook(S().base_ds.buildings, S().address_index)
    return Response(
        data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="cleanplan_import_template.xlsx"'},
    )


@app.get("/api/provider-compare")
def provider_compare():
    if not GOOGLE_COMPARE.exists():
        raise api_error(
            404,
            "no_provider_compare",
            "no Google comparison available (run scripts/google_compare.py with GOOGLE_MAPS_API_KEY)",
        )
    return json.loads(GOOGLE_COMPARE.read_text())


@app.get("/api/health")
def health():
    return {"ok": store is not None}


# ---- frontend (production build) ----------------------------------------------------------------
if FRONTEND_DIST.is_dir():

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        candidate = (FRONTEND_DIST / full_path).resolve()
        if full_path and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")  # SPA fallback (/, /sheet/…)
