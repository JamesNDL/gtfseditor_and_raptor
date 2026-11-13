import { ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { tripPosition } from '@gtfs-editor/core';
import * as maplibregl from 'maplibre-gl';
// MapLibre finds its worker relative to its own file, which bundlers move; hand it the bundled URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useRef } from 'react';
import { clock } from './clock.ts';
import { useStore } from './store.ts';
import { computeFrame, vehicleData } from './vehicles.ts';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const SYDNEY: [number, number] = [151.12, -33.87];

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

  const baselineId = useStore((s) => s.baselineId);
  const enabledModes = useStore((s) => s.enabledModes);
  const loadedModes = useStore((s) => s.loadedModes);
  const highlightRouteId = useStore((s) => s.highlightRouteId);
  const highlightTripId = useStore((s) => s.highlightTripId);
  const fitBounds = useStore((s) => s.fitBounds);
  const dataVersion = useStore((s) => s.dataVersion);

  // Create the map once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: BASEMAP_STYLE,
      center: SYDNEY,
      zoom: 10.2,
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
    const STOP_LAYERS = ['stop-station', 'stop-platform', 'stop-road'];
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
    };

    map.on('click', (e) => {
      const { open, close, openTimeline } = useStore.getState();
      // While a new line is being drawn, clicks pick its stops and nothing else.
      const { builder, set } = useStore.getState();
      if (builder) {
        const stop = stopAt(e.point.x, e.point.y);
        const last = builder.stops[builder.stops.length - 1];
        if (stop && stop.id !== last?.id) {
          set({ builder: { ...builder, stops: [...builder.stops, { id: stop.id, name: stop.name, lon: stop.lon, lat: stop.lat }] } });
        }
        return;
      }
      const target = targetAt(e.point.x, e.point.y);
      if (target?.kind === 'vehicle') return open({ kind: 'trip', id: target.tripId }, { replace: true });
      if (target?.kind === 'stop') {
        return openTimeline({ tab: 'platforms', stationId: target.id, focusStopId: target.isStation ? null : target.id });
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
      const drawing = useStore.getState().builder !== null;
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
        text = drawing ? `${target.name} · click to add to the new line` : `${target.name} · click for ${target.isStation ? 'platforms' : 'timetable'}`;
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
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
      loadedRef.current = false;
    };
  }, []);

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
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 15, 11] },
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
          'circle-color': '#0e1116',
          'circle-stroke-color': '#b6c0cc',
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
          'circle-color': '#f4f6f8',
          'circle-stroke-color': '#0e1116',
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
          'circle-color': '#1c2027',
          'circle-stroke-color': '#f4f6f8',
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
        paint: { 'text-color': '#f4f6f8' },
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
        paint: { 'text-color': '#dfe5ec', 'text-halo-color': '#0e1116', 'text-halo-width': 1.4 },
      });
      const empty = { type: 'FeatureCollection' as const, features: [] };
      for (const id of ['scenario-lines', 'builder']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty });
      for (const id of ['builder-line', 'builder-points']) if (map.getLayer(id)) map.removeLayer(id);
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
        paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 },
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
    const show = (data: GeoJSON.FeatureCollection) =>
      whenLoaded(() => (map.getSource('scenario-lines') as maplibregl.GeoJSONSource | undefined)?.setData(data));
    if (scenarioId === null) show({ type: 'FeatureCollection', features: [] });
    else
      fetch(`/api/scenarios/${scenarioId}/lines`)
        .then((r) => r.json())
        .then((data) => !cancelled && show(data))
        .catch(() => {});
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
    const features: GeoJSON.Feature[] = stops.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { color },
    }));
    if (stops.length >= 2) {
      // The worked-out road path when there is one, otherwise straight between the stops.
      const coordinates = builderPath?.coords ?? stops.map((s) => [s.lon, s.lat]);
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { color } });
    }
    whenLoaded(() => (map.getSource('builder') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features }));
    map.getCanvas().style.cursor = builder ? 'crosshair' : '';
  }, [builder, builderPath]);

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
            getLineColor: edited ? [255, 255, 255, 255] : [8, 10, 14, 255],
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
            getLineColor: [255, 255, 255, 255],
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
