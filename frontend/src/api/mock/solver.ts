// A compact heuristic planner used only by the mock API. It produces data
// shaped exactly like the backend's Plan so the UI can be built offline.

import type { Building, Cleaner, DayKey, Frequency, KPIs, Plan, PlanParams, Route, Stop } from '../types';
import { encodePolyline } from '../../lib/polyline';
import { paletteColor } from '../../lib/colors';
import { DAY_KEYS, WEEKDAYS } from '../../lib/days';
import { FEMALE_FIRST, MALE_FIRST, STATIONS, SURNAMES } from './data';
import { convexHull, distM, gridLeg, mulberry32, walkMinutes, type LL, type Rng } from './geo';

export const SHIFT_START = 420;
export const DEFAULT_DAILY = 480;
export const DEFAULT_BREAK = 30;
export const DEFAULT_UTIL = 0.85;

const WEEK_PATTERNS: Record<Frequency, string[][]> = {
  '3w': [['Mon', 'Wed', 'Fri']],
  '2w': [['Mon', 'Wed'], ['Mon', 'Thu'], ['Mon', 'Fri'], ['Tue', 'Thu'], ['Tue', 'Fri'], ['Wed', 'Fri']],
  '1w': WEEKDAYS.map((d) => [d]),
  biweekly: [],
};

/** All allowed day_key patterns for a frequency (contract table). */
export function patternsFor(f: Frequency): DayKey[][] {
  if (f === 'biweekly') return ['A', 'B'].flatMap((w) => WEEKDAYS.map((d) => [`${w}-${d}`]));
  return WEEK_PATTERNS[f].map((p) => ['A', 'B'].flatMap((w) => p.map((d) => `${w}-${d}`)));
}

export const VISITS_PER_2W: Record<Frequency, number> = { '3w': 6, '2w': 4, '1w': 2, biweekly: 1 };

export interface Ctx {
  buildings: Map<string, Building>;
  params: Required<Omit<PlanParams, 'num_cleaners'>> & { num_cleaners: number | null };
}

export function normParams(p: PlanParams = {}): Ctx['params'] {
  return {
    daily_minutes: p.daily_minutes ?? DEFAULT_DAILY,
    break_minutes: p.break_minutes ?? DEFAULT_BREAK,
    target_utilization: p.target_utilization ?? DEFAULT_UTIL,
    num_cleaners: p.num_cleaners ?? null,
  };
}

const ll = (b: { lat: number; lng: number }): LL => [b.lat, b.lng];

// ---------------------------------------------------------------- routes

/** Rebuild timings + geometry for an ordered list of building ids. */
export function buildRoute(ctx: Ctx, cleaner: Cleaner, day_key: DayKey, order: string[]): Route {
  const brk = ctx.params.break_minutes;
  const start = ll(cleaner.start);
  let t = SHIFT_START, prev = start, walk = 0, service = 0, took = false, exact = true;
  const path: LL[] = [start];
  const stops: Stop[] = [];
  for (const id of order) {
    const b = ctx.buildings.get(id)!;
    if (!took && t >= 690) { t += brk; took = true; }
    const leg = gridLeg(prev, ll(b));
    const straight = b.isolated;
    if (straight) exact = false;
    const w = Math.round(leg.minutes);
    path.push(...(straight ? [ll(b)] : leg.path.slice(1)));
    t += w; walk += w;
    const arrival = t;
    t += b.service_minutes; service += b.service_minutes;
    stops.push({ building_id: id, arrival, depart: t, walk_from_prev: w });
    prev = ll(b);
  }
  if (order.length) {
    const back = gridLeg(prev, start);
    const w = Math.round(back.minutes);
    t += w; walk += w;
    path.push(...back.path.slice(1));
  }
  if (!took && order.length) t += brk;
  return {
    cleaner_id: cleaner.id, day_key, stops,
    walk_minutes: walk, service_minutes: service, total_minutes: t - SHIFT_START,
    start_time: SHIFT_START, end_time: t,
    geometry: encodePolyline(path), geometry_exact: exact,
  };
}

function tourLen(pts: LL[], order: number[], start: LL): number {
  let s = 0, p = start;
  for (const i of order) { s += walkMinutes(p, pts[i]); p = pts[i]; }
  return s + walkMinutes(p, start);
}

/** Nearest neighbour + 2-opt; morning-window stops that would finish after
 *  their window are pulled to the front afterwards. */
