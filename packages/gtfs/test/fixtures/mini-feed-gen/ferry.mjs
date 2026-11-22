// F1: ferry, Circular Quay to Manly.
import { M_LAT, densify, round6 } from './geometry.mjs';
import { SERVICE, addShape, addStop, at, hms, routes, stopTimes, trips } from './feed.mjs';

/** Adds the F1 wharves, shapes, route and trips on two vessels. */
export function addFerry() {
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
