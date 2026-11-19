# CleanPlan demo: shared contract (backend ⇄ frontend)

A live demo built for an Upwork bid. Client: a Greek property-services company cleaning the common areas of about 1,000 apartment buildings (πολυκατοικίες) in Athens. Cleaners **walk** between buildings.
The demo must look professional and be honest. **All customer data is synthetic** (on real OpenStreetMap addresses). The UI footer must say so.

## Domain rules

- **Horizon:** 2 weeks (A, B), Mon–Fri. That gives 10 `day_key`s: `A-Mon, A-Tue, A-Wed, A-Thu, A-Fri, B-Mon … B-Fri`.
- **Frequencies and allowed day patterns.** A pattern is the set of weekdays a building is visited. Visits within a week must be at least 2 days apart.

  | Frequency | Patterns |
  |---|---|
  | `3w` | {Mon, Wed, Fri}, repeated in A and B |
  | `2w` | {Mon,Wed}, {Mon,Thu}, {Mon,Fri}, {Tue,Thu}, {Tue,Fri}, {Wed,Fri}, repeated in A and B |
  | `1w` | any single weekday, the same in A and B |
  | `biweekly` | one weekday in week A only, or in week B only |

  Target mix (approximate): 1w 55%, 2w 25%, biweekly 15%, 3w 5%.
- **Service minutes.** Computed from the building: about 15 + 3.5 × floors, plus 1.5 × floors when there is no lift, plus noise. Clamp to the range 15–75. The value is per visit.
- **Time windows (minutes from midnight).** Most buildings have none, which means "any time within the shift". About 15% are morning only, [420, 720], i.e. 07:00–12:00.
- **Cleaner:**
  - shift is 07:00 plus `daily_minutes`, defaulting to 480, and includes a 30-minute break;
  - the start and end point is the nearest metro/rail station to the cleaner's territory, or "home" for some cleaners;
  - each cleaner works only inside their own territory, so the same cleaner always visits the same building;
  - Greek first names and surnames.
- **Travel.** Walking time comes from the OSRM `foot` profile, precomputed offline. A building is `isolated` if its walk to its 3rd-nearest neighbour is more than 15 minutes.

## REST API (FastAPI, port 8000, everything under `/api`)

All times are in minutes. All coordinates are `[lat, lng]` or `{lat, lng}`.

**Sessions.** Every call sends `X-Session-Id: <uuid>` (8–64 letters, digits or dashes; anything else is a
400). The frontend creates one random id per page load, so a fresh visit always starts from the standard plan. Each session has its own plan, so one
visitor's absence, new building or re-plan never changes what another visitor sees. Sessions are kept
in memory (LRU of 200, expire after 2 h idle) and start from the default plan.

* GET without the header, or with an unknown or expired id, reads the default plan (nothing is created).
* POST without the header works on a throw-away copy of the default plan.
* Only one full re-solve (`POST /api/plan`) runs at a time on the server; a second one gets **429**
  (`code: "solver_busy"`, `Retry-After: 10`).

