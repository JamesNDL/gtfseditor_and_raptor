// The Access pane's places on the map (docs/architecture/access-analysis.md §5.2, D29, D36): the
// zone being drawn (a dashed outline with its corners and a line on to the pointer), the zone
// picked for the setup with handles to reshape it, and the saved points of interest as pins with
// their names. What is drawn is worked out in analysis-place-features.ts; the tools themselves are
// in analysis/AnalysisMapEditor.tsx. Sources and layers start with 'aa-'. The results of an
// analysis are drawn by use-analysis-result-layers.ts.
import type * as maplibregl from 'maplibre-gl';
import { useEffect, useEffectEvent, type RefObject } from 'react';
import { usePlaces } from '../analysis/analysis-api.ts';
import { useMapDrag } from '../analysis/map-drag.ts';
import { useStore } from '../app/store.ts';
import type { MapPalette } from '../app/theme.ts';
import { placeFeatures } from './analysis-place-features.ts';
import { useMapPalette } from './basemap-choice.ts';

const SOURCE = 'aa-places';
/** The zone's colour, as for a simulation's area. */
const ZONE_COLOUR = '#4cc2ff';
/** Pins picked for the analysis being set up, and one being named. */
const PICKED_COLOUR = '#ff8c1a';
const UNPICKED_COLOUR = '#9aa3ae';

const kind = (k: string): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];

/** The layers, bottom to top. */
function placeLayers(palette: MapPalette): maplibregl.AddLayerObject[] {
  const pinColour: maplibregl.ExpressionSpecification = [
    'case',
    ['get', 'picked'],
    PICKED_COLOUR,
    UNPICKED_COLOUR,
  ];
  const dot = (
    id: string,
    k: string,
    paint: maplibregl.CircleLayerSpecification['paint'],
  ): maplibregl.AddLayerObject => ({ id, type: 'circle', source: SOURCE, filter: kind(k), paint });
  return [
    {
      id: 'aa-zone-fill',
      type: 'fill',
      source: SOURCE,
      filter: kind('zone'),
      paint: { 'fill-color': ZONE_COLOUR, 'fill-opacity': 0.1 },
    },
    {
      id: 'aa-zone-edge',
      type: 'line',
      source: SOURCE,
      filter: kind('zone'),
      paint: { 'line-color': ZONE_COLOUR, 'line-width': 2.5 },
    },
    {
      id: 'aa-draft',
      type: 'line',
      source: SOURCE,
      filter: kind('draft'),
      paint: { 'line-color': ZONE_COLOUR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'aa-rubber',
      type: 'line',
      source: SOURCE,
      filter: kind('rubber'),
      paint: { 'line-color': ZONE_COLOUR, 'line-width': 1.5, 'line-dasharray': [1, 1.5] },
    },
    // A side's middle: a small hollow dot that adds a corner when dragged.
    dot('aa-middles', 'middle', {
      'circle-radius': 4,
      'circle-color': palette.ink,
      'circle-opacity': 0.7,
      'circle-stroke-color': ZONE_COLOUR,
      'circle-stroke-width': 1.5,
    }),
    // A saved zone's corner: a solid handle to drag.
    dot('aa-handles', 'handle', {
      'circle-radius': 5.5,
      'circle-color': ZONE_COLOUR,
      'circle-stroke-color': palette.ink,
      'circle-stroke-width': 2,
    }),
    dot('aa-corners', 'corner', {
      'circle-radius': ['case', ['get', 'first'], 7, 4.5],
      'circle-color': palette.ink,
      'circle-stroke-color': ZONE_COLOUR,
      'circle-stroke-width': 2,
    }),
    dot('aa-pois', 'poi', {
      'circle-radius': 8,
      'circle-color': pinColour,
      'circle-stroke-color': palette.ink,
      'circle-stroke-width': 2.5,
    }),
    {
      id: 'aa-poi-names',
      type: 'symbol',
      source: SOURCE,
      filter: kind('poi'),
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12.5,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-max-width': 10,
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': palette.label,
        'text-halo-color': palette.ink,
        'text-halo-width': 1.6,
      },
    },
  ];
}

/** Draws the Access pane's places. */
export function useAnalysisLayers(
  mapRef: RefObject<maplibregl.Map | null>,
  whenLoaded: (fn: () => void) => void,
): void {
  const palette = useMapPalette();
  const paneOpen = useStore((s) => s.leftPane === 'analysis');
  const view = useStore((s) => s.analysis);
  const zones = usePlaces((s) => s.zones);
  const pois = usePlaces((s) => s.pois);
  const drag = useMapDrag();
  // The map's helper is made afresh on each render; drawing should not rerun because of that.
  const onceLoaded = useEffectEvent(whenLoaded);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = paneOpen && view.screen === 'setup';
    onceLoaded(() => {
      const layers = placeLayers(palette);
      if (!map.getSource(SOURCE)) {
        map.addSource(SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        for (const layer of layers) map.addLayer(layer);
      }
      // Layers the network adds later (a day chosen again) would cover these: keep them on top.
      for (const layer of layers) map.moveLayer(layer.id);
      (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shown ? placeFeatures(view, zones, pois, drag) : [],
      });
    });
  }, [mapRef, paneOpen, view, zones, pois, drag, palette]);
}
