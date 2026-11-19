// Writes public/mock/fixture.json (≈1,000 buildings, ≈28 cleaners, 10-day plan).
// Run: npm run fixture
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildFixture } from '../src/api/mock/fixture';

const t0 = Date.now();
const fx = buildFixture();
mkdirSync('public/mock', { recursive: true });
writeFileSync('public/mock/fixture.json', JSON.stringify(fx));
const k = fx.plan.kpis;
const iso = fx.buildings.filter((b) => b.isolated).length;
const freq: Record<string, number> = {};
for (const b of fx.buildings) freq[b.frequency] = (freq[b.frequency] ?? 0) + 1;
const stopsPerRoute = fx.plan.routes.map((r) => r.stops.length);
console.log(JSON.stringify({
  ms: Date.now() - t0, buildings: fx.buildings.length, isolated: iso, freq,
  cleaners: k.cleaners, lower_bound: k.lower_bound_cleaners, visits: k.visits,
  walk_h: +(k.walk_minutes / 60).toFixed(1), util: +k.utilization.toFixed(3), avg_walk: +k.avg_walk_per_visit.toFixed(2),
  max_route: k.max_route_minutes, routes: fx.plan.routes.length,
  stops: [Math.min(...stopsPerRoute), Math.max(...stopsPerRoute)],
  starts: fx.plan.cleaners.map((c) => c.start.label),
  baseline: { cleaners: fx.baseline.kpis.cleaners, walk_h: +(fx.baseline.kpis.walk_minutes / 60).toFixed(1) },
}, null, 1));
