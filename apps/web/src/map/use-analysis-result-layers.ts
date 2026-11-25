// An open analysis's results on the map (FR-14, FR-12, FR-19; docs/architecture/access-analysis.md
// §5.2): the bands of equal access ratio, the lines with their ratio as labels, no service and no
// road points in their own styles, the zone's outline and the points of interest, for the point of
// interest on show. The sources carry the OpenStreetMap credit, so the map's own credit line shows
// it while the results are on screen. Sources and layers start with 'aa-'.
import type * as maplibregl from 'maplibre-gl';
import { useEffect, useEffectEvent, useRef, type RefObject } from 'react';
import {
  BAND_OPACITY,
  LINE_COLOUR,
  LINE_WIDTH_PX,
  NO_ROAD_COLOUR,
  NO_SERVICE_COLOUR,
  NO_SERVICE_RING,
  bandColours,
} from '../analysis/analysis-colours.ts';
import { useAnalysisResults } from '../analysis/analysis-results.ts';
import { useStore } from '../app/store.ts';
import { MAP_PALETTE, type MapPalette } from '../app/theme.ts';
import { useAnalysisPointLayers } from './use-analysis-point-layers.ts';

const BANDS = 'aa-bands';
const LINES = 'aa-lines';
const POINTS = 'aa-points';
/** The drive times come from OpenStreetMap's roads (FR-19, A4). */
const CREDIT = '© OpenStreetMap contributors';
/** As the zone and the picked pin are drawn in the setup (use-analysis-layers.ts). */
const ZONE_COLOUR = '#4cc2ff';
const POI_COLOUR = '#ff8c1a';
const OTHER_POI_COLOUR = '#9aa3ae';

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | number | boolean>>;
type Results = ReturnType<typeof useAnalysisResults.getState>;

const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features,
});

/** The bands, coloured well served to poorly served in the order the API gives them. */
function bandFeatures({ lines }: Results): Feature[] {
  const bands = lines?.bands.features ?? [];
  const colours = bandColours(bands.length);
  return bands.map((band, k) => ({
    type: 'Feature',
    geometry: band.geometry,
    properties: { colour: colours[k] ?? NO_SERVICE_COLOUR },
  }));
}

/** The lines of equal ratio, and the zone's outline. */
function lineFeatures({ detail, lines }: Results): Feature[] {
  const features: Feature[] = (lines?.lines.features ?? []).map((line) => ({
    type: 'Feature',
    geometry: line.geometry,
    properties: { kind: 'ratio', ratio: line.properties.ratio },
  }));
  const ring = detail?.zone.ring ?? [];
  if (ring.length > 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [...ring, ring[0]] },
      properties: { kind: 'zone' },
    });
  }
  return features;
}

/** No service and no road sample points, and the analysis's points of interest. */
function pointFeatures({ detail, points }: Results, poiSeq: number): Feature[] {
  const features: Feature[] = [];
  for (const sample of points?.features ?? []) {
    const { status } = sample.properties;
    if (status === 'noService' || status === 'noRoad') {
      features.push({ type: 'Feature', geometry: sample.geometry, properties: { kind: status } });
    }
  }
  for (const poi of detail?.pois ?? []) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
      properties: { kind: 'poi', name: poi.name, shown: poi.seq === poiSeq },
    });
  }
  return features;
}

const kind = (k: string): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];

