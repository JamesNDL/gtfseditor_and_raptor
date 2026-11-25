// FR-21, D40: an arrive-by analysis asks the journey router for journeys that arrive by its time
// (`arriveBy` in place of `depart`, D38), and counts each pair's public transport time to that
// time, so the early wait is in it and is stored. A depart-at analysis asks and counts as before.
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisSettings } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import type { BulkJourney, JourneyLine } from './journeys-client.ts';
import { journeyQueryOf, pairResultOf, type PendingPair } from './pair-result.ts';

const MIN = 60;
const clock = (h: number, m: number): number => h * 3600 + m * MIN;

const pair: PendingPair = {
  poiSeq: 1,
  pointSeq: 7,
  lon: 151.7,
  lat: -32.9,
  poiLon: 151.69,
  poiLat: -32.94,
  carSecs: 20 * MIN,
};

const arriveBy: AnalysisSettings = {
  ...DEFAULT_ANALYSIS_SETTINGS,
  timeMode: 'arriveBy',
  departSecs: clock(8, 0),
};

const stop = (time: number) => ({ stop: 'S', name: 'Stop', lat: -32.9, lon: 151.7, time });

/** AC-FR-21.1: leave 07:05, arrive 07:35 (the router's earlyWait is 25 min). */
const journey: BulkJourney = {
  depart: clock(7, 5),
  arrive: clock(7, 35),
  walkSecs: 8 * MIN,
  rides: 1,
  legs: [
    { type: 'walk', depart: clock(7, 5), arrive: clock(7, 10), metres: 300 },
    {
      type: 'ride',
      trip: 'T1',
      route: '100',
      mode: 'bus',
      depart: clock(7, 12),
      arrive: clock(7, 32),
      board: stop(clock(7, 12)),
      alight: stop(clock(7, 32)),
    },
    { type: 'walk', depart: clock(7, 32), arrive: clock(7, 35), metres: 200 },
  ],
};
const line: JourneyLine = { id: '1:7', status: 'ok', journey };

describe('journeyQueryOf', () => {
  it('asks to depart at the time for a depart-at analysis', () => {
    expect(journeyQueryOf(pair, DEFAULT_ANALYSIS_SETTINGS)).toEqual({
      id: '1:7',
      from: { lat: -32.9, lon: 151.7 },
      to: { lat: -32.94, lon: 151.69 },
      depart: clock(8, 0),
    });
  });

  it('asks to arrive by the time for an arrive-by analysis, with no depart', () => {
    const query = journeyQueryOf(pair, arriveBy);
    expect(query).toEqual({
      id: '1:7',
      from: { lat: -32.9, lon: 151.7 },
      to: { lat: -32.94, lon: 151.69 },
      arriveBy: clock(8, 0),
    });
    expect('depart' in query).toBe(false);
  });
});

describe('pairResultOf', () => {
  it('AC-FR-21.1: counts an arrive-by pair to the arrive-by time, early wait and all', () => {
    const result = pairResultOf(pair, line, arriveBy);
    expect(result.status).toBe('ok');
    expect(result.split).toMatchObject({ ptSecs: 55 * MIN, earlyWaitSecs: 25 * MIN });
    expect(result.ratio).toBeCloseTo(55 / 20);
  });

  it('makes an arrive-by pair over the longest journey no service, keeping its time', () => {
    const result = pairResultOf(pair, line, { ...arriveBy, maxJourneyMins: 50 });
    expect(result.status).toBe('noService');
    expect(result.split?.ptSecs).toBe(55 * MIN);
    expect(result.ratio).toBeNull();
  });

  it('makes no journey in time no service (FR-21)', () => {
    const none: JourneyLine = {
      id: '1:7',
      status: 'noJourney',
      reason: 'Nothing gets there by that time on this service day.',
    };
    expect(pairResultOf(pair, none, arriveBy)).toEqual({
      status: 'noService',
      split: null,
      legs: null,
      ratio: null,
    });
  });

  it('counts a depart-at pair from the departure, with no early wait', () => {
    const early = { ...DEFAULT_ANALYSIS_SETTINGS, departSecs: clock(7, 0) };
    const result = pairResultOf(pair, line, early);
    expect(result.split).toMatchObject({ ptSecs: 35 * MIN, earlyWaitSecs: 0 });
  });

  it('stops the run on a line with an error, or a missing answer', () => {
    const error: JourneyLine = { id: '1:7', status: 'error', reason: 'bad stop' };
    expect(() => pairResultOf(pair, error, arriveBy)).toThrow('bad stop');
    expect(() => pairResultOf(pair, undefined, arriveBy)).toThrow('did not answer');
  });
});
