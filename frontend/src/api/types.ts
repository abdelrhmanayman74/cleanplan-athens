// Types mirror CONTRACT.md exactly. Do not rename fields here.

export type DayKey = string; // "A-Mon"
export type Frequency = '3w' | '2w' | '1w' | 'biweekly';

export interface Building {
  id: string;
  name: string;
  street: string;
  number: string;
  postcode: string | null;
  neighborhood: string;
  lat: number;
  lng: number;
  floors: number;
  has_lift: boolean;
  service_minutes: number;
  frequency: Frequency;
  time_window: [number, number] | null;
  manager: { name: string; phone: string };
  access_note: string;
  tasks: string[];
  isolated: boolean;
}

export interface Cleaner {
  id: string;
  name: string;
  color: string;
  start: {
    lat: number; lng: number; label: string;
    /** Extra fields: what kind of start point, for the map marker (Μ metro, Η ΗΣΑΠ, Τ tram, Π rail). */
    kind?: 'station' | 'home';
    mode?: 'metro' | 'isap' | 'tram' | 'rail' | 'home';
  };
  daily_minutes: number;
}

export interface PlanParams {
  daily_minutes?: number;
  break_minutes?: number;
  target_utilization?: number;
  num_cleaners?: number | null;
}

export interface Stop {
  building_id: string;
  arrival: number;
  depart: number;
  walk_from_prev: number;
}

export interface Route {
  cleaner_id: string;
  day_key: DayKey;
  stops: Stop[];
  walk_minutes: number;
  service_minutes: number;
  total_minutes: number;
  start_time: number;
  end_time: number;
  geometry: string;
  geometry_exact: boolean;
  /** Static build: estimated legs to a new building, drawn as short dotted connectors. */
  connectors?: [number, number][][];
}

export interface KPIs {
  cleaners: number;
  lower_bound_cleaners: number;
  visits: number;
  walk_minutes: number;
  service_minutes: number;
  utilization: number;
  avg_walk_per_visit: number;
  max_route_minutes: number;
  frequency_violations: number;
  unassigned: number;
}

export interface Assignment {
  building_id: string;
  cleaner_id: string;
  pattern: string[];
}

export interface Territory {
  cleaner_id: string;
  hull: [number, number][];
}

export interface Unassigned {
  building_id: string;
  day_key: DayKey;
  /** Stable code ("needs_overtime", "no_capacity", "over_capacity"), translated by the UI. */
  reason_code?: string;
  /** English text, the fallback for unknown codes. */
  reason: string;
}

export interface Plan {
  id: string;
  created_at: string;
  params: PlanParams;
  solve_seconds: number;
  cleaners: Cleaner[];
  routes: Route[];
  assignments: Assignment[];
  territories: Territory[];
  unassigned: Unassigned[];
  kpis: KPIs;
}

export interface Change {
  building_id: string;
  day_key: DayKey;
  from_cleaner: string | null;
  to_cleaner: string | null;
  added_walk: number;
}

export interface ChangeResult {
  plan: Plan;
  changes: Change[];
  churn: number;
  untouched_routes: number;
  kpis_before: KPIs;
  kpis_after: KPIs;
  message: string;
}

export interface NewBuilding {
  lat: number;
  lng: number;
  frequency: Frequency;
  service_minutes: number;
  name?: string;
  time_window?: [number, number] | null;
}

export interface InsertCandidate {
  cleaner_id: string;
  day_keys: DayKey[];
  added_walk_minutes: number;
  feasible: boolean;
  slack_after: number;
}

export interface WorkforceEstimate {
  daily_minutes: number;
  target_utilization: number;
  total_service_minutes: number;
  est_walk_minutes: number;
  busiest_day: DayKey;
  busiest_day_load: number;
  lower_bound: number;
  estimate: number;
  solved: number | null;
}

export interface RouteSheetStop extends Stop {
  building: Building;
}

export interface RouteSheet {
  cleaner: Cleaner;
  day_key: DayKey;
  date_label: string;
  route: Route;
  stops: RouteSheetStop[];
  google_maps_url: string;
  google_maps_urls: string[];
  /** Static build: set when the link could not carry the whole scenario (e.g. a new building). */
  note?: 'scenario_not_included';
}

