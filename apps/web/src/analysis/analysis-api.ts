// The Access pane's calls to the editor's API (docs/architecture/access-analysis.md §4.4, §5.2),
// and the list of the day's analyses, kept here rather than in the app store so that the store
// gains only its one `analysis` field (D29). The rail reads it for its "running" badge. The saved
// zones and points of interest are kept here too, for the setup and the map.
import type {
  AnalysisCreateBody,
  AnalysisListEntry,
  PoiBody,
  PointOfInterest,
  Zone,
  ZoneBody,
} from '@gtfs-editor/core';
import { create } from 'zustand';
import { useStore } from '../app/store.ts';
import { getJson } from '../shared/api-client.ts';
import { isAnalysisActive } from './analysis-state.ts';

interface AnalysisList {
  /** The day the list is for, or null before it is first fetched. */
  baselineId: number | null;
  items: AnalysisListEntry[];
}

/** The day's analyses, newest first, as last fetched. */
export const useAnalysisList = create<AnalysisList>(() => ({ baselineId: null, items: [] }));

/** True while any of the day's analyses is waiting or running. */
export const useAnalysisRunning = (): boolean =>
  useAnalysisList((list) => list.items.some(isAnalysisActive));

/** Fetches the chosen day's analyses into the list, and answers them. */
export async function refreshAnalyses(): Promise<AnalysisListEntry[]> {
  const { baselineId } = useStore.getState();
  if (baselineId === null) return [];
  const items = await getJson<AnalysisListEntry[]>(`/api/analyses?baseline=${baselineId}`);
  // A day chosen while this was on its way has its own list coming.
  if (useStore.getState().baselineId === baselineId)
    useAnalysisList.setState({ baselineId, items });
  return items;
}

/** Deletes an analysis and its results; one still running is cancelled first by the API. */
export async function deleteAnalysis(id: number): Promise<void> {
  const res = await fetch(`/api/analyses/${id}`, { method: 'DELETE' });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message ?? `The analysis could not be deleted (${res.status})`);
}

/**
 * Makes an analysis and queues it to run (FR-10), then fetches the list again so its progress
 * shows. A refusal fails with the API's reason: the limits, or which router is not running (503).
 */
export async function startAnalysis(body: AnalysisCreateBody): Promise<number> {
  const { id } = await send<{ id: number }>('/api/analyses', 'POST', body);
  await refreshAnalyses();
  return id;
}

/** Stops a waiting or running analysis; it is kept, marked cancelled. */
export async function cancelAnalysis(id: number): Promise<void> {
  await send<{ ok: true }>(`/api/analyses/${id}/cancel`, 'POST');
  await refreshAnalyses();
}

// ---- zones and points of interest (FR-4, FR-5; apps/api/src/analysis/places-routes.ts) -------

interface Places {
  /** The saved zones by name, or null before they are first fetched. */
  zones: Zone[] | null;
  /** The saved points of interest by name, or null before they are first fetched. */
  pois: PointOfInterest[] | null;
  /** Why the last change to a zone failed, or null. */
  zoneError: string | null;
  /** Why the last change to a point of interest failed, or null. */
  poiError: string | null;
}

/** The saved zones and points of interest, which belong to no day (D25). */
export const usePlaces = create<Places>(() => ({
  zones: null,
  pois: null,
  zoneError: null,
  poiError: null,
}));

/** Sends a change to the API and answers its reply, or fails with the API's own words. */
async function send<T>(url: string, method: string, body?: object): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const reply = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(reply.message ?? `${url} responded ${res.status}`);
  return reply;
}

const ZONES = '/api/analysis/zones';
const POIS = '/api/analysis/pois';

/** Fetches the saved zones into the list. */
export async function refreshZones(): Promise<void> {
  usePlaces.setState({ zones: await getJson<Zone[]>(ZONES) });
}

/** Fetches the saved points of interest into the list. */
export async function refreshPois(): Promise<void> {
  usePlaces.setState({ pois: await getJson<PointOfInterest[]>(POIS) });
}

/** Saves a drawn zone and answers it; the list is fetched again. */
export async function saveZone(body: ZoneBody): Promise<Zone> {
  const zone = await send<Zone>(ZONES, 'POST', body);
  await refreshZones();
  return zone;
}

/** Renames a zone. */
export async function renameZone(id: number, name: string): Promise<void> {
  await send<Zone>(`${ZONES}/${id}`, 'PATCH', { name });
  await refreshZones();
}

/** Deletes a zone; analyses that used it keep their own copy (D25). */
export async function deleteZone(id: number): Promise<void> {
  await send<{ ok: true }>(`${ZONES}/${id}`, 'DELETE');
  await refreshZones();
}

/** Saves a placed point of interest and answers it; the list is fetched again. */
export async function savePoi(body: PoiBody): Promise<PointOfInterest> {
  const poi = await send<PointOfInterest>(POIS, 'POST', body);
  await refreshPois();
  return poi;
}

/** Renames a point of interest. */
export async function renamePoi(id: number, name: string): Promise<void> {
  await send<PointOfInterest>(`${POIS}/${id}`, 'PATCH', { name });
  await refreshPois();
}

/** Moves a point of interest. */
export async function movePoi(id: number, lon: number, lat: number): Promise<void> {
  await send<PointOfInterest>(`${POIS}/${id}`, 'PATCH', { lon, lat });
  await refreshPois();
}

/** Deletes a point of interest; analyses that used it keep their own copy (D25). */
export async function deletePoi(id: number): Promise<void> {
  await send<{ ok: true }>(`${POIS}/${id}`, 'DELETE');
  await refreshPois();
}
