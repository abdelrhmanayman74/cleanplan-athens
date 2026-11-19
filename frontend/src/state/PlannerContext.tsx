import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getApi } from '../api';
import type {
  Api, Assignment, Baseline, Building, ChangeResult, Cleaner, CostEstimate, DayKey, Frequency, InsertCandidate, Meta,
  NewBuilding, Plan, PlanParams, ProviderCompare, Route,
} from '../api/types';
import { cleanerColor } from '../lib/colors';
import { walkDeltaByCleaner } from '../lib/planStats';

export type Tab = 'plan' | 'kpi' | 'scenarios' | 'import';
export type DaySel = DayKey | 'ALL';

/**
 * `walkByCleaner`: walking minutes gained (+) or saved (−) per cleaner, from the routes themselves.
 * `changedKeys`: routes whose stops changed. `ghost`: the absent cleaner's route before the change.
 */
interface ScenarioDiff { result: ChangeResult; changedKeys: Set<string>; walkByCleaner: Map<string, number> }
export type Scenario =
  | ({ kind: 'absence'; cleanerId: string; day: DayKey; ghost: Route | null } & ScenarioDiff)
  | ({ kind: 'insert'; candidate: InsertCandidate; building: NewBuilding } & ScenarioDiff);

export interface InsertDraft {
  picking: boolean;
  pin: { lat: number; lng: number } | null;
  candidates: InsertCandidate[] | null;
  hover: number | null;
  frequency: Frequency;
  service_minutes: number;
  name: string;
  morning: boolean;
  loading: boolean;
  /** Nearest known address to the pin, e.g. "Ευτυχίδου 12, Παγκράτι". */
  address: string | null;
}

export interface AbsenceDraft { cleanerId: string; day: DayKey; nonce: number }
export interface ImportPin { lat: number; lng: number; label: string }

export interface Toast { id: number; text: string; tone: 'success' | 'info' | 'warning' | 'error' }
export interface FlyTarget { lat: number; lng: number; zoom?: number; nonce: number }

export const routeKey = (r: { cleaner_id: string; day_key: DayKey }) => `${r.cleaner_id}|${r.day_key}`;

interface PlannerValue {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  reload: () => void;
  api: Api | null;
  meta: Meta | null;
  buildings: Building[];
  buildingById: Map<string, Building>;
  plan: Plan | null;
  cleaners: Cleaner[];
  cleanerById: Map<string, Cleaner>;
  assignmentByBuilding: Map<string, Assignment>;
  routesByDay: Map<DayKey, Route[]>;
  routeByKey: Map<string, Route>;
  baseline: Baseline | null;
  cost: CostEstimate | null;
  provider: ProviderCompare | null;
  day: DaySel; setDay: (d: DaySel) => void;
  focus: string | null; setFocus: (id: string | null) => void;
  selected: string | null; selectBuilding: (id: string | null, fly?: boolean) => void;
  fly: FlyTarget | null; flyTo: (lat: number, lng: number, zoom?: number) => void;
  tab: Tab; setTab: (t: Tab) => void;
  scenario: Scenario | null;
  /** Cleaner row under the pointer: their route is drawn at full strength. */
  hoverCleaner: string | null; setHoverCleaner: (id: string | null) => void;
  /** Pre-fills the absence form (from a cleaner row) and opens the Scenarios tab. */
  absenceDraft: AbsenceDraft | null; openAbsence: (cleanerId: string, day: DayKey) => void;
  importPins: ImportPin[]; showImportPins: (pins: ImportPin[]) => void;
  /** True after a re-plan with different settings, until reset. */
  replanned: boolean;
  applyAbsence: (cleanerId: string, day: DayKey) => Promise<ChangeResult>;
  applyInsert: (b: NewBuilding, c: InsertCandidate) => Promise<ChangeResult>;
  resetPlan: () => Promise<void>;
  replan: (p: PlanParams) => Promise<Plan>;
  replanning: boolean;
  insert: InsertDraft; setInsert: (u: Partial<InsertDraft> | ((d: InsertDraft) => Partial<InsertDraft>)) => void;
  findCandidates: (pin?: { lat: number; lng: number }) => Promise<InsertCandidate[]>;
  cancelInsert: () => void;
  toast: Toast | null; showToast: (text: string, tone?: Toast['tone']) => void; dismissToast: () => void;
}

