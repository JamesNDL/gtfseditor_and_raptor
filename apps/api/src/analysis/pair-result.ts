// One pair of an access analysis run on the public transport side (D21, D23, D40; docs/
// architecture/access-analysis.md §4.4): the query sent to the journey router's bulk journeys,
// leaving at the analysis's time or arriving by it (FR-21), and what its answer line means: the
// public transport time and split (with the early wait for arrive-by), the stored legs, the status
// and, when it is ok, the access ratio.
import {
  accessRatio,
  journeySplit,
  pairStatus,
  type AnalysisSettings,
  type PairStatus,
  type PtSplit,
  type StoredLeg,
} from '@gtfs-editor/core';
import type { JourneyLine, JourneyQuery } from './journeys-client.ts';
import { storedLegs } from './stored-legs.ts';

/** A pending pair: its two ends and its car time, already worked out. */
export interface PendingPair {
  poiSeq: number;
  pointSeq: number;
  lon: number;
  lat: number;
  poiLon: number;
  poiLat: number;
  carSecs: number | null;
}

/** A pair's worked-out public transport side, ready to store. */
export interface PairResult {
  status: Exclude<PairStatus, 'pending'>;
  split: PtSplit | null;
  legs: StoredLeg[] | null;
  ratio: number | null;
}

/** The query id of a pair: '<poi seq>:<point seq>'. */
export const pairId = (pair: Pick<PendingPair, 'poiSeq' | 'pointSeq'>): string =>
  `${pair.poiSeq}:${pair.pointSeq}`;

/** The journey asked for a pair: from the sample point to the point of interest, at the time. */
export function journeyQueryOf(pair: PendingPair, settings: AnalysisSettings): JourneyQuery {
  const ends = {
    id: pairId(pair),
    from: { lat: pair.lat, lon: pair.lon },
    to: { lat: pair.poiLat, lon: pair.poiLon },
  };
  return settings.timeMode === 'arriveBy'
    ? { ...ends, arriveBy: settings.departSecs }
    : { ...ends, depart: settings.departSecs };
}

/**
 * What one answer line means for its pair (FR-11, FR-12, FR-21). No journey, or none in time, is
 * no service; so is one longer than the longest journey, which keeps its time and split. A line
 * with an error, or no line, stops the run.
 */
export function pairResultOf(
  pair: PendingPair,
  line: JourneyLine | undefined,
  settings: AnalysisSettings,
): PairResult {
  if (!line) throw new Error('The journey router did not answer every journey');
  if (line.status === 'error') {
    throw new Error(`The journey router could not plan a journey: ${line.reason}`);
  }
  const journey = line.status === 'ok' ? line.journey : null;
  const split = journey ? journeySplit(journey, settings) : null;
  const status = pairStatus(
    { journeyFound: journey !== null, ptSecs: split?.ptSecs ?? null, carSecs: pair.carSecs },
    settings,
  );
  const ratio =
    status === 'ok' && split && pair.carSecs !== null
      ? accessRatio(split.ptSecs, pair.carSecs)
      : null;
  return { status, split, legs: journey ? storedLegs(journey) : null, ratio };
}
