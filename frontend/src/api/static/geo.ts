const EARTH_RADIUS_M = 6_371_008.8; // as backend/app/travel.py
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres (backend travel.haversine_m). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dlat = rad(lat2 - lat1), dlng = rad(lng2 - lng1);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dlng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