const Ctx = createContext<PlannerValue | null>(null);
const EMPTY_INSERT: InsertDraft = {
  picking: false, pin: null, candidates: null, hover: null,
  frequency: '2w', service_minutes: 35, name: '', morning: false, loading: false, address: null,
};

export function draftToNewBuilding(d: InsertDraft, pin = d.pin): NewBuilding | null {
  if (!pin) return null;
  return {
    lat: pin.lat, lng: pin.lng, frequency: d.frequency, service_minutes: d.service_minutes,
    name: d.name.trim() || undefined, time_window: d.morning ? [420, 720] : null,
  };
}

function diff(before: Plan, result: ChangeResult): ScenarioDiff {
  // ``before`` must be the plan the server changed; a stale copy would count unrelated routes as changed
  const after = result.plan;
  const prev = new Map(before.routes.map((r) => [routeKey(r), r.stops.map((s) => s.building_id).join(',')]));
  const changedKeys = new Set<string>();
  for (const r of after.routes) if (prev.get(routeKey(r)) !== r.stops.map((s) => s.building_id).join(',')) changedKeys.add(routeKey(r));
  return { result, changedKeys, walkByCleaner: walkDeltaByCleaner(before, after) };
}

export function PlannerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PlannerValue['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [api, setApi] = useState<Api | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [cost, setCost] = useState<CostEstimate | null>(null);
  const [provider, setProvider] = useState<ProviderCompare | null>(null);
  const [day, setDay] = useState<DaySel>('A-Mon');
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const [tab, setTab] = useState<Tab>('plan');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [hoverCleaner, setHoverCleaner] = useState<string | null>(null);
  const [absenceDraft, setAbsenceDraft] = useState<AbsenceDraft | null>(null);
  const [importPins, setImportPins] = useState<ImportPin[]>([]);
  const [replanned, setReplanned] = useState(false);
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;
  const [replanning, setReplanning] = useState(false);
  const [insert, setInsertState] = useState<InsertDraft>(EMPTY_INSERT);
  const [toast, setToast] = useState<Toast | null>(null);
  const [nonce, setNonce] = useState(0);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const a = await getApi();
        const [m, bs, p] = await Promise.all([a.meta(), a.buildings(), a.currentPlan()]);
        if (cancelled) return;
        setApi(a); setMeta(m); setBuildings(bs); setPlan(p); setStatus('ready');
        // secondary data: never block the first paint
        a.baseline().then((b) => !cancelled && setBaseline(b)).catch(() => {});
        a.costEstimate().then((c) => !cancelled && setCost(c)).catch(() => {});
        if (m.provider_compare) a.providerCompare().then((pc) => !cancelled && setProvider(pc)).catch(() => {});
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  const buildingById = useMemo(() => new Map(buildings.map((b) => [b.id, b])), [buildings]);
  const cleaners = useMemo(
    () => (plan?.cleaners ?? []).map((c, i) => ({ ...c, color: cleanerColor(c.id, i) })),
    [plan],
  );
  const cleanerById = useMemo(() => new Map(cleaners.map((c) => [c.id, c])), [cleaners]);
  const assignmentByBuilding = useMemo(() => new Map((plan?.assignments ?? []).map((a) => [a.building_id, a])), [plan]);
  const routesByDay = useMemo(() => {
    const m = new Map<DayKey, Route[]>();
    for (const r of plan?.routes ?? []) {
      if (!m.has(r.day_key)) m.set(r.day_key, []);
      m.get(r.day_key)!.push(r);
    }
    return m;
  }, [plan]);
  const routeByKey = useMemo(() => new Map((plan?.routes ?? []).map((r) => [routeKey(r), r])), [plan]);

  const showToast = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), 9000);
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const flyTo = useCallback((lat: number, lng: number, zoom?: number) => setFly({ lat, lng, zoom, nonce: Date.now() }), []);
  const selectBuilding = useCallback((id: string | null, doFly = false) => {
    setSelected(id);
    if (id && doFly) {
      const b = buildingById.get(id);
      if (b) flyTo(b.lat, b.lng, 16);
    }
  }, [buildingById, flyTo]);

  const setInsert = useCallback((u: Partial<InsertDraft> | ((d: InsertDraft) => Partial<InsertDraft>)) => {
    setInsertState((d) => ({ ...d, ...(typeof u === 'function' ? u(d) : u) }));
  }, []);

  const findCandidates = useCallback(async (pin?: { lat: number; lng: number }) => {
    if (!api) return [];
    const nb = draftToNewBuilding(insert, pin ?? insert.pin);
    if (!nb) return [];
    setInsertState((d) => ({ ...d, pin: { lat: nb.lat, lng: nb.lng }, picking: false, loading: true, candidates: null, hover: null }));
    try {
      const { candidates } = await api.insertCandidates(nb);
      setInsertState((d) => ({ ...d, candidates, loading: false }));
      const first = candidates[0]?.day_keys[0];
      if (first) setDay(first);
      return candidates;
    } catch (e) {
      setInsertState((d) => ({ ...d, loading: false }));
      throw e;
    }
  }, [api, insert]);

  // label the pin with the nearest known address
  const pinLat = insert.pin?.lat, pinLng = insert.pin?.lng;
  useEffect(() => {
    if (!api || pinLat == null || pinLng == null) return;
    let stale = false;
    setInsertState((d) => ({ ...d, address: null }));
    api.reverseGeocode(pinLat, pinLng).then((a) => { if (!stale && a) setInsertState((d) => ({ ...d, address: a.label })); });
    return () => { stale = true; };
  }, [api, pinLat, pinLng]);

  const cancelInsert = useCallback(() => setInsertState((d) => ({ ...EMPTY_INSERT, frequency: d.frequency, service_minutes: d.service_minutes })), []);

  const openAbsence = useCallback((cleanerId: string, d: DayKey) => {
    setAbsenceDraft({ cleanerId, day: d, nonce: Date.now() });
    setTab('scenarios');
  }, []);
  const showImportPins = useCallback((pins: ImportPin[]) => setImportPins(pins), []);

  const applyAbsence = useCallback(async (cleanerId: string, d: DayKey) => {
    const before = planRef.current;
    if (!api || !before) throw new Error('not ready');
    const res = await api.absence(cleanerId, d);
    const ghost = before.routes.find((r) => r.cleaner_id === cleanerId && r.day_key === d) ?? null;
    setScenario({ kind: 'absence', cleanerId, day: d, ghost, ...diff(before, res) });
    setPlan(res.plan);
    setDay(d);
    setFocus(null);
    setSelected(null);
    setTab('scenarios');
    return res;
  }, [api]);

  const applyInsert = useCallback(async (b: NewBuilding, c: InsertCandidate) => {
    const before = planRef.current;
    if (!api || !before) throw new Error('not ready');
    const res = await api.insertCommit(b, c);
    const bs = await api.buildings();
    setBuildings(bs);
    setScenario({ kind: 'insert', candidate: c, building: b, ...diff(before, res) });
    setPlan(res.plan);
    setDay(c.day_keys[0] ?? 'ALL');
    setInsertState((d) => ({ ...EMPTY_INSERT, frequency: d.frequency, service_minutes: d.service_minutes }));
    return res;
  }, [api]);

  const resetPlan = useCallback(async () => {
    if (!api) return;
    const p = await api.reset();
    const bs = await api.buildings();
    setBuildings(bs);
    setPlan(p);
    setScenario(null);
    setReplanned(false);
    setInsertState(EMPTY_INSERT);
    setSelected(null);
    api.costEstimate().then(setCost).catch(() => {});
  }, [api]);

  const replan = useCallback(async (params: PlanParams) => {
    if (!api) throw new Error('not ready');
    setReplanning(true);
    try {
      const p = await api.replan(params);
      setPlan(p);
      setScenario(null);
      setReplanned(true);
      setFocus(null);
      api.costEstimate().then(setCost).catch(() => {});
      return p;
    } finally {
      setReplanning(false);
    }
  }, [api]);

  const value: PlannerValue = {
    status, error, reload: () => setNonce((n) => n + 1), api, meta, buildings, buildingById, plan, cleaners, cleanerById,
    assignmentByBuilding, routesByDay, routeByKey, baseline, cost, provider,
    day, setDay, focus, setFocus, selected, selectBuilding, fly, flyTo, tab, setTab,
    scenario, hoverCleaner, setHoverCleaner, absenceDraft, openAbsence, importPins, showImportPins, replanned, applyAbsence, applyInsert, resetPlan, replan, replanning, insert, setInsert, findCandidates, cancelInsert,
    toast, showToast, dismissToast,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlanner(): PlannerValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePlanner outside provider');
  return c;
}
