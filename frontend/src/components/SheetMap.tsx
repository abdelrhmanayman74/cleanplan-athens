import L from 'leaflet';
import { useEffect, useRef } from 'react';
import type { RouteSheet } from '../api/types';
import { decodePolyline } from '../lib/polyline';
import { useLeafletMap } from '../lib/useLeafletMap';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function createStaticMap(el: HTMLElement): L.Map {
  const map = L.map(el, {
    zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
    keyboard: false, touchZoom: false, zoomSnap: 0.25,
  });
  L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
  return map;
}

/** A small, non-interactive overview of the day's route with numbered stops. */
export function SheetMap({ sheet, color }: { sheet: RouteSheet; color: string }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useLeafletMap(container, createStaticMap);
  useEffect(() => {
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    const line = sheet.route.geometry ? decodePolyline(sheet.route.geometry) : [];
    if (line.length) L.polyline(line, { color, weight: 4, opacity: 0.9 }).addTo(layer);
    const pts: [number, number][] = sheet.stops.map((s) => [s.building.lat, s.building.lng]);
    sheet.stops.forEach((s, i) => {
      L.marker([s.building.lat, s.building.lng], {
        icon: L.divIcon({ className: 'stop-num', html: `<span style="background:${color}">${i + 1}</span>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
        interactive: false, keyboard: false,
      }).addTo(layer);
    });
    const all = [...pts, ...line, [sheet.cleaner.start.lat, sheet.cleaner.start.lng] as [number, number]];
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [18, 18], maxZoom: 17 });
    return () => { layer.remove(); };
  }, [map, sheet, color]);
  return <div ref={container} className="sheet-map no-print" aria-hidden />;
}
