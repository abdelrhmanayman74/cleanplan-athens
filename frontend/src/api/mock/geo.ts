// Planar helpers around Athens (equirectangular is fine at this scale).

export type LL = [number, number];

const LAT0 = 37.98;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
export const WALK_M_PER_MIN = 78; // ~4.7 km/h
const GRID_ANGLE = (24 * Math.PI) / 180; // dominant street grid orientation for the mock

export function toXY([lat, lng]: LL): [number, number] {
  return [(lng - 23.73) * M_PER_DEG_LNG, (lat - LAT0) * M_PER_DEG_LAT];
}
export function fromXY([x, y]: [number, number]): LL {
  return [y / M_PER_DEG_LAT + LAT0, x / M_PER_DEG_LNG + 23.73];
}
export function distM(a: LL, b: LL): number {
  const [ax, ay] = toXY(a), [bx, by] = toXY(b);
  return Math.hypot(ax - bx, ay - by);
}

/** "Street-like" walk: Manhattan distance on a rotated grid. */
export function gridLeg(a: LL, b: LL): { minutes: number; path: LL[] } {
  const [ax, ay] = toXY(a), [bx, by] = toXY(b);
  const dx = bx - ax, dy = by - ay;
  const c = Math.cos(GRID_ANGLE), s = Math.sin(GRID_ANGLE);
  const u = dx * c + dy * s; // along grid axis 1
  const v = -dx * s + dy * c; // along grid axis 2
  const mid = fromXY([ax + u * c, ay + u * s]);
  const meters = Math.abs(u) + Math.abs(v);
  return { minutes: meters / WALK_M_PER_MIN, path: Math.abs(u) < 15 || Math.abs(v) < 15 ? [a, b] : [a, mid, b] };
}

export function walkMinutes(a: LL, b: LL): number {
  return gridLeg(a, b).minutes;
}

export function convexHull(points: LL[]): LL[] {
  const pts = points.map((p) => [p[1], p[0]] as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return points.slice();
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)).map(([x, y]) => [y, x]);
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;
export const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
export function gauss(rng: Rng): number {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
