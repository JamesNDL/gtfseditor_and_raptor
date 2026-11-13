// Client side of scenarios: choosing one, sending edits, and keeping every view in step afterwards.
import { getJson, type RouteListItem } from './api.ts';
import { useStore } from './store.ts';
import { applyRemovedTrips, loadScenarioVehicles, vehicleData } from './vehicles.ts';

export interface ScenarioSummary {
  id: number;
  name: string;
  head: number;
  baselineId: number;
  editCount: number;
}

export interface ScenarioEdit {
  kind: string;
  [key: string]: unknown;
}

export interface Conflict {
  kind: 'platform' | 'vehicle';
  tripId: number;
  otherTripId: number;
  stopId?: number;
  atSecs: number;
  title: string;
  detail: string;
  fixes: { label: string; edit: ScenarioEdit }[];
}

export interface ScenarioInfo {
  id: number;
  name: string;
  head: number;
  baselineId: number;
  edits: { seq: number; kind: string; summary: string; applied: boolean }[];
  stats: {
    baselineTrips: number;
    trips: number;
    editedTrips: number;
    vehicles: number;
    baselineVehicles: number;
    unassigned: number;
  };
  conflicts: Conflict[];
  /** Each line the scenario has touched, before and after. */
  impact: {
    routeId: number;
    name: string;
    color: string;
    tripsBefore: number;
    tripsAfter: number;
    vehiclesBefore: number;
    vehiclesAfter: number;
    changedTrips: number;
    /** Seated plus standing places across the day. */
    placesBefore: number;
    placesAfter: number;
  }[];
  /** Vehicle types the scenario needs more of than the fleet has. */
  fleet: { id: number; name: string; fleetSize: number; inUse: number }[];
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string }).message ?? `${url} responded ${res.status}`);
  return json as T;
}

export async function loadScenarios(baselineId: number) {
  const scenarios = await getJson<ScenarioSummary[]>(`/api/scenarios?baseline=${baselineId}`);
  useStore.getState().set({ scenarios });
}

/** Re-reads the scenario's state and map data, then tells every view to refetch. */
export async function refreshScenario() {
  const { scenarioId, baselineId, set } = useStore.getState();
  if (baselineId === null) return;
  const list = await getJson<RouteListItem[]>(`/api/baselines/${baselineId}/routes${scenarioId === null ? '' : `?s=${scenarioId}`}`);
  const routes = new Map(list.map((r) => [r.id, r]));
  set({ routes });
  if (scenarioId === null) {
    applyRemovedTrips([]);
    vehicleData.delete('scenario');
    set({ scenarioInfo: null, dataVersion: useStore.getState().dataVersion + 1 });
    return;
  }
  const [info, removed, extra] = await Promise.all([
    getJson<ScenarioInfo>(`/api/scenarios/${scenarioId}`),
    getJson<number[]>(`/api/scenarios/${scenarioId}/removed`),
    loadScenarioVehicles(scenarioId, routes),
  ]);
  if (useStore.getState().scenarioId !== scenarioId) return; // switched away while loading
  applyRemovedTrips(removed);
  vehicleData.set('scenario', extra);
  set({ scenarioInfo: info, dataVersion: useStore.getState().dataVersion + 1 });
}

export async function selectScenario(id: number | null) {
  const state = useStore.getState();
  // Trip ids differ between a scenario and the baseline, so an open trip cannot carry across.
  const current = state.history[state.history.length - 1];
  if (current?.kind === 'trip' || current?.kind === 'vehicleDay') {
    if (state.highlightRouteId !== null) state.open({ kind: 'route', id: state.highlightRouteId }, { replace: true });
    else state.close();
  }
  state.set({ scenarioId: id, scenarioInfo: null, editError: null });
  await refreshScenario();
}

export async function createScenario() {
  const { baselineId } = useStore.getState();
  if (baselineId === null) return;
  const created = await send<ScenarioSummary>('POST', '/api/scenarios', { baselineId });
  await loadScenarios(baselineId);
  await selectScenario(created.id);
}

export async function deleteScenario(id: number) {
  const { baselineId, scenarioId } = useStore.getState();
  await send('DELETE', `/api/scenarios/${id}`);
  if (scenarioId === id) await selectScenario(null);
  if (baselineId !== null) await loadScenarios(baselineId);
}

export interface EditResponse {
  summary: string;
  idMap: Record<string, number>;
  focusTripId?: number;
  routeId?: number;
  /** Stops the edit added, the one to use first. */
  stops?: { id: number; name: string; lon: number; lat: number; parentId: number | null; isStation: boolean }[];
}

/** Sends one edit. Returns the result if it was applied, or null. Failures land in the store as `editError`. */
export async function applyEdit(edit: ScenarioEdit): Promise<EditResponse | null> {
  const state = useStore.getState();
  if (state.baselineId === null) return null;
  state.set({ editBusy: true, editError: null });
  try {
    // The first change to the published timetable starts a scenario for it automatically.
    if (useStore.getState().scenarioId === null) {
      const created = await send<ScenarioSummary>('POST', '/api/scenarios', { baselineId: state.baselineId });
      await loadScenarios(state.baselineId);
      useStore.getState().set({ scenarioId: created.id });
    }
    const scenarioId = useStore.getState().scenarioId!;
    const result = await send<EditResponse>('POST', `/api/scenarios/${scenarioId}/edits`, edit);
    // Edited trips get new ids; keep the same trip open and highlighted.
    const now = useStore.getState();
    const remap = (id: number) => result.idMap[String(id)] ?? id;
    const current = now.history[now.history.length - 1];
    let history = now.history.map((h) => (h.kind === 'trip' ? { ...h, id: remap(h.id) } : h));
    if (edit.kind === 'delete' && current?.kind === 'trip' && (edit.tripIds as number[]).includes(current.id)) {
      history = now.highlightRouteId !== null ? [{ kind: 'route', id: now.highlightRouteId }] : [];
    }
    if (edit.kind === 'duplicate' && result.focusTripId) history = [...history.slice(0, -1), { kind: 'trip', id: result.focusTripId }];
    const last = history[history.length - 1];
    now.set({ history, highlightTripId: last?.kind === 'trip' ? last.id : null });
    await refreshScenario();
    return result;
  } catch (err) {
    useStore.getState().set({ editError: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    useStore.getState().set({ editBusy: false });
  }
}

async function step(direction: 'undo' | 'redo') {
  const state = useStore.getState();
  if (state.scenarioId === null) return;
  state.set({ editBusy: true, editError: null });
  try {
    await send('POST', `/api/scenarios/${state.scenarioId}/${direction}`);
    // The open trip may not exist on the other side of the undo; fall back to its line.
    const now = useStore.getState();
    const current = now.history[now.history.length - 1];
    if (current?.kind === 'trip') {
      if (now.highlightRouteId !== null) now.open({ kind: 'route', id: now.highlightRouteId }, { replace: true });
      else now.close();
    }
    await refreshScenario();
  } catch (err) {
    useStore.getState().set({ editError: err instanceof Error ? err.message : String(err) });
  } finally {
    useStore.getState().set({ editBusy: false });
  }
}

/** Applies the suggested fix for each conflict in turn, re-checking after every one. */
export async function fixAll(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const next = useStore.getState().scenarioInfo?.conflicts.find((c) => c.fixes.length > 0);
    if (!next) return;
    if (!(await applyEdit(next.fixes[0].edit))) return;
  }
}

export const undo = () => step('undo');
export const redo = () => step('redo');
