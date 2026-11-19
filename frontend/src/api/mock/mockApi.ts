// In-browser mock of the FastAPI backend (VITE_MOCK=1). Same shapes as CONTRACT.md.

import type {
  Api, Building, Change, ChangeResult, CostEstimate, DayKey, ImportIssue, ImportResult, ImportRow, InsertCandidate,
  Meta, NewBuilding, Plan, PlanParams, ProviderCompare, Route, RouteSheet, WorkforceEstimate,
} from '../types';
import { ApiError } from '../client';
import { DAY_KEYS, splitDay } from '../../lib/days';
import { normalizeSearch } from '../../lib/normalize';
import { HOODS } from './data';
import { buildFixture, type Fixture } from './fixture';
import { distM, walkMinutes } from './geo';
import {
  VISITS_PER_2W, buildRoute, cheapestInsertion, computeKpis, convexHullForCleaner, normParams, patternsFor,
  solvePlan, type Ctx,
} from './solver';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const GR_DAYS: Record<string, string> = { Mon: 'Δευτέρα', Tue: 'Τρίτη', Wed: 'Τετάρτη', Thu: 'Πέμπτη', Fri: 'Παρασκευή' };

async function loadFixture(): Promise<Fixture> {
  try {
    const res = await fetch('/mock/fixture.json');
    if (res.ok) return (await res.json()) as Fixture;
  } catch { /* fall through */ }
  return buildFixture();
}

