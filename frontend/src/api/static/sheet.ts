// Browser port of backend/app/routesheet.py.

import type { Building, Plan, RouteSheet } from '../types';

const GMAPS_MAX_WAYPOINTS = 9;
const WEEKDAY_EL: Record<string, string> = { Mon: 'Δευτέρα', Tue: 'Τρίτη', Wed: 'Τετάρτη', Thu: 'Πέμπτη', Fri: 'Παρασκευή' };
const WEEK_EL: Record<string, string> = { A: 'Εβδομάδα Α', B: 'Εβδομάδα Β' };
const ll = ([lat, lng]: [number, number]) => `${lat.toFixed(6)},${lng.toFixed(6)}`;

/** Walking directions through `points`, split so each link has at most 9 waypoints. */
export function googleMapsUrls(points: [number, number][]): string[] {
  const urls: string[] = [];
  for (let i = 0; i < points.length - 1;) {
    const j = Math.min(i + GMAPS_MAX_WAYPOINTS + 1, points.length - 1);
    const seg = points.slice(i, j + 1);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${ll(seg[0])}&destination=${ll(seg[seg.length - 1])}&travelmode=walking`;
    if (seg.length > 2) url += '&waypoints=' + encodeURIComponent(seg.slice(1, -1).map(ll).join('|')).replace(/%2C/g, ',').replace(/%7C/g, '|');
    urls.push(url);
    i = j;
  }
  return urls;
}

export function routeSheet(plan: Plan, buildingById: Map<string, Building>, cleanerId: string, dayKey: string): RouteSheet | null {
  const cleaner = plan.cleaners.find((c) => c.id === cleanerId);
  const route = plan.routes.find((r) => r.cleaner_id === cleanerId && r.day_key === dayKey);
  if (!cleaner || !route) return null;
  const stops = route.stops.map((s) => ({ ...s, building: buildingById.get(s.building_id)! }));
  const start: [number, number] = [cleaner.start.lat, cleaner.start.lng];
  const urls = stops.length ? googleMapsUrls([start, ...stops.map((s) => [s.building.lat, s.building.lng] as [number, number]), start]) : [];
  const [week, day] = dayKey.split('-');
  return {
    cleaner, day_key: dayKey, date_label: `${WEEK_EL[week]} · ${WEEKDAY_EL[day]}`, route, stops,
    google_maps_url: urls[0] ?? '', google_maps_urls: urls,
  };
}
