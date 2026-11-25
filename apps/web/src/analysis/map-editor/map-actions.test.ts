// FR-4, FR-5 (AC-FR-4.1, AC-FR-5.1): what the map editor saves. The name box saves a drawn zone
// (and picks it for the analysis), a dropped pin (and ticks it) or a new name; dragging a pin
// moves it; dragging a zone's corner reshapes it. The API is a stand-in fetch.
import type { GeoJsonPosition, PointOfInterest, Zone } from '@gtfs-editor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../app/store.ts';
import { usePlaces } from '../analysis-api.ts';
import { defaultAnalysisView, type AnalysisView } from '../analysis-state.ts';
import { useMapDrag } from '../map-drag.ts';
import {
  NO_MAP_WORK,
  addCorner,
  closeDrawing,
  dropPoi,
  pickTool,
  startRenaming,
  type MapWork,
} from '../map-work.ts';
import { cancelName, movePoiTo, reshapeZoneTo, saveName } from './map-actions.ts';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let zones: Zone[] = [];
let pois: PointOfInterest[] = [];
/** When set, every request that changes something answers 400 with this message. */
let refuse: string | null = null;

const SQUARE: GeoJsonPosition[] = [
  [151.2, -33.9],
  [151.21, -33.9],
  [151.21, -33.89],
  [151.2, -33.89],
];

const poi = (id: number, name: string, lon: number, lat: number): PointOfInterest => ({
  id,
  name,
  kind: 'place',
  source: 'drawn',
  lon,
  lat,
});
const zone = (id: number, name: string, ring: GeoJsonPosition[]): Zone => ({
  id,
  name,
  ring,
  createdAt: '2026-11-26T00:00:00Z',
});

/** A stand-in for the API's zone and point of interest routes. */
async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method, url, body });
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (method !== 'GET' && refuse) return json({ message: refuse }, 400);
  if (url === '/api/analysis/zones' && method === 'GET') return json(zones);
  if (url === '/api/analysis/pois' && method === 'GET') return json(pois);
  const fields = body as { name?: string; ring?: GeoJsonPosition[]; lon: number; lat: number };
  if (url === '/api/analysis/zones' && method === 'POST') {
    const made = zone(21, fields.name ?? '', fields.ring ?? []);
    zones = [...zones, made];
    return json(made);
  }
  if (url === '/api/analysis/pois' && method === 'POST') {
    const made = poi(11, fields.name ?? '', fields.lon, fields.lat);
    pois = [...pois, made];
    return json(made);
  }
  const one = /^\/api\/analysis\/(zones|pois)\/(\d+)$/.exec(url);
  if (method === 'PATCH' && one) {
    const id = Number(one[2]);
    if (one[1] === 'zones') {
      zones = zones.map((z) => (z.id === id ? { ...z, ...fields } : z));
      return json(zones.find((z) => z.id === id));
    }
    pois = pois.map((p) => (p.id === id ? { ...p, ...fields } : p));
    return json(pois.find((p) => p.id === id));
  }
  return json({ message: 'Not found' }, 404);
}

const view = (): AnalysisView => useStore.getState().analysis;
const setWork = (work: MapWork) =>
  useStore.getState().set({ analysis: { ...defaultAnalysisView(), screen: 'setup', work } });