export function orderStops(ctx: Ctx, start: LL, ids: string[]): string[] {
  const pts = ids.map((id) => ll(ctx.buildings.get(id)!));
  const left = new Set(pts.map((_, i) => i));
  const order: number[] = [];
  let cur = start;
  while (left.size) {
    let best = -1, bd = Infinity;
    for (const i of left) { const d = walkMinutes(cur, pts[i]); if (d < bd) { bd = d; best = i; } }
    order.push(best); left.delete(best); cur = pts[best];
  }
  let improved = true, guard = 0;
  while (improved && guard++ < 30) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
        if (tourLen(pts, cand, start) + 1e-6 < tourLen(pts, order, start)) { order.splice(0, order.length, ...cand); improved = true; }
      }
    }
  }
  // try both directions, keep the one that serves morning-window stops earlier
  const late = (o: number[]) => {
    let t = SHIFT_START, p = start, pen = 0;
    for (const i of o) {
      t += walkMinutes(p, pts[i]); p = pts[i];
      const b = ctx.buildings.get(ids[i])!;
      t += b.service_minutes;
      if (b.time_window && t > b.time_window[1]) pen += t - b.time_window[1];
    }
    return pen;
  };
  const rev = order.slice().reverse();
  let final = late(rev) < late(order) ? rev : order;
  if (late(final) > 0) {
    const morning = final.filter((i) => ctx.buildings.get(ids[i])!.time_window);
    final = morning.concat(final.filter((i) => !ctx.buildings.get(ids[i])!.time_window));
  }
  return final.map((i) => ids[i]);
}

/** Cheapest insertion of one building into an existing ordered route. */
export function cheapestInsertion(ctx: Ctx, cleaner: Cleaner, order: string[], b: Building): { order: string[]; delta: number } {
  const start = ll(cleaner.start);
  const pts = [start, ...order.map((id) => ll(ctx.buildings.get(id)!)), start];
  const p = ll(b);
  let best = 0, bd = Infinity;
  // a morning-only building may not be inserted late in the day (rough cap: first 5 slots)
  const lastSlot = b.time_window ? Math.min(pts.length - 1, 5) : pts.length - 1;
  for (let i = 0; i < lastSlot; i++) {
    const d = walkMinutes(pts[i], p) + walkMinutes(p, pts[i + 1]) - walkMinutes(pts[i], pts[i + 1]);
    if (d < bd) { bd = d; best = i; }
  }
  const next = order.slice();
  next.splice(best, 0, b.id);
  return { order: next, delta: bd };
}

// ---------------------------------------------------------------- KPIs

export function computeKpis(ctx: Ctx, plan: Pick<Plan, 'cleaners' | 'routes' | 'assignments' | 'unassigned'>): KPIs {
  const avail = ctx.params.daily_minutes - ctx.params.break_minutes;
  let walk = 0, service = 0, visits = 0, maxRoute = 0;
  const dayService = new Map<DayKey, number>();
  for (const r of plan.routes) {
    walk += r.walk_minutes; service += r.service_minutes; visits += r.stops.length;
    maxRoute = Math.max(maxRoute, r.total_minutes);
    dayService.set(r.day_key, (dayService.get(r.day_key) ?? 0) + r.service_minutes);
  }
  const busiest = Math.max(0, ...dayService.values());
  let violations = 0;
  for (const a of plan.assignments) {
    const b = ctx.buildings.get(a.building_id);
    if (!b) continue;
    const ok = patternsFor(b.frequency).some((p) => p.length === a.pattern.length && p.every((d) => a.pattern.includes(d)));
    if (!ok) violations++;
  }
  const active = plan.cleaners.length;
  return {
    cleaners: active,
    lower_bound_cleaners: Math.ceil(busiest / avail),
    visits, walk_minutes: walk, service_minutes: service,
    utilization: active ? (walk + service) / (active * DAY_KEYS.length * avail) : 0,
    avg_walk_per_visit: visits ? walk / visits : 0,
    max_route_minutes: maxRoute,
    frequency_violations: violations,
    unassigned: plan.unassigned.length,
  };
}

// ---------------------------------------------------------------- planning

