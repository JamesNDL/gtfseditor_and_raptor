// What the Access pane's setup draws: the picked zone with its handles (none while a tool is in
// use), the outline being drawn with its line to the pointer, and the pins, dragged or waiting.
import type { GeoJsonPosition, PointOfInterest, Zone } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import { defaultAnalysisView, type AnalysisView } from '../analysis/analysis-state.ts';
import type { MapDrag } from '../analysis/map-drag.ts';
import { NO_MAP_WORK, addCorner, dropPoi, pickTool, type MapWork } from '../analysis/map-work.ts';
import { placeFeatures } from './analysis-place-features.ts';

const SQUARE: GeoJsonPosition[] = [
  [151.2, -33.9],
  [151.21, -33.9],
  [151.21, -33.89],
  [151.2, -33.89],
];
const ZONES: Zone[] = [{ id: 5, name: 'Centre', ring: SQUARE, createdAt: '2026-11-26T00:00:00Z' }];
const POIS: PointOfInterest[] = [
  { id: 3, name: 'Library', kind: 'place', source: 'drawn', lon: 151.3, lat: -33.8 },
];
const NO_DRAG: MapDrag = { pointer: null, poi: null, zone: null };

const setup = (work: MapWork = NO_MAP_WORK): AnalysisView => {
  const view = defaultAnalysisView();
  return { ...view, screen: 'setup', work, setup: { ...view.setup, zoneId: 5, poiIds: [3] } };
};
const kinds = (view: AnalysisView, drag = NO_DRAG): string[] =>
  placeFeatures(view, ZONES, POIS, drag).map((f) => String(f.properties.kind));

describe('placeFeatures', () => {
  it('draws the picked zone with a handle at each corner and mid-side, and the pins', () => {
    expect(kinds(setup())).toEqual([
      'zone',
      ...Array<string>(4).fill('middle'),
      ...Array<string>(4).fill('handle'),
      'poi',
    ]);
  });

  it('hides the handles while a tool is in use, and the picked zone while drawing', () => {
    expect(kinds(setup(pickTool(NO_MAP_WORK, 'poi')))).toEqual(['zone', 'poi']);
    expect(kinds(setup(pickTool(NO_MAP_WORK, 'zone')))).toEqual(['poi']);
  });

  it('draws the outline being drawn and a line from its last corner to the pointer', () => {
    let work = pickTool(NO_MAP_WORK, 'zone');
    work = addCorner(addCorner(work, SQUARE[0]), SQUARE[1]);
    const drag: MapDrag = { ...NO_DRAG, pointer: [151.21, -33.885] };
    const features = placeFeatures(setup(work), ZONES, POIS, drag);
    const rubber = features.find((f) => f.properties.kind === 'rubber');
    expect(rubber?.geometry).toEqual({
      type: 'LineString',
      coordinates: [SQUARE[1], [151.21, -33.885]],
    });
    expect(features.filter((f) => f.properties.kind === 'corner')).toHaveLength(2);
  });

  it('draws a zone and a pin where they are being dragged to', () => {
    const moved: GeoJsonPosition[] = [SQUARE[0], SQUARE[1], [151.22, -33.88], SQUARE[3]];
    const drag: MapDrag = {
      pointer: null,
      poi: { id: 3, at: [151.4, -33.7] },
      zone: { id: 5, ring: moved },
    };
    const features = placeFeatures(setup(), ZONES, POIS, drag);
    expect(features[0].geometry).toEqual({ type: 'Polygon', coordinates: [[...moved, moved[0]]] });
    expect(features.at(-1)?.geometry).toEqual({ type: 'Point', coordinates: [151.4, -33.7] });
  });

  it('draws the new pin waiting for its name', () => {
    const work = dropPoi(pickTool(NO_MAP_WORK, 'poi'), [151.25, -33.85]);
    const last = placeFeatures(setup(work), ZONES, POIS, NO_DRAG).at(-1);
    expect(last?.geometry).toEqual({ type: 'Point', coordinates: [151.25, -33.85] });
    expect(last?.properties).toEqual({ kind: 'poi', name: '', picked: true });
  });
});