export interface CostEstimate {
  buildings: number;
  naive_elements: number;
  our_elements: number;
  price_per_1000_usd: number;
  free_elements_per_month: number;
  naive_cost_usd: number;
  our_cost_usd: number;
  note: string;
}

/** One data-quality note on an import row: stable `code`, optional `value`, English `text`. */
export interface ImportIssue {
  code: string;
  text: string;
  value?: string;
}

export interface ImportRow {
  input: Record<string, string>;
  matched: boolean;
  confidence: number;
  lat?: number;
  lng?: number;
  matched_label?: string;
  /** English, all issues joined with "; ". */
  issue?: string;
  issues?: ImportIssue[];
  /** Parsed frequency code, when the frequency cell was understood. */
  frequency?: Frequency;
}

/** `summary` is not typed in the contract; accept a string or a flat object. */
export type ImportSummary = string | Record<string, unknown> | null | undefined;

export interface ImportResult {
  rows: ImportRow[];
  summary: ImportSummary;
}

export interface ProviderCompare {
  pairs: { from: string; to: string; osrm_min: number; google_min: number }[];
  mean_abs_diff_min: number;
  note: string;
}

export interface Meta {
  day_keys: DayKey[];
  frequencies: unknown;
  patterns: unknown;
  neighborhoods: unknown;
  data_note: string;
  travel_provider: string;
  /** True only if a Google comparison exists; when false the client skips GET /api/provider-compare. */
  provider_compare: boolean;
  /** One-click example absence on the default plan (all visits absorbed by 3–4 colleagues). */
  demo_absence?: { cleaner_id: string; day_key: DayKey } | null;
}

export interface NearestAddress { street: string; number: string; neighborhood: string; label: string; distance_m: number }

export interface Baseline {
  kpis: KPIs;
  description: string;
  // Extra fields from the real backend (the mock leaves them out):
  /** Naive routes are not shift-limited: how many end after the shift, and by how much in total. */
  overtime_routes?: number;
  overtime_minutes?: number;
  /** Visits that finish after the building's time window closes. */
  time_window_violations?: number;
}

/** What an implementation can do; the UI adapts (the static build replays precomputed results). */
export interface ApiFeatures {
  /** Results come from files precomputed by the real optimiser (static build). */
  replay: boolean;
  /** Target utilisations a re-plan supports; undefined means any. */
  replanTargets?: number[];
  /** Absences can only be tried on the standard plan. */
  absenceOnStandardPlanOnly: boolean;
}

export interface Api {
  features: ApiFeatures;
  /** Query string that lets a route-sheet link show this visitor's current scenario elsewhere. */
  shareQuery(): string;
  meta(): Promise<Meta>;
  buildings(): Promise<Building[]>;
  cleaners(): Promise<Cleaner[]>;
  currentPlan(): Promise<Plan>;
  replan(params: PlanParams): Promise<Plan>;
  baseline(): Promise<Baseline>;
  absence(cleaner_id: string, day_key: DayKey): Promise<ChangeResult>;
  insertCandidates(b: NewBuilding): Promise<{ candidates: InsertCandidate[] }>;
  insertCommit(building: NewBuilding, candidate: InsertCandidate): Promise<ChangeResult>;
  reset(): Promise<Plan>;
  workforce(daily_minutes: number, target_utilization: number): Promise<WorkforceEstimate>;
  /** `context` is the sheet page's query string (from `shareQuery()`), e.g. a shared session or scenario. */
  routeSheet(cleaner_id: string, day_key: DayKey, context?: string): Promise<RouteSheet>;
  costEstimate(): Promise<CostEstimate>;
  importFile(file: File): Promise<ImportResult>;
  importSampleUrl(): string;
  /** Nearest known address to a point (offline OSM index); null if unavailable. */
  reverseGeocode(lat: number, lng: number): Promise<NearestAddress | null>;
  /** The session's 2-week schedule as an .xlsx file. */
  exportSchedule(): Promise<Blob>;
  /** Resolves to null when the endpoint returns a non-200 status. */
  providerCompare(): Promise<ProviderCompare | null>;
}
