// Two analyses compared on the map (FR-17, AC-FR-17.1; docs/architecture/access-analysis.md §5.2
// 'Colours', §5.3): each sample point coloured by how its access ratio changed (greens better,
// orange to red worse), gained service in a green ring and lost service in a red ring, with the
// zone's outline and the point of interest compared for. Drawn while the Access pane shows the
// compare screen; the results' own layers (use-analysis-result-layers.ts) are hidden meanwhile.
// Sources and layers start with 'aa-compare-'.
import type * as maplibregl from 'maplibre-gl';
import { useEffect, useEffectEvent, type RefObject } from 'react';
import { compareStyle } from '../analysis/analysis-colours.ts';
import { useComparison } from '../analysis/analysis-compare.ts';
import { useAnalysisResults } from '../analysis/analysis-results.ts';
import { useStore } from '../app/store.ts';
import type { MapPalette } from '../app/theme.ts';
import { useMapPalette } from './basemap-choice.ts';

const ZONE = 'aa-compare-zone';
const POINTS = 'aa-compare-points';
/** The drive times come from OpenStreetMap's roads (FR-19, A4). */
const CREDIT = '© OpenStreetMap contributors';
/** As the results draw the zone and the point of interest on show (use-analysis-result-layers.ts). */
const ZONE_COLOUR = '#4cc2ff';
const POI_COLOUR = '#ff8c1a';
/** A filled point with no ring of its own gets a faint edge, so pale yellow shows on a light map. */
const EDGE = 'rgba(0, 0, 0, 0.35)';

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | number | boolean>>;

const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features,
});

/** The compared sample points, styled by their change, and the point of interest on top. */
function pointFeatures(
  result: ReturnType<typeof useComparison.getState>['result'],
  poi: { name: string; lon: number; lat: number } | undefined,
): Feature[] {
  const features: Feature[] = (result?.points.features ?? []).map((point) => {
    const { fill, ring } = compareStyle(point.properties.kind, point.properties.change);
    return {
      type: 'Feature',
      geometry: point.geometry,
      properties: {
        kind: 'point',
        fill: fill ?? '#000000',
        hollow: fill === null,
        ring: ring ?? EDGE,
        ringWidth: fill === null ? 2.2 : ring === null ? 0.6 : 1.2,
      },
    };
  });
  if (poi) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
      properties: { kind: 'poi', name: poi.name },
    });
  }
  return features;
}

const kind = (k: string): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];

/** The layers, bottom to top. */
function layers(palette: MapPalette): maplibregl.AddLayerObject[] {
  return [
    {
      id: 'aa-compare-zone-line',
      type: 'line',
      source: ZONE,
      paint: { 'line-color': ZONE_COLOUR, 'line-width': 2 },
    },
    {
      id: 'aa-compare-point-dots',
      type: 'circle',
      source: POINTS,
      filter: kind('point'),
      paint: {
        'circle-radius': ['case', ['get', 'hollow'], 5, 4.5],
        'circle-color': ['get', 'fill'],
        'circle-opacity': ['case', ['get', 'hollow'], 0, 1],
        'circle-stroke-color': ['get', 'ring'],
        'circle-stroke-width': ['get', 'ringWidth'],
      },
    },
    {
      id: 'aa-compare-poi',
      type: 'circle',
      source: POINTS,
      filter: kind('poi'),
      paint: {
        'circle-radius': 8,
        'circle-color': POI_COLOUR,
        'circle-stroke-color': palette.ink,
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'aa-compare-poi-name',
      type: 'symbol',
      source: POINTS,
      filter: kind('poi'),
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
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
  'aa-compare-zone-line',
  'aa-compare-point-dots',
  'aa-compare-poi',
  'aa-compare-poi-name',
];

/** Adds the sources and layers once per map. */
function addLayers(map: maplibregl.Map, palette: MapPalette): void {
  for (const id of [ZONE, POINTS]) {
    map.addSource(id, { type: 'geojson', data: collection([]), attribution: CREDIT });
  }
  for (const layer of layers(palette)) map.addLayer(layer);
}

/** Draws the comparison while the Access pane shows it. */
export function useAnalysisCompareLayers(
  mapRef: RefObject<maplibregl.Map | null>,
  whenLoaded: (fn: () => void) => void,
): void {
  const palette = useMapPalette();
  const paneOpen = useStore((s) => s.leftPane === 'analysis');
  const screen = useStore((s) => s.analysis.screen);
  const openId = useStore((s) => s.analysis.openId);
  const poiSeq = useStore((s) => s.analysis.poiSeq);
  const detail = useAnalysisResults((r) => r.detail);
  const result = useComparison((c) => c.result);
  // The map's helper is made afresh on each render; drawing should not rerun because of that.
  const onceLoaded = useEffectEvent(whenLoaded);

  const shown = paneOpen && screen === 'compare' && detail !== null && detail.id === openId;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    onceLoaded(() => {
      if (!map.getSource(POINTS)) addLayers(map, palette);
      for (const id of LAYER_IDS) {
        map.moveLayer(id);
        // Hidden layers also take the credit off the map's credit line.
        map.setLayoutProperty(id, 'visibility', shown ? 'visible' : 'none');
      }
      const ring = shown ? detail.zone.ring : [];
      const zone: Feature[] =
        ring.length > 2
          ? [
              {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: [...ring, ring[0]] },
                properties: {},
              },
            ]
          : [];
      const poi = shown ? detail.pois.find((p) => p.seq === poiSeq) : undefined;
      map.getSource<maplibregl.GeoJSONSource>(ZONE)?.setData(collection(zone));
      map
        .getSource<maplibregl.GeoJSONSource>(POINTS)
        ?.setData(collection(shown ? pointFeatures(result, poi) : []));
    });
  }, [mapRef, shown, detail, poiSeq, result, palette]);
}
