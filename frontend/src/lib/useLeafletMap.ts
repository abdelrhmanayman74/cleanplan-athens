// Thin React bindings for plain Leaflet (BSD-2-Clause). The map and its layers are managed
// imperatively; React only decides when to (re)draw them.

import L from 'leaflet';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

/**
 * Creates a Leaflet map in `container` once it is mounted and removes it on unmount.
 * `create` runs once per mount (tiles, controls and panes belong there). Returns null until ready.
 */
export function useLeafletMap(container: RefObject<HTMLElement>, create: (el: HTMLElement) => L.Map): L.Map | null {
  const [map, setMap] = useState<L.Map | null>(null);
  const factory = useRef(create);
  useEffect(() => {
    if (!container.current) return;
    const m = factory.current(container.current);
    setMap(m);
    return () => {
      m.remove();
      setMap(null);
    };
  }, [container]);
  return map;
}

/** A layer group that stays on `map` while the calling component is mounted. */
export function useLayerGroup(map: L.Map): L.LayerGroup {
  const group = useMemo(() => L.layerGroup(), []);
  useEffect(() => {
    group.addTo(map);
    return () => { group.remove(); };
  }, [map, group]);
  return group;
}

/** Current zoom and bounds, updated after every pan or zoom. */
export function useMapView(map: L.Map): { zoom: number; bounds: L.LatLngBounds } {
  const [view, setView] = useState(() => ({ zoom: map.getZoom(), bounds: map.getBounds() }));
  useEffect(() => {
    const update = () => setView({ zoom: map.getZoom(), bounds: map.getBounds() });
    map.on('moveend zoomend', update);
    return () => { map.off('moveend zoomend', update); };
  }, [map]);
  return view;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text for Leaflet tooltips and div icons, which take HTML strings. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
