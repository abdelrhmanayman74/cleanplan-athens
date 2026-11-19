// Browser port of the new-building what-if (backend/app/solver/timeline.py, insertion.py and the
// insert half of whatif.py). Existing buildings use the precomputed OSRM matrix; a new address uses
// Haversine × the detour factor calibrated against OSRM, exactly as the server does.

import type { Building, Change, ChangeResult, InsertCandidate, KPIs, NewBuilding, Plan, Route, Stop } from '../types';
import { haversineM } from './geo';

const SHIFT_START = 7 * 60;
const BREAK_EARLIEST = 11 * 60 + 30;
const MAX_INSERT_CLEANERS = 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface Params { dailyMinutes: number; breakMinutes: number }
const shiftEnd = (p: Params) => SHIFT_START + p.dailyMinutes;

/** Travel times between matrix nodes, plus new buildings added in this tab (estimated). */
export class World {
  readonly nodeOf = new Map<string, number>();
  readonly building = new Map<string, Building>();
  private coords: [number, number][];
  private n0: number;

  constructor(
    private matrix: Uint16Array, nodes: [number, number][], buildings: Building[],
    private detour: number, private speed: number,
  ) {
    this.coords = nodes.slice();
    this.n0 = nodes.length;
    buildings.forEach((b, i) => {
      if (i < this.n0) this.nodeOf.set(b.id, i);
      this.building.set(b.id, b);
    });
  }

  /** Adds a building outside the matrix; its legs are Haversine estimates. */
  add(b: Building): void {
    this.nodeOf.set(b.id, this.coords.length);
    this.coords.push([b.lat, b.lng]);
    this.building.set(b.id, b);
  }

  isEstimated(node: number): boolean { return node >= this.n0; }
  coord(node: number): [number, number] { return this.coords[node]; }

  /** Walking seconds a -> b (np.rint of the Haversine estimate for new buildings). */
  seconds(a: number, b: number): number {
    if (a === b) return 0;
    if (a < this.n0 && b < this.n0) return this.matrix[a * this.n0 + b];
    const [p, q] = [this.coords[a], this.coords[b]];
    return Math.round((haversineM(p[0], p[1], q[0], q[1]) * this.detour) / this.speed);
  }
}

// ---- timeline.py ---------------------------------------------------------------------------------

interface Schedule { stops: Stop[]; walk: number; service: number; end: number; breakAfter: number | null; feasible: boolean }
type Window = [number, number] | null;

function simulate(walks: number[], services: number[], windows: Window[], breakAfter: number | null, breakMinutes: number) {
  let t = SHIFT_START, ok = true;
  const times: [number, number][] = [];
  services.forEach((s, k) => {
    t += walks[k];
    const tw = windows[k];
    if (tw) {
      t = Math.max(t, tw[0]);
      if (t + s > tw[1] + 1e-9) ok = false;
    }
    times.push([t, t + s]);
    t += s;
    if (breakAfter === k) t += breakMinutes;
  });
  return { times, end: t + walks[walks.length - 1], ok };
}

