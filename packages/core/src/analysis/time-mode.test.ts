// Arrive-by (FR-21, AC-FR-21.1, FR-9, D40): the public transport time of an arrive-by pair runs
// from the journey's departure to the arrive-by time, so the early wait counts; the car time takes
// the traffic factor of the part of the day the arrive-by time falls in; the time is named
// "Depart 08:00" or "Arrive by 08:00"; and settings stored before arrive-by read as depart-at.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisSettings } from './defaults.ts';
import { pairStatus, trafficFactorAt, type RouterJourney } from './ratio.ts';
import {
  arriveBySplit,
  journeySplit,
  timeText,
  withTimeMode,
  type StoredAnalysisSettings,
} from './time-mode.ts';

const MIN = 60;
const clock = (h: number, m: number): number => h * 3600 + m * MIN;

/** AC-FR-21.1: leave the sample point 07:05, walk, bus, walk, arrive 07:35. */
const bus: RouterJourney = {
  depart: clock(7, 5),
  arrive: clock(7, 35),
  walkSecs: 8 * MIN,
  rides: 1,
  legs: [
    { type: 'walk', depart: clock(7, 5), arrive: clock(7, 10) },
    {
      type: 'ride',
      depart: clock(7, 12),
      arrive: clock(7, 32),
      board: { time: clock(7, 12) },
      alight: { time: clock(7, 32) },
    },
    { type: 'walk', depart: clock(7, 32), arrive: clock(7, 35) },
  ],
};

const arriveBy = (change: Partial<AnalysisSettings> = {}): AnalysisSettings => ({
  ...DEFAULT_ANALYSIS_SETTINGS,
  timeMode: 'arriveBy',
  departSecs: clock(8, 0),
  ...change,
});

describe('arriveBySplit (FR-21)', () => {
  it('AC-FR-21.1: leave 07:05, arrive 07:35, arrive by 08:00 is 55 min, 25 of them early wait', () => {
    expect(arriveBySplit(bus, clock(8, 0))).toEqual({
      ptSecs: 55 * MIN,
      walkSecs: 8 * MIN,
      waitSecs: 2 * MIN,
      rideSecs: 20 * MIN,
      earlyWaitSecs: 25 * MIN,
      rides: 1,
    });
  });

  it('has no early wait when the journey arrives on the dot', () => {
    const split = arriveBySplit(bus, clock(7, 35));
    expect(split.earlyWaitSecs).toBe(0);
    expect(split.ptSecs).toBe(30 * MIN);
  });

  it('the parts add up to the public transport time', () => {
    const s = arriveBySplit(bus, clock(8, 0));
    expect(s.walkSecs + s.waitSecs + s.rideSecs + s.earlyWaitSecs).toBe(s.ptSecs);
  });
});

describe('journeySplit', () => {
  it('counts an arrive-by pair to the arrive-by time', () => {
    expect(journeySplit(bus, arriveBy()).ptSecs).toBe(55 * MIN);
  });

  it('counts a depart-at pair from the departure, with no early wait (D23)', () => {
    const split = journeySplit(bus, { ...DEFAULT_ANALYSIS_SETTINGS, departSecs: clock(7, 0) });
    expect(split.ptSecs).toBe(35 * MIN);
    expect(split.earlyWaitSecs).toBe(0);
  });

  it('applies the longest journey to the time with the early wait in it', () => {
    const settings = arriveBy({ maxJourneyMins: 50 });
    const { ptSecs } = journeySplit(bus, settings);
    expect(pairStatus({ journeyFound: true, ptSecs, carSecs: 600 }, settings)).toBe('noService');
    const roomy = arriveBy({ maxJourneyMins: 55 });
    expect(pairStatus({ journeyFound: true, ptSecs, carSecs: 600 }, roomy)).toBe('ok');
  });
});

describe('the traffic factor for an arrive-by time (FR-9)', () => {
  it('takes the part of the day the arrive-by time falls in', () => {
    const s = arriveBy();
    expect(trafficFactorAt(s.departSecs, s.trafficFactors)).toBe(1.4);
    const midday = arriveBy({ departSecs: clock(10, 0) });
    expect(trafficFactorAt(midday.departSecs, midday.trafficFactors)).toBe(1.2);
  });
});

describe('timeText (AC-FR-21.3)', () => {
  it('names the time and how it is used', () => {
    expect(timeText({ timeMode: 'depart', departSecs: clock(8, 0) })).toBe('Depart 08:00');
    expect(timeText({ timeMode: 'arriveBy', departSecs: clock(8, 0) })).toBe('Arrive by 08:00');
    expect(timeText({ timeMode: 'arriveBy', departSecs: clock(24, 30) })).toBe('Arrive by 24:30');
  });
});

describe('withTimeMode', () => {
  it('reads settings stored before arrive-by as depart-at', () => {
    const { timeMode: _mode, ...old } = DEFAULT_ANALYSIS_SETTINGS;
    const stored: StoredAnalysisSettings = old;
    expect(withTimeMode(stored)).toEqual(DEFAULT_ANALYSIS_SETTINGS);
    expect(withTimeMode(stored).timeMode).toBe('depart');
  });

  it('keeps an arrive-by time mode', () => {
    expect(withTimeMode(arriveBy()).timeMode).toBe('arriveBy');
  });
});