**Errors.** App errors return `{"detail": {"code": string, "message": string}}`. `code` is stable and
translated by the UI (e.g. `solver_busy`, `file_too_large`, `missing_columns`, `unreadable_file`,
`route_not_found`, `invalid_session`); `message` is English. Request validation errors keep FastAPI's shape.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/meta` | | `{day_keys, frequencies, patterns, neighborhoods, data_note, travel_provider, provider_compare, demo_absence}`; `provider_compare` is true only if a Google comparison exists; `demo_absence` is `{cleaner_id, day_key}` (a one-click example on the default plan) or null |
| GET | `/api/buildings` | | `Building[]` |
| GET | `/api/cleaners` | | `Cleaner[]` for the current plan |
| GET | `/api/plan/current` | | `Plan` (a default plan is precomputed at startup, so this returns instantly) |
| POST | `/api/plan` | `PlanParams` | `Plan` (full re-solve; target under 60 s; becomes the session's current plan). 429 if another solve is running |
| GET | `/api/plan/baseline` | | `Baseline`: naive baseline (k-means by building *count*, round-robin days, nearest-neighbour routes, no shift limit), same buildings and team size |
| POST | `/api/plan/absence` | `{cleaner_id, day_key}` | `ChangeResult` |
| POST | `/api/plan/insert-candidates` | `NewBuilding` | `{candidates: InsertCandidate[]}` (top 3, the rest of the plan unchanged) |
| POST | `/api/plan/insert-commit` | `{building: NewBuilding, candidate: InsertCandidate}` | `ChangeResult` |
| POST | `/api/plan/reset` | | `Plan` (back to the default precomputed plan) |
| GET | `/api/workforce/estimate` | `?daily_minutes=480&target_utilization=0.85` | `WorkforceEstimate` (instant, analytic, no solve) |
| GET | `/api/route-sheet/{cleaner_id}/{day_key}` | | `RouteSheet` |
| GET | `/api/cost-estimate` | | `CostEstimate` |
| GET | `/api/plan/export.xlsx` | | the session's 2-week schedule: one sheet per week, rows = cleaner × day with ordered stops and times |
| GET | `/api/geocode/reverse` | `?lat=&lng=` | `{street, number, neighborhood, label, distance_m}`: nearest address in the offline OSM index |
| POST | `/api/import` | multipart `file` (.xlsx/.csv: columns `street, number, postcode, frequency, floors, has_lift`, or the Greek headers `Οδός, Αριθμός, Τ.Κ., Συχνότητα, Όροφοι, Ανελκυστήρας`; frequency as a code or e.g. "2 φορές/εβδ.") | `{rows: ImportRow[], summary}` |
| GET | `/api/import/sample` | | .xlsx template with Greek headers (12 of 13 rows match; one typo gets a suggestion) |
| GET | `/api/provider-compare` | | `ProviderCompare` or 404 (only if `data/google_compare.json` exists; the UI calls it only when `meta.provider_compare`) |

## Types (TypeScript notation)

```ts
type DayKey = string; // "A-Mon"
type Frequency = "3w" | "2w" | "1w" | "biweekly";

interface Building {
  id: string; name: string;            // e.g. "Πολυκατοικία Φορμίωνος 42"
  street: string; number: string; postcode: string | null;
  neighborhood: string;                // Greek, e.g. "Παγκράτι"
  lat: number; lng: number;
  floors: number; has_lift: boolean;
  service_minutes: number; frequency: Frequency;
  time_window: [number, number] | null;
  manager: { name: string; phone: string };   // synthetic διαχειριστής
  access_note: string;                 // Greek, e.g. "Κλειδί στον θυρωρό"
  tasks: string[];                     // Greek: ["Σκάλες","Είσοδος","Ανελκυστήρας","Κάδοι"]
  isolated: boolean;
}

interface Cleaner {
  id: string; name: string; color: string;   // distinct hex color
  start: { lat: number; lng: number; label: string;   // e.g. "Μετρό Αμπελόκηποι", "ΗΣΑΠ Καλλιθέα", "Τραμ Ζάππειο"
           kind: "station" | "home"; mode: "metro" | "isap" | "tram" | "rail" | "home" };
  daily_minutes: number;
}

interface PlanParams { daily_minutes?: number; break_minutes?: number; target_utilization?: number; num_cleaners?: number | null /* null = auto */ }

interface Stop { building_id: string; arrival: number; depart: number; walk_from_prev: number }
interface Route {
  cleaner_id: string; day_key: DayKey; stops: Stop[];
  walk_minutes: number; service_minutes: number; total_minutes: number; // total = shift used incl. break
  start_time: number; end_time: number;
  geometry: string;          // Google encoded polyline (precision 5), full route incl. start/end legs
  geometry_exact: boolean;   // false if some legs fell back to straight lines
}
interface KPIs {
  cleaners: number; lower_bound_cleaners: number;
  visits: number; walk_minutes: number; service_minutes: number;
  utilization: number;        // (service + walk) / available shift minutes, 0..1
  avg_walk_per_visit: number; max_route_minutes: number;
  frequency_violations: number; // must be 0 for our plan
  unassigned: number;
}
interface Plan {
  id: string; created_at: string; params: PlanParams; solve_seconds: number;
  cleaners: Cleaner[]; routes: Route[];
  assignments: { building_id: string; cleaner_id: string; pattern: string[] /* day_keys */ }[];
  territories: { cleaner_id: string; hull: [number, number][] }[];   // convex hull for map shading
  unassigned: { building_id: string; day_key: DayKey; reason_code: string; reason: string }[];
  // reason_code: "needs_overtime" | "no_capacity" | "over_capacity" (translated by the UI); reason: English
  kpis: KPIs;
}
interface Change { building_id: string; day_key: DayKey; from_cleaner: string | null; to_cleaner: string | null; added_walk: number }
interface ChangeResult {
  plan: Plan; changes: Change[];
  churn: number;                      // number of visits whose cleaner or day changed
  untouched_routes: number;           // routes with identical stop sequences
  kpis_before: KPIs; kpis_after: KPIs;
  message: string;                    // Greek-ready summary is built by the frontend; this is English
}
interface NewBuilding { lat: number; lng: number; frequency: Frequency; service_minutes: number; name?: string; time_window?: [number, number] | null }
interface InsertCandidate { cleaner_id: string; day_keys: DayKey[]; added_walk_minutes: number; feasible: boolean; slack_after: number }
interface WorkforceEstimate {
  daily_minutes: number; target_utilization: number;
  total_service_minutes: number; est_walk_minutes: number;   // BHH-style estimate, labelled as an estimate
  busiest_day: DayKey; busiest_day_load: number;
  lower_bound: number; estimate: number; solved: number | null;  // solved = current plan's cleaners
}
interface RouteSheet {
  cleaner: Cleaner; day_key: DayKey; date_label: string; route: Route;
  stops: (Stop & { building: Building })[];
  google_maps_url: string;   // walking directions with waypoints (split into several links if > 9 waypoints)
  google_maps_urls: string[];
}
interface CostEstimate {
  buildings: number; naive_elements: number; our_elements: number;
  price_per_1000_usd: number; free_elements_per_month: number;
  naive_cost_usd: number; our_cost_usd: number;
  note: string;  // "List price as of <date>, verify at developers.google.com/maps/billing-and-pricing/pricing"
}
interface ImportIssue {
  code: string;    // missing_street | street_not_found | street_suggestion | number_not_found | street_approximate | number_nearest |
                   // unknown_frequency | floors_out_of_range | floors_not_number | has_lift_unknown
  value?: string;  // e.g. the street or number actually used, or the rejected input
  text: string;    // English
}
interface ImportRow {
  input: Record<string, string>; matched: boolean; confidence: number;
  lat?: number; lng?: number; matched_label?: string;
  issue?: string;          // English, all issues joined with "; "
  issues?: ImportIssue[];
  frequency?: Frequency;   // the parsed frequency, when understood
}
interface Baseline {
  kpis: KPIs; description: string;
  overtime_routes: number;         // routes ending after 07:00 + daily_minutes
  overtime_minutes: number;        // total minutes past the shift end
  time_window_violations: number;  // visits finishing after their window closes
}
interface ProviderCompare { pairs: { from: string; to: string; osrm_min: number; google_min: number }[]; mean_abs_diff_min: number; note: string }
```

## Frontend ⇄ backend

- Dev: Vite on 5173 proxies `/api` to `http://localhost:8000`.
- Prod: FastAPI serves `frontend/dist` at `/`, and SPA routes fall back to `index.html`.
- Static build (`npm run build:static`, GitHub Pages): no server. `frontend/src/api/static/` implements the same
  client interface from files written by `backend/scripts/export_static.py` (the same functions as these endpoints)
  plus browser ports of the new-building insertion, geocoder and Excel export. Route-sheet links carry the scenario
  as `?shift=<hours>&absence=<cleaner_id>:<day_key>` instead of a session id (see ARCHITECTURE.md).
- Routes:
  - `/` is the planner.
  - `/sheet/:cleanerId/:dayKey?s=<session id>` is the mobile route sheet (shareable link). The sheet sends `s` as
    `X-Session-Id`, so the link shows the sender's plan on another device; once that session has expired it shows
    the default plan.
- The UI language is **Greek by default** with an EN toggle. Search ignores accents and case: normalise with NFD, strip combining marks, lowercase, and map final ς to σ.
