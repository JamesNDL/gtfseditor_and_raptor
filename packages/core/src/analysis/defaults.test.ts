// The starting settings of an access analysis (D34, FR-8, FR-9) and their checks.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS, settingsProblem, type AnalysisSettings } from './defaults.ts';

/** The starting settings with some fields changed. */
const withChange = (change: Partial<AnalysisSettings>): AnalysisSettings => ({
  ...DEFAULT_ANALYSIS_SETTINGS,
  ...change,
});

describe('DEFAULT_ANALYSIS_SETTINGS', () => {
  it('D34: holds the agreed starting values', () => {
    expect(DEFAULT_ANALYSIS_SETTINGS).toEqual({
      timeMode: 'depart',
      departSecs: 28_800,
      spacingM: 250,
      maxWalkM: 800,
      maxJourneyMins: 120,
      maxChanges: 3,
      modes: ['train', 'metro', 'light_rail', 'ferry', 'bus', 'coach', 'other'],
      parkingMins: 5,
      trafficFactors: { early: 1.0, am: 1.4, day: 1.2, pm: 1.4, evening: 1.0 },
      breaks: [1, 1.5, 2, 3, 4],
    });
  });

  it('FR-8: leaves school buses out of the modes', () => {
    expect(DEFAULT_ANALYSIS_SETTINGS.modes).not.toContain('school_bus');
  });

  it('passes its own checks', () => {
    expect(settingsProblem(DEFAULT_ANALYSIS_SETTINGS)).toBeNull();
  });
});

describe('settingsProblem', () => {
  it('passes values at the ends of each range', () => {
    const low = withChange({
      departSecs: 0,
      maxWalkM: 100,
      maxJourneyMins: 10,
      maxChanges: 0,
      parkingMins: 0,
      trafficFactors: { early: 0.5, am: 0.5, day: 0.5, pm: 0.5, evening: 0.5 },
      breaks: [0.1],
    });
    const high = withChange({
      departSecs: 36 * 3600,
      maxWalkM: 2000,
      maxJourneyMins: 240,
      maxChanges: 7,
      parkingMins: 60,
      trafficFactors: { early: 3, am: 3, day: 3, pm: 3, evening: 3 },
      breaks: [1, 2, 3, 4, 5, 6, 7, 20],
    });
    expect(settingsProblem(low)).toBeNull();
    expect(settingsProblem(high)).toBeNull();
  });

  it('refuses a longest walk outside 100 to 2,000 m, with the reason', () => {
    expect(settingsProblem(withChange({ maxWalkM: 99 }))).toBe(
      'The longest walk must be between 100 and 2,000 m.',
    );
    expect(settingsProblem(withChange({ maxWalkM: 2001 }))).not.toBeNull();
  });

  it('refuses a longest journey outside 10 to 240 minutes', () => {
    expect(settingsProblem(withChange({ maxJourneyMins: 9 }))).toBe(
      'The longest journey must be between 10 and 240 minutes.',
    );
    expect(settingsProblem(withChange({ maxJourneyMins: 241 }))).not.toBeNull();
  });

  it('refuses most changes outside 0 to 7, or not a whole number', () => {
    expect(settingsProblem(withChange({ maxChanges: -1 }))).toBe(
      'The most changes must be a whole number between 0 and 7.',
    );
    expect(settingsProblem(withChange({ maxChanges: 8 }))).not.toBeNull();
    expect(settingsProblem(withChange({ maxChanges: 1.5 }))).not.toBeNull();
  });

  it('refuses a traffic factor outside 0.5 to 3, naming the part of the day', () => {
    const factors = { ...DEFAULT_ANALYSIS_SETTINGS.trafficFactors, pm: 3.1 };
    expect(settingsProblem(withChange({ trafficFactors: factors }))).toBe(
      'The traffic factor for the evening peak must be between 0.5 and 3.',
    );
    const low = { ...DEFAULT_ANALYSIS_SETTINGS.trafficFactors, early: 0.4 };
    expect(settingsProblem(withChange({ trafficFactors: low }))).not.toBeNull();
  });

  it('refuses a parking allowance outside 0 to 60 minutes', () => {
    expect(settingsProblem(withChange({ parkingMins: -1 }))).toBe(
      'The parking allowance must be between 0 and 60 minutes.',
    );
    expect(settingsProblem(withChange({ parkingMins: 61 }))).not.toBeNull();
  });

  it('refuses a departure time outside 00:00 to 36:00', () => {
    expect(settingsProblem(withChange({ departSecs: -1 }))).toBe(
      'The departure time must be between 00:00 and 36:00.',
    );
    expect(settingsProblem(withChange({ departSecs: 36 * 3600 + 1 }))).not.toBeNull();
  });

  it('FR-21: names the arrive-by time when it is out of range', () => {
    expect(settingsProblem(withChange({ timeMode: 'arriveBy', departSecs: -1 }))).toBe(
      'The arrive-by time must be between 00:00 and 36:00.',
    );
  });

  it('refuses no lines, or more than 8', () => {
    expect(settingsProblem(withChange({ breaks: [] }))).toBe('Give between 1 and 8 lines.');
    expect(settingsProblem(withChange({ breaks: [1, 2, 3, 4, 5, 6, 7, 8, 9] }))).not.toBeNull();
  });

  it('refuses lines that do not rise, or fall outside 0.1 to 20', () => {
    expect(settingsProblem(withChange({ breaks: [1, 2, 2] }))).toBe(
      'Each line must be higher than the one before.',
    );
    expect(settingsProblem(withChange({ breaks: [2, 1] }))).not.toBeNull();
    expect(settingsProblem(withChange({ breaks: [0.05, 1] }))).toBe(
      'Each line must be between 0.1 and 20.',
    );
    expect(settingsProblem(withChange({ breaks: [1, 21] }))).not.toBeNull();
  });

  it('refuses values that are not numbers', () => {
    expect(settingsProblem(withChange({ maxWalkM: Number.NaN }))).not.toBeNull();
    expect(settingsProblem(withChange({ breaks: [1, Number.NaN] }))).not.toBeNull();
  });
});
