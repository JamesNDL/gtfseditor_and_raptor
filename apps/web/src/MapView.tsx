import { ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { tripPosition } from '@gtfs-editor/core';
import * as maplibregl from 'maplibre-gl';
// MapLibre finds its worker relative to its own file, which bundlers move; hand it the bundled URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useRef } from 'react';
import { describePick, pickClosurePoint, pickClosureStop, pickStop, placeStop } from './builder.ts';
import { clock } from './clock.ts';
import { useStore } from './store.ts';
import { MAP_PALETTE, type MapPalette } from './theme.ts';
import { computeFrame, vehicleData } from './vehicles.ts';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const SYDNEY: [number, number] = [151.12, -33.87];
// The colours in use, set each time the map is built for a theme.
let P: MapPalette = MAP_PALETTE.dark;
// Where the map was looking, so that rebuilding it for another theme does not lose the place.
let lastView: { center: [number, number]; zoom: number } | null = null;

// Drawn bottom to top.
const MODE_ORDER = ['school_bus', 'bus', 'coach', 'ferry', 'light_rail', 'metro', 'train'];

// Opacity is [zoomed out, zoomed in]: dense bus networks stay faint until you are close enough to read them.
const LINE_STYLE: Record<string, { width: [number, number]; opacity: [number, number]; dash?: number[] }> = {
  school_bus: { width: [0.5, 1.5], opacity: [0.08, 0.4] },
  bus: { width: [0.5, 2], opacity: [0.07, 0.5] },
  coach: { width: [1, 2], opacity: [0.4, 0.6] },
  ferry: { width: [1.2, 2.5], opacity: [0.8, 0.8], dash: [2, 2] },
  light_rail: { width: [1.5, 4], opacity: [0.9, 0.9] },
  metro: { width: [2, 5], opacity: [0.95, 0.95] },
  train: { width: [2, 5], opacity: [0.95, 0.95] },
};

// Vehicle dot size: a real-world radius, clamped so dots stay visible zoomed out and sane zoomed in.
const VEHICLE_STYLE: Record<string, { radiusM: number; minPx: number; maxPx: number }> = {
  school_bus: { radiusM: 35, minPx: 1.6, maxPx: 6 },
  bus: { radiusM: 35, minPx: 1.8, maxPx: 6 },
  coach: { radiusM: 60, minPx: 2.5, maxPx: 7 },
  ferry: { radiusM: 70, minPx: 3, maxPx: 8 },
  light_rail: { radiusM: 60, minPx: 2.8, maxPx: 8 },
  metro: { radiusM: 110, minPx: 3.4, maxPx: 10 },
  train: { radiusM: 110, minPx: 3.4, maxPx: 10 },
};

interface Props {
  onVehicleCount: (count: number) => void;
}

export function MapView({ onVehicleCount }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const dirtyRef = useRef(true);
  // The map's 'style.load' event fires once; effects that run later must not wait for it again.
  const loadedRef = useRef(false);
  const whenLoaded = (fn: () => void) => {
    const map = mapRef.current;
    if (!map) return;
    if (loadedRef.current) fn();
    else map.once('style.load', fn);
  };

  P = MAP_PALETTE[useStore((s) => s.theme)];
  const baselineId = useStore((s) => s.baselineId);
  const enabledModes = useStore((s) => s.enabledModes);
  const loadedModes = useStore((s) => s.loadedModes);
  const highlightRouteId = useStore((s) => s.highlightRouteId);
  const highlightTripId = useStore((s) => s.highlightTripId);
  const fitBounds = useStore((s) => s.fitBounds);
  const dataVersion = useStore((s) => s.dataVersion);
  const scenarioInfo = useStore((s) => s.scenarioInfo);
  const showChanged = useStore((s) => s.showChanged);

  // Create the map once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: P.basemap,
      center: lastView?.center ?? SYDNEY,
      zoom: lastView?.zoom ?? 10.2,
      minZoom: 4,
      maxPitch: 0,
      dragRotate: false,
      attributionControl: { compact: true },
    });
    map.once('style.load', () => (loadedRef.current = true));
    map.touchZoomRotate.disableRotation();
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
    mapRef.current = map;
    overlayRef.current = overlay;

    // Lines the scenario created are listed first so that they win a click over what lies beneath.
    const lineLayerIds = () => ['line-scenario', ...MODE_ORDER.map((m) => `line-${m}`)].filter((id) => map.getLayer(id));

    const pickVehicle = (x: number, y: number, radius = 6): number | null => {
      const info = overlay.pickObject({ x, y, radius });
      if (!info || info.index < 0 || !info.layer?.id.startsWith('vehicles-')) return null;
      const mv = vehicleData.get(info.layer.id.slice('vehicles-'.length));
      return mv ? mv.pack.tripId[mv.frameTrip[info.index]] : null;
    };
    const routesAt = (x: number, y: number): number[] => {
      const ids = lineLayerIds();
      if (!ids.length) return [];
      const features = map.queryRenderedFeatures(
        [
          [x - 5, y - 5],
          [x + 5, y + 5],
        ],
        { layers: ids },
      );
      // Topmost layers come first; keep that order so rail beats bus.
      return [...new Set(features.map((f) => Number(f.properties.route_id)))];
    };

    // Stops are small, so they get a generous target: the nearest station, platform or stop within
    // STOP_REACH pixels of the pointer.
    const STOP_REACH = 14;
    const STOP_LAYERS = ['stop-station', 'stop-platform', 'stop-road', 'stop-new', 'stop-new-platform'];
    const stopAt = (x: number, y: number): { id: number; name: string; isStation: boolean; lon: number; lat: number } | null => {
      const layers = STOP_LAYERS.filter((id) => map.getLayer(id));
      if (!layers.length) return null;
      const features = map.queryRenderedFeatures(
        [
          [x - STOP_REACH, y - STOP_REACH],
          [x + STOP_REACH, y + STOP_REACH],
        ],
        { layers },
      );
      let best: { d: number; feature: (typeof features)[number] } | null = null;
      for (const feature of features) {
        if (feature.geometry.type !== 'Point') continue;
        const p = map.project(feature.geometry.coordinates as [number, number]);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= STOP_REACH && (!best || d < best.d)) best = { d, feature };
      }
      if (!best) return null;
      const props = best.feature.properties;
      const [lon, lat] = (best.feature.geometry as GeoJSON.Point).coordinates;
      return { id: Number(props.stop_id), name: String(props.name), isStation: props.station === true || props.station === 'true', lon, lat };
    };

    // What a click or hover lands on. A vehicle directly under the pointer wins; otherwise a nearby stop
    // beats a nearby vehicle, because vehicles keep moving through and stops would be unreachable.
    type Target =
      | { kind: 'vehicle'; tripId: number }
      | { kind: 'stop'; id: number; name: string; isStation: boolean; lon: number; lat: number }
      | { kind: 'routes'; ids: number[] };
    const targetAt = (x: number, y: number): Target | null => {
      const exact = pickVehicle(x, y, 2);
      if (exact !== null) return { kind: 'vehicle', tripId: exact };
      const stop = stopAt(x, y);
      if (stop) return { kind: 'stop', ...stop };
      const near = pickVehicle(x, y, 6);
      if (near !== null) return { kind: 'vehicle', tripId: near };
      const ids = routesAt(x, y);
      return ids.length ? { kind: 'routes', ids } : null;
    };

    let hoveredStop = -1;
    const setHoveredStop = (id: number) => {
      if (id === hoveredStop || !map.getLayer('stop-hover')) return;
      hoveredStop = id;
      map.setFilter('stop-hover', ['==', ['get', 'stop_id'], id]);
      if (map.getLayer('stop-hover-new')) map.setFilter('stop-hover-new', ['==', ['get', 'stop_id'], id]);
    };

    map.on('click', (e) => {
      const { open, close, openTimeline } = useStore.getState();
      // While a closure is being set up, clicks say where it is.
      const closing = useStore.getState().closing;
      if (closing) {
        if (closing.what === 'road') return pickClosurePoint(e.lngLat.lng, e.lngLat.lat);
        const stop = stopAt(e.point.x, e.point.y);
        if (stop) pickClosureStop(stop);
        return;
      }
      // While a line is being drawn or reshaped, clicks pick its stops and nothing else.
      if (useStore.getState().builder) {
        // A named new stop is waiting: this click says where it goes.
        if (useStore.getState().placing) return void placeStop(e.lngLat.lng, e.lngLat.lat);
        const stop = stopAt(e.point.x, e.point.y);
        if (stop) pickStop(stop);
        return;
      }
      const target = targetAt(e.point.x, e.point.y);
      if (target?.kind === 'vehicle') return open({ kind: 'trip', id: target.tripId }, { replace: true });
      if (target?.kind === 'stop') {
        // Details open on the right, like a line or a trip. An open platform chart follows along.
        if (useStore.getState().timeline.open && useStore.getState().timeline.tab === 'platforms') {
          openTimeline({ tab: 'platforms', stationId: target.id, focusStopId: target.isStation ? null : target.id });
        }
        return open({ kind: 'station', id: target.id }, { replace: true });
      }
      const routeIds = target?.kind === 'routes' ? target.ids : [];
      if (routeIds.length === 1) return open({ kind: 'route', id: routeIds[0] }, { replace: true });
      if (routeIds.length > 1) return open({ kind: 'routeList', ids: routeIds }, { replace: true });
      close();
    });

    let lastMove = 0;
    map.on('mousemove', (e) => {
      const now = performance.now();
      if (now - lastMove < 50) return;
      lastMove = now;
      const tooltip = tooltipRef.current!;
      const { routes } = useStore.getState();
      let text = '';
      const closing = useStore.getState().closing;
      if (closing) {
        const stop = closing.what === 'road' ? null : stopAt(e.point.x, e.point.y);
        setHoveredStop(stop ? stop.id : -1);
        const hint = closing.what === 'road' ? 'Click where the road is closed' : stop ? `${stop.name} · click: the closure is ${closing.from && !closing.to ? 'between here and ' + closing.from.name : 'on one side of here'}` : '';
        map.getCanvas().style.cursor = closing.what === 'road' ? 'crosshair' : stop ? 'pointer' : '';
        tooltip.style.display = hint ? 'block' : 'none';
        tooltip.textContent = hint;
        tooltip.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 14}px)`;
        return;
      }
      const drawing = useStore.getState().builder !== null;
      const placing = drawing ? useStore.getState().placing : null;
      if (placing) {
        setHoveredStop(-1);
        map.getCanvas().style.cursor = 'crosshair';
        tooltip.style.display = 'block';
        tooltip.textContent = `Click to place ${placing.name} here`;
        tooltip.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 14}px)`;
        return;
      }
      const drawStop = drawing ? stopAt(e.point.x, e.point.y) : null;
      const target: Target | null = drawing ? (drawStop ? { kind: 'stop', ...drawStop } : null) : targetAt(e.point.x, e.point.y);
      setHoveredStop(target?.kind === 'stop' ? target.id : -1);
      if (target?.kind === 'vehicle') {
        for (const mv of vehicleData.values()) {
          const i = mv.indexByTripId.get(target.tripId);
          if (i === undefined) continue;
          const route = routes.get(mv.pack.tripRoute[i]);
          text = route ? `${route.shortName ?? route.longName ?? 'Vehicle'} vehicle` : 'Vehicle';
        }
      } else if (target?.kind === 'stop') {
        text = drawing ? `${target.name} · ${describePick(target)}` : `${target.name} · click for ${target.isStation ? 'station details' : 'stop details'}`;
      } else if (target?.kind === 'routes') {
        const ids = target.ids;
        const names = ids.slice(0, 4).map((id) => routes.get(id)?.shortName ?? routes.get(id)?.longName ?? '?');
        text = names.join(', ') + (ids.length > 4 ? ` +${ids.length - 4} more` : '');
      }
      map.getCanvas().style.cursor = text ? 'pointer' : '';
      tooltip.style.display = text ? 'block' : 'none';
      if (text) {
        tooltip.textContent = text;
        tooltip.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 14}px)`;
      }
    });
    map.on('mouseout', () => (tooltipRef.current!.style.display = 'none'));

    return () => {
      const c = map.getCenter();
      lastView = { center: [c.lng, c.lat], zoom: map.getZoom() };
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  // Outline the lines the scenario has touched.
  useEffect(() => {
    whenLoaded(() => {
      const map = mapRef.current;
      if (!map?.getLayer('sel-changed')) return;
      const ids = showChanged ? (scenarioInfo?.impact ?? []).map((i) => i.routeId).slice(0, 400) : [];
      map.setFilter('sel-changed', ids.length ? ['in', ['get', 'route_id'], ['literal', ids]] : ['==', ['get', 'route_id'], -1]);
    });
  }, [scenarioInfo, showChanged, baselineId]);

  // Network lines and stops for the chosen baseline.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || baselineId === null) return;
    const add = () => {
      for (const layer of map.getStyle().layers) {
        if (layer.id.startsWith('line-') || layer.id.startsWith('sel-') || layer.id.startsWith('stop-')) map.removeLayer(layer.id);
      }
      if (map.getSource('network')) map.removeSource('network');
      map.addSource('network', {
        type: 'vector',
        tiles: [`${location.origin}/api/baselines/${baselineId}/tiles/{z}/{x}/{y}`],
        minzoom: 4,
        maxzoom: 14,
      });
      // Lines the scenario has changed, outlined so that edits can be seen on the map. Drawn under the lines themselves, so their colours still show.
      map.addLayer({
        id: 'sel-changed',
        type: 'line',
        source: 'network',
        'source-layer': 'lines',
        filter: ['==', ['get', 'route_id'], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffd60a', 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 7, 15, 13], 'line-blur': 1.5 },
      });
      const enabled = useStore.getState().enabledModes;
      for (const mode of MODE_ORDER) {
        const s = LINE_STYLE[mode];
        map.addLayer({
          id: `line-${mode}`,
          type: 'line',
          source: 'network',
          'source-layer': 'lines',
          filter: ['==', ['get', 'mode'], mode],
          layout: { 'line-cap': 'round', 'line-join': 'round', visibility: enabled[mode] ? 'visible' : 'none' },
          paint: {
            'line-color': ['get', 'color'],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, s.opacity[0], 14, s.opacity[1]],
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, s.width[0], 15, s.width[1]],
            ...(s.dash ? { 'line-dasharray': s.dash } : {}),
          },
        });
      }
      map.addLayer({
        id: 'sel-glow',
        type: 'line',
        source: 'network',
        'source-layer': 'lines',
        filter: ['==', ['get', 'route_id'], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': P.casing, 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 15, 11] },
      });
      map.addLayer({
        id: 'sel-line',
        type: 'line',
        source: 'network',
        'source-layer': 'lines',
        filter: ['==', ['get', 'route_id'], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 15, 6] },
      });
      map.addLayer({
        id: 'stop-road',
        type: 'circle',
        source: 'network',
        'source-layer': 'stops',
        minzoom: 14,
        filter: ['all', ['!=', ['get', 'station'], true], ['!=', ['get', 'rail'], true]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3.5, 17, 6.5],
          'circle-color': P.ink,
          'circle-stroke-color': P.soft,
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'stop-station',
        type: 'circle',
        source: 'network',
        'source-layer': 'stops',
        filter: ['==', ['get', 'station'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 12, 5, 16, 9],
          'circle-color': P.paper,
          'circle-stroke-color': P.ink,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 14, 2],
        },
      });
      // Individual platforms and wharves, once zoomed in far enough to tell them apart.
      map.addLayer({
        id: 'stop-platform',
        type: 'circle',
        source: 'network',
        'source-layer': 'stops',
        minzoom: 14.5,
        filter: ['all', ['!=', ['get', 'station'], true], ['==', ['get', 'rail'], true]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 5, 18, 10],
          'circle-color': P.panel,
          'circle-stroke-color': P.paper,
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'stop-platform-label',
        type: 'symbol',
        source: 'network',
        'source-layer': 'stops',
        minzoom: 15.5,
        filter: ['all', ['!=', ['get', 'station'], true], ['==', ['get', 'rail'], true], ['has', 'platform']],
        layout: {
          'text-field': ['get', 'platform'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': P.paper },
      });
      // Ring around whichever stop the pointer is near, so it is clear what a click will open.
      map.addLayer({
        id: 'stop-hover',
        type: 'circle',
        source: 'network',
        'source-layer': 'stops',
        filter: ['==', ['get', 'stop_id'], -1],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 8, 16, 14],
          'circle-color': 'rgba(76, 194, 255, 0.18)',
          'circle-stroke-color': '#4cc2ff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'stop-station-label',
        type: 'symbol',
        source: 'network',
        'source-layer': 'stops',
        minzoom: 11.5,
        filter: ['==', ['get', 'station'], true],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 0.9],
          'text-anchor': 'top',
          'text-max-width': 8,
        },
        paint: { 'text-color': P.label, 'text-halo-color': P.ink, 'text-halo-width': 1.4 },
      });
      const empty = { type: 'FeatureCollection' as const, features: [] };
      for (const id of ['scenario-lines', 'scenario-stops', 'scenario-closures', 'closing', 'builder']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty });
      for (const id of ['builder-line', 'builder-points', 'closure-fill', 'closure-edge', 'closing-fill', 'closing-edge', 'closing-paths', 'closing-points']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      map.addLayer(
        {
          id: 'line-scenario',
          type: 'line',
          source: 'scenario-lines',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 15, 6] },
        },
        'stop-road',
      );
      // Stops the scenario has added. They are few, so they show at every zoom, in the accent colour.
      map.addLayer({
        id: 'stop-new',
        type: 'circle',
        source: 'scenario-stops',
        filter: ['!=', ['get', 'platform'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 6, 17, 9],
          'circle-color': P.ink,
          'circle-stroke-color': '#4cc2ff',
          'circle-stroke-width': 2.5,
        },
      });
      map.addLayer({
        id: 'stop-new-platform',
        type: 'circle',
        source: 'scenario-stops',
        minzoom: 14.5,
        filter: ['==', ['get', 'platform'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 5, 18, 10],
          'circle-color': P.panel,
          'circle-stroke-color': '#4cc2ff',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'stop-hover-new',
        type: 'circle',
        source: 'scenario-stops',
        filter: ['==', ['get', 'stop_id'], -1],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 8, 16, 14],
          'circle-color': 'rgba(76, 194, 255, 0.18)',
          'circle-stroke-color': '#4cc2ff',
          'circle-stroke-width': 2,
        },
      });
      // Closed roads and lines: those the scenario has made, and the one being set up.
      for (const [id, source, opacity] of [['closure', 'scenario-closures', 0.45], ['closing', 'closing', 0.45]] as const) {
        map.addLayer({
          id: `${id}-fill`,
          type: 'fill',
          source,
          filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
          paint: { 'fill-color': '#ff3b30', 'fill-opacity': opacity },
        });
        map.addLayer({
          id: `${id}-edge`,
          type: 'line',
          source,
          filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
          paint: { 'line-color': '#ff3b30', 'line-width': 3 },
        });
      }
      map.addLayer({
        id: 'closing-paths',
        type: 'line',
        source: 'closing',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffd60a', 'line-width': 3, 'line-opacity': 0.8, 'line-dasharray': [1.5, 1.2] },
      });
      map.addLayer({
        id: 'closing-points',
        type: 'circle',
        source: 'closing',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 7, 'circle-color': '#ff3b30', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
      });
      map.addLayer({
        id: 'builder-line',
        type: 'line',
        source: 'builder',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-dasharray': [1.5, 1.2] },
      });
      map.addLayer({
        id: 'builder-points',
        type: 'circle',
        source: 'builder',
        filter: ['==', ['geometry-type'], 'Point'],
        // Stops being added are large; stops a reshaped line keeps are small; stops taken off it are hollow.
        paint: {
          'circle-radius': ['match', ['get', 'kind'], 'new', 7, 'gone', 5, 4],
          'circle-color': ['match', ['get', 'kind'], 'gone', P.ink, '#ffffff'],
          'circle-stroke-color': ['match', ['get', 'kind'], 'gone', '#8b96a3', ['get', 'color']],
          'circle-stroke-width': ['match', ['get', 'kind'], 'new', 3, 2],
        },
      });
    };
    whenLoaded(add);
  }, [baselineId]);

  // Lines the open scenario has created.
  const scenarioId = useStore((s) => s.scenarioId);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    const show = (source: string, data: GeoJSON.FeatureCollection) =>
      whenLoaded(() => (map.getSource(source) as maplibregl.GeoJSONSource | undefined)?.setData(data));
    for (const [source, what] of [['scenario-lines', 'lines'], ['scenario-stops', 'stops'], ['scenario-closures', 'closures']]) {
      if (scenarioId === null) show(source, { type: 'FeatureCollection', features: [] });
      else
        fetch(`/api/scenarios/${scenarioId}/${what}`)
          .then((r) => r.json())
          .then((data) => !cancelled && show(source, data))
          .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [scenarioId, dataVersion, baselineId]);

  // The line being drawn: a dashed path through the stops picked so far.
  const builder = useStore((s) => s.builder);
  const builderPath = useStore((s) => s.builderPath);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const stops = builder?.stops ?? [];
    const color = `#${builder?.color ?? 'ffffff'}`;
    const reshape = builder?.reshape;
    const original = new Set(reshape?.original.map((s) => s.id));
    const current = new Set(stops.map((s) => s.id));
    const point = (s: { lon: number; lat: number }, kind: string): GeoJSON.Feature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { color, kind },
    });
    const features: GeoJSON.Feature[] = [
      ...(reshape?.original.filter((s) => !current.has(s.id)).map((s) => point(s, 'gone')) ?? []),
      ...stops.map((s) => point(s, !reshape || !original.has(s.id) ? 'new' : 'kept')),
    ];
    const line = (coordinates: number[][]) => features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { color } });
    // The worked-out path when there is one. A new line falls back to straight between its stops;
    // a reshaped line shows nothing until its path is known, since the published line is still drawn.
    if (builderPath) line(builderPath.coords);
    else if (!reshape && stops.length >= 2) line([...stops, ...(builder?.loop && stops.length >= 3 ? [stops[0]] : [])].map((s) => [s.lon, s.lat]));
    if (builderPath?.otherCoords) line(builderPath.otherCoords);
    whenLoaded(() => (map.getSource('builder') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features }));
    map.getCanvas().style.cursor = builder ? 'crosshair' : '';
  }, [builder, builderPath]);

  // The closure being set up: where it is, the area it covers, and where the traffic would go instead.
  const closing = useStore((s) => s.closing);
  const closingPreview = useStore((s) => s.closingPreview);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const features: GeoJSON.Feature[] = [];
    const point = (p: { lon: number; lat: number }) => features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: {} });
    if (closing) {
      if (closingPreview) features.push({ type: 'Feature', geometry: closingPreview.zone, properties: {} });
      for (const coordinates of closingPreview?.paths ?? []) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} });
      if (closing.what === 'road' && closing.point) point(closing.point);
      if (closing.what !== 'road') for (const stop of [closing.from, closing.to]) if (stop) point(stop);
    }
    whenLoaded(() => (map.getSource('closing') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features }));
    if (!closing && !useStore.getState().builder) map.getCanvas().style.cursor = '';
  }, [closing, closingPreview]);

  // Show or hide each mode's lines.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const mode of MODE_ORDER) {
        if (map.getLayer(`line-${mode}`)) {
          map.setLayoutProperty(`line-${mode}`, 'visibility', enabledModes[mode] ? 'visible' : 'none');
        }
      }
    };
    whenLoaded(apply);
    dirtyRef.current = true;
  }, [enabledModes, loadedModes]);

  // Highlight the selected route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const filter: maplibregl.FilterSpecification = ['==', ['get', 'route_id'], highlightRouteId ?? -1];
      if (map.getLayer('sel-glow')) map.setFilter('sel-glow', filter);
      if (map.getLayer('sel-line')) map.setFilter('sel-line', filter);
    };
    whenLoaded(apply);
  }, [highlightRouteId]);

  useEffect(() => {
    dirtyRef.current = true;
  }, [highlightTripId, dataVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitBounds) return;
    map.fitBounds(fitBounds, { padding: { top: 110, bottom: 150, left: 60, right: 480 }, maxZoom: 14, duration: 900 });
  }, [fitBounds]);

  // Animation loop: advance the clock and redraw the vehicles.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let lastSecs = -1;
    let lastCount = -1;
    const ring = new Float64Array(2);

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const elapsed = Math.min(100, now - last);
      last = now;
      const state = useStore.getState();
      if (state.playing) clock.advance(elapsed, state.speed);
      const secs = clock.secs;
      if (secs === lastSecs && !dirtyRef.current) return;
      lastSecs = secs;
      dirtyRef.current = false;

      const layers: ScatterplotLayer[] = [];
      let total = 0;
      let ringAt: [number, number] | null = null;
      // The scenario's own trips are drawn last, on top, with a white edge so edits stand out.
      for (const mode of [...MODE_ORDER, 'scenario']) {
        const mv = vehicleData.get(mode);
        const edited = mode === 'scenario';
        if (!mv || (!edited && !state.enabledModes[mode])) continue;
        const count = computeFrame(mv, secs, state.enabledModes);
        total += count;
        const style = edited ? { radiusM: 90, minPx: 3.6, maxPx: 10 } : VEHICLE_STYLE[mode];
        layers.push(
          new ScatterplotLayer({
            id: `vehicles-${mode}`,
            data: {
              length: count,
              attributes: {
                getPosition: { value: mv.positions.subarray(0, count * 2), size: 2 },
                getFillColor: { value: mv.colors.subarray(0, count * 4), size: 4 },
              },
            },
            getRadius: style.radiusM,
            radiusUnits: 'meters',
            radiusMinPixels: style.minPx,
            radiusMaxPixels: style.maxPx,
            stroked: true,
            getLineColor: edited ? P.bright : P.outline,
            lineWidthUnits: 'pixels',
            getLineWidth: edited ? 1.5 : 1,
            pickable: true,
          }),
        );
        if (state.highlightTripId !== null) {
          const i = mv.indexByTripId.get(state.highlightTripId);
          if (i !== undefined && tripPosition(mv.pack, i, secs, ring, 0)) ringAt = [ring[0], ring[1]];
        }
      }
      if (ringAt) {
        layers.push(
          new ScatterplotLayer({
            id: 'selected-vehicle',
            data: [{ position: ringAt }],
            getPosition: (d: { position: [number, number] }) => d.position,
            getRadius: 13,
            radiusUnits: 'pixels',
            filled: false,
            stroked: true,
            getLineColor: P.bright,
            lineWidthUnits: 'pixels',
            getLineWidth: 3,
            updateTriggers: { getPosition: secs },
          }),
        );
      }
      overlayRef.current?.setProps({ layers });
      if (total !== lastCount) {
        lastCount = total;
        onVehicleCount(total);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [onVehicleCount]);

  return (
    <>
      <div ref={containerRef} className="map" />
      <div ref={tooltipRef} className="map-tooltip" />
    </>
  );
}
