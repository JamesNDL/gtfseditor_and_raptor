// Changing the setup's timetable, name and settings (FR-6, FR-8, FR-9). Each helper answers a new
// view and copies what it changes, so the starting settings (D34) are never changed.
import type { AnalysisSettings, DayBandId } from '@gtfs-editor/core';
import type { AnalysisSetupChoices, AnalysisView } from '../analysis-state.ts';

const withSetup = (view: AnalysisView, setup: Partial<AnalysisSetupChoices>): AnalysisView => ({
  ...view,
  setup: { ...view.setup, ...setup },
});

/** Runs on a scenario of the day, or on the published day (null). */
export const pickTimetable = (view: AnalysisView, scenarioId: number | null): AnalysisView =>
  withSetup(view, { scenarioId });

/** Names the analysis; left empty, the API names it. */
export const nameSetup = (view: AnalysisView, name: string): AnalysisView =>
  withSetup(view, { name });

/** Changes some settings and keeps the rest. */
export const changeSettings = (
  view: AnalysisView,
  settings: Partial<AnalysisSettings>,
): AnalysisView => withSetup(view, { settings: { ...view.setup.settings, ...settings } });

/** Allows a mode, or stops allowing it if it was allowed. */
export function toggleMode(view: AnalysisView, modeId: string): AnalysisView {
  const modes = view.setup.settings.modes;
  return changeSettings(view, {
    modes: modes.includes(modeId) ? modes.filter((m) => m !== modeId) : [...modes, modeId],
  });
}

/** Changes the traffic factor for one part of the day. */
export const changeFactor = (view: AnalysisView, band: DayBandId, factor: number): AnalysisView =>
  changeSettings(view, {
    trafficFactors: { ...view.setup.settings.trafficFactors, [band]: factor },
  });