/** The layers, bottom to top. */
function layers(palette: MapPalette): maplibregl.AddLayerObject[] {
  return [
    {
      id: 'aa-band-fill',
      type: 'fill',
      source: BANDS,
      // Neighbouring band pieces share edges; antialiasing would show thin seams between them.
      paint: {
        'fill-color': ['get', 'colour'],
        'fill-opacity': BAND_OPACITY,
        'fill-antialias': false,
      },
    },
    {
      id: 'aa-zone-outline',
      type: 'line',
      source: LINES,
      filter: kind('zone'),
      paint: { 'line-color': ZONE_COLOUR, 'line-width': 2 },
    },
    {
      id: 'aa-ratio-lines',
      type: 'line',
      source: LINES,
      filter: kind('ratio'),
      paint: { 'line-color': LINE_COLOUR, 'line-width': LINE_WIDTH_PX },
    },
    {
      id: 'aa-ratio-labels',
      type: 'symbol',
      source: LINES,
      filter: kind('ratio'),
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 220,
        'text-field': ['to-string', ['get', 'ratio']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
      },
      paint: { 'text-color': LINE_COLOUR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
    },
    {
      id: 'aa-no-service',
      type: 'circle',
      source: POINTS,
      filter: kind('noService'),
      paint: {
        'circle-radius': 3.5,
        'circle-color': NO_SERVICE_COLOUR,
        'circle-stroke-color': NO_SERVICE_RING,
        'circle-stroke-width': 1.2,
      },
    },
    {
      id: 'aa-no-road',
      type: 'circle',
      source: POINTS,
      filter: kind('noRoad'),
      paint: {
        'circle-radius': 3.5,
        'circle-opacity': 0,
        'circle-stroke-color': NO_ROAD_COLOUR,
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: 'aa-result-pois',
      type: 'circle',
      source: POINTS,
      filter: kind('poi'),
      paint: {
        'circle-radius': ['case', ['get', 'shown'], 8, 6],
        'circle-color': ['case', ['get', 'shown'], POI_COLOUR, OTHER_POI_COLOUR],
        'circle-stroke-color': palette.ink,
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'aa-result-poi-names',
      type: 'symbol',
      source: POINTS,
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
}

const LAYER_IDS = [
  'aa-band-fill',
  'aa-zone-outline',
  'aa-ratio-lines',
  'aa-ratio-labels',
  'aa-no-service',
  'aa-no-road',
  'aa-result-pois',
  'aa-result-poi-names',
];

/** Adds the sources and layers once per map. */
function addLayers(map: maplibregl.Map, palette: MapPalette): void {
  for (const id of [BANDS, LINES, POINTS]) {
    map.addSource(id, { type: 'geojson', data: collection([]), attribution: CREDIT });
  }
  for (const layer of layers(palette)) map.addLayer(layer);
}

/** Room left round the zone when the map moves to it: the pane on the left, the time bar below. */
const FIT_PADDING = { left: 430, right: 60, top: 90, bottom: 150 };

/** Moves the map to the zone of an analysis just opened. */
function fitZone(map: maplibregl.Map, ring: readonly (readonly [number, number])[]): void {
  if (ring.length < 3) return;
  const lons = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  map.fitBounds(
    [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ],
    { padding: FIT_PADDING, maxZoom: 15, duration: 600 },
  );
}

/** Draws the open analysis's results while the Access pane shows them. */
export function useAnalysisResultLayers(
  mapRef: RefObject<maplibregl.Map | null>,
  whenLoaded: (fn: () => void) => void,
): void {
  const theme = useStore((s) => s.theme);
  const paneOpen = useStore((s) => s.leftPane === 'analysis');
  const screen = useStore((s) => s.analysis.screen);
  const openId = useStore((s) => s.analysis.openId);
  const poiSeq = useStore((s) => s.analysis.poiSeq);
  const results = useAnalysisResults();
  const fitted = useRef<number | null>(null);
  // The map's helper is made afresh on each render; drawing should not rerun because of that.
  const onceLoaded = useEffectEvent(whenLoaded);

  const detail = results.detail;
  const shown = paneOpen && screen === 'results' && detail !== null && detail.id === openId;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    onceLoaded(() => {
      if (!map.getSource(BANDS)) addLayers(map, MAP_PALETTE[theme]);
      // Layers the network adds later (a day chosen again) would cover these: keep them on top.
      for (const id of LAYER_IDS) {
        map.moveLayer(id);
        // Hidden layers also take the credit off the map's credit line.
        map.setLayoutProperty(id, 'visibility', shown ? 'visible' : 'none');
      }
      const data: [string, Feature[]][] = [
        [BANDS, shown ? bandFeatures(results) : []],
        [LINES, shown ? lineFeatures(results) : []],
        [POINTS, shown ? pointFeatures(results, poiSeq) : []],
      ];
      for (const [id, features] of data) {
        map.getSource<maplibregl.GeoJSONSource>(id)?.setData(collection(features));
      }
      if (shown && fitted.current !== detail.id) {
        fitted.current = detail.id;
        fitZone(map, detail.zone.ring);
      }
      if (!shown && openId === null) fitted.current = null;
    });
  }, [mapRef, shown, detail, openId, poiSeq, results, theme]);
  // Called after the effect above, so the picked point's layers go on top of these.
  useAnalysisPointLayers(mapRef, whenLoaded, shown);
}