export function scheduleFor(w: World, depot: number, ids: string[], p: Params): Schedule {
  const nodes = ids.map((i) => w.nodeOf.get(i)!);
  const path = [depot, ...nodes, depot];
  const walks = path.slice(1).map((b, i) => w.seconds(path[i], b) / 60);
  const bs = ids.map((i) => w.building.get(i)!);
  const services = bs.map((b) => b.service_minutes);
  const windows: Window[] = bs.map((b) => b.time_window ?? null);
  const n = ids.length;
  if (!n) return { stops: [], walk: 0, service: 0, end: SHIFT_START, breakAfter: null, feasible: true };

  // break after the first stop ending at or after 11:30, and after the last windowed stop
  const t0 = simulate(walks, services, windows, null, 0).times;
  let firstLate = t0.findIndex(([, d]) => d >= BREAK_EARLIEST);
  if (firstLate < 0) firstLate = n - 1;
  const lastWin = windows.reduce((m, tw, k) => (tw ? k : m), -1);
  const preferred = Math.max(firstLate, lastWin);
  const candidates = [preferred, ...[...Array(n).keys()].filter((k) => k !== preferred)];
  const hasLateOpen = windows.some((tw) => tw && tw[0] > SHIFT_START);
  let best: { k: number; times: [number, number][]; end: number; ok: boolean } | null = null;
  for (const k of candidates) {
    const s = simulate(walks, services, windows, k, p.breakMinutes);
    const fits = s.ok && s.end <= shiftEnd(p) + 1e-9;
    if (!best || fits) best = { k, ...s };
    if (fits || (s.ok && !hasLateOpen)) break;
  }
  const { k, times, end, ok } = best!;
  return {
    stops: ids.map((id, i) => ({ building_id: id, arrival: r2(times[i][0]), depart: r2(times[i][1]), walk_from_prev: r2(walks[i]) })),
    walk: r2(walks.reduce((a, b) => a + b, 0)),
    service: services.reduce((a, b) => a + b, 0),
    end: r2(end),
    breakAfter: k,
    feasible: ok && end - shiftEnd(p) <= 1e-9,
  };
}

// ---- insertion.py --------------------------------------------------------------------------------

interface Insertion { position: number; added: number; schedule: Schedule }

export function bestInsertion(w: World, depot: number, ids: string[], newId: string, p: Params): Insertion | null {
  const path = [depot, ...ids.map((i) => w.nodeOf.get(i)!), depot];
  const x = w.nodeOf.get(newId)!;
  const legs = path.slice(1).map((b, i) => [path[i], b] as const);
  const delta = legs.map(([a, b]) => (w.seconds(a, x) + w.seconds(x, b) - w.seconds(a, b)) / 60);
  const walk = legs.reduce((s, [a, b]) => s + w.seconds(a, b), 0) / 60;
  const service = [...ids, newId].reduce((s, i) => s + w.building.get(i)!.service_minutes, 0);
  const slack = shiftEnd(p) - (SHIFT_START + walk + service + p.breakMinutes);
  const order = delta.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [d, pos] of order) {
    if (d > slack + 1e-9) break;
    const trial = [...ids.slice(0, pos), newId, ...ids.slice(pos)];
    const sch = scheduleFor(w, depot, trial, p);
    if (sch.feasible) return { position: pos, added: r2(Math.max(0, d)), schedule: sch };
  }
  return null;
}

// ---- whatif.py: new building --------------------------------------------------------------------

export function newBuildingRecord(buildings: Building[], nb: NewBuilding, id: string, detour: number, speed: number): Building {
  const dists = buildings.map((b) => haversineM(nb.lat, nb.lng, b.lat, b.lng));
  const nearest = buildings[dists.indexOf(Math.min(...dists))];
  const walk3 = dists.slice().sort((a, b) => a - b).slice(0, 3).map((d) => (d * detour) / speed);
  return {
    id, name: nb.name || 'Νέο κτίριο (what-if)', street: '', number: '', postcode: null,
    neighborhood: nearest.neighborhood, lat: nb.lat, lng: nb.lng,
    floors: Math.max(2, Math.min(8, Math.round((nb.service_minutes - 15) / 3.5))), has_lift: true,
    service_minutes: nb.service_minutes, frequency: nb.frequency, time_window: nb.time_window ?? null,
    manager: { name: '', phone: '' }, access_note: '', tasks: ['Σκάλες', 'Είσοδος'],
    isolated: walk3.length >= 3 && walk3[2] > 15 * 60,
  };
}

const routeIndex = (plan: Plan) => new Map(plan.routes.map((r) => [`${r.cleaner_id}|${r.day_key}`, r]));
const stopIds = (r: Route | undefined) => (r?.stops ?? []).map((s) => s.building_id);

function centroids(w: World, plan: Plan): Map<string, [number, number]> {
  const acc = new Map<string, [number, number, number]>();
  for (const a of plan.assignments) {
    const b = w.building.get(a.building_id);
    if (!b) continue;
    const c = acc.get(a.cleaner_id) ?? [0, 0, 0];
    acc.set(a.cleaner_id, [c[0] + b.lat, c[1] + b.lng, c[2] + 1]);
  }
  return new Map([...acc].map(([k, [la, ln, n]]) => [k, [la / n, ln / n]]));
}