export async function createMockApi(): Promise<Api> {
  const fx = await loadFixture();
  let buildings: Building[] = fx.buildings;
  const defaultBuildings = clone(fx.buildings);
  const defaultPlan = clone(fx.plan);
  let plan: Plan = clone(fx.plan);
  let newCounter = 0;

  const ctx = (): Ctx => ({ buildings: new Map(buildings.map((b) => [b.id, b])), params: normParams(plan.params) });
  const routeKey = (r: Pick<Route, 'cleaner_id' | 'day_key'>) => `${r.cleaner_id}|${r.day_key}`;
  const cleanerById = (id: string) => {
    const c = plan.cleaners.find((x) => x.id === id);
    if (!c) throw new ApiError(404, `Unknown cleaner ${id}`);
    return c;
  };

  function finalize(next: Plan, before: Plan, changes: Change[], message: string): ChangeResult {
    const c = ctx();
    next.kpis = computeKpis(c, next);
    const prev = new Map(before.routes.map((r) => [routeKey(r), r.stops.map((s) => s.building_id).join(',')]));
    const untouched = next.routes.filter((r) => prev.get(routeKey(r)) === r.stops.map((s) => s.building_id).join(',')).length;
    plan = next;
    return {
      plan: clone(next), changes,
      churn: changes.filter((ch) => ch.from_cleaner !== null).length,
      untouched_routes: untouched,
      kpis_before: before.kpis, kpis_after: next.kpis, message,
    };
  }

  function bestInsertFor(c: Ctx, nb: Building, extraOrder?: Map<string, string[]>) {
    const out: InsertCandidate[] = [];
    for (const cl of plan.cleaners) {
      if (distM([cl.start.lat, cl.start.lng], [nb.lat, nb.lng]) > 4000) continue;
      let best: InsertCandidate | null = null;
      for (const pat of patternsFor(nb.frequency)) {
        let added = 0, slack = Infinity;
        for (const d of pat) {
          const r = plan.routes.find((x) => x.cleaner_id === cl.id && x.day_key === d);
          const order = extraOrder?.get(`${cl.id}|${d}`) ?? r?.stops.map((s) => s.building_id) ?? [];
          const ins = cheapestInsertion(c, cl, order, nb);
          const rebuilt = buildRoute(c, cl, d, ins.order);
          added += rebuilt.walk_minutes - (r?.walk_minutes ?? 0);
          slack = Math.min(slack, cl.daily_minutes - rebuilt.total_minutes);
        }
        const cand: InsertCandidate = { cleaner_id: cl.id, day_keys: pat, added_walk_minutes: Math.round(added), feasible: slack >= 0, slack_after: Math.round(slack) };
        if (!best || (cand.feasible && !best.feasible) || (cand.feasible === best.feasible && cand.added_walk_minutes < best.added_walk_minutes)) best = cand;
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.added_walk_minutes - b.added_walk_minutes).slice(0, 3);
  }

  function toBuilding(nb: NewBuilding, id: string): Building {
    let hood = HOODS[0];
    for (const h of HOODS) if (distM(h.center, [nb.lat, nb.lng]) < distM(hood.center, [nb.lat, nb.lng])) hood = h;
    const near = buildings.map((b) => walkMinutes([b.lat, b.lng], [nb.lat, nb.lng])).sort((a, b) => a - b);
    return {
      id, name: nb.name?.trim() || 'Νέα πολυκατοικία', street: nb.name?.trim() || 'Νέα διεύθυνση', number: '—',
      postcode: hood.postcode, neighborhood: hood.name, lat: nb.lat, lng: nb.lng, floors: 5, has_lift: true,
      service_minutes: nb.service_minutes, frequency: nb.frequency, time_window: nb.time_window ?? null,
      manager: { name: '—', phone: '—' }, access_note: 'Νέος πελάτης: επιβεβαίωση πρόσβασης', tasks: ['Σκάλες', 'Είσοδος'],
      isolated: (near[2] ?? Infinity) > 15,
    };
  }

  const api: Api = {
    features: { replay: false, absenceOnStandardPlanOnly: false },
    shareQuery: () => '',
    async meta(): Promise<Meta> {
      return {
        day_keys: DAY_KEYS,
        frequencies: ['3w', '2w', '1w', 'biweekly'],
        patterns: Object.fromEntries((['3w', '2w', '1w', 'biweekly'] as const).map((f) => [f, patternsFor(f)])),
        neighborhoods: HOODS.map((h) => h.name),
        data_note: 'Synthetic customers on real OpenStreetMap street names (mock mode).',
        travel_provider: 'mock (grid walking estimate)',
        provider_compare: true,
      };
    },
    async buildings() { await sleep(120); return clone(buildings); },
    async cleaners() { return clone(plan.cleaners); },
    async currentPlan() { await sleep(180); return clone(plan); },
    async replan(params: PlanParams) {
      const t0 = performance.now();
      await sleep(400);
      const next = solvePlan(buildings, params, 11 + Math.round((params.daily_minutes ?? 480) / 30));
      const elapsed = (performance.now() - t0) / 1000;
      if (elapsed < 3.5) await sleep((3.5 - elapsed) * 1000); // feel like a real solve
      next.solve_seconds = +((performance.now() - t0) / 1000).toFixed(1);
      next.id = `plan-${Date.now()}`;
      plan = next;
      return clone(plan);
    },
    async baseline() { return clone(fx.baseline); },

    async absence(cleaner_id: string, day_key: DayKey) {
      await sleep(500);
      const c = ctx();
      const absent = cleanerById(cleaner_id);
      const before = clone(plan);
      const route = plan.routes.find((r) => r.cleaner_id === cleaner_id && r.day_key === day_key);
      if (!route) throw new ApiError(400, 'Cleaner has no route on this day');
      const orders = new Map(plan.routes.filter((r) => r.day_key === day_key).map((r) => [r.cleaner_id, r.stops.map((s) => s.building_id)]));
      orders.delete(cleaner_id);
      const neighbours = plan.cleaners
        .filter((x) => x.id !== cleaner_id)
        .map((x) => ({ x, d: distM([x.start.lat, x.start.lng], [absent.start.lat, absent.start.lng]) }))
        .sort((a, b) => a.d - b.d).slice(0, 8).map((o) => o.x);
      const changes: Change[] = [];
      const unassigned = plan.unassigned.slice();
      const touched = new Set<string>();
      for (const s of route.stops) {
        const b = c.buildings.get(s.building_id)!;
        let best: { cl: typeof neighbours[number]; order: string[]; added: number } | null = null;
        for (const cl of neighbours) {
          const cur = orders.get(cl.id) ?? [];
          const curRoute = buildRoute(c, cl, day_key, cur);
          const ins = cheapestInsertion(c, cl, cur, b);
          const r = buildRoute(c, cl, day_key, ins.order);
          if (r.total_minutes > cl.daily_minutes) continue;
          if (b.time_window && r.stops.find((x) => x.building_id === b.id)!.depart > b.time_window[1]) continue;
          const added = r.walk_minutes - (cur.length ? curRoute.walk_minutes : 0);
          if (!best || added < best.added) best = { cl, order: ins.order, added };
        }
        if (best) {
          orders.set(best.cl.id, best.order);
          touched.add(best.cl.id);
          changes.push({ building_id: b.id, day_key, from_cleaner: cleaner_id, to_cleaner: best.cl.id, added_walk: Math.round(best.added) });
        } else {
          unassigned.push({ building_id: b.id, day_key, reason_code: 'needs_overtime', reason: 'No nearby colleague has enough shift time left' });
          changes.push({ building_id: b.id, day_key, from_cleaner: cleaner_id, to_cleaner: null, added_walk: 0 });
        }
      }
      const routes = plan.routes
        .filter((r) => !(r.cleaner_id === cleaner_id && r.day_key === day_key))
        .map((r) => (r.day_key === day_key && touched.has(r.cleaner_id) ? buildRoute(c, cleanerById(r.cleaner_id), day_key, orders.get(r.cleaner_id)!) : r));
      const next: Plan = { ...clone(plan), routes, unassigned, id: `plan-abs-${Date.now()}` };
      const moved = changes.filter((x) => x.to_cleaner).length;
      return finalize(next, before, changes, `${moved} visits of ${absent.name} reassigned to ${touched.size} colleagues; ${route.stops.length - moved} unassigned.`);
    },

    async insertCandidates(nb: NewBuilding) {
      await sleep(350);
      const c = ctx();
      const b = toBuilding(nb, '__probe__');
      c.buildings.set(b.id, b);
      return { candidates: bestInsertFor(c, b) };
    },

    async insertCommit(nb: NewBuilding, cand: InsertCandidate) {
      await sleep(450);
      const before = clone(plan);
      const b = toBuilding(nb, `new${String(++newCounter).padStart(3, '0')}`);
      buildings = buildings.concat(b);
      const c = ctx();
      const cl = cleanerById(cand.cleaner_id);
      const changes: Change[] = [];
      let routes = plan.routes.slice();
      for (const d of cand.day_keys) {
        const idx = routes.findIndex((r) => r.cleaner_id === cl.id && r.day_key === d);
        const order = idx >= 0 ? routes[idx].stops.map((s) => s.building_id) : [];
        const ins = cheapestInsertion(c, cl, order, b);
        const r = buildRoute(c, cl, d, ins.order);
        changes.push({ building_id: b.id, day_key: d, from_cleaner: null, to_cleaner: cl.id, added_walk: Math.round(r.walk_minutes - (idx >= 0 ? routes[idx].walk_minutes : 0)) });
        if (idx >= 0) routes[idx] = r; else routes = routes.concat(r);
      }
      const next: Plan = clone(plan);
      next.routes = routes;
      next.assignments = next.assignments.concat({ building_id: b.id, cleaner_id: cl.id, pattern: cand.day_keys.slice() });
      next.territories = next.territories.map((t) => (t.cleaner_id === cl.id ? { ...t, hull: convexHullForCleaner(c, next, cl.id) } : t));
      next.id = `plan-ins-${Date.now()}`;
      return finalize(next, before, changes, `New building added to ${cl.name} on ${cand.day_keys.join(', ')}; no other building moved.`);
    },

    async reset() {
      await sleep(250);
      buildings = clone(defaultBuildings);
      plan = clone(defaultPlan);
      return clone(plan);
    },

    async workforce(daily_minutes: number, target_utilization: number): Promise<WorkforceEstimate> {
      const brk = normParams(plan.params).break_minutes;
      const avail = daily_minutes - brk;
      const perDayService = new Map<DayKey, number>(DAY_KEYS.map((d) => [d, 0]));
      const perDayVisits = new Map<DayKey, number>(DAY_KEYS.map((d) => [d, 0]));
      const asg = new Map(plan.assignments.map((a) => [a.building_id, a.pattern]));
      let total = 0;
      for (const b of buildings) {
        const pat = asg.get(b.id) ?? patternsFor(b.frequency)[0];
        for (const d of pat) { perDayService.set(d, perDayService.get(d)! + b.service_minutes); perDayVisits.set(d, perDayVisits.get(d)! + 1); }
        total += b.service_minutes * VISITS_PER_2W[b.frequency];
      }
      // BHH: L ≈ 0.7124·√(n·A) per tour region; area ≈ sum of neighbourhood discs; plus start/end legs
      const area = HOODS.reduce((s, h) => s + Math.PI * h.radius ** 2, 0) * 1.3;
      let estWalk = 0, busiest = DAY_KEYS[0], busiestLoad = 0;
      const kGuess = Math.max(1, Math.round(total / (DAY_KEYS.length * avail * target_utilization)));
      for (const d of DAY_KEYS) {
        const n = perDayVisits.get(d)!;
        const walk = (0.7124 * Math.sqrt(n * area * kGuess) * 1.3) / 78 + kGuess * 18;
        estWalk += walk;
        const load = perDayService.get(d)! + walk;
        if (load > busiestLoad) { busiestLoad = load; busiest = d; }
      }
      await sleep(60);
      return {
        daily_minutes, target_utilization,
        total_service_minutes: Math.round(total), est_walk_minutes: Math.round(estWalk),
        busiest_day: busiest, busiest_day_load: Math.round(busiestLoad),
        lower_bound: Math.ceil(perDayService.get(busiest)! / avail),
        estimate: Math.ceil(busiestLoad / (avail * target_utilization)),
        solved: plan.kpis.cleaners,
      };
    },

    async routeSheet(cleaner_id: string, day_key: DayKey): Promise<RouteSheet> {
      await sleep(150);
      const cl = cleanerById(cleaner_id);
      const route = plan.routes.find((r) => r.cleaner_id === cleaner_id && r.day_key === day_key);
      if (!route) throw new ApiError(404, 'No route for this cleaner and day');
      const bm = new Map(buildings.map((b) => [b.id, b]));
      const stops = route.stops.map((s) => ({ ...s, building: bm.get(s.building_id)! }));
      const origin = `${cl.start.lat},${cl.start.lng}`;
      const pts = stops.map((s) => `${s.building.lat},${s.building.lng}`);
      const urls: string[] = [];
      // ≤ 9 waypoints per link: chain segments origin → … → origin
      const seq = [origin, ...pts, origin];
      for (let i = 0; i < seq.length - 1; i += 10) {
        const part = seq.slice(i, Math.min(seq.length, i + 11));
        const o = part[0], dst = part[part.length - 1], wp = part.slice(1, -1);
        urls.push(`https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${o}&destination=${dst}${wp.length ? `&waypoints=${encodeURIComponent(wp.join('|'))}` : ''}`);
      }
      const { week, day } = splitDay(day_key);
      return {
        cleaner: clone(cl), day_key, date_label: `${GR_DAYS[day]} · Εβδομάδα ${week === 'A' ? 'Α' : 'Β'}`,
        route: clone(route), stops: clone(stops), google_maps_url: urls[0], google_maps_urls: urls,
      };
    },

    async costEstimate(): Promise<CostEstimate> {
      const n = buildings.length + plan.cleaners.length;
      const naive = n * n;
      const our = plan.territories.reduce((s, t) => {
        const m = plan.assignments.filter((a) => a.cleaner_id === t.cleaner_id).length + 1;
        return s + m * m;
      }, 0);
      const price = 5, free = 10_000;
      const cost = (e: number) => +((Math.max(0, e - free) / 1000) * price).toFixed(2);
      return {
        buildings: buildings.length, naive_elements: naive, our_elements: our,
        price_per_1000_usd: price, free_elements_per_month: free,
        naive_cost_usd: cost(naive), our_cost_usd: cost(our),
        note: 'List price as of March 2025, verify at developers.google.com/maps/billing-and-pricing/pricing',
      };
    },

    async importFile(file: File): Promise<ImportResult> {
      await sleep(600);
      let text: string;
      if (/\.csv$/i.test(file.name)) text = await file.text();
      else {
        // The mock cannot parse .xlsx; it falls back to the bundled sample rows.
        const res = await fetch('/mock/sample-import.csv');
        text = await res.text();
      }
      return mockImport(text, buildings);
    },
    importSampleUrl: () => '/mock/sample-import.csv',

    async reverseGeocode() { return null; },
    async exportSchedule(): Promise<Blob> { throw new ApiError(501, 'Excel export needs the real backend'); },
    async providerCompare(): Promise<ProviderCompare | null> {
      const pick = (i: number) => buildings[(i * 97) % buildings.length];
      const pairs = Array.from({ length: 8 }, (_, i) => {
        const a = pick(i), b = pick(i + 3);
        const osrm = Math.round(walkMinutes([a.lat, a.lng], [b.lat, b.lng]));
        return { from: a.name, to: b.name, osrm_min: osrm, google_min: Math.max(1, osrm + ((i * 7) % 5) - 2) };
      });
      const mad = pairs.reduce((s, p) => s + Math.abs(p.osrm_min - p.google_min), 0) / pairs.length;
      return { pairs, mean_abs_diff_min: +mad.toFixed(1), note: 'Mock sample: walking minutes, OSRM foot vs Google Routes (8 random pairs).' };
    },
  };
  return api;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const split = (l: string) => {
    const out: string[] = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if ((ch === ',' || ch === ';') && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0] ?? '').map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[m][n] / Math.max(m, n);
}

const issueFields = (issues: ImportIssue[]) =>
  (issues.length ? { issue: issues.map((i) => i.text).join('; '), issues } : {});

function mockImport(text: string, buildings: Building[]): ImportResult {
  const rows = parseCsv(text);
  const streets = [...new Set(buildings.map((b) => b.street))];
  const out: ImportRow[] = rows.map((input) => {
    const q = normalizeSearch(input.street ?? '');
    let best = '', score = 0;
    for (const s of streets) { const sc = similarity(q, normalizeSearch(s)); if (sc > score) { score = sc; best = s; } }
    const freqOk = ['3w', '2w', '1w', 'biweekly'].includes((input.frequency ?? '').trim());
    if (score < 0.6) {
      const text = 'Street not found in OpenStreetMap extract';
      return { input, matched: false, confidence: +score.toFixed(2), issue: text, issues: [{ code: 'street_not_found', text }] };
    }
    const same = buildings.filter((b) => b.street === best);
    const num = parseInt(input.number ?? '', 10);
    const exact = same.find((b) => b.number === String(num));
    const near = exact ?? same.reduce((a, b) => (Math.abs(+b.number - num) < Math.abs(+a.number - num) ? b : a), same[0]);
    const conf = +(score * (exact ? 0.99 : 0.82)).toFixed(2);
    return {
      input, matched: true, confidence: conf, lat: near.lat, lng: near.lng,
      matched_label: `${best} ${exact ? near.number : num}, ${near.postcode ?? ''} ${near.neighborhood}`.trim(),
      ...issueFields([
        ...(!freqOk ? [{ code: 'unknown_frequency', text: 'Unknown frequency, defaulted to 1w', value: input.frequency ?? '' }] : []),
        ...(!exact ? [{ code: 'number_nearest', text: 'House number interpolated on street', value: near.number }] : []),
      ]),
    };
  });
  const matched = out.filter((r) => r.matched).length;
  return { rows: out, summary: { total: out.length, matched, unmatched: out.length - matched } };
}
