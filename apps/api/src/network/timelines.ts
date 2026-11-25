// The timeline charts: trip diagram, platforms, and the vehicles that run a line.

import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { int, notFound } from '../http.ts';
import { scenarioOf, visible } from '../scenarios/scenarios.ts';
import { stopDeleted } from '../scenarios/stops.ts';

export function registerTimelineRoutes(app: FastifyInstance, sql: Sql) {
  // ---------------------------------------------------------------------------
  // Timeline views
  // ---------------------------------------------------------------------------

  // Stringline: every trip that calls at two or more stations of one stopping pattern's corridor.
  app.get('/api/patterns/:id/stringline', async (req) => {
    const id = int((req.params as any).id);
    const others = (req.query as any).others === '1';
    const sc = await scenarioOf(req, sql);
    const vis = visible(sql, 't', sc);
    const [pattern] = await sql`
      select p.id, p.baseline_id, p.route_id, r.mode_id, m.rule_set,
             (select t.id from trips t where t.pattern_id = p.id order by (t.scenario_id is not null), t.id limit 1) as sample_trip
      from patterns p join routes r on r.id = p.route_id join modes m on m.id = r.mode_id
      where p.id = ${id}`;
    if (!pattern || !pattern.sample_trip) throw notFound('Pattern');

    // The station axis, in travel order, with distance along the line.
    const stations = await sql`
      select station_id as id, name, dist from (
        select distinct on (station_id) station_id, name, dist, seq from (
          select coalesce(s.parent_id, s.id) as station_id, coalesce(p.name, s.name) as name, st.dist, st.seq
          from stop_times st join stops s on s.id = st.stop_id left join stops p on p.id = s.parent_id
          where st.trip_id = ${pattern.sample_trip}) q
        order by station_id, seq) x
      order by seq`;
    const stationIds = stations.map((s) => s.id);
    const indexOf = new Map(stationIds.map((sid, i) => [sid, i]));

    interface StringTrip {
      id: number;
      routeId: number;
      edited: boolean;
      calls: number[];
    }
    // Other lines must share at least three stations to count as using the corridor; two is usually just a
    // shared interchange. The line itself only needs two.
    /** Which trips to read: visible() for this scenario, or the trips it removed (below). */
    type Condition = ReturnType<typeof visible>;
    const enough = (t: StringTrip) => t.calls.length >= (t.routeId === pattern.route_id ? 8 : 12);
    const tripsWhere = async (which: Condition): Promise<StringTrip[]> => {
      const calls = await sql`
        select st.trip_id, t.route_id, coalesce(s.parent_id, s.id) as station_id, st.arr, st.dep,
               (st.pickup_type = 1 and st.drop_off_type = 1) as passing, (t.scenario_id is not null) as edited
        from stops s
        join stop_times st on st.stop_id = s.id
        join trips t on t.id = st.trip_id
        join routes r on r.id = t.route_id
        join modes m on m.id = r.mode_id
        where s.baseline_id = ${pattern.baseline_id}
          and (s.parent_id = any(${stationIds}) or s.id = any(${stationIds}))
          and ${others ? sql`m.rule_set = ${pattern.rule_set}` : sql`t.route_id = ${pattern.route_id}`}
          and ${which}
        order by st.trip_id, st.arr`;
      // Flat [stationIndex, arr, dep, passing] per call keeps the payload small.
      const out: StringTrip[] = [];
      let current: StringTrip | null = null;
      for (const c of calls) {
        if (!current || current.id !== c.trip_id) {
          if (current && enough(current)) out.push(current);
          current = { id: c.trip_id, routeId: c.route_id, edited: c.edited, calls: [] };
        }
        current.calls.push(indexOf.get(c.station_id)!, c.arr, c.dep, c.passing ? 1 : 0);
      }
      if (current && enough(current)) out.push(current);
      return out;
    };
    const trips = await tripsWhere(vis);
    // The published trips this scenario replaced or removed, so the view can show what changed.
    const ghosts = sc
      ? await tripsWhere(sql`t.scenario_id is null and exists (
          select 1 from scenario_removed x where x.scenario_id = ${sc.id} and x.trip_id = t.id and x.edit_seq <= ${sc.head})`)
      : [];

    const routeIds = [...new Set(trips.map((t) => t.routeId))];
    const routes = routeIds.length
      ? await sql`
          select r.id, r.short_name as "shortName", coalesce(r.color, m.color) as color
          from routes r join modes m on m.id = r.mode_id where r.id = any(${routeIds})`
      : [];
    return { patternId: id, routeId: pattern.route_id, stations, routes, trips, ghosts };
  });

  // Platform occupancy: every call at a station's platforms, plus vehicles waiting there between trips.
  app.get('/api/stations/:id/platforms', async (req) => {
    const id = int((req.params as any).id);
    const sc = await scenarioOf(req, sql);
    const vis = visible(sql, 't', sc);
    const [station] = await sql`
      select p.id, p.name, p.baseline_id as "baselineId", ST_X(p.geom) as lon, ST_Y(p.geom) as lat
      from stops s join stops p on p.id = coalesce(s.parent_id, s.id) where s.id = ${id}`;
    if (!station) throw notFound('Station');
    const platforms = await sql`
      select c.id, c.name, c.platform_code as "platformCode" from stops c
      where (c.parent_id = ${station.id} or c.id = ${station.id}) and c.location_type = 0 and cardinality(c.mode_ids) > 0
        -- A platform the scenario has deleted has no row in the chart.
        and not ${stopDeleted(sql, 'c', sc)}`;
    const stopIds = platforms.map((p) => p.id);
    if (!stopIds.length)
      return { station, platforms: [], routes: [], calls: [], layovers: [], conflicts: [] };

    const calls = await sql`
      select st.trip_id as "tripId", st.seq, st.stop_id as "stopId", st.arr, st.dep,
             (st.pickup_type = 1 and st.drop_off_type = 1) as passing,
             r.id as "routeId", t.headsign,
             (t.first_stop_id = st.stop_id and st.dep = t.start_secs) as starts,
             (t.last_stop_id = st.stop_id and st.arr = t.end_secs) as ends
      from stop_times st
      join trips t on t.id = st.trip_id
      join routes r on r.id = t.route_id
      where st.stop_id = any(${stopIds}) and ${vis}
      order by st.arr`;
    const routes = await sql`
      select r.id, r.short_name as "shortName", coalesce(r.color, m.color) as color
      from routes r join modes m on m.id = r.mode_id
      where r.id = any(${[...new Set(calls.map((c) => c.routeId))]})`;

    // A vehicle that ends one trip here and starts its next from the same platform holds it in between.
    const layovers = await sql`
      select a.last_stop_id as "stopId", a.end_secs as "from", b.start_secs as "to",
             a.id as "tripId", b.id as "nextTripId", (vd.source = 'inferred') as inferred,
             coalesce(r.color, m.color) as color
      from trips a
      join lateral (
        select n.* from trips n
        where n.vehicle_day_id = a.vehicle_day_id and n.id <> a.id and n.start_secs >= a.end_secs and ${visible(sql, 'n', sc)}
        order by n.start_secs limit 1) b on true
      join vehicle_days vd on vd.id = a.vehicle_day_id
      join routes r on r.id = b.route_id
      join modes m on m.id = r.mode_id
      where a.last_stop_id = any(${stopIds}) and b.first_stop_id = a.last_stop_id and b.start_secs > a.end_secs
        and ${visible(sql, 'a', sc)}`;

    const conflicts = await sql`
      select stop_id as "stopId", trip_a as "tripA", trip_b as "tripB", from_secs as "from", to_secs as "to"
      from baseline_conflicts where stop_id = any(${stopIds})`;

    return { station, platforms, routes, calls, layovers, conflicts };
  });

  // Every vehicle that runs at least one trip on a line, with its whole day.
  app.get('/api/routes/:id/vehicles', async (req) => {
    const id = int((req.params as any).id);
    const sc = await scenarioOf(req, sql);
    const vis = visible(sql, 't', sc);
    const days = await sql<
      {
        id: number;
        label: string;
        source: 'run_number' | 'inferred';
        startSecs: number;
        endSecs: number;
        gapCount: number;
        isNew: boolean;
      }[]
    >`
      select vd.id, vd.label, vd.source, vd.start_secs as "startSecs", vd.end_secs as "endSecs", vd.gap_count as "gapCount",
             (vd.scenario_id is not null) as "isNew"
      from vehicle_days vd
      where vd.id in (select t.vehicle_day_id from trips t where t.route_id = ${id} and t.vehicle_day_id is not null and ${vis})
      order by vd.start_secs, vd.id`;
    const dayIds = days.map((d) => d.id);
    if (!dayIds.length) return { vehicleDays: [], stayAboard: [] };
    const trips = await sql`
      select t.id, t.vehicle_day_id as "vehicleDayId", t.start_secs as "startSecs", t.end_secs as "endSecs",
             r.id as "routeId", r.short_name as "shortName", coalesce(r.color, m.color) as color, t.headsign,
             (t.scenario_id is not null) as edited,
             coalesce(f.parent_id, f.id) as "firstStationId", coalesce(l.parent_id, l.id) as "lastStationId"
      from trips t
      join routes r on r.id = t.route_id
      join modes m on m.id = r.mode_id
      join stops f on f.id = t.first_stop_id
      join stops l on l.id = t.last_stop_id
      where t.vehicle_day_id = any(${dayIds}) and ${vis}
      order by t.vehicle_day_id, t.start_secs, t.id`;
    const stayAboard = await sql`
      select a.id as "from", b.id as "to" from stay_aboard_links l
      join trips a on coalesce(a.origin_trip_id, a.id) = l.from_trip_id
      join trips b on coalesce(b.origin_trip_id, b.id) = l.to_trip_id
      where a.vehicle_day_id = any(${dayIds}) and ${visible(sql, 'a', sc)} and ${visible(sql, 'b', sc)}
        and a.feed_block_id is not distinct from b.feed_block_id`;
    const byDay = new Map<number, typeof trips>();
    for (const t of trips) {
      let list = byDay.get(t.vehicleDayId);
      if (!list) byDay.set(t.vehicleDayId, (list = [] as unknown as typeof trips));
      list.push(t);
    }
    return {
      vehicleDays: days
        .map((d) => {
          const own = byDay.get(d.id) ?? [];
          return {
            ...d,
            startSecs: own.length ? Math.min(...own.map((t) => t.startSecs)) : d.startSecs,
            endSecs: own.length ? Math.max(...own.map((t) => t.endSecs)) : d.endSecs,
            trips: own,
          };
        })
        .sort(
          (a, b) => Number(b.isNew) - Number(a.isNew) || a.startSecs - b.startSecs || a.id - b.id,
        ),
      stayAboard: stayAboard.map((l) => [l.from, l.to]),
    };
  });
}
