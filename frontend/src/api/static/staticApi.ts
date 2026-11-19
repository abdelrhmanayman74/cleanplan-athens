// The static (GitHub Pages) implementation of the API. Plans, baselines, workforce estimates and
// every single-day absence were computed by the real optimiser (backend/scripts/export_static.py)
// and are replayed from files; only input-dependent work (a new building, an imported file, the
// Excel export) runs in the browser, with ports of the backend code.

import type {
  Api, Baseline, Building, ChangeResult, CostEstimate, DayKey, ImportResult, InsertCandidate, Meta, NearestAddress,
  NewBuilding, Plan, PlanParams, WorkforceEstimate,
} from '../types';
import { ApiError } from '../client';
import { scheduleWorkbook } from './excel';
import { AddressIndex, importRows, parseCsv, TableError, type AddressRow } from './geocoder';
import { commitInsert, insertCandidates, newBuildingRecord, World, type Params } from './insertion';
import { routeSheet } from './sheet';

interface StaticMeta extends Meta {
  static: { replan_minutes: number[]; replan_target: number; default_minutes: number; walk_speed_mps: number; detour_factor: number; break_minutes: number };
  patterns: Record<string, string[][]>;
}
interface PlanFile { plan: Plan; baseline: Baseline; cost: CostEstimate }
interface AbsenceDiff {
  id: string; routes: Plan['routes']; unassigned: Plan['unassigned']; changes: ChangeResult['changes'];
  churn: number; untouched_routes: number; kpis_after: Plan['kpis']; message: string;
}

const BASE = `${import.meta.env.BASE_URL}static-data/`;
const REPLAN_DELAY_MS = 700; // a short "Υπολογισμός…" so the switch to a precomputed plan isn't jarring

const cache = new Map<string, Promise<unknown>>();
function load<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    cache.set(path, fetch(BASE + path).then((r) => {
      if (!r.ok) throw new ApiError(r.status, `${path}: HTTP ${r.status}`);
      return path.endsWith('.json') ? r.json() : r.arrayBuffer();
    }));
  }
  return cache.get(path) as Promise<T>;
}

/** The scenario a route-sheet link can carry: `?shift=7` and/or `?absence=c22:A-Tue`. */
interface Scenario { minutes: number; absence: { cleanerId: string; day: DayKey } | null; added: boolean }

function parseScenario(query: string, defaultMinutes: number): Scenario {
  const q = new URLSearchParams(query);
  const shift = Number(q.get('shift'));
  const [cleanerId, day] = (q.get('absence') ?? '').split(':');
  return {
    minutes: shift > 0 ? Math.round(shift * 60) : defaultMinutes,
    absence: cleanerId && day ? { cleanerId, day } : null,
    added: q.get('added') === '1',
  };
}

