// Writes the small test feed in ./mini-feed: a made-up weekday timetable in central Sydney, big
// enough for the scenario e2e suite (apps/api/test/scenarios.e2e.mjs) and nothing more.
// Usage: node packages/gtfs/test/fixtures/make-mini-feed.mjs
//
// What it holds (all ids are made up; places and coordinates are real):
//   T1  train, Redfern to Chatswood, 11 stations each with two platforms, every 15 minutes from
//       05:00 until after midnight. Four train runs (run numbers in the trip ids, as TfNSW does)
//       turn round in 2 minutes, so each trip has a tight follow-on. One run is a 4-car set.
//   333 bus, Circular Quay to Bondi Beach along Oxford St and Bondi Rd, every 20 minutes, slower
//       in the peaks. Stops in pairs across the road.
//   373 bus, Museum to Coogee, every 20 minutes.
//   389 bus, Pyrmont to Bondi Junction, sharing 333's stops along Oxford St, with one stop of its
//       own there. Every other trip runs only as far as Taylor Square: two stop patterns each way.
//   F1  ferry, Circular Quay to Manly, every 30 minutes, on two vessels given block ids.
// The file is deterministic: running it again gives the same files.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'mini-feed');
const SERVICE = 'WKDY';

// --- Geometry -------------------------------------------------------------------------------

const M_LAT = 110_540;
const mLon = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);
const metres = (a, b) => Math.hypot((b[0] - a[0]) * mLon(a[1]), (b[1] - a[1]) * M_LAT);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Points every `step` metres or less along the waypoints, with the distance of each from the start. */
function densify(waypoints, step) {
  const pts = [waypoints[0]];
  const dist = [0];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const len = metres(a, b);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      dist.push(dist[dist.length - 1] + len / n);
    }
  }
  return { pts: pts.map((p) => [round6(p[0]), round6(p[1])]), dist };
}

/** The point at a distance along a path, moved `left` metres to the left of the way it runs. */
function pointAt(path, along, left = 0) {
  const { pts, dist } = path;
  let i = 1;
  while (i < pts.length - 1 && dist[i] < along) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const f = Math.max(0, Math.min(1, (along - dist[i - 1]) / (dist[i] - dist[i - 1] || 1)));
  const x = a[0] + (b[0] - a[0]) * f;
  const y = a[1] + (b[1] - a[1]) * f;
  const dx = (b[0] - a[0]) * mLon(y);
  const dy = (b[1] - a[1]) * M_LAT;
  const len = Math.hypot(dx, dy) || 1;
  // Left of the direction of travel.
  const east = (-dy / len) * left;
  const north = (dx / len) * left;
  return [round6(x + east / mLon(y)), round6(y + north / M_LAT)];
}

/** Where a point sits along a path, and how far it is from it. */
function locate(path, p) {
  const { pts, dist } = path;
  let best = { along: 0, off: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const k = mLon(p[1]);
    const ax = (a[0] - p[0]) * k;
    const ay = (a[1] - p[1]) * M_LAT;
    const dx = (b[0] - a[0]) * k;
    const dy = (b[1] - a[1]) * M_LAT;
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + f * dx, ay + f * dy);
    if (off < best.off) best = { along: dist[i - 1] + f * (dist[i] - dist[i - 1]), off };
  }
  return best;
}

// --- Times ----------------------------------------------------------------------------------

