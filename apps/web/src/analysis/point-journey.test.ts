// AA-21 (FR-15, D30, D39; AC 2): one sample point's journey as drawn on the map: rides along the
// path the API gives (the vehicle's path, or a straight line when it is not known), in their mode
// colour and labelled with the line; walks as straight lines joining the sample point, the stops
// and the point of interest; and the car path.
import type { Mode } from '../shared/api-client.ts';
import type { PointDetail, PointRideLeg } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import { journeyPieces, modeLook } from './point-journey.ts';

const MODES: Mode[] = [
  { id: 'bus', name: 'Bus', ruleSet: 'road', color: '00B5EF' },
  { id: 'train', name: 'Train', ruleSet: 'rail', color: 'F6891F' },
];
const look = (id: string) => modeLook(MODES, id);

const ride = (
  route: string,
  mode: string,
  from: [number, number],
  to: [number, number],
): PointRideLeg => ({
  type: 'ride',
  route,
  mode,
  board: { name: 'A', lon: from[0], lat: from[1], time: 29000 },
  alight: { name: 'B', lon: to[0], lat: to[1], time: 29600 },
  secs: 600,
  metres: 3000,
  // Along the vehicle's path: north first, then east, by way of a corner.
  path: [from, [from[0], to[1]], to],
  pathFrom: 'shape',
});

const POI = { lon: 151.3, lat: -33.8 };

const detail = (over: Partial<PointDetail> = {}): PointDetail => ({
  seq: 7,
  i: 0,
  j: 0,
  lon: 151.2,
  lat: -33.9,
  poiSeq: 0,
  status: 'ok',
  pt: { ptSecs: 2000, walkSecs: 500, waitSecs: 300, rideSecs: 1200, earlyWaitSecs: 0, rides: 2 },
  legs: [
    { type: 'walk', secs: 300, metres: 400 },
    ride('333', 'bus', [151.21, -33.9], [151.25, -33.85]),
    { type: 'transfer', secs: 0, metres: 0 },
    ride('T1', 'train', [151.25, -33.85], [151.29, -33.8]),
    { type: 'walk', secs: 200, metres: 250 },
  ],
  driveSecs: 600,
  driveMetres: 7000,
  carSecs: 1140,
  trafficFactor: 1.4,
  parkingSecs: 300,
  ratio: 1.75,
  carPath: [
    [151.2, -33.9],
    [151.26, -33.86],
    [151.3, -33.8],
  ],
  carPathMessage: null,
  ...over,
});

describe('modeLook', () => {
  it("gives a mode's name and colour, and a plain grey for a mode not known", () => {
    expect(look('bus')).toEqual({ name: 'Bus', colour: '#00B5EF' });
    expect(look('cable_car')).toEqual({ name: 'cable_car', colour: '#888888' });
  });
});

describe('journeyPieces (AC 2)', () => {
  it('draws rides along their paths in their mode colour, and walks straight between them', () => {
    const pieces = journeyPieces(detail(), POI, look).filter((p) => p.kind !== 'car');
    expect(pieces).toEqual([
      {
        kind: 'walk',
        colour: null,
        label: null,
        line: [
          [151.2, -33.9],
          [151.21, -33.9],
        ],
      },
      {
        kind: 'ride',
        colour: '#00B5EF',
        label: '333',
        line: [
          [151.21, -33.9],
          [151.21, -33.85],
          [151.25, -33.85],
        ],
      },
      {
        kind: 'ride',
        colour: '#F6891F',
        label: 'T1',
        line: [
          [151.25, -33.85],
          [151.25, -33.8],
          [151.29, -33.8],
        ],
      },
      {
        kind: 'walk',
        colour: null,
        label: null,
        line: [
          [151.29, -33.8],
          [151.3, -33.8],
        ],
      },
    ]);
  });

  it('draws a ride whose path is not known as the straight line the API gives', () => {
    const straight: PointRideLeg = {
      ...ride('333', 'bus', [151.21, -33.9], [151.25, -33.85]),
      path: [
        [151.21, -33.9],
        [151.25, -33.85],
      ],
      pathFrom: 'straight',
    };
    const pieces = journeyPieces(detail({ legs: [straight], carPath: null }), POI, look);
    expect(pieces.find((p) => p.kind === 'ride')?.line).toEqual(straight.path);
  });

  it('adds the car path as it came from the road router', () => {
    const car = journeyPieces(detail(), POI, look).find((p) => p.kind === 'car');
    expect(car?.line).toEqual(detail().carPath);
  });

  it('joins two rides with a walk when the second boards somewhere else', () => {
    const legs = [
      ride('333', 'bus', [151.21, -33.9], [151.25, -33.85]),
      ride('T1', 'train', [151.26, -33.85], [151.3, -33.8]),
    ];
    const pieces = journeyPieces(detail({ legs, carPath: null }), POI, look);
    expect(pieces.map((p) => p.kind)).toEqual(['walk', 'ride', 'walk', 'ride']);
    expect(pieces[2].line).toEqual([
      [151.25, -33.85],
      [151.26, -33.85],
    ]);
  });

  it('draws a journey on foot only as one walk to the point of interest', () => {
    const pieces = journeyPieces(
      detail({ legs: [{ type: 'walk', secs: 600, metres: 700 }], carPath: null }),
      POI,
      look,
    );
    expect(pieces).toEqual([
      {
        kind: 'walk',
        colour: null,
        label: null,
        line: [
          [151.2, -33.9],
          [151.3, -33.8],
        ],
      },
    ]);
  });

  it('draws no journey when there is none, and no car path when it could not be fetched', () => {
    const none = detail({ legs: null, pt: null, status: 'noService', carPath: null });
    expect(journeyPieces(none, POI, look)).toEqual([]);
  });
});
