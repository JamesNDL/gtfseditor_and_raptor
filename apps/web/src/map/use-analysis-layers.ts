// The Access pane's places on the map (docs/architecture/access-analysis.md §5.2, D29): the zone
// being drawn (a dashed outline with its corners), the zone picked for the setup, and the saved
// points of interest as pins with their names. While a zone is drawn or a point of interest placed
// or moved, the pointer is a cross, a double click does not zoom, and Escape stops it. Sources and
// layers start with 'aa-'. The results of an analysis are drawn by AA-20's own hook.
import type { GeoJsonPosition, PointOfInterest, Zone } from '@gtfs-editor/core';
import type * as maplibregl from 'maplibre-gl';
import { useEffect, useEffectEvent, type RefObject } from 'react';
import { usePlaces } from '../analysis/analysis-api.ts';
import { cancelMapWork, isMapBusy, type AnalysisView } from '../analysis/analysis-state.ts';
import { useStore } from '../app/store.ts';
import { MAP_PALETTE, type MapPalette } from '../app/theme.ts';

const SOURCE = 'aa-places';
/** The zone's colour, as for a simulation's area. */
const ZONE_COLOUR = '#4cc2ff';
/** Pins picked for the analysis being set up, and the one being moved. */
const PICKED_COLOUR = '#ff8c1a';
const UNPICKED_COLOUR = '#9aa3ae';

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | boolean>>;

const point = (coordinates: GeoJsonPosition, properties: Feature['properties']): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties,
});

/** What the setup shows on the map: the picked zone, the zone being drawn and the pins. */
function placeFeatures(
  view: AnalysisView,
  zones: Zone[] | null,
  pois: PointOfInterest[] | null,
): Feature[] {
  const features: Feature[] = [];
  const zone = zones?.find((z) => z.id === view.setup.zoneId);
  if (zone && view.drawing === null) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...zone.ring, zone.ring[0]]] },
      properties: { kind: 'zone' },
    });
  }
  const corners = view.drawing ?? [];
  if (corners.length >= 2) {
    const line = view.drawingClosed ? [...corners, corners[0]] : corners;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line },
      properties: { kind: 'draft' },
    });
  }
  corners.forEach((corner, i) => features.push(point(corner, { kind: 'corner', first: i === 0 })));
  for (const poi of pois ?? []) {
    const picked = view.setup.poiIds.includes(poi.id) || view.movingPoiId === poi.id;
    features.push(point([poi.lon, poi.lat], { kind: 'poi', name: poi.name, picked }));
  }
  return features;
}

const kind = (k: string): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];

/** Adds the source and layers once per map. */
function addLayers(map: maplibregl.Map, palette: MapPalette): void {
  map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const pinColour: maplibregl.ExpressionSpecification = [
    'case',
    ['get', 'picked'],
    PICKED_COLOUR,
    UNPICKED_COLOUR,
  ];
  const layers: maplibregl.AddLayerObject[] = [
    {
      id: 'aa-zone-fill',
      type: 'fill',
      source: SOURCE,
      filter: kind('zone'),
      paint: { 'fill-color': ZONE_COLOUR, 'fill-opacity': 0.08 },
    },
    {
      id: 'aa-zone-edge',
      type: 'line',
      source: SOURCE,
      filter: kind('zone'),
      paint: { 'line-color': ZONE_COLOUR, 'line-width': 2 },
    },
    {
      id: 'aa-draft',
      type: 'line',
      source: SOURCE,
      filter: kind('draft'),
      paint: { 'line-color': ZONE_COLOUR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'aa-corners',
      type: 'circle',
      source: SOURCE,
      filter: kind('corner'),
      paint: {
        'circle-radius': ['case', ['get', 'first'], 6, 4],
        'circle-color': palette.ink,
        'circle-stroke-color': ZONE_COLOUR,
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'aa-pois',
      type: 'circle',
      source: SOURCE,
      filter: kind('poi'),
      paint: {
        'circle-radius': 7,
        'circle-color': pinColour,
        'circle-stroke-color': palette.ink,
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'aa-poi-names',
      type: 'symbol',
      source: SOURCE,
      filter: kind('poi'),
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-max-width': 10,
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': palette.label,
        'text-halo-color': palette.ink,
        'text-halo-width': 1.4,
      },
    },
  ];
  for (const layer of layers) map.addLayer(layer);
}

const LAYER_IDS = [
  'aa-zone-fill',
  'aa-zone-edge',
  'aa-draft',
  'aa-corners',
  'aa-pois',
  'aa-poi-names',
];

/** Draws the Access pane's places, and handles the map while drawing or placing. */
export function useAnalysisLayers(
  mapRef: RefObject<maplibregl.Map | null>,
  whenLoaded: (fn: () => void) => void,
): void {
  const theme = useStore((s) => s.theme);
  const paneOpen = useStore((s) => s.leftPane === 'analysis');
  const view = useStore((s) => s.analysis);
  const zones = usePlaces((s) => s.zones);
  const pois = usePlaces((s) => s.pois);
  const busy = isMapBusy(view);
  // The map's helper is made afresh on each render; drawing should not rerun because of that.
  const onceLoaded = useEffectEvent(whenLoaded);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = paneOpen && view.screen === 'setup';
    onceLoaded(() => {
      if (!map.getSource(SOURCE)) addLayers(map, MAP_PALETTE[theme]);
      // Layers the network adds later (a day chosen again) would cover these: keep them on top.
      for (const id of LAYER_IDS) map.moveLayer(id);
      (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shown ? placeFeatures(view, zones, pois) : [],
      });
    });
  }, [mapRef, paneOpen, view, zones, pois, theme]);

  // Folding the pane away stops the map work, so that clicks on the map work as usual again.
  useEffect(() => {
    if (busy && !paneOpen) {
      const { analysis, set } = useStore.getState();
      set({ analysis: cancelMapWork(analysis) });
    }
  }, [busy, paneOpen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !busy) return;
    const canvas = map.getCanvas();
    // The map's own pointer handler sets the cursor first; this runs after it.
    const cross = () => (canvas.style.cursor = 'crosshair');
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const { analysis, set } = useStore.getState();
      set({ analysis: cancelMapWork(analysis) });
    };
    map.doubleClickZoom.disable();
    cross();
    map.on('mousemove', cross);
    window.addEventListener('keydown', escape);
    return () => {
      map.doubleClickZoom.enable();
      map.off('mousemove', cross);
      canvas.style.cursor = '';
      window.removeEventListener('keydown', escape);
    };
  }, [mapRef, busy]);
}
