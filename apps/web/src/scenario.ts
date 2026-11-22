// Client side of scenarios: choosing one, sending edits, and keeping every view in step afterwards.
import { getJson, type RouteListItem } from './api.ts';
import { useStore } from './store.ts';
import {
  applyRemovedTrips,
  applyWaits,
  loadScenarioVehicles,
  loadWaits,
  vehicleData,
} from './vehicles.ts';

export interface ScenarioSummary {
  id: number;
  name: string;
  head: number;
  baselineId: number;
  editCount: number;
  createdAt?: string;
  /** Simulation runs made on this scenario. */
  simRuns?: number;
}

export interface ScenarioEdit {
  kind: string;
  [key: string]: unknown;
}

export interface Conflict {
  /**
   * platform and vehicle: two trips in one place, or one vehicle on two trips at once.
   * speed: a stretch run faster than the mode can go, or backwards in time.
   * place: a vehicle whose next trip starts somewhere it cannot have reached.
   * closure: a path made after a closure that runs through it.
   */
  kind: 'platform' | 'vehicle' | 'speed' | 'place' | 'closure';
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
    /** The most trips running at any one moment, in the scenario and as published. */
    peak?: number;
    baselinePeak?: number;
  };
  conflicts: Conflict[];
  /** True when a list of clashes reached its limit, so there are more than are counted. */
  conflictsCapped?: boolean;
  /** How many vehicle types have a fleet size. With none, nothing warns that there are too few vehicles. */
  fleetLimitsSet?: number;
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
  if (!res.ok)
    throw new Error((json as { message?: string }).message ?? `${url} responded ${res.status}`);
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
  const list = await getJson<RouteListItem[]>(
    `/api/baselines/${baselineId}/routes${scenarioId === null ? '' : `?s=${scenarioId}`}`,
  );
  const routes = new Map(list.map((r) => [r.id, r]));
  set({ routes });
  // Which vehicle waits where between trips changes with the scenario. Not waited for: the map
  // redraws when the answer arrives.
  void loadWaits(baselineId, scenarioId);
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
  applyWaits();
  set({ scenarioInfo: info, dataVersion: useStore.getState().dataVersion + 1 });
}

