import L from 'leaflet';
import { useEffect, useMemo, useRef } from 'react';
import type { Building, Route } from '../api/types';
import { fmtNumber } from '../lib/format';
import { decodePolyline } from '../lib/polyline';
import { esc, useLayerGroup, useLeafletMap, useMapView } from '../lib/useLeafletMap';
import { useI18n } from '../i18n/I18n';
import { routeKey, usePlanner } from '../state/PlannerContext';
import { useTheme, type Theme } from '../state/theme';
import { startGlyph } from '../lib/stations';

const ATHENS: [number, number] = [37.9785, 23.7395];
// Standard OSM tiles (no key). CARTO basemaps now require an API key, so the
// light/dark look is produced with CSS filters on the tile pane (see app.css).
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const MAP_COLORS: Record<Theme, { stroke: string; idle: string; warning: string; accent: string; ghost: string }> = {
  light: { stroke: '#ffffff', idle: '#a39b8e', warning: '#b0502a', accent: '#0b5fa5', ghost: '#5f594f' },
  dark: { stroke: '#1f1c18', idle: '#6b6358', warning: '#e3906a', accent: '#4da3e0', ghost: '#b8b0a3' },
};
const DIM = 0.15; // opacity of routes that are not the point of the current view
const NUMBERS_FROM_ZOOM = 15;

function createMap(el: HTMLElement): L.Map {
  const map = L.map(el, {
    center: ATHENS, zoom: 14, minZoom: 11, maxZoom: 18, zoomSnap: 0.25, preferCanvas: true, zoomControl: false,
  });
  L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  // territory hulls under the routes, routes under markers
  map.createPane('hulls').style.zIndex = '330';
  map.createPane('routes').style.zIndex = '390';
  return map;
}

const decodeCache = new Map<string, [number, number][]>();
function positions(r: Route): [number, number][] {
  let p = decodeCache.get(r.geometry);
  if (!p) { p = decodePolyline(r.geometry); decodeCache.set(r.geometry, p); }
  return p;
}

const toPin = (ll: L.LatLng) => ({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) });

const tip = (offsetY: number, extra: L.TooltipOptions = {}): L.TooltipOptions =>
  ({ direction: 'top', offset: [0, offsetY], className: 'map-tip', ...extra });

// ------------------------------------------------------------------ buildings (canvas circle markers)

function BuildingsLayer({ map, theme }: { map: L.Map; theme: Theme }) {
  const { buildings, assignmentByBuilding, cleanerById, routesByDay, day, focus, selected, selectBuilding, scenario } = usePlanner();
  const markers = useRef(new Map<string, L.CircleMarker>());
  const select = useRef(selectBuilding);
  select.current = selectBuilding;
  const group = useLayerGroup(map);
  const rings = useLayerGroup(map);
  const renderer = useMemo(() => L.canvas({ padding: 0.3 }), [map]);

  // (re)create markers when the building set changes; the effect below styles them
  useEffect(() => {
    group.clearLayers();
    markers.current.clear();
    for (const b of buildings) {
      const m = L.circleMarker([b.lat, b.lng], { renderer, radius: 4, weight: 1, fillOpacity: 0.9, bubblingMouseEvents: false });
      m.bindTooltip(() => tooltipHtml(b), tip(-6, { opacity: 1 }));
      m.on('click', () => select.current(b.id));
      m.addTo(group);
      markers.current.set(b.id, m);
    }
  }, [buildings, group, renderer]);

  // restyle on any view change
  useEffect(() => {
    const colors = MAP_COLORS[theme];
    const visitBy = new Map<string, string>();
    if (day !== 'ALL') for (const r of routesByDay.get(day) ?? []) for (const s of r.stops) visitBy.set(s.building_id, r.cleaner_id);
    const changed = new Set((scenario?.result.changes ?? []).filter((c) => day === 'ALL' || c.day_key === day).map((c) => c.building_id));
    for (const b of buildings) {
      const m = markers.current.get(b.id);
      if (!m) continue;
      const owner = assignmentByBuilding.get(b.id)?.cleaner_id;
      const todays = visitBy.get(b.id);
      const cid = day === 'ALL' ? owner : todays;
      const color = cid ? cleanerById.get(cid)?.color ?? colors.idle : colors.idle;
      const dimmed = focus && (cid ?? owner) !== focus;
      let radius = day === 'ALL' ? 4 : todays ? 5 : 3;
      let fillOpacity = day === 'ALL' || todays ? 0.92 : 0.55;
      let weight = 1, stroke = colors.stroke;
      if (dimmed) { fillOpacity = 0.12; radius = Math.min(radius, 3.5); }
      if (changed.has(b.id)) { radius = 7; weight = 2.5; }
      if (selected === b.id) { radius = 9; weight = 3; stroke = colors.accent; }
      m.setStyle({ fillColor: color, color: stroke, weight, fillOpacity, opacity: dimmed ? 0.2 : 1 });
      m.setRadius(radius);
      if (selected === b.id || changed.has(b.id)) m.bringToFront();
    }
    // isolated warning rings
    rings.clearLayers();
    for (const b of buildings) {
      if (!b.isolated) continue;
      L.circleMarker([b.lat, b.lng], {
        renderer, radius: 10, color: colors.warning, weight: 2, dashArray: '3 3', fill: false, interactive: false,
        opacity: focus && assignmentByBuilding.get(b.id)?.cleaner_id !== focus ? 0.25 : 0.95,
      }).addTo(rings);
    }
  }, [buildings, assignmentByBuilding, cleanerById, routesByDay, day, focus, selected, scenario, theme, renderer, rings]);

  return null;
}

