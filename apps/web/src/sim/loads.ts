// How full each vehicle is through the day in the chosen run, for colouring vehicles on the map
// and trips in the timelines. It is large and read every frame, so it lives outside React.
import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { FULL_STEPS, fetchResults, type VehicleLoads } from './results.ts';

interface TripLoad {
  places: number;
  peak: number;
  /** Times at which the fullness step changes, and the step from each. */
  times: number[];
  steps: number[];
}

export const tripLoads: { runId: number | null; byTrip: Map<number, TripLoad>; error: string | null } = { runId: null, byTrip: new Map(), error: null };

let loading: { runId: number; done: Promise<void> } | null = null;

/** Fetches a run's loads, once. Resolves when they are the ones in `tripLoads`. */
export function loadTripLoads(runId: number): Promise<void> {
  if (tripLoads.runId === runId) return Promise.resolve();
  if (loading?.runId === runId) return loading.done;
  const done = fetchResults<VehicleLoads>(`/api/sim-runs/${runId}/results/vehicle-loads`).then(
    (answer) => {
      const byTrip = new Map<number, TripLoad>();
      for (const row of answer.trips) {
        const load: TripLoad = { places: row[1], peak: row[2], times: [], steps: [] };
        for (let i = 3; i < row.length; i += 2) {
          load.times.push(row[i]);
          load.steps.push(row[i + 1]);
        }
        byTrip.set(row[0], load);
      }
      if (loading?.runId === runId) {
        tripLoads.runId = runId;
        tripLoads.byTrip = byTrip;
        tripLoads.error = null;
        loading = null;
      }
    },
    (err) => {
      if (loading?.runId === runId) loading = null;
      tripLoads.error = String(err.message ?? err);
    },
  );
  loading = { runId, done };
  return done;
}

/** The fullness step of a trip at a time: 0 for empty or carrying nobody all day, 1 to 4 as FULL_STEPS. */
export function stepAt(tripId: number, secs: number): number {
  const load = tripLoads.byTrip.get(tripId);
  if (!load) return 0;
  let step = 0;
  for (let i = 0; i < load.times.length && load.times[i] <= secs; i++) step = load.steps[i];
  return step;
}

/** The colour of a step, as a hex string; empty is a quiet grey. */
export const EMPTY_COLOR = '#5b6470';
export const stepColor = (step: number) => (step <= 0 ? EMPTY_COLOR : FULL_STEPS[step - 1].color);
export const stepLabel = (step: number) => (step <= 0 ? 'empty' : `${FULL_STEPS[step - 1].label} full`.replace('under half full', 'under half full'));

/** A trip's fullest moment in words, or null when it carries nobody. */
export function peakText(tripId: number): string | null {
  const load = tripLoads.byTrip.get(tripId);
  if (!load || load.peak <= 0) return null;
  return load.places > 0
    ? `at most ${load.peak.toLocaleString('en-AU')} aboard, ${Math.round((100 * load.peak) / load.places)}% of ${load.places.toLocaleString('en-AU')} places`
    : `at most ${load.peak.toLocaleString('en-AU')} aboard`;
}

/**
 * For the timelines: the run whose loads colour the trips, once they have arrived; null while
 * the colouring is off, or the run was made on another timetable than the one open.
 */
export function useTripColours(): number | null {
  const on = useStore((s) => s.simTripColours);
  const scenarioId = useStore((s) => s.scenarioId);
  const run = useStore((s) => s.simRuns.find((r) => r.id === s.simRunId));
  const fits = on && !!run && run.state === 'done' && (run.kind === 'scenario' ? run.scenarioId : null) === scenarioId;
  const runId = fits ? run.id : null;
  const [ready, setReady] = useState<number | null>(tripLoads.runId);
  useEffect(() => {
    if (runId === null) return;
    let live = true;
    void loadTripLoads(runId).then(() => live && setReady(tripLoads.runId));
    return () => {
      live = false;
    };
  }, [runId]);
  return runId !== null && ready === runId && tripLoads.runId === runId ? runId : null;
}