beforeEach(() => {
  calls = [];
  zones = [zone(5, 'Centre', SQUARE)];
  pois = [poi(3, 'Library', 151.2, -33.9)];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  usePlaces.setState({ zones, pois, zoneError: null, poiError: null });
  useMapDrag.setState({ pointer: null, poi: null, zone: null });
  setWork(NO_MAP_WORK);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveName', () => {
  it('saves a closed outline as a zone, picks it, and puts the tool down (AC-FR-4.1)', async () => {
    let work = pickTool(NO_MAP_WORK, 'zone');
    for (const corner of SQUARE) work = addCorner(work, corner);
    setWork(closeDrawing(work));
    await saveName('Mayfield');
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/analysis/zones',
      body: { name: 'Mayfield', ring: SQUARE },
    });
    expect(view().setup.zoneId).toBe(21);
    expect(view().work).toEqual(NO_MAP_WORK);
    expect(usePlaces.getState().zones?.map((z) => z.name)).toEqual(['Centre', 'Mayfield']);
  });

  it('saves a dropped pin as a point of interest and ticks it (AC-FR-5.1)', async () => {
    setWork(dropPoi(pickTool(NO_MAP_WORK, 'poi'), [151.25, -33.85]));
    await saveName('Hospital');
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/analysis/pois',
      body: { name: 'Hospital', lon: 151.25, lat: -33.85 },
    });
    expect(view().setup.poiIds).toEqual([11]);
    expect(view().work).toEqual(NO_MAP_WORK);
  });

  it('renames a saved point of interest', async () => {
    setWork(startRenaming(NO_MAP_WORK, 3));
    await saveName('City library');
    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/api/analysis/pois/3',
      body: { name: 'City library' },
    });
    expect(usePlaces.getState().pois?.[0].name).toBe('City library');
    expect(view().work).toEqual(NO_MAP_WORK);
  });

  it("fails with the API's words and keeps the box open", async () => {
    refuse = 'Give the point of interest a name';
    const waiting = dropPoi(pickTool(NO_MAP_WORK, 'poi'), [151.25, -33.85]);
    setWork(waiting);
    await expect(saveName('Hospital')).rejects.toThrow(refuse);
    expect(view().work).toEqual(waiting);
    expect(view().setup.poiIds).toEqual([]);
  });
});

describe('cancelName', () => {
  it('forgets the outline or the pin waiting for a name', () => {
    setWork(dropPoi(pickTool(NO_MAP_WORK, 'poi'), [151.25, -33.85]));
    cancelName();
    expect(view().work).toEqual(NO_MAP_WORK);
  });
});

describe('movePoiTo', () => {
  it('moves a dragged pin, and lets go of the drag once saved (AC-FR-5.1)', async () => {
    useMapDrag.setState({ poi: { id: 3, at: [151.3, -33.8] } });
    await movePoiTo(3, [151.3, -33.8]);
    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/api/analysis/pois/3',
      body: { lon: 151.3, lat: -33.8 },
    });
    expect(usePlaces.getState().pois?.[0]).toMatchObject({ lon: 151.3, lat: -33.8 });
    expect(useMapDrag.getState().poi).toBeNull();
  });

  it("shows the API's words when the move is refused, and puts the pin back", async () => {
    refuse = 'A point of interest needs a longitude from -180 to 180';
    useMapDrag.setState({ poi: { id: 3, at: [181, -33.8] } });
    await movePoiTo(3, [181, -33.8]);
    expect(usePlaces.getState().poiError).toBe(refuse);
    expect(useMapDrag.getState().poi).toBeNull();
  });
});

describe('reshapeZoneTo', () => {
  const moved: GeoJsonPosition[] = [SQUARE[0], SQUARE[1], [151.22, -33.88], SQUARE[3]];

  it("saves the zone's new outline", async () => {
    useMapDrag.setState({ zone: { id: 5, ring: moved } });
    await reshapeZoneTo(5, moved);
    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/api/analysis/zones/5',
      body: { ring: moved },
    });
    expect(usePlaces.getState().zones?.[0].ring).toEqual(moved);
    expect(useMapDrag.getState().zone).toBeNull();
  });

  it('refuses an outline that crosses itself without asking the API, and puts it back', async () => {
    const crossed: GeoJsonPosition[] = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
    useMapDrag.setState({ zone: { id: 5, ring: crossed } });
    await reshapeZoneTo(5, crossed);
    expect(calls).toEqual([]);
    expect(usePlaces.getState().zoneError).toMatch(/crosses itself/);
    expect(useMapDrag.getState().zone).toBeNull();
  });

  it("shows the API's words when the new outline is refused", async () => {
    refuse = 'A zone may have at most 200 corners';
    await reshapeZoneTo(5, moved);
    expect(usePlaces.getState().zoneError).toBe(refuse);
  });
});
