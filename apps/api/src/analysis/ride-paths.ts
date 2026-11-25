// The path of each ride of the picked sample point's journey (D39; docs/architecture/
// access-analysis.md §12): looked up when the point is picked, not stored. The ride's trip is found
// in the timetable the analysis ran on (its day, and its scenario's own trips) by the trip id the
// run kept; a ride stored before ids were kept finds a trip of its line that leaves its boarding
// stop and reaches its alighting stop at the stored times. The trip's shape is the one the editor
// draws (`shapes`, through the trip or its stopping pattern), cut between the two stops by
// `legPath` in packages/core. A ride with no trip found is the straight line, marked so.
import {
  legPath,
  type GeoJsonPosition,
  type PointLeg,
  type StoredLeg,
  type StoredRideLeg,
  type TripCall,
  type TripShape,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';

/** The timetable an analysis ran on: its day (null once deleted) and its scenario, if any. */
export interface RideTimetable {
  baselineId: number | null;
  scenarioId: number | null;
}

/** About 10 m in degrees: a stop matched by place with no id (as `rideCalls` in core). */
const SAME_PLACE_DEG = 0.0001;

/** A point as PostGIS takes it. */
const pointOf = (sql: Sql, end: { lon: number; lat: number }) =>
  sql`st_setsrid(st_makepoint(${end.lon}, ${end.lat}), 4326)`;

/** The trip with the ride's trip id in the analysis's day, or null. */
async function tripById(sql: Sql, baselineId: number, trip: string): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    select id from trips where baseline_id = ${baselineId} and gtfs_id = ${trip}`;
  return row?.id ?? null;
}

/**
 * A trip of the ride's line, in the day or the analysis's scenario, that leaves a stop at the
 * boarding place at the boarding time and later reaches one at the alighting place at the
 * alighting time; the scenario's own trips first. Null when there is none.
 */
async function tripByTimes(
  sql: Sql,
  { baselineId, scenarioId }: RideTimetable,
  leg: StoredRideLeg,
): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    select t.id
    from trips t
    join routes r on r.id = t.route_id
    join stop_times a on a.trip_id = t.id and a.dep = ${leg.board.time}
    join stops sa on sa.id = a.stop_id
    join stop_times b on b.trip_id = t.id and b.seq > a.seq and b.arr = ${leg.alight.time}
    join stops sb on sb.id = b.stop_id
    where t.baseline_id = ${baselineId}
      and (t.scenario_id is null or t.scenario_id = ${scenarioId})
      and coalesce(nullif(r.short_name, ''), r.long_name) = ${leg.route}
      and st_dwithin(sa.geom, ${pointOf(sql, leg.board)}, ${SAME_PLACE_DEG})
      and st_dwithin(sb.geom, ${pointOf(sql, leg.alight)}, ${SAME_PLACE_DEG})
    order by (t.scenario_id is null), t.id
    limit 1`;
  return row?.id ?? null;
}

/** A trip's calls in order and its shape (none when it has no shape). */
async function geometryOf(
  sql: Sql,
  tripId: number,
): Promise<{ calls: TripCall[]; shape: TripShape | null }> {
  const calls = await sql<TripCall[]>`
    select s.gtfs_id as stop, st_x(s.geom) as lon, st_y(s.geom) as lat, st.arr, st.dep, st.dist
    from stop_times st join stops s on s.id = st.stop_id
    where st.trip_id = ${tripId} order by st.seq`;
  const [row] = await sql<{ coords: GeoJsonPosition[]; dists: number[] | null }[]>`
    select (st_asgeojson(sh.geom, 7)::json -> 'coordinates') as coords, sh.dists
    from trips t
    left join patterns p on p.id = t.pattern_id
    join shapes sh on sh.id = coalesce(t.shape_id, p.shape_id)
    where t.id = ${tripId}`;
  const shape = row ? { coords: row.coords, dists: row.dists?.map(Number) ?? null } : null;
  return { calls, shape };
}

/** One ride with its path. */
async function withPath(sql: Sql, timetable: RideTimetable, leg: StoredRideLeg): Promise<PointLeg> {
  const { baselineId } = timetable;
  let tripId: number | null = null;
  if (baselineId !== null) {
    tripId = leg.trip === undefined ? null : await tripById(sql, baselineId, leg.trip);
    tripId ??= await tripByTimes(sql, timetable, leg);
  }
  const trip = tripId === null ? null : await geometryOf(sql, tripId);
  const { path, from } = legPath(leg, trip);
  return { ...leg, path: path.map(([lon, lat]): GeoJsonPosition => [lon, lat]), pathFrom: from };
}

/** The stored legs of a pair, each ride with its path on the map (D39). */
export async function legsWithPaths(
  sql: Sql,
  timetable: RideTimetable,
  legs: StoredLeg[] | null,
): Promise<PointLeg[] | null> {
  if (legs === null) return null;
  const shown: PointLeg[] = [];
  for (const leg of legs) {
    shown.push(leg.type === 'ride' ? await withPath(sql, timetable, leg) : leg);
  }
  return shown;
}