function cleanerNames(rng: Rng, n: number): string[] {
  const names = new Set<string>();
  while (names.size < n) {
    const female = rng() < 0.6;
    const [m, f] = SURNAMES[Math.floor(rng() * SURNAMES.length)];
    const first = female ? FEMALE_FIRST[Math.floor(rng() * FEMALE_FIRST.length)] : MALE_FIRST[Math.floor(rng() * MALE_FIRST.length)];
    names.add(`${first} ${female ? f : m}`);
  }
  return [...names];
}

const workload = (b: Building) => VISITS_PER_2W[b.frequency] * (b.service_minutes + 5);

/** Capacitated k-means: k-means++ seeds, then regret-ordered greedy assignment
 *  under a workload cap, iterated. Balanced and mostly compact. */
function balancedClusters(bs: Building[], k: number, rng: Rng, balanced: boolean): number[] {
  const pts = bs.map(ll);
  const centers: LL[] = [pts[Math.floor(rng() * pts.length)]];
  while (centers.length < k) {
    const d = pts.map((p) => Math.min(...centers.map((c) => distM(p, c))) ** 2);
    const sum = d.reduce((a, b) => a + b, 0);
    let r = rng() * sum, i = 0;
    while (r > d[i] && i < d.length - 1) r -= d[i++];
    centers.push(pts[i]);
  }
  const w = bs.map(balanced ? workload : () => 1);
  const cap = (w.reduce((a, b) => a + b, 0) / k) * 1.03;
  let assign: number[] = new Array(bs.length).fill(0);
  for (let it = 0; it < 14; it++) {
    const dist = pts.map((p) => centers.map((c) => distM(p, c)));
    const order = pts.map((_, i) => {
      const s = dist[i].slice().sort((a, b) => a - b);
      return { i, regret: (s[1] ?? 0) - s[0] };
    }).sort((a, b) => b.regret - a.regret);
    const load = new Array(k).fill(0);
    for (const { i } of order) {
      const cand = dist[i].map((d, j) => ({ d, j })).sort((a, b) => a.d - b.d);
      const pickJ = cand.find((c) => load[c.j] + w[i] <= cap) ?? cand.reduce((a, b) => (load[a.j] < load[b.j] ? a : b));
      assign[i] = pickJ.j;
      load[pickJ.j] += w[i];
    }
    const sx = new Array(k).fill(0), sy = new Array(k).fill(0), cnt = new Array(k).fill(0);
    assign.forEach((j, i) => { sx[j] += pts[i][0]; sy[j] += pts[i][1]; cnt[j]++; });
    for (let j = 0; j < k; j++) if (cnt[j]) centers[j] = [sx[j] / cnt[j], sy[j] / cnt[j]];
  }
  assign = assign.slice();
  return assign;
}

interface Solved { plan: Plan; overflow: number }