function tooltipHtml(b: Building): string {
  return `<strong>${esc(b.street)} ${esc(b.number)}</strong><br/><span>${esc(b.neighborhood)} · ${b.service_minutes}′</span>`;
}

// ------------------------------------------------------------------ routes and numbered stops

function RoutesLayer({ map, theme }: { map: L.Map; theme: Theme }) {
  const { routesByDay, day, focus, hoverCleaner, cleanerById, scenario, insert, buildingById, routeByKey, selectBuilding } = usePlanner();
  const { t } = useI18n();
  const svg = useMemo(() => L.svg({ pane: 'routes', padding: 0.4 }), [map]);
  const ghost = useLayerGroup(map);
  const lines = useLayerGroup(map);
  const numbers = useLayerGroup(map);
  const rings = useLayerGroup(map);
  const active = hoverCleaner ?? focus; // a hovered list row wins over the focused territory
  const { zoom, bounds } = useMapView(map);

  const hoverCand = insert.hover != null ? insert.candidates?.[insert.hover] : null;
  const hoverKey = hoverCand ? routeKey({ cleaner_id: hoverCand.cleaner_id, day_key: hoverCand.day_keys[0] }) : null;
  const scenarioActive = !!scenario && day !== 'ALL' && (scenario.kind === 'insert' ? scenario.candidate.day_keys.includes(day) : scenario.day === day);
  const changedKeys = scenarioActive ? scenario!.changedKeys : null;
  const ghostRoute = scenarioActive && scenario!.kind === 'absence' ? scenario!.ghost : null;

  // the day's routes, plus a hovered insert candidate's route if it is on another day
  const drawn = useMemo(() => {
    const routes = day === 'ALL' ? [] : routesByDay.get(day) ?? [];
    const hoverRoute = hoverKey ? routeByKey.get(hoverKey) : null;
    return hoverRoute && !routes.includes(hoverRoute) ? [...routes, hoverRoute] : routes;
  }, [day, routesByDay, hoverKey, routeByKey]);

  useEffect(() => {
    lines.clearLayers();
    for (const r of drawn) {
      const c = cleanerById.get(r.cleaner_id);
      if (!c) continue;
      const k = routeKey(r);
      const isChanged = !!changedKeys?.has(k);
      const isHover = k === hoverKey;
      // after a what-if, unchanged routes fade so the changed ones stand out
      const dim = active ? active !== r.cleaner_id : (changedKeys && !isChanged) || (hoverKey && !isHover);
      const weight = isChanged || isHover || active === r.cleaner_id ? 5 : 3;
      const pos = positions(r);
      if (isChanged) {
        L.polyline(pos, { renderer: svg, color: c.color, weight: weight + 8, opacity: 0.25, lineCap: 'round', interactive: false }).addTo(lines);
      }
      // solid lines only: a leg without cached street geometry is a quiet straight segment
      L.polyline(pos, {
        renderer: svg, color: c.color, weight, opacity: dim ? DIM : 0.9, lineCap: 'round', lineJoin: 'round', interactive: false,
      }).addTo(lines);
      // estimated legs to a new building: short dotted connectors
      for (const seg of r.connectors ?? []) {
        L.polyline(seg, { renderer: svg, color: c.color, weight: 3, opacity: dim ? DIM : 0.95, dashArray: '1 7', lineCap: 'round', interactive: false }).addTo(lines);
      }
    }
  }, [lines, svg, drawn, cleanerById, changedKeys, hoverKey, active]);

  // absence: the absent cleaner's old route as a grey ghost, and a pulsing ring on every moved visit
  // in the colour of the colleague who now has it
  useEffect(() => {
    ghost.clearLayers();
    rings.clearLayers();
    if (!ghostRoute || !scenario) return;
    const pos = positions(ghostRoute);
    L.polyline(pos, { renderer: svg, color: MAP_COLORS[theme].stroke, weight: 9, opacity: 0.7, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(ghost);
    L.polyline(pos, {
      renderer: svg, color: MAP_COLORS[theme].ghost, weight: 5, opacity: 0.85, dashArray: '1 10', lineCap: 'round', interactive: false,
    }).addTo(ghost);
    for (const ch of scenario.result.changes) {
      const b = buildingById.get(ch.building_id);
      const color = ch.to_cleaner ? cleanerById.get(ch.to_cleaner)?.color : MAP_COLORS[theme].warning;
      if (!b || ch.day_key !== day) continue;
      L.marker([b.lat, b.lng], {
        icon: L.divIcon({ className: 'pulse-ring', html: `<i style="border-color:${color}"></i><span style="border-color:${color}"></span>`, iconSize: [36, 36], iconAnchor: [18, 18] }),
        interactive: false, keyboard: false, zIndexOffset: 400,
      }).addTo(rings);
    }
  }, [ghost, rings, svg, ghostRoute, scenario, day, buildingById, cleanerById, theme]);

  useEffect(() => {
    numbers.clearLayers();
    const visible = bounds.pad(0.2);
    for (const r of drawn) {
      const c = cleanerById.get(r.cleaner_id);
      const k = routeKey(r);
      const numbered = zoom >= NUMBERS_FROM_ZOOM
        && (active ? active === r.cleaner_id : !changedKeys || changedKeys.has(k) || k === hoverKey);
      if (!c || !numbered) continue;
      r.stops.forEach((s, i) => {
        const b = buildingById.get(s.building_id);
        if (!b) return;
        if (!visible.contains([b.lat, b.lng])) return;
        L.marker([b.lat, b.lng], { icon: numberIcon(i + 1, c.color), zIndexOffset: 500 })
          .bindTooltip(`<strong>${esc(t('map.stop', { n: i + 1 }))} · ${esc(b.street)} ${esc(b.number)}</strong>`, tip(-10))
          .on('click', () => selectBuilding(b.id))
          .addTo(numbers);
      });
    }
  }, [numbers, drawn, cleanerById, buildingById, changedKeys, hoverKey, active, zoom, bounds, selectBuilding, t]);

  return null;
}

const iconCache = new Map<string, L.DivIcon>();
function numberIcon(n: number, color: string): L.DivIcon {
  const k = `${n}-${color}`;
  let ic = iconCache.get(k);
  if (!ic) {
    ic = L.divIcon({ className: 'stop-num', html: `<span style="background:${color}">${n}</span>`, iconSize: [20, 20], iconAnchor: [10, 10] });
    iconCache.set(k, ic);
  }
  return ic;
}

function stationIcon(color: string, letter: string | null, dim: boolean): L.DivIcon {
  const glyph = letter
    ?? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9H3z"/></svg>';
  return L.divIcon({
    className: `station-icon ${dim ? 'is-dim' : ''}`,
    html: `<span style="border-color:${color};box-shadow:0 0 0 2px ${color}33">${glyph}</span>`,
    iconSize: [24, 24], iconAnchor: [12, 12],
  });
}

const pinIcon = L.divIcon({
  className: 'new-pin',
  html: '<svg viewBox="0 0 32 40" width="32" height="40"><path d="M16 39s13-12.4 13-23A13 13 0 0 0 3 16c0 10.6 13 23 13 23z" fill="var(--accent)" stroke="white" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="white"/></svg>',
  iconSize: [32, 40], iconAnchor: [16, 39],
});

// ------------------------------------------------------------------ territories, stations, new-building pin

function Territories({ map }: { map: L.Map }) {
  const { plan, cleanerById, focus } = usePlanner();
  const group = useLayerGroup(map);
  const renderer = useMemo(() => L.canvas({ pane: 'hulls' }), [map]);
  useEffect(() => {
    group.clearLayers();
    for (const tr of plan?.territories ?? []) {
      const c = cleanerById.get(tr.cleaner_id);
      if (!c || tr.hull.length < 3) continue;
      const on = focus === tr.cleaner_id;
      const off = !!focus && !on;
      // outline only, except for the selected cleaner's territory
      L.polygon(tr.hull, {
        renderer, color: c.color, weight: on ? 2 : 1, opacity: off ? 0.12 : on ? 0.8 : 0.3,
        fill: on, fillColor: c.color, fillOpacity: 0.12, interactive: false,
      }).addTo(group);
    }
  }, [group, renderer, plan, cleanerById, focus]);
  return null;
}

function Stations({ map }: { map: L.Map }) {
  const { cleaners, focus, setFocus } = usePlanner();
  const { t } = useI18n();
  const group = useLayerGroup(map);
  useEffect(() => {
    group.clearLayers();
    for (const c of cleaners) {
      L.marker([c.start.lat, c.start.lng], { icon: stationIcon(c.color, startGlyph(c.start), !!focus && focus !== c.id), zIndexOffset: 800 })
        .bindTooltip(`<strong>${esc(c.start.label)}</strong><br/>${esc(t('map.start'))} · ${esc(c.name)}`, tip(-12))
        .on('click', () => setFocus(focus === c.id ? null : c.id))
        .addTo(group);
    }
  }, [group, cleaners, focus, setFocus, t]);
  return null;
}

function InsertPin({ map }: { map: L.Map }) {
  const { insert, setInsert, routeByKey, buildingById, cleanerById } = usePlanner();
  const { t, patternLabel } = useI18n();
  const link = useLayerGroup(map);
  const pin = insert.pin;
  const marker = useRef<L.Marker | null>(null);
  const cand = insert.hover != null ? insert.candidates?.[insert.hover] : null;
  // the pin's label: its address, and on candidate hover who takes it on which days
  const label = [insert.address ?? t('map.pinHere'), cand && `→ ${cleanerById.get(cand.cleaner_id)?.name ?? cand.cleaner_id} · ${patternLabel(cand.day_keys)}`]
    .filter(Boolean).map((x) => esc(x as string)).join('<br/>');

  // click to drop the pin
  useEffect(() => {
    if (!insert.picking) return;
    const onClick = (e: L.LeafletMouseEvent) => setInsert({ pin: toPin(e.latlng), picking: false, candidates: null, hover: null });
    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [map, insert.picking, setInsert]);

  // the pin itself; dragging it moves the new building
  useEffect(() => {
    if (!pin) return;
    const m = L.marker([pin.lat, pin.lng], { icon: pinIcon, draggable: true, zIndexOffset: 1000 })
      .on('dragend', () => setInsert({ pin: toPin(m.getLatLng()), candidates: null, hover: null }))
      .addTo(map);
    marker.current = m;
    return () => { m.remove(); marker.current = null; };
  }, [map, pin, setInsert]);
  // label to the right of the pin, clear of the stop markers it sits among
  useEffect(() => {
    marker.current?.unbindTooltip().bindTooltip(label, { direction: 'right', offset: [14, -22], permanent: true, className: 'map-tip' });
  }, [label, pin]);

  // dotted link from the pin to the nearest stop of the hovered candidate's route
  useEffect(() => {
    link.clearLayers();
    if (!pin || !cand) return;
    const r = routeByKey.get(routeKey({ cleaner_id: cand.cleaner_id, day_key: cand.day_keys[0] }));
    let best: [number, number] | null = null, bd = Infinity;
    for (const s of r?.stops ?? []) {
      const b = buildingById.get(s.building_id);
      if (!b) continue;
      const d = (b.lat - pin.lat) ** 2 + (b.lng - pin.lng) ** 2;
      if (d < bd) { bd = d; best = [b.lat, b.lng]; }
    }
    if (best) {
      L.polyline([[pin.lat, pin.lng], best], { color: cleanerById.get(cand.cleaner_id)?.color, weight: 3, dashArray: '2 6', interactive: false }).addTo(link);
    }
  }, [link, pin, cand, routeByKey, buildingById, cleanerById]);

  return null;
}

/** Matched addresses of an import, framed on arrival. */
function ImportPins({ map }: { map: L.Map }) {
  const { importPins, tab } = usePlanner();
  const group = useLayerGroup(map);
  const pins = useMemo(() => (tab === 'import' ? importPins : []), [tab, importPins]);
  useEffect(() => {
    group.clearLayers();
    for (const p of pins) {
      L.marker([p.lat, p.lng], { icon: importIcon, zIndexOffset: 900 }).bindTooltip(esc(p.label), tip(-30)).addTo(group);
    }
    if (pins.length) map.flyToBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng])), { padding: [60, 60], maxZoom: 15, duration: 0.8 });
  }, [group, map, pins]);
  return null;
}

