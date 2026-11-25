// The traffic factor, car time, access ratio, pair status and public transport time split
// (FR-9, FR-11, FR-12, D23).
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS } from './defaults.ts';
import {
  accessRatio,
  carSecs,
  pairStatus,
  ptSplit,
  trafficFactorAt,
  type RouterJourney,
} from './ratio.ts';

const MIN = 60;
const clock = (h: number, m: number): number => h * 3600 + m * MIN;
const factors = { early: 1.0, am: 1.4, day: 1.2, pm: 1.4, evening: 1.1 };

describe('trafficFactorAt', () => {
  it('uses the DAY_BANDS edges: 06:29 early, 06:30 morning peak, 15:00 evening peak, 19:00 evening', () => {
    expect(trafficFactorAt(clock(6, 29), factors)).toBe(1.0);
    expect(trafficFactorAt(clock(6, 30), factors)).toBe(1.4);
    expect(trafficFactorAt(clock(9, 30), factors)).toBe(1.2);
    expect(trafficFactorAt(clock(15, 0), factors)).toBe(1.4);
    expect(trafficFactorAt(clock(19, 0), factors)).toBe(1.1);
  });

  it('takes a time past 24:00 as evening', () => {
    expect(trafficFactorAt(clock(25, 10), factors)).toBe(1.1);
  });
});

describe('carSecs', () => {
  it('AC-FR-9.1: 08:00 departure, factor 1.4, parking 5 min, drive 10 min gives 19 min', () => {
    const factor = trafficFactorAt(clock(8, 0), DEFAULT_ANALYSIS_SETTINGS.trafficFactors);
    expect(factor).toBe(1.4);
    expect(carSecs(10 * MIN, factor, 5 * MIN)).toBeCloseTo(19 * MIN, 6);
  });
});

describe('accessRatio', () => {
  it('AC-FR-11.1: 30 min by public transport and 15 min by car gives 2.0', () => {
    expect(accessRatio(30 * MIN, 15 * MIN)).toBe(2.0);
  });

  it('gives no ratio when the car time is not above zero', () => {
    expect(accessRatio(30 * MIN, 0)).toBeNull();
  });
});

describe('pairStatus', () => {
  const settings = { maxJourneyMins: 120 };

  it('is ok with a journey within the limits and a drive', () => {
    expect(pairStatus({ journeyFound: true, ptSecs: 40 * MIN, carSecs: 600 }, settings)).toBe('ok');
  });

  it('AC-FR-12.1: no journey is no service', () => {
    expect(pairStatus({ journeyFound: false, ptSecs: null, carSecs: 600 }, settings)).toBe(
      'noService',
    );
  });

  it('AC-FR-12.1: a journey longer than the longest journey is no service', () => {
    expect(pairStatus({ journeyFound: true, ptSecs: 121 * MIN, carSecs: 600 }, settings)).toBe(
      'noService',
    );
    expect(pairStatus({ journeyFound: true, ptSecs: 120 * MIN, carSecs: 600 }, settings)).toBe(
      'ok',
    );
  });

  it('AC-FR-12.1: no drive is no road', () => {
    expect(pairStatus({ journeyFound: true, ptSecs: 40 * MIN, carSecs: null }, settings)).toBe(
      'noRoad',
    );
  });

  it('AC-FR-20.1: a car time of zero is no road, so every ok pair has a ratio', () => {
    // A sample point on the same road spot as its point of interest, with no parking allowance.
    expect(pairStatus({ journeyFound: true, ptSecs: 10 * MIN, carSecs: 0 }, settings)).toBe(
      'noRoad',
    );
  });

  it('AC-FR-12.1: no service wins over no road', () => {
    expect(pairStatus({ journeyFound: false, ptSecs: null, carSecs: null }, settings)).toBe(
      'noService',
    );
  });
});

describe('ptSplit', () => {
  it('D23: counts from the asked departure, so the wait before the first ride is included', () => {
    // Asked 08:00; walk 08:07 to 08:11, wait, ride 08:15 to 08:35.
    const journey: RouterJourney = {
      depart: clock(8, 7),
      arrive: clock(8, 35),
      walkSecs: 4 * MIN,
      rides: 1,
      legs: [
        { type: 'walk', depart: clock(8, 7), arrive: clock(8, 11) },
        {
          type: 'ride',
          depart: clock(8, 15),
          arrive: clock(8, 35),
          board: { time: clock(8, 15) },
          alight: { time: clock(8, 35) },
        },
      ],
    };
    expect(ptSplit(journey, clock(8, 0))).toEqual({
      ptSecs: 35 * MIN,
      walkSecs: 4 * MIN,
      waitSecs: 11 * MIN,
      rideSecs: 20 * MIN,
      rides: 1,
    });
  });

  it('adds the waits between rides to the wait', () => {
    // Asked 08:00; ride 08:05 to 08:20, change, ride 08:30 to 08:50, walk 08:50 to 08:55.
    const journey: RouterJourney = {
      depart: clock(8, 5),
      arrive: clock(8, 55),
      walkSecs: 5 * MIN,
      rides: 2,
      legs: [
        {
          type: 'ride',
          depart: clock(8, 5),
          arrive: clock(8, 20),
          board: { time: clock(8, 5) },
          alight: { time: clock(8, 20) },
        },
        {
          type: 'ride',
          depart: clock(8, 30),
          arrive: clock(8, 50),
          board: { time: clock(8, 30) },
          alight: { time: clock(8, 50) },
        },
        { type: 'walk', depart: clock(8, 50), arrive: clock(8, 55) },
      ],
    };
    expect(ptSplit(journey, clock(8, 0))).toEqual({
      ptSecs: 55 * MIN,
      walkSecs: 5 * MIN,
      waitSecs: 15 * MIN,
      rideSecs: 35 * MIN,
      rides: 2,
    });
  });
});