export function solveWithK(ctx: Ctx, bs: Building[], k: number, seed: number, naive = false): Solved {
  const rng = mulberry32(seed);
  const clusters = balancedClusters(bs, k, rng, !naive);
  const names = cleanerNames(mulberry32(seed + 1), k);
  const groups: Building[][] = Array.from({ length: k }, () => []);
  clusters.forEach((c, i) => groups[c].push(bs[i]));
  // order cleaners west→east so colours spread nicely
  const order = groups.map((g, i) => ({ g, i, x: g.reduce((s, b) => s + b.lng, 0) / Math.max(1, g.length) }))
    .filter((o) => o.g.length).sort((a, b) => a.x - b.x);

  const cleaners: Cleaner[] = [];
  const routes: Route[] = [];
  const assignments: Plan['assignments'] = [];
  const territories: Plan['territories'] = [];
  let overflow = 0;

  order.forEach(({ g }, ci) => {
    const centroid: LL = [g.reduce((s, b) => s + b.lat, 0) / g.length, g.reduce((s, b) => s + b.lng, 0) / g.length];
    // start = nearest station unless far away → "home" inside the territory
    let st = STATIONS[0];
    for (const s of STATIONS) if (distM(centroid, [s.lat, s.lng]) < distM(centroid, [st.lat, st.lng])) st = s;
    const useHome = distM(centroid, [st.lat, st.lng]) > 1600 || ci % 9 === 4;
    const home = g.reduce((best, b) => (distM(ll(b), centroid) < distM(ll(best), centroid) ? b : best), g[0]);
    const cleaner: Cleaner = {
      id: `c${String(ci + 1).padStart(2, '0')}`,
      name: names[ci],
      color: paletteColor(ci),
      start: useHome
        ? { lat: +(home.lat + 0.0012).toFixed(6), lng: +(home.lng - 0.0009).toFixed(6), label: `Οικία (${home.neighborhood})` }
        : { lat: st.lat, lng: st.lng, label: st.label },
      daily_minutes: ctx.params.daily_minutes,
    };
    cleaners.push(cleaner);
    territories.push({ cleaner_id: cleaner.id, hull: convexHull(g.map(ll)).map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]) });

    const load = new Map<DayKey, number>(DAY_KEYS.map((d) => [d, 0]));
    const dayIds = new Map<DayKey, string[]>(DAY_KEYS.map((d) => [d, []]));
    const put = (b: Building, pat: DayKey[]) => {
      for (const d of pat) { load.set(d, load.get(d)! + b.service_minutes); dayIds.get(d)!.push(b.id); }
      assignments.push({ building_id: b.id, cleaner_id: cleaner.id, pattern: pat.slice() });
    };
    if (naive) {
      // round-robin days in input order, no geography
      let rr = 0;
      for (const b of g) { const pats = patternsFor(b.frequency); put(b, pats[rr++ % pats.length]); }
    } else {
      // 2) 1w + biweekly: angular sweep around the territory centre, one compact slice per weekday
      const rest = g.filter((b) => b.frequency === '1w' || b.frequency === 'biweekly')
        .map((b) => ({ b, a: Math.atan2(b.lat - centroid[0], b.lng - centroid[1]) }))
        .sort((p, q) => p.a - q.a);
      // start the sweep after the largest angular gap so slices stay contiguous
      let gapAt = 0, gap = -1;
      rest.forEach((x, i) => {
        const nx = rest[(i + 1) % rest.length];
        const d = ((nx.a - x.a) + 2 * Math.PI) % (2 * Math.PI);
        if (d > gap) { gap = d; gapAt = (i + 1) % rest.length; }
      });
      const swept = rest.slice(gapAt).concat(rest.slice(0, gapAt)).map((x) => x.b);
      // weekday slice centres from a sweep over *all* buildings (weighted by visits)
      const allSwept = g.map((b) => ({ b, a: Math.atan2(b.lat - centroid[0], b.lng - centroid[1]) }))
        .sort((p, q) => ((p.a - rest[gapAt]?.a + 4 * Math.PI) % (2 * Math.PI)) - ((q.a - rest[gapAt]?.a + 4 * Math.PI) % (2 * Math.PI)));
      const totalW = allSwept.reduce((s2, x) => s2 + workload(x.b), 0);
      const centres: LL[] = WEEKDAYS.map(() => [0, 0]);
      const cnt = WEEKDAYS.map(() => 0);
      let acc = 0;
      for (const x of allSwept) {
        const wd = Math.min(4, Math.floor((acc / totalW) * 5));
        centres[wd] = [centres[wd][0] + x.b.lat, centres[wd][1] + x.b.lng]; cnt[wd]++;
        acc += workload(x.b);
      }
      centres.forEach((c, i) => { centres[i] = cnt[i] ? [c[0] / cnt[i], c[1] / cnt[i]] : centroid; });
      // 3w fixed; 2w: pick the allowed pair whose weekday slices are closest, with a load-balance term
      const multi = g.filter((b) => b.frequency === '3w' || b.frequency === '2w').sort((p, q) => q.service_minutes - p.service_minutes);
      const wdIndex = (d: DayKey) => WEEKDAYS.indexOf(d.split('-')[1] as (typeof WEEKDAYS)[number]);
      for (const b of multi) {
        let best = patternsFor(b.frequency)[0], bc = Infinity;
        for (const p of patternsFor(b.frequency)) {
          const geo = p.reduce((s2, d) => s2 + distM(ll(b), centres[wdIndex(d)]), 0) / 10;
          const bal = p.reduce((s2, d) => s2 + load.get(d)!, 0) / 12;
          if (geo + bal < bc) { bc = geo + bal; best = p; }
        }
        put(b, best);
      }
      const avg = (wd: string) => (load.get(`A-${wd}`)! + load.get(`B-${wd}`)!) / 2;
      const contrib = (b: Building) => (b.frequency === '1w' ? b.service_minutes : b.service_minutes / 2);
      const target = (WEEKDAYS.reduce((s2, wd) => s2 + avg(wd), 0) + swept.reduce((s2, b) => s2 + contrib(b), 0)) / 5;
      let wi = 0;
      for (const b of swept) {
        while (wi < 4 && avg(WEEKDAYS[wi]) + contrib(b) / 2 > target) wi++;
        const wd = WEEKDAYS[wi];
        if (b.frequency === '1w') put(b, [`A-${wd}`, `B-${wd}`]);
        else put(b, [load.get(`A-${wd}`)! <= load.get(`B-${wd}`)! ? `A-${wd}` : `B-${wd}`]);
      }
    }
    for (const d of DAY_KEYS) {
      const ids = dayIds.get(d)!;
      if (!ids.length) continue;
      const ordered = naive ? nearestOnly(ctx, ll(cleaner.start), ids) : orderStops(ctx, ll(cleaner.start), ids);
      const r = buildRoute(ctx, cleaner, d, ordered);
      if (r.total_minutes > ctx.params.daily_minutes) overflow += r.total_minutes - ctx.params.daily_minutes;
      routes.push(r);
    }
  });

  const partial = { cleaners, routes, assignments, unassigned: [] as Plan['unassigned'] };
  return {
    overflow,
    plan: {
      id: `plan-${seed}-${k}`,
      created_at: new Date().toISOString(),
      params: { ...ctx.params },
      solve_seconds: 0,
      ...partial,
      territories,
      kpis: computeKpis(ctx, partial),
    },
  };
}

