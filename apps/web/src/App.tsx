import { useCallback, useEffect } from 'react';
import { getJson, type Baseline, type Mode, type RouteListItem } from './api.ts';
import { clock } from './clock.ts';
import { FleetPanel } from './FleetPanel.tsx';
import { Inspector } from './inspector/Inspector.tsx';
import { liveStats } from './liveStats.ts';
import { MapView } from './MapView.tsx';
import { ModePanel } from './ModePanel.tsx';
import { NewLinePanel } from './NewLinePanel.tsx';
import { ReshapePanel } from './ReshapePanel.tsx';
import { loadScenarios, redo, selectScenario, undo } from './scenario.ts';
import { ScenarioPanel } from './ScenarioPanel.tsx';
import { useStore } from './store.ts';
import { TimeBar } from './TimeBar.tsx';
import { TimelinePanel } from './timeline/TimelinePanel.tsx';
import { TopBar } from './TopBar.tsx';
import { applyRemovedTrips, loadModeVehicles, vehicleData } from './vehicles.ts';

// Small packs first so something is moving almost immediately.
// Read the link once at startup, before anything rewrites the address bar.
const initialHash = location.hash;

const LOAD_ORDER = ['train', 'metro', 'light_rail', 'ferry', 'coach', 'bus', 'school_bus'];

export function App() {
  const baselineId = useStore((s) => s.baselineId);
  const set = useStore((s) => s.set);
  const inspectorOpen = useStore((s) => s.history.length > 0 || s.builder !== null);
  const timelineOpen = useStore((s) => s.timeline.open);

  useEffect(() => {
    Promise.all([getJson<Baseline[]>('/api/baselines'), getJson<Mode[]>('/api/modes')]).then(([baselines, modes]) => {
      set({
        baselines,
        modes,
        enabledModes: Object.fromEntries(modes.map((m) => [m.id, true])),
        baselineId: baselines[0]?.id ?? null,
      });
    });
  }, [set]);

  useEffect(() => {
    if (baselineId === null) return;
    let cancelled = false;
    const { baselines, modes } = useStore.getState();
    const baseline = baselines.find((b) => b.id === baselineId)!;
    clock.setMax(baseline.stats.lastArrival);
    clock.set(7.5 * 3600);
    vehicleData.clear();
    applyRemovedTrips([]);
    set({
      loadedModes: {},
      routes: new Map(),
      history: [],
      highlightRouteId: null,
      highlightTripId: null,
      scenarios: [],
      scenarioId: null,
      scenarioInfo: null,
    });
    loadScenarios(baselineId).catch((err) => console.error('Failed to load scenarios', err));

    (async () => {
      const list = await getJson<RouteListItem[]>(`/api/baselines/${baselineId}/routes`);
      if (cancelled) return;
      const routes = new Map(list.map((r) => [r.id, r]));
      set({ routes });
      // Open whatever the link points at, for example #route=2317 or #trip=18202&t=12000.
      // Optional extras: tl=stringline|platforms|vehicles, station=<id>, view=<start>-<end> in seconds.
      const params = new URLSearchParams(initialHash.slice(1));
      const linkedScenario = Number(params.get('scenario'));
      if (linkedScenario > 0) await selectScenario(linkedScenario).catch(() => selectScenario(null));
      if (cancelled) return;
      const kind = (['route', 'trip', 'vehicleDay'] as const).find((k) => Number(params.get(k)) > 0);
      if (kind) useStore.getState().open({ kind, id: Number(params.get(kind)) }, { replace: true });
      if (Number(params.get('t')) > 0) clock.set(Number(params.get('t')));
      if (params.get('fleet')) useStore.getState().set({ fleetOpen: true });
      const tab = params.get('tl');
      if (tab === 'stringline' || tab === 'platforms' || tab === 'vehicles') {
        const station = Number(params.get('station'));
        const state = useStore.getState();
        state.openTimeline({
          tab,
          ...(kind === 'route' ? { routeId: Number(params.get('route')) } : {}),
          ...(station ? { stationId: station } : {}),
        });
        const view = params.get('view')?.split('-').map(Number);
        if (view?.length === 2 && view.every(Number.isFinite)) state.setView(view[0], view[1]);
      }
      for (const modeId of LOAD_ORDER) {
        if (!baseline.tripsByMode[modeId]) continue;
        const mode = modes.find((m) => m.id === modeId);
        const loaded = await loadModeVehicles(baselineId, modeId, routes, mode?.color ?? '888888');
        if (cancelled) return;
        vehicleData.set(modeId, loaded);
        set({ loadedModes: { ...useStore.getState().loadedModes, [modeId]: true } });
      }
    })().catch((err) => console.error('Failed to load vehicle data', err));
    return () => {
      cancelled = true;
    };
  }, [baselineId, set]);

  // Keep the address bar pointing at what is open, so a link can be shared.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.history === previous.history) return;
        const current = state.history[state.history.length - 1];
        const hash = current && current.kind !== 'routeList' ? `#${current.kind}=${current.id}` : '';
        if (hash !== location.hash) history.replaceState(null, '', location.pathname + location.search + hash);
      }),
    [],
  );

  // Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes, Space plays and pauses. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        void redo();
      } else if (e.key === ' ' && !mod) {
        e.preventDefault();
        useStore.getState().set({ playing: !useStore.getState().playing });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onVehicleCount = useCallback((count: number) => liveStats.setVehicles(count), []);

  return (
    <div className={`app${inspectorOpen ? ' inspector-open' : ''}${timelineOpen ? ' timeline-open' : ''}`}>
      <MapView onVehicleCount={onVehicleCount} />
      <TopBar />
      <div className="left-column">
        <ModePanel />
        <ScenarioPanel />
      </div>
      <TimelinePanel />
      <Inspector />
      <NewLinePanel />
      <ReshapePanel />
      <TimeBar />
      <FleetPanel />
    </div>
  );
}
