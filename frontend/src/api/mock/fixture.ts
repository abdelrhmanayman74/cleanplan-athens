import type { Baseline, Building, Plan } from '../types';
import { generateBuildings } from './buildings';
import { baselineKpis, solvePlan } from './solver';

export interface Fixture {
  generated_at: string;
  note: string;
  buildings: Building[];
  plan: Plan;
  baseline: Baseline;
}

export const BASELINE_DESCRIPTION =
  'Naive baseline: k-means territories by building count, round-robin visit days, nearest-neighbour routes. Same buildings, same shift.';

export function buildFixture(): Fixture {
  const buildings = generateBuildings(7);
  const plan = solvePlan(buildings, {}, 11);
  plan.id = 'default';
  return {
    generated_at: new Date().toISOString(),
    note: 'Synthetic customers on Athens street names. Mock data for frontend development only.',
    buildings,
    plan,
    baseline: { kpis: baselineKpis(buildings, {}, plan.cleaners.length), description: BASELINE_DESCRIPTION },
  };
}
