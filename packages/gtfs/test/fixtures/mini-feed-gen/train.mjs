// T1: train, Redfern to Chatswood.
import { densify, locate, mLon, round6 } from './geometry.mjs';
import { SERVICE, addShape, addStop, at, hms, routes, stopTimes, trips } from './feed.mjs';

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

// Each trip takes 28 minutes and a train waits 2 minutes before going back: a 60-minute round
// trip, so four trains give a train every 15 minutes each way.
const TRAIN_DWELL = 30;
const TRAIN_RUN = 28 * 60;

/** Adds the T1 stations, track shapes, route and trips. */
export function addTrain() {
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
