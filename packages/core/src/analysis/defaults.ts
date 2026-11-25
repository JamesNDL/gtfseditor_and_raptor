// The settings of an access analysis, their starting values (D34) and their checks (FR-8, FR-9).
import { DAY_BANDS } from '../time.ts';

/** The id of a part of the day in DAY_BANDS. */
export type DayBandId = (typeof DAY_BANDS)[number]['id'];

/** The traffic factor for each part of the day: the drive time is multiplied by it (FR-9). */
export type TrafficFactors = Record<DayBandId, number>;

/** What an analysis is run with. Times are seconds since the start of the service day. */
export interface AnalysisSettings {
  departSecs: number;
  /** Distance between sample points, in metres (checked by `analysisProblem` in limits.ts). */
  spacingM: number;
  /** Longest walk to or from a stop, in metres. */
  maxWalkM: number;
  /** Longest journey; a slower one is no service. */
  maxJourneyMins: number;
  maxChanges: number;
  /** The journey router's mode ids that may be used. */
  modes: string[];
  /** The parking allowance, added to every car time. */
  parkingMins: number;
  trafficFactors: TrafficFactors;
  /** The access ratios the lines of equal ratio are drawn at, rising. */
  breaks: number[];
}

/** The starting settings (D34): 08:00, 250 m, 800 m walk, 120 minutes, 3 changes, no school buses. */
export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  departSecs: 8 * 3600,
  spacingM: 250,
  maxWalkM: 800,
  maxJourneyMins: 120,
  maxChanges: 3,
  modes: ['train', 'metro', 'light_rail', 'ferry', 'bus', 'coach', 'other'],
  parkingMins: 5,
  trafficFactors: { early: 1.0, am: 1.4, day: 1.2, pm: 1.4, evening: 1.0 },
  breaks: [1, 1.5, 2, 3, 4],
};

const n = (value: number): string => value.toLocaleString('en-AU');

/** True when value is a number from min to max, both included. */
const within = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

/** The problem with the lines of equal ratio, or null. */
function breaksProblem(breaks: number[]): string | null {
  if (breaks.length < 1 || breaks.length > 8) return 'Give between 1 and 8 lines.';
  if (!breaks.every((b) => within(b, 0.1, 20))) return 'Each line must be between 0.1 and 20.';
  if (breaks.some((b, k) => b <= (breaks[k - 1] ?? -Infinity))) {
    return 'Each line must be higher than the one before.';
  }
  return null;
}

/** The problem with the traffic factors, naming the part of the day, or null. */
function factorsProblem(factors: TrafficFactors): string | null {
  const band = DAY_BANDS.find((b) => !within(factors[b.id], 0.5, 3));
  return band ? `The traffic factor for the ${band.label} must be between 0.5 and 3.` : null;
}

/**
 * Why these settings cannot be used, in plain English, or null when they are all in range.
 * The spacing is not checked here: `analysisProblem` in limits.ts does that with the counts.
 */
export function settingsProblem(s: AnalysisSettings): string | null {
  if (!within(s.departSecs, 0, 36 * 3600)) {
    return 'The departure time must be between 00:00 and 36:00.';
  }
  if (!within(s.maxWalkM, 100, 2000)) {
    return `The longest walk must be between 100 and ${n(2000)} m.`;
  }
  if (!within(s.maxJourneyMins, 10, 240)) {
    return 'The longest journey must be between 10 and 240 minutes.';
  }
  if (!within(s.maxChanges, 0, 7) || !Number.isInteger(s.maxChanges)) {
    return 'The most changes must be a whole number between 0 and 7.';
  }
  if (!within(s.parkingMins, 0, 60)) {
    return 'The parking allowance must be between 0 and 60 minutes.';
  }
  return factorsProblem(s.trafficFactors) ?? breaksProblem(s.breaks);
}
