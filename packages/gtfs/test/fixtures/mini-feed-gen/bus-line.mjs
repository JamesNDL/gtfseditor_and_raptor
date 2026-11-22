// Builds one bus line: its stops, shapes, route, trips and stop times.
import { densify, locate, pointAt } from './geometry.mjs';
import {
  SERVICE,
  addShape,
  addStop,
  hms,
  inPeak,
  routes,
  stopById,
  stopTimes,
  trips,
} from './feed.mjs';

const KERB = 12; // metres from the middle of the road to a stop

/**
 * A bus line: the road it takes, its own stops (names, spaced evenly unless placed), stops of
 * other lines it shares, and its timetable. Returns the stops it calls at in each direction.
 */
export function busLine(line) {
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