function evaluate(w: World, plan: Plan, p: Params, cleanerId: string, depot: number, bid: string, pattern: string[]): InsertCandidate {
  const routes = routeIndex(plan);
  let added = 0, slack = Infinity, feasible = true;
  for (const d of pattern) {
    const ids = stopIds(routes.get(`${cleanerId}|${d}`));
    const ins = bestInsertion(w, depot, ids, bid, p);
    if (!ins) {
      // not feasible: report the cheapest position anyway and how much it would overrun
      feasible = false;
      const base = scheduleFor(w, depot, ids, p);
      let best: [number, number] | null = null;
      for (let pos = 0; pos <= ids.length; pos++) {
        const s = scheduleFor(w, depot, [...ids.slice(0, pos), bid, ...ids.slice(pos)], p);
        const cand: [number, number] = [s.walk - base.walk, shiftEnd(p) - s.end];
        if (!best || cand[0] < best[0]) best = cand;
      }
      added += best![0];
      slack = Math.min(slack, best![1]);
    } else {
      added += ins.added;
      slack = Math.min(slack, shiftEnd(p) - ins.schedule.end);
    }
  }
  return { cleaner_id: cleanerId, day_keys: [...pattern], added_walk_minutes: r1(added), feasible, slack_after: r1(slack) };
}

