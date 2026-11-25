// Arrive-by (FR-21, D40): how an analysis's time is used, named in words, read from settings
// stored before arrive-by, and the public transport time of an arrive-by pair, which runs from the
// journey's departure to the arrive-by time so that the early wait counts.
import { formatSecs } from '../time.ts';
import type { AnalysisSettings, TimeMode } from './defaults.ts';
import { ptSplit, type PtSplit, type RouterJourney } from './ratio.ts';

/** Settings as stored: those saved before arrive-by have no time mode. */
export type StoredAnalysisSettings = Omit<AnalysisSettings, 'timeMode'> & { timeMode?: TimeMode };

/** Stored settings with their time mode; none is depart-at, as every analysis was before. */
export const withTimeMode = (stored: StoredAnalysisSettings): AnalysisSettings => ({
  ...stored,
  timeMode: stored.timeMode ?? 'depart',
});

/** The time in words, as the settings line, list and export say it: "Depart 08:00", "Arrive by 08:00". */
export function timeText(s: Pick<AnalysisSettings, 'timeMode' | 'departSecs'>): string {
  const clock = formatSecs(s.departSecs);
  return s.timeMode === 'arriveBy' ? `Arrive by ${clock}` : `Depart ${clock}`;
}

/**
 * An arrive-by journey's public transport time and split (FR-21, AC-FR-21.1): from when it leaves
 * until the arrive-by time. The early wait is the time between arriving and the arrive-by time;
 * the wait is what is left after the walks, the rides and the early wait (waits between rides).
 */
export function arriveBySplit(journey: RouterJourney, arriveBySecs: number): PtSplit {
  const fromDeparture = ptSplit(journey, journey.depart);
  const earlyWaitSecs = arriveBySecs - journey.arrive;
  return {
    ...fromDeparture,
    ptSecs: arriveBySecs - journey.depart,
    earlyWaitSecs,
  };
}

/** A pair's split as its analysis counts it: from the departure, or to the arrive-by time. */
export function journeySplit(
  journey: RouterJourney,
  settings: Pick<AnalysisSettings, 'timeMode' | 'departSecs'>,
): PtSplit {
  return settings.timeMode === 'arriveBy'
    ? arriveBySplit(journey, settings.departSecs)
    : ptSplit(journey, settings.departSecs);
}
