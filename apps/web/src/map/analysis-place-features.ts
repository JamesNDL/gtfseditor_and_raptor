// What the Access pane's setup draws on the map, as GeoJSON for map/use-analysis-layers.ts: the
// picked zone (where it is being dragged to, if it is) with its corner and mid-side handles, the
// zone being drawn with the line on to the pointer, and the pins (a dragged one where it is, and
// one waiting for its name).
import type { GeoJsonPosition, PointOfInterest, Zone } from '@gtfs-editor/core';
import type { MapDrag } from '../analysis/map-drag.ts';
import type { AnalysisView } from '../analysis/analysis-state.ts';
import { edgeMiddles } from '../analysis/zone-edit.ts';

export type PlaceFeature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | boolean>>;

const point = (
  coordinates: GeoJsonPosition,
  properties: PlaceFeature['properties'],
): PlaceFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties,
});

const line = (coordinates: GeoJsonPosition[], kind: string): PlaceFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: { kind },
});

/** The picked zone, and its handles while no tool is in use. */
function zoneFeatures(view: AnalysisView, zones: Zone[] | null, drag: MapDrag): PlaceFeature[] {
  const zone = zones?.find((z) => z.id === view.setup.zoneId);
  if (!zone || view.work.tool === 'zone') return [];
  const ring = drag.zone?.id === zone.id ? drag.zone.ring : zone.ring;
  const features: PlaceFeature[] = [
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
      properties: { kind: 'zone' },
    },
  ];
  if (view.work.tool === null) {
    for (const middle of edgeMiddles(ring)) features.push(point(middle, { kind: 'middle' }));
    for (const corner of ring) features.push(point(corner, { kind: 'handle' }));
  }
  return features;
}

/** The outline being drawn, its corners, and the line from the last corner to the pointer. */
function draftFeatures(view: AnalysisView, drag: MapDrag): PlaceFeature[] {
  const { tool, corners, closed } = view.work;
  if (tool !== 'zone') return [];
  const features: PlaceFeature[] = [];
  if (corners.length >= 2)
    features.push(line(closed ? [...corners, corners[0]] : corners, 'draft'));
  const last = corners[corners.length - 1];
  if (!closed && last && drag.pointer) features.push(line([last, drag.pointer], 'rubber'));
  corners.forEach((corner, i) => features.push(point(corner, { kind: 'corner', first: i === 0 })));
  return features;
}

/** The saved pins, and the new one waiting for its name. */
function pinFeatures(
  view: AnalysisView,
  pois: PointOfInterest[] | null,
  drag: MapDrag,
): PlaceFeature[] {
  const features = (pois ?? []).map((poi) => {
    const at: GeoJsonPosition = drag.poi?.id === poi.id ? drag.poi.at : [poi.lon, poi.lat];
    const picked = view.setup.poiIds.includes(poi.id) || view.work.renamingPoiId === poi.id;
    return point(at, { kind: 'poi', name: poi.name, picked });
  });
  const pending = view.work.pendingPoi;
  if (pending) features.push(point(pending, { kind: 'poi', name: '', picked: true }));
  return features;
}

/** Everything the setup draws on the map. */
export const placeFeatures = (
  view: AnalysisView,
  zones: Zone[] | null,
  pois: PointOfInterest[] | null,
  drag: MapDrag,
): PlaceFeature[] => [
  ...zoneFeatures(view, zones, drag),
  ...draftFeatures(view, drag),
  ...pinFeatures(view, pois, drag),
];