export async function createStaticApi(): Promise<Api> {
  const meta = await load<StaticMeta>('meta.json');
  const baseBuildings = await load<Building[]>('buildings.json');
  const s = meta.static;
  const planFile = (minutes: number) => load<PlanFile>(`plans/${minutes}.json`);
  const absenceDiff = async (cleanerId: string, day: DayKey) => (await load<Record<string, AbsenceDiff>>(`absences/${day}.json`))[cleanerId];
  const addressIndex = (() => {
    let idx: Promise<AddressIndex> | null = null;
    return () => (idx ??= load<AddressRow[]>('address_index.json').then((rows) => new AddressIndex(rows)));
  })();
  let world: Promise<World> | null = null;
  const getWorld = () => (world ??= Promise.all([load<ArrayBuffer>('matrix.u16'), load<[number, number][]>('nodes.json')])
    .then(([m, nodes]) => {
      const w = new World(new Uint16Array(m), nodes, baseBuildings, s.detour_factor, s.walk_speed_mps);
      for (const b of added) w.add(b);
      return w;
    }));

  // this tab's state
  let minutes = s.default_minutes;
  let plan = (await planFile(minutes)).plan;
  let absence: Scenario['absence'] = null;
  let added: Building[] = [];
  const params = (): Params => ({ dailyMinutes: minutes, breakMinutes: s.break_minutes });
  const isStandard = () => minutes === s.default_minutes && !absence && !added.length;

  /** The default plan with one precomputed absence applied (what /api/plan/absence returns). */
  async function withAbsence(base: Plan, cleanerId: string, day: DayKey): Promise<ChangeResult> {
    const diff = await absenceDiff(cleanerId, day);
    if (!diff) throw new ApiError(422, `no route for ${cleanerId} / ${day}`);
    const byKey = new Map(diff.routes.map((r) => [`${r.cleaner_id}|${r.day_key}`, r]));
    const after: Plan = {
      ...base,
      id: diff.id,
      routes: base.routes.map((r) => byKey.get(`${r.cleaner_id}|${r.day_key}`) ?? r),
      unassigned: [...base.unassigned, ...diff.unassigned],
      kpis: diff.kpis_after,
    };
    return {
      plan: after, changes: diff.changes, churn: diff.churn, untouched_routes: diff.untouched_routes,
      kpis_before: base.kpis, kpis_after: diff.kpis_after, message: diff.message,
    };
  }

  const api: Api = {
    features: { replay: true, replanTargets: [s.replan_target], absenceOnStandardPlanOnly: true },

    shareQuery() {
      const q = new URLSearchParams();
      if (minutes !== s.default_minutes) q.set('shift', String(minutes / 60));
      if (absence) q.set('absence', `${absence.cleanerId}:${absence.day}`);
      if (added.length) q.set('added', '1');
      const str = q.toString();
      return str ? `?${str}` : '';
    },

    async meta() { return meta; },
    async buildings() { return [...baseBuildings, ...added]; },
    async cleaners() { return plan.cleaners; },
    async currentPlan() { return plan; },

    async replan(p: PlanParams) {
      const m = p.daily_minutes ?? s.default_minutes;
      if (!s.replan_minutes.includes(m) || (p.target_utilization != null && Math.abs(p.target_utilization - s.replan_target) > 1e-6)) {
        throw new ApiError(422, 'this combination is not precomputed in the static demo', 'static_replan');
      }
      const [file] = await Promise.all([planFile(m), new Promise((r) => setTimeout(r, REPLAN_DELAY_MS))]);
      minutes = m; plan = file.plan; absence = null; added = []; world = null;
      return plan;
    },

    async baseline() { return (await planFile(minutes)).baseline; },

    async absence(cleanerId, day) {
      if (!isStandard()) {
        throw new ApiError(409, 'absences are precomputed for the standard plan only', 'absence_standard_only');
      }
      const res = await withAbsence(plan, cleanerId, day);
      plan = res.plan;
      absence = { cleanerId, day };
      return res;
    },

    async insertCandidates(nb: NewBuilding) {
      const w = await getWorld();
      const record = newBuildingRecord([...baseBuildings, ...added], nb, `cand-${Date.now()}`, s.detour_factor, s.walk_speed_mps);
      return { candidates: insertCandidates(w, plan, params(), record, meta.patterns[nb.frequency]) };
    },

    async insertCommit(nb: NewBuilding, c: InsertCandidate) {
      const w = await getWorld();
      const id = `n${String(added.length + 1).padStart(3, '0')}`;
      const record = newBuildingRecord([...baseBuildings, ...added], nb, id, s.detour_factor, s.walk_speed_mps);
      const res = commitInsert(w, plan, params(), record, c);
      added = [...added, record];
      plan = res.plan;
      return res;
    },

    async reset() {
      minutes = s.default_minutes; absence = null; added = []; world = null;
      plan = (await planFile(minutes)).plan;
      return plan;
    },

    async workforce(dailyMinutes: number, target: number): Promise<WorkforceEstimate> {
      const all = await load<Record<string, WorkforceEstimate>>('workforce.json');
      const est = all[`${dailyMinutes}|${target.toFixed(2)}`];
      if (!est) throw new ApiError(422, 'estimate not precomputed');
      return { ...est, solved: plan.kpis.cleaners };
    },

    /** Built from the URL alone, so a link opened on a phone shows the same scenario. */
    async routeSheet(cleanerId, day, context = '') {
      const sc = parseScenario(context, s.default_minutes);
      let p = (await planFile(sc.minutes)).plan;
      if (sc.absence && sc.minutes === s.default_minutes) p = (await withAbsence(p, sc.absence.cleanerId, sc.absence.day)).plan;
      const sheet = routeSheet(p, new Map(baseBuildings.map((b) => [b.id, b])), cleanerId, day);
      if (!sheet) throw new ApiError(404, `no route for ${cleanerId} / ${day}`, 'route_not_found');
      return sc.added ? { ...sheet, note: 'scenario_not_included' } : sheet;
    },

    async costEstimate() { return (await planFile(minutes)).cost; },

    async importFile(file: File): Promise<ImportResult> {
      if (file.size > 5_000_000) throw new ApiError(413, 'file too large (max 5 MB)', 'file_too_large');
      let table: string[][];
      try {
        if (/\.csv$/i.test(file.name)) table = parseCsv(await file.text());
        else {
          const { readSheet } = await import('read-excel-file/browser');
          table = (await readSheet(file)).map((row) => row.map((v) => (v == null ? '' : String(v))));
        }
      } catch (e) {
        throw new ApiError(422, `could not read file: ${e instanceof Error ? e.message : e}`, 'unreadable_file');
      }
      try {
        return importRows(table, await addressIndex());
      } catch (e) {
        if (e instanceof TableError) throw new ApiError(422, e.message, e.code);
        throw e;
      }
    },

    importSampleUrl: () => `${BASE}import_template.xlsx`,

    async reverseGeocode(lat: number, lng: number): Promise<NearestAddress | null> {
      return (await addressIndex()).nearest(lat, lng);
    },

    async exportSchedule() {
      return scheduleWorkbook(plan, new Map([...baseBuildings, ...added].map((b) => [b.id, b])));
    },

    async providerCompare() { return null; },
  };
  return api;
}