const hms = (secs) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}`;
};
const at = (h, m = 0) => h * 3600 + m * 60;
const inPeak = (secs) =>
  (secs >= at(6, 30) && secs < at(9, 30)) || (secs >= at(15) && secs < at(19));

// --- Feed tables ----------------------------------------------------------------------------

const stops = [];
const stopById = new Map();
const routes = [];
const trips = [];
const stopTimes = [];
const shapes = [];

function addStop(row) {
  const full = {
    stop_code: '',
    location_type: '',
    parent_station: '',
    wheelchair_boarding: '1',
    level_id: '',
    platform_code: '',
    ...row,
  };
  stops.push(full);
  stopById.set(full.stop_id, full);
  return full;
}

function addShape(id, path) {
  path.pts.forEach((p, i) =>
    shapes.push([id, p[1], p[0], i + 1, path.dist[i].toFixed(2)].join(',')),
  );
}

// --- T1: train ------------------------------------------------------------------------------

const STATIONS = [
  ['RDF', 'Redfern', 151.1984, -33.8917],
  ['CEN', 'Central', 151.2062, -33.8832],
  ['TNH', 'Town Hall', 151.207, -33.8732],
  ['WYN', 'Wynyard', 151.2055, -33.8656],
  ['MPT', 'Milsons Point', 151.2118, -33.8463],
  ['NSY', 'North Sydney', 151.2073, -33.8402],
  ['WVT', 'Waverton', 151.1978, -33.8381],
  ['WLS', 'Wollstonecraft', 151.1916, -33.8326],
  ['STL', 'St Leonards', 151.1944, -33.8231],
  ['ART', 'Artarmon', 151.1846, -33.8089],
  ['CHW', 'Chatswood', 151.1812, -33.7969],
];

for (const [code, name, lon, lat] of STATIONS) {
  addStop({
    stop_id: `X${code}`,
    stop_name: `${name} Station`,
    stop_lat: lat,
    stop_lon: lon,
    location_type: '1',
  });
  for (const n of [1, 2]) {
    addStop({
      stop_id: `X${code}${n}`,
      stop_code: `X${code}${n}`,
      stop_name: `${name} Station Platform ${n}`,
      stop_lat: lat,
      stop_lon: round6(lon + (n === 1 ? -6 : 6) / mLon(lat)),
      parent_station: `X${code}`,
      platform_code: String(n),
    });
  }
}
const trackUp = densify(
  STATIONS.map((s) => [s[2], s[3]]),
  50,
);
const trackDown = densify(
  [...STATIONS].reverse().map((s) => [s[2], s[3]]),
  50,
);
addShape('XT1-UP', trackUp);
addShape('XT1-DN', trackDown);
routes.push({
  route_id: 'XT1',
  agency_id: 'XTR',
  route_short_name: 'T1',
  route_long_name: 'Redfern to Chatswood',
  route_desc: 'Test trains',
  route_type: '2',
  route_color: 'F99D1C',
  route_text_color: 'FFFFFF',
  exact_times: '0',
});

// Each trip takes 28 minutes and a train waits 2 minutes before going back: a 60-minute round
// trip, so four trains give a train every 15 minutes each way.
const TRAIN_DWELL = 30;
const TRAIN_RUN = 28 * 60;
{
  const along = STATIONS.map((s) => locate(trackUp, [s[2], s[3]]).along);
  const total = along[along.length - 1];
  const moving = TRAIN_RUN - TRAIN_DWELL * (STATIONS.length - 2);
  // Seconds between stations, in proportion to the distance, in the Up direction.
  const hops = along.slice(1).map((d, i) => Math.round(((d - along[i]) / total) * moving));
  hops[hops.length - 1] += moving - hops.reduce((sum, h) => sum + h, 0);
  /** Arrival and departure at each station, in seconds after the trip leaves. */
  const timesFor = (direction) => {
    const run = direction === 0 ? hops : [...hops].reverse();
    const out = [{ arr: 0, dep: 0 }];
    run.forEach((h, i) => {
      const arr = out[i].dep + h;
      out.push({ arr, dep: i === run.length - 1 ? arr : arr + TRAIN_DWELL });
    });
    return out;
  };
  const RUNS = [
    { run: '101', set: 'A', cars: 8, first: at(5) },
    { run: '102', set: 'A', cars: 8, first: at(5, 15) },
    { run: '103', set: 'A', cars: 8, first: at(5, 30) },
    { run: '104', set: 'T', cars: 4, first: at(5, 45) },
  ];
  let serial = 900000;
  for (const r of RUNS) {
    let start = r.first;
    let direction = 0;
    let leg = 1;
    // The last trains leave after midnight, so their times run past 24:00.
    while (start <= at(24, 45)) {
      const tripId = `${r.run}${direction === 0 ? 'U' : 'D'}.${1000 + leg}.110.${String(leg).padStart(2, '0')}.${r.set}.${r.cars}.${serial++}`;
      const order = direction === 0 ? STATIONS : [...STATIONS].reverse();
      const shape = direction === 0 ? trackUp : trackDown;
      trips.push({
        route_id: 'XT1',
        service_id: SERVICE,
        trip_id: tripId,
        trip_headsign: order[order.length - 1][1],
        direction_id: String(direction),
        block_id: '',
        shape_id: direction === 0 ? 'XT1-UP' : 'XT1-DN',
        wheelchair_accessible: '1',
        route_direction: `${order[0][1]} to ${order[order.length - 1][1]}`,
        trip_note: '',
        bikes_allowed: '',
      });
      // Through stations Up trains use platform 1 and Down trains platform 2; at the ends a train
      // arrives and leaves from platform 1.
      const times = timesFor(direction);
      order.forEach((s, k) => {
        const end = k === 0 || k === order.length - 1;
        const platform = end ? 1 : direction === 0 ? 1 : 2;
        const stopId = `X${s[0]}${platform}`;
        stopTimes.push({
          trip_id: tripId,
          arrival_time: hms(start + times[k].arr),
          departure_time: hms(start + times[k].dep),
          stop_id: stopId,
          stop_sequence: k + 1,
          stop_headsign: '',
          pickup_type: '0',
          drop_off_type: '0',
          shape_dist_traveled: locate(shape, [s[2], s[3]]).along.toFixed(1),
          timepoint: '1',
          stop_note: '',
        });
      });
      start += TRAIN_RUN + 120;
      direction = 1 - direction;
      leg++;
    }
  }
}

// --- Buses ----------------------------------------------------------------------------------

const KERB = 12; // metres from the middle of the road to a stop

/**
 * A bus line: the road it takes, its own stops (names, spaced evenly unless placed), stops of
 * other lines it shares, and its timetable.
 */
function busLine(line) {
  routes.push({
    route_id: line.id,
    agency_id: 'XBS',
    route_short_name: line.name,
    route_long_name: line.longName,
    route_desc: 'Test buses',
    route_type: '700',
    route_color: '00B5EF',
    route_text_color: 'FFFFFF',
    exact_times: '0',
  });
  const paths = [densify(line.road, 25), densify([...line.road].reverse(), 25)];
  const length = paths[0].dist[paths[0].dist.length - 1];
  // Own stops, given as distances along the road from the first end.
  const ownAlong = line.stops.map((s, i) => s.along ?? (length * i) / (line.stops.length - 1));
  const stopsOf = [[], []];
  for (const direction of [0, 1]) {
    const pathD = paths[direction];
    line.stops.forEach((s, i) => {
      const along = direction === 0 ? ownAlong[i] : length - ownAlong[i];
      if (s.only !== undefined && s.only !== direction) return;
      const p = pointAt(pathD, along, KERB);
      const id = `${line.id}${direction === 0 ? 'A' : 'B'}${String(i + 1).padStart(2, '0')}`;
      addStop({ stop_id: id, stop_code: id, stop_name: s.name, stop_lat: p[1], stop_lon: p[0] });
      stopsOf[direction].push({ id, along });
    });
    // Stops of other lines on the same side of the same road are shared.
    for (const id of line.shares?.[direction] ?? []) {
      const s = stopById.get(id);
      const found = locate(pathD, [s.stop_lon, s.stop_lat]);
      if (found.off > KERB + 3) continue;
      if (found.along < 80 || found.along > length - 80) continue;
      if (stopsOf[direction].some((o) => Math.abs(o.along - found.along) < 120)) continue;
      stopsOf[direction].push({ id, along: found.along });
    }
    stopsOf[direction].sort((a, b) => a.along - b.along);
    addShape(`${line.id}-${direction}`, pathD);
  }
  for (const direction of [0, 1]) {
    const all = stopsOf[direction];
    for (const start of line.departures(direction)) {
      const short = line.shortTo && line.isShort(start, direction);
      let calls = all;
      if (short) {
        // A short working runs only between the first end and `shortTo` (direction 0), or back.
        const cut = all.findIndex((s) => s.id === line.shortTo[direction]);
        calls = direction === 0 ? all.slice(0, cut + 1) : all.slice(cut);
      }
      const first = calls[0].along;
      const runSecs = (inPeak(start) ? line.peakMins : line.mins) * 60;
      const tripId = `${line.id}.${direction}.${hms(start).replaceAll(':', '').slice(0, 4)}`;
      trips.push({
        route_id: line.id,
        service_id: SERVICE,
        trip_id: tripId,
        trip_headsign: stopById.get(calls[calls.length - 1].id).stop_name.replace(/,.*$/, ''),
        direction_id: String(direction),
        block_id: '',
        shape_id: `${line.id}-${direction}`,
        wheelchair_accessible: '1',
        route_direction: '',
        trip_note: '',
        bikes_allowed: '',
      });
      // A short working that starts part way along leaves at its own departure time.
      const offset = Math.round((first / length) * runSecs);
      calls.forEach((c, k) => {
        const secs = start + Math.round((c.along / length) * runSecs) - offset;
        stopTimes.push({
          trip_id: tripId,
          arrival_time: hms(secs),
          departure_time: hms(secs),
          stop_id: c.id,
          stop_sequence: k + 1,
          stop_headsign: '',
          pickup_type: '0',
          drop_off_type: '0',
          shape_dist_traveled: c.along.toFixed(1),
          timepoint: k === 0 || k === calls.length - 1 ? '1' : '0',
          stop_note: '',
        });
      });
    }
  }
  return stopsOf;
}

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
{
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

// --- F1: ferry ------------------------------------------------------------------------------

{
  const wharves = [
    ['CQW', 'Circular Quay Wharf', 151.2108, -33.8606, 'Circular Quay, Wharf 3', '3'],
    ['MNW', 'Manly Wharf', 151.2845, -33.8, 'Manly, Wharf 1', '1'],
  ];
  for (const [code, name, lon, lat, side, platform] of wharves) {
    addStop({
      stop_id: `X${code}`,
      stop_name: name,
      stop_lat: lat,
      stop_lon: lon,
      location_type: '1',
    });
    addStop({
      stop_id: `X${code}1`,
      stop_name: side,
      stop_lat: round6(lat - 20 / M_LAT),
      stop_lon: lon,
      parent_station: `X${code}`,
      platform_code: platform,
    });
  }
  const water = [
    [151.2108, -33.8608],
    [151.214, -33.8575],
    [151.22, -33.856],
    [151.23, -33.8545],
    [151.24, -33.852],
    [151.25, -33.846],
    [151.26, -33.838],
    [151.27, -33.828],
    [151.278, -33.815],
    [151.283, -33.805],
    [151.2845, -33.8002],
  ];
  const paths = [densify(water, 200), densify([...water].reverse(), 200)];
  addShape('XF1-0', paths[0]);
  addShape('XF1-1', paths[1]);
  routes.push({
    route_id: 'XF1',
    agency_id: 'XFY',
    route_short_name: 'F1',
    route_long_name: 'Circular Quay to Manly',
    route_desc: 'Test ferries',
    route_type: '4',
    route_color: '00774B',
    route_text_color: 'FFFFFF',
    exact_times: '0',
  });
  // Two vessels; each crossing takes 30 minutes.
  const length = paths[0].dist[paths[0].dist.length - 1];
  let n = 0;
  for (const [vessel, first] of [
    ['XF1-B1', at(6)],
    ['XF1-B2', at(6, 30)],
  ]) {
    for (let start = first, direction = 0; start <= at(22, 30); direction = 1 - direction) {
      const tripId = `XF1.${vessel.slice(-2)}.${String(++n).padStart(3, '0')}`;
      trips.push({
        route_id: 'XF1',
        service_id: SERVICE,
        trip_id: tripId,
        trip_headsign: direction === 0 ? 'Manly' : 'Circular Quay',
        direction_id: String(direction),
        block_id: vessel,
        shape_id: `XF1-${direction}`,
        wheelchair_accessible: '1',
        route_direction: '',
        trip_note: '',
        bikes_allowed: '',
      });
      const ends = direction === 0 ? ['XCQW1', 'XMNW1'] : ['XMNW1', 'XCQW1'];
      ends.forEach((id, k) =>
        stopTimes.push({
          trip_id: tripId,
          arrival_time: hms(start + k * 1800),
          departure_time: hms(start + k * 1800),
          stop_id: id,
          stop_sequence: k + 1,
          stop_headsign: '',
          pickup_type: '0',
          drop_off_type: '0',
          shape_dist_traveled: (k * length).toFixed(1),
          timepoint: '1',
          stop_note: '',
        }),
      );
      // 15 minutes at each end: each vessel leaves the Quay every 90 minutes.
      start += 1800 + 900;
    }
  }
}

// --- Writing --------------------------------------------------------------------------------

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const table = (columns, rows) =>
  [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') +
  '\n';

await mkdir(OUT, { recursive: true });
const files = {
  'agency.txt': table(
    ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang', 'agency_phone'],
    [
      ['XTR', 'Test Trains'],
      ['XBS', 'Test Buses'],
      ['XFY', 'Test Ferries'],
    ].map(([agency_id, agency_name]) => ({
      agency_id,
      agency_name,
      agency_url: 'https://example.com/',
      agency_timezone: 'Australia/Sydney',
      agency_lang: 'EN',
      agency_phone: '',
    })),
  ),
  'calendar.txt': table(
    [
      'service_id',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
      'start_date',
      'end_date',
    ],
    [
      {
        service_id: SERVICE,
        monday: 1,
        tuesday: 1,
        wednesday: 1,
        thursday: 1,
        friday: 1,
        saturday: 0,
        sunday: 0,
        start_date: '20260105',
        end_date: '20271231',
      },
    ],
  ),
  // Not running on Australia Day, which falls on a Tuesday in 2027.
  'calendar_dates.txt': table(
    ['service_id', 'date', 'exception_type'],
    [{ service_id: SERVICE, date: '20270126', exception_type: 2 }],
  ),
  'routes.txt': table(
    [
      'route_id',
      'agency_id',
      'route_short_name',
      'route_long_name',
      'route_desc',
      'route_type',
      'route_color',
      'route_text_color',
      'exact_times',
    ],
    routes,
  ),
  'stops.txt': table(
    [
      'stop_id',
      'stop_code',
      'stop_name',
      'stop_lat',
      'stop_lon',
      'location_type',
      'parent_station',
      'wheelchair_boarding',
      'level_id',
      'platform_code',
    ],
    stops,
  ),
  'trips.txt': table(
    [
      'route_id',
      'service_id',
      'trip_id',
      'shape_id',
      'trip_headsign',
      'direction_id',
      'block_id',
      'wheelchair_accessible',
      'route_direction',
      'trip_note',
      'bikes_allowed',
    ],
    trips,
  ),
  'stop_times.txt': table(
    [
      'trip_id',
      'arrival_time',
      'departure_time',
      'stop_id',
      'stop_sequence',
      'stop_headsign',
      'pickup_type',
      'drop_off_type',
      'shape_dist_traveled',
      'timepoint',
      'stop_note',
    ],
    stopTimes,
  ),
  'shapes.txt':
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n' +
    shapes.join('\n') +
    '\n',
  // A walkway between the two platforms at Central.
  'pathways.txt': table(
    [
      'pathway_id',
      'from_stop_id',
      'to_stop_id',
      'pathway_mode',
      'is_bidirectional',
      'traversal_time',
    ],
    [
      {
        pathway_id: 'XCEN-P1-P2',
        from_stop_id: 'XCEN1',
        to_stop_id: 'XCEN2',
        pathway_mode: 1,
        is_bidirectional: 1,
        traversal_time: 60,
      },
    ],
  ),
};
for (const [name, text] of Object.entries(files)) await writeFile(path.join(OUT, name), text);
console.log(
  `Wrote ${OUT}: ${routes.length} routes, ${stops.length} stops, ${trips.length} trips, ` +
    `${stopTimes.length} stop times, ${shapes.length} shape points`,
);
