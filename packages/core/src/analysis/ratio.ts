// The rules behind one pair's result: the traffic factor, the car time, the access ratio, the
// pair's status and the split of its public transport time (FR-9, FR-11, FR-12, D23).
import { bandOf, DAY_BANDS } from '../time.ts';
import type { AnalysisSettings, TrafficFactors } from './defaults.ts';

/** Where a pair stands: not yet worked out, has a ratio, no public transport, or no road. */
export type PairStatus = 'pending' | 'ok' | 'noService' | 'noRoad';

/** A ride leg of a journey router answer: the times it is boarded and left. */
export interface RouterRideLeg {
  type: 'ride';
  depart: number;
  arrive: number;
  board: { time: number };
  alight: { time: number };
}

/** A walk, a transfer between stops, or a warning in a journey router answer. */
export interface RouterOtherLeg {
  type: 'walk' | 'transfer' | 'warning';
  depart?: number;
  arrive?: number;
}

/** The part of a journey router journey (one line of `/v1/journeys/bulk`) the analysis reads. */
export interface RouterJourney {
  depart: number;
  arrive: number;
  walkSecs: number;
  rides: number;
  legs: (RouterRideLeg | RouterOtherLeg)[];
}

/** A pair's public transport time, from the asked departure, and how it splits up. */
export interface PtSplit {
  ptSecs: number;
  walkSecs: number;
  waitSecs: number;
  rideSecs: number;
  rides: number;
}

/** What a pair's status is worked out from. Times in seconds; null when there is none. */
export interface PairTimes {
  journeyFound: boolean;
  ptSecs: number | null;
  driveSecs: number | null;
}

/** The traffic factor for the part of the day (DAY_BANDS) the departure falls in. */
export function trafficFactorAt(departSecs: number, factors: TrafficFactors): number {
  const band = DAY_BANDS[bandOf(departSecs)] ?? DAY_BANDS[DAY_BANDS.length - 1];
  return factors[band.id];
}

/** The car time (FR-9): the free-flow drive times the traffic factor, plus the parking allowance. */
export function carSecs(driveSecs: number, factor: number, parkingSecs: number): number {
  return driveSecs * factor + parkingSecs;
}

/** The access ratio (FR-11): public transport time over car time; null if the car time is not above zero. */
export function accessRatio(ptSecs: number, carTimeSecs: number): number | null {
  return carTimeSecs > 0 ? ptSecs / carTimeSecs : null;
}

/**
 * A worked-out pair's status (FR-12). No journey, or one longer than the longest journey, is no
 * service; no drive is no road. No service wins when both apply.
 */
export function pairStatus(
  times: PairTimes,
  settings: Pick<AnalysisSettings, 'maxJourneyMins'>,
): Exclude<PairStatus, 'pending'> {
  const { journeyFound, ptSecs, driveSecs } = times;
  if (!journeyFound || ptSecs === null || ptSecs > settings.maxJourneyMins * 60) return 'noService';
  if (driveSecs === null) return 'noRoad';
  return 'ok';
}

/**
 * Splits a journey's public transport time (D23). It counts from the asked departure, not the
 * journey's own, as the router leaves as late as it can: waiting at home for the first vehicle is
 * waiting. The wait is what is left after the walks and the rides, so it includes changes.
 */
export function ptSplit(journey: RouterJourney, askedDepartSecs: number): PtSplit {
  const ptSecs = journey.arrive - askedDepartSecs;
  let rideSecs = 0;
  for (const leg of journey.legs) {
    if (leg.type === 'ride') rideSecs += leg.alight.time - leg.board.time;
  }
  const walkSecs = journey.walkSecs;
  return {
    ptSecs,
    walkSecs,
    waitSecs: ptSecs - walkSecs - rideSecs,
    rideSecs,
    rides: journey.rides,
  };
}
