# CleanPlan backend

FastAPI + OR-Tools service behind the CleanPlan demo: it plans which cleaner visits which
πολυκατοικία, on which days of a 2-week (A/B) cycle, and in what walking order. The API contract is
in `../CONTRACT.md`; the design is explained in `../ARCHITECTURE.md`.

**Data honesty.** The 1,000 buildings are real OpenStreetMap addresses in 8 Athens neighbourhoods
(© OpenStreetMap contributors, ODbL). Everything about them as *customers* (managers, phones,
frequencies, floors, lifts, service minutes, time windows, notes, cleaners) is synthetic and
generated with fixed seeds. Walking times come from OSRM's `foot` profile and are precomputed, so
the API never needs a routing server at runtime.

## Run

```bash
cd backend
uv sync                                    # Python 3.11 + deps (ortools, fastapi, …)
uv run uvicorn app.main:app --port 8000    # starts instantly from data/default_plan.json
uv run pytest                              # 20 tests, ~20 s
```

With the frontend: `cd ../frontend && npm run dev` (Vite on :5173 proxies `/api` to :8000), or build
it (`npm run build`) and FastAPI serves `frontend/dist` at `/` with SPA fallback for `/sheet/*`.

One container for everything, from the repo root: `docker compose up --build` → http://localhost:8000.

## Measured results (default plan, this machine: 12 cores)

| | Optimised | Naive baseline (same cleaners) |
|---|---|---|
| Cleaners | **29** (lower bound 24, analytic estimate 26) | 29 |
| Walking, 2 weeks | **7,961 min** (3.18 min/visit) | 9,453 min (3.78 min/visit), +19% |
| Longest route (incl. break) | **409 min** | 851 min |
| Routes over the 8-hour shift | **0** | 46 (5,341 overtime minutes) |
| Morning time-window violations | **0** | 70 |
| Frequency violations / unassigned | **0 / 0** | 0 / 0 |
| Utilisation (work ÷ shift−break) | 72.0 % (planned against an 85 % target) | 73.2 % (more of it is walking) |

* Full solve with auto workforce: **≈11 s** (`POST /api/plan`; 9.3 s inside the Docker image).
* Same seed → identical plan (`plan-cb62d2d305`), checked by a test.
* All 290 route geometries follow OSM streets (`geometry_exact=true`).
* Absence, largest route (c22 on A-Mon, 11 stops): 11 visits moved to 4 colleagues, churn 11,
  285/290 routes byte-identical, +20 walking minutes in total. Over all 290 possible single-day
  absences: 288 are fully absorbed inside normal shifts; 2 visits in total need overtime; 0.13 s each.

The lower bound is rigorous: all service plus the shortest possible walk into every visit, spread
perfectly over the 10 days, at the 85 % planning target. The gap to 29 comes from real walking
(≈3× the bound), keeping each of the 4 separated areas self-contained (Καλλιθέα needs 3.2 cleaners'
worth of work, so it gets 4), and daily balance.

## Endpoints

Exactly as in `CONTRACT.md`. Additive fields (safe to ignore):

* `Cleaner.start` also has `kind` (`station`/`home`), `ref` (station id) and `node` (matrix index).
* `Route` also has `break: [start, end]` and `feasible` (shift and windows respected); after an
  absence the empty route has `absent: true`.
* `/api/plan/baseline` also returns `overtime_routes`, `overtime_minutes`, `time_window_violations`.
* `/api/meta` also returns `stations` and `dataset` (provenance); `/api/workforce/estimate` a `note`.
* `/api/health` for container health checks.

`InsertCandidate.added_walk_minutes` is the extra walking summed over all visits of the 2-week
pattern. `ChangeResult.churn` counts visits whose cleaner changed, including visits reported as
"needs overtime".

## Data pipeline (reproducible; only needed to rebuild `data/`)

```bash
uv sync --group pipeline
uv run python scripts/fetch_osm.py          # Overpass: addressed buildings in 8 areas + stations (cached in data/raw)
uv run python scripts/build_dataset.py      # sample 1,000 spread-out buildings, synthetic attributes, address index
scripts/build_osrm.sh                       # Geofabrik greece-latest → Athens clip (pyosmium) → OSRM foot (MLD)
scripts/build_osrm.sh serve                 # osrm-routed on :5000 (container cleanplan-osrm)
uv run python scripts/build_matrix.py       # 1057×1057 walking matrix, leg geometries, `isolated`, calibration
uv run python scripts/precompute_plan.py --force
uv run python scripts/fill_legs.py          # OSRM geometry for every pair inside/next to each territory
uv run python scripts/precompute_plan.py --force   # redraw with the new legs
uv run python scripts/render_plan.py        # data/plan_preview.png (routes coloured by cleaner)
docker rm -f cleanplan-osrm
```

Outputs in `data/`: `buildings.json`, `stations.json`, `nodes.json`, `matrix.npy` (int32 seconds),
`legs.json.gz` (≈69k encoded polylines), `address_index.json` (5,988 OSM addresses for the importer),
`meta.json` (Haversine detour factor calibrated against OSRM: 1.16), `default_plan.json`, `baseline.json`.
Large downloads (PBF, OSRM graph) live in `osrm-data/` (git-ignored).

`scripts/google_compare.py` compares OSRM and Google Routes (WALK) on ≤200 pairs of one territory if
`GOOGLE_MAPS_API_KEY` is set and writes `data/google_compare.json` (served at
`/api/provider-compare`). It has not been run: no key was used for this demo.

## Code map

```
app/
  main.py            FastAPI routes, CORS, static frontend
  state.py           in-memory plan state, default plan / baseline cache
  data.py            Dataset: buildings, stations, matrix, leg geometries
  travel.py          TravelTimeProvider + Precomputed / OSRM / Haversine / GoogleRoutes
  domain.py          day keys, frequencies, allowed patterns
  geocoder.py        offline fuzzy address matching (accents, case, Greeklish)
  importer.py        .xlsx/.csv import + sample file
  routesheet.py      mobile route sheet, Google Maps walking links
  solver/
    optimizer.py     pipeline: areas → K → territories → days → routes → repair
    territories.py   balanced compact clustering (k-means + min-cost flow)
    days.py          CP-SAT day-pattern choice per territory
    routing.py       OR-Tools route per (cleaner, day), process pool
    timeline.py      timed schedule + break placement
    insertion.py     cheapest feasible insertion
    whatif.py        absence, insert candidates / commit
    baseline.py      naive comparison plan
    estimates.py     workforce (BHH) and Google matrix cost estimates
    plan.py          plan assembly, KPIs, hulls, lower bound
scripts/             data pipeline (see above)
tests/               pytest
```
