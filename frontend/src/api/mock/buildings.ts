import type { Building, Frequency } from '../types';
import { ACCESS_NOTES, FEMALE_FIRST, HOODS, MALE_FIRST, OUTLIERS, SURNAMES } from './data';
import { distM, fromXY, gauss, mulberry32, pick, toXY, walkMinutes, type LL, type Rng } from './geo';

function personName(rng: Rng): string {
  const female = rng() < 0.5;
  const [m, f] = pick(rng, SURNAMES);
  return `${pick(rng, female ? FEMALE_FIRST : MALE_FIRST)} ${female ? f : m}`;
}

function phone(rng: Rng): string {
  let s = '69';
  for (let i = 0; i < 8; i++) s += Math.floor(rng() * 10);
  return `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}`;
}

function frequency(rng: Rng): Frequency {
  const r = rng();
  return r < 0.55 ? '1w' : r < 0.8 ? '2w' : r < 0.95 ? 'biweekly' : '3w';
}

function makeBuilding(rng: Rng, idx: number, street: string, num: number, hood: string, postcode: string | null, at: LL): Building {
  const floors = Math.max(2, Math.min(9, Math.round(5 + gauss(rng) * 1.4)));
  const has_lift = floors >= 5 ? rng() < 0.92 : rng() < 0.55;
  const raw = 15 + 3.5 * floors + (has_lift ? 0 : 1.5 * floors) + gauss(rng) * 4;
  const service_minutes = Math.round(Math.max(15, Math.min(75, raw)));
  const tasks = ['Σκάλες', 'Είσοδος'];
  if (has_lift) tasks.push('Ανελκυστήρας');
  if (rng() < 0.7) tasks.push('Κάδοι');
  if (rng() < 0.3) tasks.push('Τζάμια εισόδου');
  if (rng() < 0.2) tasks.push('Πυλωτή');
  if (rng() < 0.1) tasks.push('Ταράτσα');
  return {
    id: `b${String(idx + 1).padStart(4, '0')}`,
    name: `Πολυκατοικία ${street} ${num}`,
    street, number: String(num), postcode, neighborhood: hood,
    lat: +at[0].toFixed(6), lng: +at[1].toFixed(6),
    floors, has_lift, service_minutes, frequency: frequency(rng),
    time_window: rng() < 0.15 ? [420, 720] : null,
    manager: { name: personName(rng), phone: phone(rng) },
    access_note: pick(rng, ACCESS_NOTES),
    tasks, isolated: false,
  };
}

export function generateBuildings(seed = 7): Building[] {
  const rng = mulberry32(seed);
  const out: Building[] = [];
  const usedAddr = new Set<string>();
  for (const h of HOODS) {
    const [cx, cy] = toXY(h.center);
    const a = (h.angle * Math.PI) / 180;
    // Streets: parallel lines in two grid directions crossing the neighbourhood disc.
    const lines = h.streets.map((name, i) => {
      const dir = i % 2 === 0 ? a : a + Math.PI / 2;
      const off = ((i >> 1) / Math.max(1, (h.streets.length >> 1) - 1) - 0.5) * 1.7 * h.radius + gauss(rng) * 40;
      return { name, dir, off };
    });
    let made = 0, guard = 0;
    while (made < h.count && guard++ < h.count * 40) {
      const line = pick(rng, lines);
      const t = (rng() * 2 - 1) * h.radius;
      const nx = -Math.sin(line.dir), ny = Math.cos(line.dir);
      const side = rng() < 0.5 ? -1 : 1;
      const x = cx + Math.cos(line.dir) * t + nx * (line.off + side * (9 + rng() * 6));
      const y = cy + Math.sin(line.dir) * t + ny * (line.off + side * (9 + rng() * 6));
      if (Math.hypot(x - cx, y - cy) > h.radius * (0.92 + rng() * 0.16)) continue;
      const base = Math.max(1, Math.round((t + h.radius) / 14));
      const num = base * 2 + (side > 0 ? 1 : 0);
      const key = `${line.name}|${num}`;
      if (usedAddr.has(key)) continue;
      usedAddr.add(key);
      out.push(makeBuilding(rng, out.length, line.name, num, h.name, h.postcode, fromXY([x, y])));
      made++;
    }
  }
  for (const o of OUTLIERS) {
    let best = HOODS[0];
    for (const h of HOODS) if (distM(h.center, o.center) < distM(best.center, o.center)) best = h;
    out.push(makeBuilding(rng, out.length, o.street, 20 + Math.floor(rng() * 180), best.name, best.postcode, o.center));
  }
  markIsolated(out);
  return out;
}

export function markIsolated(bs: Building[]): void {
  for (const b of bs) {
    const d: number[] = [];
    for (const o of bs) if (o !== b) d.push(walkMinutes([b.lat, b.lng], [o.lat, o.lng]));
    d.sort((x, y) => x - y);
    b.isolated = (d[2] ?? Infinity) > 15;
  }
}
