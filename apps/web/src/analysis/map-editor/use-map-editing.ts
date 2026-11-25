// The map editor's pointer work, besides clicks (which analysis-map.ts handles): the cross pointer
// and the line to the pointer while drawing, a double click to finish an outline, and dragging a
// saved pin or a corner of the picked zone (or the middle of a side, which adds a corner). A press
// on something draggable stops the map from panning; a press anywhere else pans as usual.
import type { GeoJsonPosition } from '@gtfs-editor/core';
import type * as maplibregl from 'maplibre-gl';
import { useEffect } from 'react';
import { useStore } from '../../app/store.ts';
import { usePlaces } from '../analysis-api.ts';
import { useMapDrag } from '../map-drag.ts';
import { NO_MAP_WORK, closeDrawing, isMapBusy } from '../map-work.ts';
import { dragRing, handleAt, type ZoneHandle } from '../zone-edit.ts';
import { PIN_REACH_PX } from '../analysis-map.ts';
import { movePoiTo, reshapeZoneTo } from './map-actions.ts';

/** How far, in pixels, a press must move before it is a drag rather than a click. */
const DRAG_PX = 3;

type Grab = { kind: 'poi'; id: number } | { kind: 'zone'; id: number; handle: ZoneHandle };

/** The pin or zone handle under the point, when no tool is in use on the setup. */
function grabAt(map: maplibregl.Map, point: maplibregl.Point): Grab | null {
  const { analysis } = useStore.getState();
  if (isMapBusy(analysis.work)) return null;
  const pixelsTo = (place: GeoJsonPosition): number => map.project(place).dist(point);
  const { zones, pois } = usePlaces.getState();
  for (const poi of pois ?? []) {
    if (pixelsTo([poi.lon, poi.lat]) <= PIN_REACH_PX) return { kind: 'poi', id: poi.id };
  }
  const zone = zones?.find((z) => z.id === analysis.setup.zoneId);
  const handle = zone ? handleAt(zone.ring, pixelsTo) : null;
  return zone && handle ? { kind: 'zone', id: zone.id, handle } : null;
}

/** Follows a press on a pin or a handle: moves it with the pointer, and saves it on release. */
function follow(map: maplibregl.Map, grab: Grab, start: maplibregl.Point): void {
  const canvas = map.getCanvas();
  let dragging = false;
  let at: GeoJsonPosition | null = null;
  const move = (e: maplibregl.MapMouseEvent) => {
    if (!dragging && e.point.dist(start) < DRAG_PX) return;
    dragging = true;
    canvas.style.cursor = 'grabbing';
    at = [e.lngLat.lng, e.lngLat.lat];
    if (grab.kind === 'poi') useMapDrag.setState({ poi: { id: grab.id, at } });
    else {
      const zone = usePlaces.getState().zones?.find((z) => z.id === grab.id);
      if (zone)
        useMapDrag.setState({ zone: { id: grab.id, ring: dragRing(zone.ring, grab.handle, at) } });
    }
  };
  const release = () => {
    map.off('mousemove', move);
    canvas.style.cursor = '';
    if (!dragging || !at) return;
    if (grab.kind === 'poi') void movePoiTo(grab.id, at);
    else {
      const ring = useMapDrag.getState().zone?.ring;
      if (ring) void reshapeZoneTo(grab.id, ring);
    }
  };
  map.on('mousemove', move);
  window.addEventListener('mouseup', release, { once: true });
}

export function useMapEditing(map: maplibregl.Map, shown: boolean): void {
  const busy = useStore((s) => isMapBusy(s.analysis.work));
  const drawing = useStore((s) => s.analysis.work.tool === 'zone' && !s.analysis.work.closed);

  // Folding the pane away, or leaving the setup, puts the tool down so clicks work as usual.
  useEffect(() => {
    const { analysis, set } = useStore.getState();
    if (!shown && analysis.work !== NO_MAP_WORK)
      set({ analysis: { ...analysis, work: NO_MAP_WORK } });
  }, [shown]);

  // While a tool is in use the pointer is a cross and a double click does not zoom.
  useEffect(() => {
    if (!busy) return;
    const canvas = map.getCanvas();
    // The map's own pointer handler sets the cursor first; this runs after it.
    const cross = () => (canvas.style.cursor = 'crosshair');
    map.doubleClickZoom.disable();
    cross();
    map.on('mousemove', cross);
    return () => {
      map.doubleClickZoom.enable();
      map.off('mousemove', cross);
      canvas.style.cursor = '';
    };
  }, [map, busy]);

  // While drawing: the line on to the pointer, and a double click finishes the outline.
  useEffect(() => {
    if (!drawing) return;
    const track = (e: maplibregl.MapMouseEvent) =>
      useMapDrag.setState({ pointer: [e.lngLat.lng, e.lngLat.lat] });
    const leave = () => useMapDrag.setState({ pointer: null });
    const finish = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault();
      const { analysis, set } = useStore.getState();
      set({ analysis: { ...analysis, work: closeDrawing(analysis.work) } });
    };
    map.on('mousemove', track);
    map.on('mouseout', leave);
    map.on('dblclick', finish);
    return () => {
      map.off('mousemove', track);
      map.off('mouseout', leave);
      map.off('dblclick', finish);
      leave();
    };
  }, [map, drawing]);

  // With no tool, pins and the picked zone's handles show they can be dragged, and drag.
  useEffect(() => {
    if (!shown || busy) return;
    const canvas = map.getCanvas();
    const hover = (e: maplibregl.MapMouseEvent) => {
      if (e.originalEvent.buttons) return;
      const grab = grabAt(map, e.point);
      if (grab) canvas.style.cursor = grab.kind === 'poi' ? 'pointer' : 'move';
    };
    const press = (e: maplibregl.MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return;
      const grab = grabAt(map, e.point);
      if (!grab) return;
      // Stops the map panning, for this press only.
      e.preventDefault();
      follow(map, grab, e.point);
    };
    map.on('mousemove', hover);
    map.on('mousedown', press);
    return () => {
      map.off('mousemove', hover);
      map.off('mousedown', press);
    };
  }, [map, shown, busy]);
}
