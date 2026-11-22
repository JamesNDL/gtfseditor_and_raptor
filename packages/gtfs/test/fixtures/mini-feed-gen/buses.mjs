// The 333, 373 and 389 bus lines.
import { busLine } from './bus-line.mjs';
import { at } from './feed.mjs';
import { densify, locate } from './geometry.mjs';

const everyFrom = (from, to, mins) => {
  const out = [];
  for (let s = from; s <= to; s += mins * 60) out.push(s);
  return out;
};

const ROAD_333 = [
  [151.211, -33.8615],
  [151.2105, -33.868],
  [151.21, -33.8735],
  [151.2125, -33.877],
  [151.2195, -33.881],
  [151.227, -33.8845],
  [151.235, -33.887],
  [151.2475, -33.8915],
  [151.256, -33.892],
  [151.262, -33.8935],
  [151.27, -33.8925],
  [151.2745, -33.891],
];

/** Adds the 333, 373 and 389 bus lines, in that order. */
export function addBuses() {
  const stops333 = busLine({
    id: 'X333',
    name: '333',
    longName: 'Circular Quay to Bondi Beach',
    road: ROAD_333,
    stops: [
      'Circular Quay, Alfred St',
      'Elizabeth St near Hunter St',
      'Elizabeth St near Park St',
      'Liverpool St at Hyde Park',
      'Oxford St at Crown St',
      'Oxford St at Taylor Square',
      'Oxford St near Barcom Ave',
      'Oxford St near Glenmore Rd',
      'Oxford St at Paddington Town Hall',
      'Oxford St near Centennial Park',
      'Bondi Junction, Oxford St',
      'Bondi Rd near Denison St',
      'Bondi Rd near Wellington St',
      'Bondi Rd at Watson St',
      'Bondi Rd near Campbell Pde',
      'Bondi Beach, Campbell Pde',
    ].map((name) => ({ name })),
    mins: 30,
    peakMins: 36,
    departures: () => everyFrom(at(6), at(21, 40), 20),
  });

  busLine({
    id: 'X373',
    name: '373',
    longName: 'Museum to Coogee',
    road: [
      [151.2085, -33.879],
      [151.2115, -33.8835],
      [151.218, -33.8885],
      [151.22, -33.896],
      [151.226, -33.905],
      [151.238, -33.911],
      [151.248, -33.9165],
      [151.2575, -33.9205],
    ],
    stops: [
      'Museum Station, Elizabeth St',
      'Elizabeth St near Campbell St',
      'Albion St near Riley St',
      'Flinders St near Moore Park Rd',
      'Anzac Pde at Moore Park',
      'Anzac Pde near Lang Rd',
      'Alison Rd near Doncaster Ave',
      'Alison Rd at Randwick Racecourse',
      'Belmore Rd at Randwick',
      'Avoca St near Frances St',
      'Coogee Bay Rd near Carr St',
      'Coogee Bay Rd near Brook St',
      'Coogee Bay Rd near Arden St',
      'Coogee Beach, Arden St',
    ].map((name) => ({ name })),
    mins: 32,
    peakMins: 38,
    departures: (direction) => everyFrom(at(6, direction === 0 ? 5 : 10), at(21, 50), 20),
  });

  // 389 joins 333's road at Park St and runs with it as far as Bondi Junction.
  const join = 2;
  const end = 7;
  const road = [
    [151.1945, -33.8695],
    [151.2, -33.8715],
    [151.2065, -33.873],
    ...ROAD_333.slice(join, end + 1),
  ];
  const shared = (direction) => stops333[direction].map((s) => s.id);
  const path0 = densify(road, 25);
  const length = path0.dist[path0.dist.length - 1];
  // One stop of its own on Oxford St, between two of 333's: a stop 333 runs past.
  const between = locate(path0, [151.2235, -33.88285]).along;
  const isShort = (start) => Math.round(start / 1200) % 2 === 1;
  busLine({
    id: 'X389',
    name: '389',
    longName: 'Pyrmont to Bondi Junction',
    road,
    stops: [
      { name: 'Pyrmont, Harris St', along: 0 },
      { name: 'Druitt St near Sussex St', along: 450 },
      { name: 'Park St near George St', along: 1000 },
      { name: 'Oxford St near Victoria St', along: between },
      { name: 'Bondi Junction Interchange', along: length },
    ],
    shares: [shared(0), shared(1)],
    shortTo: ['X333A06', 'X333B06'],
    isShort,
    mins: 26,
    peakMins: 31,
    departures: () => everyFrom(at(6, 10), at(21, 50), 20),
  });
}