function nearestOnly(ctx: Ctx, start: LL, ids: string[]): string[] {
  const left = new Set(ids);
  const out: string[] = [];
  let cur = start;
  while (left.size) {
    let best = '', bd = Infinity;
    for (const id of left) { const d = walkMinutes(cur, ll(ctx.buildings.get(id)!)); if (d < bd) { bd = d; best = id; } }
    out.push(best); left.delete(best); cur = ll(ctx.buildings.get(best)!);
  }
  return out;
}

export function estimateK(ctx: Ctx, bs: Building[]): number {
  const total = bs.reduce((s, b) => s + workload(b), 0);
  const cap = DAY_KEYS.length * (ctx.params.daily_minutes - ctx.params.break_minutes) * ctx.params.target_utilization;
  return Math.max(1, Math.ceil(total / cap));
}

/** Full mock solve: grow K until no route exceeds the shift. */
export function solvePlan(bs: Building[], params: PlanParams = {}, seed = 11): Plan {
  const ctx: Ctx = { buildings: new Map(bs.map((b) => [b.id, b])), params: normParams(params) };
  const t0 = Date.now();
  let k = ctx.params.num_cleaners ?? estimateK(ctx, bs);
  let res = solveWithK(ctx, bs, k, seed);
  if (ctx.params.num_cleaners == null) {
    for (let i = 0; i < 12 && res.overflow > 0; i++) res = solveWithK(ctx, bs, ++k, seed);
  }
  res.plan.solve_seconds = +((Date.now() - t0) / 1000).toFixed(2);
  return res.plan;
}

/** Naive baseline KPIs: k-means by count, round-robin days, NN routes. */
export function baselineKpis(bs: Building[], params: PlanParams = {}, k?: number): KPIs {
  const ctx: Ctx = { buildings: new Map(bs.map((b) => [b.id, b])), params: normParams(params) };
  const kk = k ?? estimateK(ctx, bs);
  const { plan } = solveWithK(ctx, bs, kk, 5, true);
  // cleaners needed if every route had to fit in a shift
  const perDay = new Map<DayKey, number>();
  for (const r of plan.routes) perDay.set(r.day_key, (perDay.get(r.day_key) ?? 0) + Math.ceil(r.total_minutes / ctx.params.daily_minutes));
  const needed = Math.max(...perDay.values());
  const avail = ctx.params.daily_minutes - ctx.params.break_minutes;
  return {
    ...plan.kpis,
    cleaners: needed,
    utilization: (plan.kpis.walk_minutes + plan.kpis.service_minutes) / (needed * DAY_KEYS.length * avail),
  };
}

export function convexHullForCleaner(ctx: Ctx, plan: Plan, cleanerId: string): [number, number][] {
  const pts = plan.assignments.filter((a) => a.cleaner_id === cleanerId)
    .map((a) => ctx.buildings.get(a.building_id)).filter(Boolean).map((b) => ll(b!));
  return convexHull(pts);
}
