// AA-18 (FR-4, FR-5; AC-FR-4.1, AC-FR-4.2, AC-FR-5.1, and AC 4: while drawing or placing, map
// clicks do nothing else): what a click on the map does while the Access pane is drawing a zone,
// placing a point of interest or moving one. The API is a stand-in fetch.
import type { GeoJsonPosition, PointOfInterest } from '@gtfs-editor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../app/store.ts';
import { analysisMapClick } from './analysis-map.ts';
import { usePlaces } from './analysis-api.ts';
import {
  defaultAnalysisView,
  startDrawing,
  startMovingPoi,
  startPlacingPoi,
  type AnalysisView,
} from './analysis-state.ts';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let pois: PointOfInterest[] = [];
/** When set, every request that changes something answers 400 with this message. */
let refuse: string | null = null;

const poi = (id: number, name: string, lon: number, lat: number): PointOfInterest => ({
  id,
  name,
  kind: 'place',
  source: 'drawn',
  lon,
  lat,
});

/** A stand-in for the API's points of interest routes. */
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
  if (method === 'GET' && url === '/api/analysis/pois') return json(pois);
  const fields = body as { name: string; lon: number; lat: number };
  if (method === 'POST' && url === '/api/analysis/pois') {
    const made = poi(11, fields.name, fields.lon, fields.lat);
    pois = [...pois, made];
    return json(made);
  }
  const moved = /^\/api\/analysis\/pois\/(\d+)$/.exec(url);
  if (method === 'PATCH' && moved) {
    const id = Number(moved[1]);
    pois = pois.map((p) => (p.id === id ? { ...p, lon: fields.lon, lat: fields.lat } : p));
    return json(pois.find((p) => p.id === id));
  }
  return json({ message: 'Not found' }, 404);
}

const view = (): AnalysisView => useStore.getState().analysis;
const setView = (analysis: AnalysisView) => useStore.getState().set({ analysis });
const setup = (): AnalysisView => ({ ...defaultAnalysisView(), screen: 'setup' });
/** Every corner is far from the click. */
const far = (): number => 500;

beforeEach(() => {
  calls = [];
  pois = [poi(3, 'Library', 151.2, -33.9)];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  usePlaces.setState({ zones: null, pois: null, zoneError: null, poiError: null });
  setView(setup());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('analysisMapClick', () => {
  it('leaves the click alone when nothing is being drawn, placed or moved', () => {
    expect(analysisMapClick(151.2, -33.9, far)).toBe(false);
    expect(view()).toEqual(setup());
    expect(calls).toEqual([]);
  });

  it('adds a corner while a zone is being drawn, and uses the click (AC-FR-4.1, AC 4)', () => {
    setView(startDrawing(setup()));
    expect(analysisMapClick(151.2, -33.9, far)).toBe(true);
    expect(analysisMapClick(151.21, -33.9, far)).toBe(true);
    expect(view().drawing).toEqual([
      [151.2, -33.9],
      [151.21, -33.9],
    ]);
    expect(calls).toEqual([]);
  });

  it('closes the outline on a click within 10 pixels of the first corner (AC-FR-4.1)', () => {
    setView(startDrawing(setup()));
    for (const [lon, lat] of [
      [151.2, -33.9],
      [151.21, -33.9],
      [151.21, -33.89],
    ])
      analysisMapClick(lon, lat, far);
    const first = view().drawing?.[0];
    const near = (corner: GeoJsonPosition): number => (corner === first ? 8 : 500);
    expect(analysisMapClick(151.2001, -33.9001, near)).toBe(true);
    expect(view().drawingClosed).toBe(true);
    expect(view().drawing).toHaveLength(3);
  });

  it('refuses to close an outline that crosses itself (AC-FR-4.2)', () => {
    setView(startDrawing(setup()));
    for (const [lon, lat] of [
      [151.2, -33.9],
      [151.21, -33.89],
      [151.21, -33.9],
      [151.2, -33.89],
    ])
      analysisMapClick(lon, lat, far);
    const first = view().drawing?.[0];
    analysisMapClick(151.2, -33.9, (corner) => (corner === first ? 0 : 500));
    expect(view().drawingClosed).toBe(false);
    expect(view().drawingProblem).toMatch(/crosses itself/);
    expect(view().drawing).toHaveLength(4);
  });

  it('uses the click, and changes nothing, while a closed outline waits for its name', () => {
    setView(startDrawing(setup()));
    for (const [lon, lat] of [
      [151.2, -33.9],
      [151.21, -33.9],
      [151.21, -33.89],
    ])
      analysisMapClick(lon, lat, far);
    analysisMapClick(151.2, -33.9, () => 0);
    const closed = view();
    expect(analysisMapClick(151.3, -33.8, far)).toBe(true);
    expect(view()).toBe(closed);
  });

  it('places a named point of interest where the map is clicked, and picks it (AC-FR-5.1)', async () => {
    setView(startPlacingPoi(setup(), 'Hospital'));
    expect(analysisMapClick(151.25, -33.85, far)).toBe(true);
    // The wait is over at once, so a second click cannot place it twice.
    expect(view().placingPoi).toBeNull();
    expect(analysisMapClick(151.26, -33.86, far)).toBe(false);
    await vi.waitFor(() => expect(view().setup.poiIds).toEqual([11]));
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/analysis/pois',
      body: { name: 'Hospital', lon: 151.25, lat: -33.85 },
    });
    expect(usePlaces.getState().pois?.map((p) => p.name)).toEqual(['Library', 'Hospital']);
  });

  it('moves a point of interest to where the map is clicked (AC-FR-5.1)', async () => {
    setView(startMovingPoi(setup(), 3));
    expect(analysisMapClick(151.3, -33.8, far)).toBe(true);
    expect(view().movingPoiId).toBeNull();
    await vi.waitFor(() =>
      expect(usePlaces.getState().pois).toEqual([poi(3, 'Library', 151.3, -33.8)]),
    );
    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/api/analysis/pois/3',
      body: { lon: 151.3, lat: -33.8 },
    });
  });

  it("shows the API's words when a point of interest cannot be placed", async () => {
    refuse = 'A point of interest needs a longitude from -180 to 180';
    setView(startPlacingPoi(setup(), 'Hospital'));
    analysisMapClick(151.25, -33.85, far);
    await vi.waitFor(() => expect(usePlaces.getState().poiError).toBe(refuse));
    expect(view().setup.poiIds).toEqual([]);
  });
});
