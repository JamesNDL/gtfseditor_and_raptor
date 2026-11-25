// AA-19 (FR-6, FR-8, FR-9): changing the setup's timetable, name and settings. The settings start
// at D34's values, and changing them never changes those starting values.
import { DEFAULT_ANALYSIS_SETTINGS } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import { defaultAnalysisView, newAnalysis } from '../analysis-state.ts';
import {
  changeFactor,
  changeSettings,
  nameSetup,
  pickTimetable,
  toggleMode,
} from './setup-choices.ts';

const DEFAULTS = structuredClone(DEFAULT_ANALYSIS_SETTINGS);

describe('the starting settings (D34)', () => {
  it('are the starting values, for a new analysis too', () => {
    expect(defaultAnalysisView().setup.settings).toEqual(DEFAULTS);
    expect(newAnalysis(defaultAnalysisView(), 2).setup.settings).toEqual(DEFAULTS);
  });
});

describe('pickTimetable and nameSetup', () => {
  it('picks a scenario or the published day', () => {
    const view = pickTimetable(defaultAnalysisView(), 3);
    expect(view.setup.scenarioId).toBe(3);
    expect(pickTimetable(view, null).setup.scenarioId).toBeNull();
  });

  it('names the analysis', () => {
    expect(nameSetup(defaultAnalysisView(), 'Morning check').setup.name).toBe('Morning check');
  });

  it('keeps the other choices', () => {
    const start = {
      ...defaultAnalysisView(),
      setup: { ...defaultAnalysisView().setup, zoneId: 5 },
    };
    expect(pickTimetable(start, 3).setup.zoneId).toBe(5);
    expect(nameSetup(start, 'x').setup.zoneId).toBe(5);
  });
});

describe('changeSettings (FR-8, FR-9)', () => {
  it('changes the settings given and keeps the rest', () => {
    const view = changeSettings(defaultAnalysisView(), { maxWalkM: 400, parkingMins: 10 });
    expect(view.setup.settings).toEqual({ ...DEFAULTS, maxWalkM: 400, parkingMins: 10 });
  });

  it('never changes the starting values', () => {
    changeSettings(defaultAnalysisView(), { spacingM: 100, departSecs: 0 });
    expect(DEFAULT_ANALYSIS_SETTINGS).toEqual(DEFAULTS);
  });
});

describe('toggleMode (FR-8)', () => {
  it('takes a mode out and puts it back', () => {
    const without = toggleMode(defaultAnalysisView(), 'bus');
    expect(without.setup.settings.modes).not.toContain('bus');
    expect(toggleMode(without, 'bus').setup.settings.modes).toContain('bus');
  });

  it('allows school buses when ticked', () => {
    expect(toggleMode(defaultAnalysisView(), 'school_bus').setup.settings.modes).toContain(
      'school_bus',
    );
    expect(DEFAULT_ANALYSIS_SETTINGS).toEqual(DEFAULTS);
  });
});

describe('changeFactor (FR-9)', () => {
  it('changes one part of the day', () => {
    const view = changeFactor(defaultAnalysisView(), 'am', 1.6);
    expect(view.setup.settings.trafficFactors).toEqual({ ...DEFAULTS.trafficFactors, am: 1.6 });
    expect(DEFAULT_ANALYSIS_SETTINGS).toEqual(DEFAULTS);
  });
});