const candKey = (o: InsertCandidate) => [o.feasible ? 0 : 1, o.added_walk_minutes, -o.slack_after] as const;
function cmp(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Top options (best pattern per cleaner, distinct cleaners) for a new building; the plan is unchanged. */
export function insertCandidates(w: World, plan: Plan, p: Params, record: Building, patterns: string[][], top = 3): InsertCandidate[] {
  const cents = centroids(w, plan);
  w.add(record);
  const near = [...cents.keys()]
    .sort((a, b) => {
      const [pa, pb] = [cents.get(a)!, cents.get(b)!];
      return (pa[0] - record.lat) ** 2 + (pa[1] - record.lng) ** 2 - ((pb[0] - record.lat) ** 2 + (pb[1] - record.lng) ** 2) || (a < b ? -1 : 1);
    })
    .slice(0, MAX_INSERT_CLEANERS);
  const depots = new Map(plan.cleaners.map((c) => [c.id, (c.start as { node?: number }).node!]));
  const perCleaner = near.map((c) =>
    patterns.map((pat) => evaluate(w, plan, p, c, depots.get(c)!, record.id, pat))
      .reduce((best, o) => (cmp(candKey(o), candKey(best)) < 0 ? o : best)));
  perCleaner.sort((a, b) => cmp([...candKey(a), a.cleaner_id], [...candKey(b), b.cleaner_id]));
  return perCleaner.slice(0, top);
}

/** Inserts the new building's visits into the chosen cleaner's routes; no other building moves. */
export function commitInsert(w: World, plan: Plan, p: Params, record: Building, cand: InsertCandidate): ChangeResult {
  w.add(record);
  const cleaner = plan.cleaners.find((c) => c.id === cand.cleaner_id)!;
  const depot = (cleaner.start as { node?: number }).node!;
  const x = w.nodeOf.get(record.id)!;
  const changes: Change[] = [];
  const routes = plan.routes.map((r) => {
    if (r.cleaner_id !== cleaner.id || !cand.day_keys.includes(r.day_key)) return r;
    const ids = stopIds(r);
    const ins = bestInsertion(w, depot, ids, record.id, p);
    let pos: number, added: number;
    if (ins) ({ position: pos, added } = ins);
    else {
      // the user chose an infeasible option: cheapest position, the route runs over the shift
      const path = [depot, ...ids.map((i) => w.nodeOf.get(i)!), depot];
      const deltas = path.slice(1).map((b, i) => w.seconds(path[i], x) + w.seconds(x, b) - w.seconds(path[i], b));
      pos = deltas.indexOf(Math.min(...deltas));
      added = Math.min(...deltas) / 60;
    }
    const next = [...ids.slice(0, pos), record.id, ...ids.slice(pos)];
    changes.push({ building_id: record.id, day_key: r.day_key, from_cleaner: null, to_cleaner: cleaner.id, added_walk: r2(added) });
    return makeRoute(w, r, depot, next, pos, p);
  });
  const after: Plan = {
    ...plan,
    id: `${plan.id}+${record.id}`,
    routes,
    assignments: [...plan.assignments, { building_id: record.id, cleaner_id: cleaner.id, pattern: [...cand.day_keys] }],
  };
  after.territories = plan.territories.map((t) => (t.cleaner_id === cleaner.id ? { ...t, hull: convexHull(after, cleaner.id, w) } : t));
  after.kpis = kpis(after, plan.kpis, p);
  const sig = (r: Route) => `${r.cleaner_id}|${r.day_key}|${stopIds(r).join(',')}`;
  const before = new Set(plan.routes.map(sig));
  return {
    plan: after, changes, churn: 0,
    untouched_routes: after.routes.filter((r) => before.has(sig(r))).length,
    kpis_before: plan.kpis, kpis_after: after.kpis,
    message: `Added ${record.name} (${record.frequency}) to ${cleaner.name} on ${cand.day_keys.join(', ')}; no existing building changed cleaner or day. Travel times for the new address are estimates.`,
  };
}

/** The new route keeps its street geometry; the two estimated legs to the new building are drawn
 * as short dotted connectors (`connectors`) instead of pretending to follow streets. */
function makeRoute(w: World, old: Route, depot: number, ids: string[], pos: number, p: Params): Route {
  const sch = scheduleFor(w, depot, ids, p);
  const path = [depot, ...ids.map((i) => w.nodeOf.get(i)!), depot];
  const x = pos + 1; // index of the new building in `path`
  const brk = sch.breakAfter != null && sch.stops.length ? sch.stops[sch.breakAfter].depart : null;
  return {
    ...old,
    stops: sch.stops,
    walk_minutes: sch.walk,
    service_minutes: sch.service,
    total_minutes: r2(sch.end - SHIFT_START),
    start_time: SHIFT_START,
    end_time: sch.end,
    geometry_exact: false,
    connectors: [[w.coord(path[x - 1]), w.coord(path[x])], [w.coord(path[x]), w.coord(path[x + 1])]],
    break: brk == null ? null : [brk, brk + p.breakMinutes],
    feasible: sch.feasible,
  } as Route;
}

function kpis(plan: Plan, before: KPIs, p: Params): KPIs {
  const visits = plan.routes.reduce((s, r) => s + r.stops.length, 0);
  const walk = plan.routes.reduce((s, r) => s + r.walk_minutes, 0);
  const service = plan.routes.reduce((s, r) => s + r.service_minutes, 0);
  const available = plan.cleaners.length * 10 * (p.dailyMinutes - p.breakMinutes);
  return {
    ...before,
    visits,
    walk_minutes: r1(walk),
    service_minutes: r1(service),
    utilization: available ? Math.round(((walk + service) / available) * 1e4) / 1e4 : 0,
    avg_walk_per_visit: visits ? r2(walk / visits) : 0,
    max_route_minutes: r1(Math.max(0, ...plan.routes.map((r) => r.total_minutes))),
  };
}

/** Convex hull of a cleaner's buildings (monotone chain), as [lat, lng] for the territory shading. */
function convexHull(plan: Plan, cleanerId: string, w: World): [number, number][] {
  const pts = plan.assignments.filter((a) => a.cleaner_id === cleanerId)
    .map((a) => w.building.get(a.building_id)!).map((b) => [b.lng, b.lat] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (ps: [number, number][]) => {
    const h: [number, number][] = [];
    for (const q of ps) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    return h.slice(0, -1);
  };
  const hull = [...half(pts), ...half(pts.slice().reverse())];
  return [...hull, hull[0]].map(([lng, lat]) => [lat, lng]);
}
