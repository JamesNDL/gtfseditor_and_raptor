// The picked sample point on the results map (FR-15, D30; docs/architecture/access-analysis.md
// §5.2): a ring round the point, its public transport journey as straight lines between leg ends
// (rides in their mode colour and labelled with the line, walks dotted) and the car path dashed.
// Drawn above the other results layers (use-analysis-result-layers.ts), which call this hook.
// Sources and layers start with 'aa-'.
import type * as maplibregl from 'maplibre-gl';
import { useEffect, useEffectEvent, type RefObject } from 'react';
import { useAnalysisResults } from '../analysis/analysis-results.ts';
import { isDetailFor, usePointDetail } from '../analysis/point-detail.ts';
import { journeyPieces, modeLook } from '../analysis/point-journey.ts';
import { useStore } from '../app/store.ts';

const JOURNEY = 'aa-journey';
const PICKED = 'aa-picked';
/** The car path's colour: strong on both basemaps, and unlike any band. */
const CAR_COLOUR = '#c2185b';
const WALK_COLOUR = '#4a4f57';
const PICK_COLOUR = '#ff8c1a';

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string>>;

const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features,
});

const kind = (k: string): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];

const LAYERS: maplibregl.AddLayerObject[] = [
  {
    id: 'aa-car-path',
    type: 'line',
    source: JOURNEY,
    filter: kind('car'),
    layout: { 'line-join': 'round' },
    paint: { 'line-color': CAR_COLOUR, 'line-width': 3, 'line-dasharray': [2, 1.5] },
  },
  {
    id: 'aa-walk',
    type: 'line',
    source: JOURNEY,
    filter: kind('walk'),
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': WALK_COLOUR, 'line-width': 3, 'line-dasharray': [0.1, 1.8] },
  },
  {
    id: 'aa-ride-casing',
    type: 'line',
    source: JOURNEY,
    filter: kind('ride'),
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 7 },
  },
  {
    id: 'aa-ride',
    type: 'line',
    source: JOURNEY,
    filter: kind('ride'),
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'colour'], 'line-width': 4 },
  },
  {
    id: 'aa-ride-labels',
    type: 'symbol',
    source: JOURNEY,
    filter: kind('ride'),
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#1b2330', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  },
  {
    id: 'aa-picked',
    type: 'circle',
    source: PICKED,
    paint: {
      'circle-radius': 7,
      'circle-opacity': 0,
      'circle-stroke-color': PICK_COLOUR,
      'circle-stroke-width': 3,
    },
  },
];

/** Draws the picked sample point, its journey and its car path while its detail is open. */
export function useAnalysisPointLayers(
  mapRef: RefObject<maplibregl.Map | null>,
  whenLoaded: (fn: () => void) => void,
  resultsShown: boolean,
): void {
  const openId = useStore((s) => s.analysis.openId);
  const poiSeq = useStore((s) => s.analysis.poiSeq);
  const pointSeq = useStore((s) => s.analysis.pointSeq);
  const modes = useStore((s) => s.modes);
  const shown = usePointDetail();
  // The other results layers are moved to the top when these change; these go back above them.
  const results = useAnalysisResults();
  const onceLoaded = useEffectEvent(whenLoaded);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const key = openId !== null && pointSeq !== null ? { id: openId, poiSeq, seq: pointSeq } : null;
    const detail = resultsShown && isDetailFor(shown, key) ? shown.detail : null;
    const poi = results.detail?.pois.find((p) => p.seq === poiSeq);
    // The ring shows at once, before the detail arrives.
    const sample = resultsShown
      ? results.points?.features.find((f) => f.properties.seq === pointSeq)
      : undefined;
    onceLoaded(() => {
      if (!map.getSource(JOURNEY)) {
        for (const id of [JOURNEY, PICKED]) {
          map.addSource(id, { type: 'geojson', data: collection([]) });
        }
        for (const layer of LAYERS) map.addLayer(layer);
      }
      for (const { id } of LAYERS) {
        map.moveLayer(id);
        map.setLayoutProperty(id, 'visibility', resultsShown ? 'visible' : 'none');
      }
      const pieces = detail && poi ? journeyPieces(detail, poi, (m) => modeLook(modes, m)) : [];
      const journey: Feature[] = pieces.map((p) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: p.line },
        properties: { kind: p.kind, colour: p.colour ?? '', label: p.label ?? '' },
      }));
      const picked: Feature[] = sample
        ? [{ type: 'Feature', geometry: sample.geometry, properties: {} }]
        : [];
      map.getSource<maplibregl.GeoJSONSource>(JOURNEY)?.setData(collection(journey));
      map.getSource<maplibregl.GeoJSONSource>(PICKED)?.setData(collection(picked));
    });
  }, [mapRef, resultsShown, openId, poiSeq, pointSeq, modes, shown, results]);
}
