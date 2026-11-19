import type { Building, Plan } from '../api/types';

const SHIFT_START = 7 * 60; // 07:00, minutes from midnight (CONTRACT.md)

export interface ShiftStats {
  overtimeRoutes: number;
  overtimeMinutes: number;
  windowViolations: number;
  longestDay: number;
}

/**
 * Over-shift numbers of a plan, with the definitions the backend uses for the naive baseline
 * (app/solver/baseline.py): a route is over the shift when it ends after 07:00 + shift length, and
 * a time window is missed when the visit finishes after the window closes.
 */
export function shiftStats(plan: Plan, buildingById: Map<string, Building>): ShiftStats {
  const shiftEnd = SHIFT_START + (plan.params.daily_minutes ?? 480);
  let overtimeRoutes = 0, overtimeMinutes = 0, windowViolations = 0;
  for (const r of plan.routes) {
    if (r.stops.length && r.end_time > shiftEnd + 1e-6) {
      overtimeRoutes++;
      overtimeMinutes += r.end_time - shiftEnd;
    }
    for (const s of r.stops) {
      const tw = buildingById.get(s.building_id)?.time_window;
      if (tw && s.depart > tw[1] + 1e-6) windowViolations++;
    }
  }
  return { overtimeRoutes, overtimeMinutes, windowViolations, longestDay: plan.kpis.max_route_minutes };
}

/** Walking minutes gained (+) or saved (−) per cleaner between two versions of a plan. */
export function walkDeltaByCleaner(before: Plan, after: Plan): Map<string, number> {
  const prev = new Map(before.routes.map((r) => [`${r.cleaner_id}|${r.day_key}`, r.walk_minutes]));
  const out = new Map<string, number>();
  for (const r of after.routes) {
    const d = r.walk_minutes - (prev.get(`${r.cleaner_id}|${r.day_key}`) ?? 0);
    if (Math.abs(d) > 1e-9) out.set(r.cleaner_id, (out.get(r.cleaner_id) ?? 0) + d);
  }
  return out;
}

/**
 * Rounds each value to an integer so that the rounded parts add up to the rounded total
 * (largest remainder), so per-cleaner lines never contradict the headline number.
 */
export function roundToTotal(values: Map<string, number>, total: number): Map<string, number> {
  const entries = [...values.entries()];
  const target = Math.round(total);
  const floors = entries.map(([k, v]) => [k, Math.floor(v), v - Math.floor(v)] as const);
  let rest = target - floors.reduce((s, [, f]) => s + f, 0);
  const order = [...floors].sort((a, b) => (rest >= 0 ? b[2] - a[2] : a[2] - b[2]));
  const out = new Map(floors.map(([k, f]) => [k, f]));
  for (let i = 0; rest !== 0 && order.length; i = (i + 1) % order.length) {
    const k = order[i][0];
    out.set(k, out.get(k)! + Math.sign(rest));
    rest -= Math.sign(rest);
  }
  return out;
}
