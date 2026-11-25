// AA-21 (FR-15, NFR-6; AC-FR-15.1, AC 3): what one sample point's detail says: each walk, wait
// and ride of its journey in plain words, the walk/wait/ride split, the car time, and what is said
// when there is no journey or the car path could not be fetched.
import type { PointDetail, PointLeg, PointRideLeg, PtSplit } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import type { ModeLook } from '../point-journey.ts';
import {
  carPathText,
  carText,
  distanceText,
  journeyText,
  legRows,
  minutesText,
  splitParts,
} from './point-detail-text.ts';

const look = (modeId: string): ModeLook =>
  modeId === 'bus' ? { name: 'Bus', colour: '#00b5ef' } : { name: 'Train', colour: '#f6891f' };

const stop = (name: string, time: number) => ({ name, lat: -33.9, lon: 151.2, time });

/** A ride's path as the API gives it: along its trip unless said otherwise. */
const along: Pick<PointRideLeg, 'path' | 'pathFrom'> = {
  path: [
    [151.2, -33.9],
    [151.21, -33.91],
    [151.2, -33.9],
  ],
  pathFrom: 'shape',
};

/** Leaves at 08:00; walks 6 min, waits, Bus 333 08:10 to 08:22, changes, Train 08:30 to 08:40. */
const LEGS: PointLeg[] = [
  { type: 'walk', secs: 360, metres: 447 },
  {
    type: 'ride',
    route: '333',
    mode: 'bus',
    board: stop('Bondi Junction', 8 * 3600 + 600),
    alight: stop('Central', 8 * 3600 + 1320),
    secs: 720,
    metres: 6100,
    ...along,
  },
  { type: 'transfer', secs: 180, metres: 160 },
  {
    type: 'ride',
    route: 'T1',
    mode: 'train',
    board: stop('Central', 8 * 3600 + 1800),
    alight: stop('Strathfield', 8 * 3600 + 2400),
    secs: 600,
    metres: 11000,
    ...along,
  },
  { type: 'walk', secs: 240, metres: 1260 },
];

/** The split of LEGS from 08:00. */
const PT: PtSplit = {
  ptSecs: 2640,
  walkSecs: 780,
  waitSecs: 540,
  rideSecs: 1320,
  earlyWaitSecs: 0,
  rides: 2,
};

const detail = (over: Partial<PointDetail> = {}): PointDetail => ({
  seq: 7,
  i: 2,
  j: 1,
  lon: 151.2,
  lat: -33.9,
  poiSeq: 0,
  status: 'ok',
  pt: PT,
  legs: LEGS,
  driveSecs: 600,
  driveMetres: 7200,
  carSecs: 1140,
  trafficFactor: 1.4,
  parkingSecs: 300,
  ratio: 2.3157,
  carPath: [
    [151.2, -33.9],
    [151.1, -33.87],
  ],
  carPathMessage: null,
  ...over,
});

describe('minutesText and distanceText', () => {
  it('gives whole minutes, and says under a minute rather than 0', () => {
    expect(minutesText(360)).toBe('6 min');
    expect(minutesText(389)).toBe('6 min');
    expect(minutesText(391)).toBe('7 min');
    expect(minutesText(20)).toBe('under 1 min');
    expect(minutesText(5400)).toBe('90 min');
  });

  it('gives walk distances as about, rounded, in metres or kilometres', () => {
    expect(distanceText(447)).toBe('about 450 m');
    expect(distanceText(12)).toBe('about 10 m');
    expect(distanceText(1260)).toBe('about 1.3 km');
  });
});