export async function selectScenario(id: number | null) {
  const state = useStore.getState();
  // Trip ids differ between a scenario and the baseline, so an open trip cannot carry across.
  const current = state.history[state.history.length - 1];
  if (current?.kind === 'trip' || current?.kind === 'vehicleDay') {
    if (state.highlightRouteId !== null)
      state.open({ kind: 'route', id: state.highlightRouteId }, { replace: true });
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

export async function renameScenario(id: number, name: string) {
  const { baselineId } = useStore.getState();
  await send('PATCH', `/api/scenarios/${id}`, { name });
  if (baselineId !== null) await loadScenarios(baselineId);
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
  stops?: {
    id: number;
    name: string;
    lon: number;
    lat: number;
    parentId: number | null;
    isStation: boolean;
  }[];
}

/** Sends one edit. Returns the result if it was applied, or null. Failures land in the store as `editError`. */
export async function applyEdit(edit: ScenarioEdit): Promise<EditResponse | null> {
  const state = useStore.getState();
  if (state.baselineId === null) return null;
  // One edit at a time: a second drag before the first has landed would name a trip that no longer exists.
  if (state.editBusy) return null;
  state.set({ editBusy: true, editError: null });
  try {
    // The first change to the published timetable starts a scenario for it automatically.
    if (useStore.getState().scenarioId === null) {
      const created = await send<ScenarioSummary>('POST', '/api/scenarios', {
        baselineId: state.baselineId,
      });
      await loadScenarios(state.baselineId);
      useStore.getState().set({ scenarioId: created.id });
    }
    const scenarioId = useStore.getState().scenarioId!;
    // Sent unconfirmed first. A change that would add many vehicles comes back described, not
    // applied; the user is asked (EditConfirm), and only a yes sends it again to be applied.
    type Answer =
      EditResponse | { needsConfirm: { added: number; message: string; summary: string } };
    const url = `/api/scenarios/${scenarioId}/edits`;
    let answer = await send<Answer>('POST', url, { ...edit, confirm: edit.confirm === true });
    if ('needsConfirm' in answer) {
      useStore.getState().set({ editConfirm: { edit, ...answer.needsConfirm } });
      const yes = await new Promise<boolean>((resolve) => (answerConfirm = resolve));
      answerConfirm = null;
      if (!yes) return null;
      answer = await send<Answer>('POST', url, { ...edit, confirm: true });
      if ('needsConfirm' in answer) throw new Error('The change could not be confirmed');
    }
    const result = answer;
    // Edited trips get new ids; keep the same trip open and highlighted.
    const now = useStore.getState();
    const remap = (id: number) => result.idMap[String(id)] ?? id;
    const current = now.history[now.history.length - 1];
    let history = now.history.map((h) => (h.kind === 'trip' ? { ...h, id: remap(h.id) } : h));
    if (
      edit.kind === 'delete' &&
      current?.kind === 'trip' &&
      (edit.tripIds as number[]).includes(current.id)
    ) {
      history = now.highlightRouteId !== null ? [{ kind: 'route', id: now.highlightRouteId }] : [];
    }
    if (edit.kind === 'duplicate' && result.focusTripId)
      history = [...history.slice(0, -1), { kind: 'trip', id: result.focusTripId }];
    const last = history[history.length - 1];
    now.set({ history, highlightTripId: last?.kind === 'trip' ? last.id : null });
    await refreshScenario();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useStore.getState().set({ editError: message });
    // The server refused a trip that has changed since this screen was drawn: draw it again.
    if (/has since been changed/.test(message)) await refreshScenario().catch(() => undefined);
    return null;
  } finally {
    useStore.getState().set({ editBusy: false, editConfirm: null });
  }
}

async function step(direction: 'undo' | 'redo') {
  const state = useStore.getState();
  if (state.scenarioId === null) return;
  // As in applyEdit: nothing is sent while another change is still on its way.
  if (state.editBusy) return;
  state.set({ editBusy: true, editError: null });
  try {
    await send('POST', `/api/scenarios/${state.scenarioId}/${direction}`);
    // The open trip may not exist on the other side of the undo; fall back to its line.
    const now = useStore.getState();
    const current = now.history[now.history.length - 1];
    if (current?.kind === 'trip') {
      if (now.highlightRouteId !== null)
        now.open({ kind: 'route', id: now.highlightRouteId }, { replace: true });
      else now.close();
    }
    await refreshScenario();
  } catch (err) {
    useStore.getState().set({ editError: err instanceof Error ? err.message : String(err) });
  } finally {
    useStore.getState().set({ editBusy: false });
  }
}

// The question EditConfirm is showing, waiting for its answer.
let answerConfirm: ((yes: boolean) => void) | null = null;
/** The user's answer to "this adds N vehicles": go ahead, or leave everything as it is. */
export const confirmEdit = () => answerConfirm?.(true);
export const cancelConfirm = () => answerConfirm?.(false);

const FIX_ALL_LIMIT = 40;

/** Applies the suggested fix for each conflict in turn, re-checking after every one. */
export async function fixAll(): Promise<void> {
  for (let i = 0; i < FIX_ALL_LIMIT; i++) {
    const next = useStore.getState().scenarioInfo?.conflicts.find((c) => c.fixes.length > 0);
    if (!next) return;
    if (!(await applyEdit(next.fixes[0].edit))) return;
  }
  // It stops after a set number so that it cannot run away. Say so, rather than look finished.
  const left =
    useStore.getState().scenarioInfo?.conflicts.filter((c) => c.fixes.length > 0).length ?? 0;
  if (left > 0) {
    useStore.getState().set({
      editError: `"Fix all" stops after ${FIX_ALL_LIMIT} fixes, and ${left} clash${left === 1 ? ' is' : 'es are'} left that it can fix. Press it again to carry on.`,
    });
  }
}

export const undo = () => step('undo');
export const redo = () => step('redo');