const importIcon = L.divIcon({
  className: 'import-pin',
  html: '<svg viewBox="0 0 24 30" width="22" height="28"><path d="M12 29s10-9.3 10-17.2A10 10 0 0 0 2 11.8C2 19.7 12 29 12 29z" fill="var(--success)" stroke="white" stroke-width="2"/><circle cx="12" cy="12" r="3.6" fill="white"/></svg>',
  iconSize: [22, 28], iconAnchor: [11, 27],
});

// ------------------------------------------------------------------ camera

function Controller({ map }: { map: L.Map }) {
  const { fly, focus, plan, buildings, buildingById, scenario } = usePlanner();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !buildings.length) return;
    fitted.current = true;
    const b = L.latLngBounds(buildings.filter((x) => !x.isolated).map((x) => [x.lat, x.lng] as [number, number]));
    map.fitBounds(b, { paddingTopLeft: [24, 64], paddingBottomRight: [24, 48], animate: false });
  }, [buildings, map]);
  useEffect(() => {
    if (fly) map.flyTo([fly.lat, fly.lng], fly.zoom ?? Math.max(map.getZoom(), 16), { duration: 0.8 });
  }, [fly, map]);
  useEffect(() => {
    if (!focus || !plan) return;
    const tr = plan.territories.find((x) => x.cleaner_id === focus);
    if (tr && tr.hull.length) map.flyToBounds(L.latLngBounds(tr.hull), { padding: [40, 40], duration: 0.7, maxZoom: 16 });
  }, [focus, plan, map]);
  // after a what-if, frame the routes it touched (and the absent cleaner's old route)
  useEffect(() => {
    if (!scenario || !plan) return;
    const pts: [number, number][] = [];
    for (const r of plan.routes) {
      if (!scenario.changedKeys.has(routeKey(r))) continue;
      for (const s of r.stops) { const b = buildingById.get(s.building_id); if (b) pts.push([b.lat, b.lng]); }
    }
    if (scenario.kind === 'absence' && scenario.ghost) pts.push(...positions(scenario.ghost));
    if (pts.length) map.flyToBounds(L.latLngBounds(pts), { padding: [56, 56], duration: 0.8, maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, map]);
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

// ------------------------------------------------------------------ public component

export function MapView() {
  const { theme } = useTheme();
  const { insert, scenario, day } = usePlanner();
  const { t, lang } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const map = useLeafletMap(container, createMap);
  return (
    <div className={`map-wrap ${insert.picking ? 'is-picking' : ''}`} data-tour="map">
      <div ref={container} className="map" />
      {map && (
        <>
          <Controller map={map} />
          <Territories map={map} />
          <RoutesLayer map={map} theme={theme} />
          <BuildingsLayer map={map} theme={theme} />
          <Stations map={map} />
          <InsertPin map={map} />
          <ImportPins map={map} />
        </>
      )}
      {scenario && day !== 'ALL' && (scenario.kind === 'absence' ? scenario.day === day : scenario.candidate.day_keys.includes(day)) && (
        <div className="map-caption" aria-live="polite">
          {t('map.othersUnchanged', { n: fmtNumber(scenario.result.untouched_routes, lang) })}
        </div>
      )}
      <div className="map-legend" aria-label={t('map.legend.title')}>
        <span><i className="lg-dot" /> {t('map.legend.building')}</span>
        <span><i className="lg-ring" /> {t('map.legend.isolated')}</span>
        <span><i className="lg-station">Μ</i> {t('map.legend.station')}</span>
      </div>
    </div>
  );
}