describe('legRows (AC-FR-15.1)', () => {
  it('lists each walk, wait, ride and change in order, with the lines used', () => {
    expect(legRows(LEGS, 8 * 3600, look).map((r) => [r.kind, r.text])).toEqual([
      ['walk', 'Walk 6 min (about 450 m)'],
      ['wait', 'Wait 4 min'],
      ['ride', 'Bus 333 from Bondi Junction to Central, 12 min'],
      ['change', 'Change: walk 3 min (about 160 m)'],
      ['wait', 'Wait 5 min'],
      ['ride', 'Train T1 from Central to Strathfield, 10 min'],
      ['walk', 'Walk 4 min (about 1.3 km)'],
    ]);
  });

  it('gives each ride its mode colour, and the others none', () => {
    const rows = legRows(LEGS, 8 * 3600, look);
    expect(rows.filter((r) => r.kind === 'ride').map((r) => r.colour)).toEqual([
      '#00b5ef',
      '#f6891f',
    ]);
    expect(rows.filter((r) => r.kind !== 'ride').every((r) => r.colour === null)).toBe(true);
  });

  it('leaves out an empty walk and a wait of under half a minute', () => {
    const legs: PointLeg[] = [
      { type: 'walk', secs: 0, metres: 0 },
      {
        type: 'ride',
        route: '333',
        mode: 'bus',
        board: stop('A', 8 * 3600 + 20),
        alight: stop('B', 8 * 3600 + 620),
        secs: 600,
        metres: 3000,
        ...along,
      },
    ];
    expect(legRows(legs, 8 * 3600, look).map((r) => r.text)).toEqual([
      'Bus 333 from A to B, 10 min',
    ]);
  });

  it('says a change at the same stop without a walk', () => {
    const legs: PointLeg[] = [LEGS[1], { type: 'transfer', secs: 0, metres: 0 }, LEGS[3]];
    expect(legRows(legs, 8 * 3600 + 600, look).map((r) => r.text)).toEqual([
      'Bus 333 from Bondi Junction to Central, 12 min',
      'Change at Central',
      'Wait 8 min',
      'Train T1 from Central to Strathfield, 10 min',
    ]);
  });

  it('says when a ride is drawn straight because its path is not known (D39)', () => {
    const ride = LEGS[1];
    if (ride.type !== 'ride') throw new Error('the test legs changed');
    const straight: PointLeg = { ...ride, path: [], pathFrom: 'straight' };
    expect(legRows([straight], 8 * 3600 + 600, look).map((r) => r.text)).toEqual([
      'Bus 333 from Bondi Junction to Central, 12 min (path not known, drawn straight)',
    ]);
  });
});

describe('splitParts (AC-FR-15.1)', () => {
  it('splits the public transport time into walking, waiting and riding, as shares of it', () => {
    const parts = splitParts(PT);
    expect(parts.map((p) => [p.kind, p.label])).toEqual([
      ['walk', 'Walk 13 min'],
      ['wait', 'Wait 9 min'],
      ['ride', 'Ride 22 min'],
    ]);
    expect(parts.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1);
    expect(parts[2].share).toBeCloseTo(1320 / 2640);
  });

  it('gives no shares for a journey of no time', () => {
    const parts = splitParts({
      ptSecs: 0,
      walkSecs: 0,
      waitSecs: 0,
      rideSecs: 0,
      earlyWaitSecs: 0,
      rides: 0,
    });
    expect(parts.every((p) => p.share === 0)).toBe(true);
  });
});

describe('carText and journeyText', () => {
  it('shows how the car time is made up', () => {
    expect(carText(detail())).toBe('19 min (drive 10 min × 1.4 traffic + 5 min parking)');
  });

  it('says there is no road when there is no drive', () => {
    expect(carText(detail({ status: 'noRoad', driveSecs: null, carSecs: null }))).toBe(
      'No drive found',
    );
  });

  it('gives the public transport time, or why there is none', () => {
    expect(journeyText(detail(), 120)).toBe('44 min');
    expect(journeyText(detail({ status: 'noService', pt: null, legs: null }), 120)).toBe(
      'No journey found within the limits',
    );
    const long = detail({
      status: 'noService',
      ratio: null,
      pt: {
        ptSecs: 8000,
        walkSecs: 600,
        waitSecs: 1400,
        rideSecs: 6000,
        earlyWaitSecs: 0,
        rides: 2,
      },
    });
    expect(journeyText(long, 120)).toBe('133 min: longer than the longest journey (120 min)');
  });
});

describe('carPathText (AC 3)', () => {
  it('says nothing when the car path is drawn', () => {
    expect(carPathText(detail())).toBeNull();
  });

  it('says the car path could not be fetched when the road router is not answering', () => {
    const down = detail({ carPath: null, carPathMessage: 'fetch failed' });
    expect(carPathText(down)).toBe('The car path could not be fetched (fetch failed).');
  });

  it('says there is no car path when there is no road', () => {
    const noRoad = detail({
      status: 'noRoad',
      carPath: null,
      carPathMessage: 'No road near the start',
    });
    expect(carPathText(noRoad)).toBe('There is no car path: no drive was found from here.');
  });
});
