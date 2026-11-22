// The panel on the right: a line, a trip, a vehicle day, a station.

import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { int, notFound } from '../http.ts';
import { scenarioOf, visible } from '../scenarios.ts';

export function registerInspectorRoutes(app: FastifyInstance, sql: Sql) {
  // ---------------------------------------------------------------------------
  // Line inspector
  // ---------------------------------------------------------------------------
  app.get('/api/routes/:id', async (req) => {
    const id = int((req.params as any).id);
    const sc = await scenarioOf(req, sql);
    const vis = visible(sql, 't', sc);
    const [route] = await sql`
      select r.id, r.baseline_id as "baselineId", r.gtfs_id as "gtfsId", r.short_name as "shortName",
             r.long_name as "longName", r.description, r.mode_id as "modeId", m.name as "modeName",
             coalesce(r.color, m.color) as color, r.agency_name as agency, r.trip_count as "tripCount",
             ST_XMin(e.box) as west, ST_YMin(e.box) as south, ST_XMax(e.box) as east, ST_YMax(e.box) as north
      from routes r join modes m on m.id = r.mode_id
      left join lateral (
        select ST_Extent(s.geom) as box from patterns p join shapes s on s.id = p.shape_id where p.route_id = r.id) e on true
      where r.id = ${id}`;
    if (!route) throw notFound('Route');

    const [summary] = await sql`
      select min(start_secs) as "firstDeparture", max(end_secs) as "lastArrival",
             count(distinct vehicle_day_id)::int as "vehicleDays",
             round(avg(end_secs - start_secs))::int as "avgRunSecs", count(*)::int as "tripCount"
      from trips t where t.route_id = ${id} and ${vis}`;

    // Departures and capacity per hour and direction. Capacity uses the resolved vehicle type per trip.
    const hourly = await sql`
      select coalesce(t.direction_id, 0) as direction, (t.start_secs / 3600)::int as hour,
             count(*)::int as trips, sum(v.seated)::int as seated, sum(v.standing)::int as standing
      from trips t
      join trip_vehicle tv on tv.trip_id = t.id
      join vehicle_types v on v.id = tv.vehicle_type_id
      where t.route_id = ${id} and ${vis} group by 1, 2 order by 1, 2`;

    const directions = await sql`
      select coalesce(direction_id, 0) as direction, mode() within group (order by headsign) as headsign, count(*)::int as trips
      from trips t where t.route_id = ${id} and ${vis} group by 1 order by 1`;

    const vehicleTypes = await sql`
      select v.id, v.name, v.cars, v.seated, v.standing, v.capacity_is_placeholder as "capacityIsPlaceholder",
             bool_and(tv.assumed) as assumed, count(*)::int as trips
      from trips t join trip_vehicle tv on tv.trip_id = t.id join vehicle_types v on v.id = tv.vehicle_type_id
      where t.route_id = ${id} and ${vis} group by v.id order by count(*) desc`;

    const patterns = await sql`
      select p.id, coalesce(p.direction_id, 0) as direction, p.headsign,
             (select count(*)::int from trips t where t.pattern_id = p.id and ${vis}) as "tripCount",
             cardinality(p.stop_ids) as "stopCount", f.name as "firstStop", l.name as "lastStop"
      from patterns p
      join stops f on f.id = p.stop_ids[1]
      join stops l on l.id = p.stop_ids[cardinality(p.stop_ids)]
      where p.route_id = ${id}
        and (p.scenario_id is null or ${sc ? sql`(p.scenario_id = ${sc.id} and p.created_edit <= ${sc.head})` : sql`false`})
        -- Patterns a scenario has replaced (a reshaped line) have no trips left and are not listed.
        and exists (select 1 from trips t where t.pattern_id = p.id and ${vis})
      order by 4 desc`;

    // Departures of the main stopping pattern in each direction, for the frequency card.
    const mainDepartures = await sql`
      with ranked as (
        select t.pattern_id, coalesce(t.direction_id, 0) as direction, count(*) as n,
               row_number() over (partition by coalesce(t.direction_id, 0) order by count(*) desc) as rank
        from trips t where t.route_id = ${id} and t.pattern_id is not null and ${vis} group by 1, 2)
      select r.direction, array_agg(t.start_secs order by t.start_secs) as starts
      from ranked r join trips t on t.pattern_id = r.pattern_id and ${vis}
      where r.rank = 1 group by r.direction order by r.direction`;

    // When a scenario is open, also send the published timetable's numbers so the two can be compared.
    let before = null;
    if (sc) {
      const [counts] = await sql`
        select count(*)::int as "tripCount", count(distinct vehicle_day_id)::int as "vehicleDays"
        from trips where route_id = ${id} and scenario_id is null`;
      const hourlyBefore = await sql`
        select coalesce(t.direction_id, 0) as direction, (t.start_secs / 3600)::int as hour,
               count(*)::int as trips, sum(v.seated)::int as seated, sum(v.standing)::int as standing
        from trips t
        join trip_vehicle tv on tv.trip_id = t.id
        join vehicle_types v on v.id = tv.vehicle_type_id
        where t.route_id = ${id} and t.scenario_id is null group by 1, 2 order by 1, 2`;
      before = { ...counts, hourly: hourlyBefore };
    }

    return {
      ...route,
      ...summary,
      hourly,
      directions,
      vehicleTypes,
      patterns,
      before,
      mainDepartures,
    };
  });

  app.get('/api/routes/:id/trips', async (req) => {
    const id = int((req.params as any).id);
    const vis = visible(sql, 't', await scenarioOf(req, sql));
    return sql`
      select t.id, t.gtfs_id as "gtfsId", coalesce(t.direction_id, 0) as direction, t.headsign,
             t.start_secs as "startSecs", t.end_secs as "endSecs", t.pattern_id as "patternId",
             t.vehicle_day_id as "vehicleDayId", vd.label as "vehicleDayLabel", vd.source as "vehicleDaySource",
             v.name as "vehicleType", tv.assumed as "vehicleAssumed",
             f.name as "firstStop", l.name as "lastStop", cardinality(p.stop_ids) as "stopCount",
             (t.scenario_id is not null) as edited, t.pinned
      from trips t
      join trip_vehicle tv on tv.trip_id = t.id
      join vehicle_types v on v.id = tv.vehicle_type_id
      left join vehicle_days vd on vd.id = t.vehicle_day_id
      left join patterns p on p.id = t.pattern_id
      join stops f on f.id = t.first_stop_id
      join stops l on l.id = t.last_stop_id
      where t.route_id = ${id} and ${vis}
      order by t.start_secs, t.id`;
  });

  const tripSummary = (where: ReturnType<typeof sql>) => sql`
    select t.id, t.gtfs_id as "gtfsId", t.headsign, t.start_secs as "startSecs", t.end_secs as "endSecs",
           t.vehicle_day_seq as "vehicleDaySeq", r.id as "routeId", r.short_name as "routeShortName",
           coalesce(r.color, m.color) as color, r.mode_id as "modeId",
           f.name as "firstStop", l.name as "lastStop",
           coalesce(f.parent_id, f.id) as "firstStationId", coalesce(l.parent_id, l.id) as "lastStationId"
    from trips t
    join routes r on r.id = t.route_id
    join modes m on m.id = r.mode_id
    join stops f on f.id = t.first_stop_id
    join stops l on l.id = t.last_stop_id
    where ${where}`;

  app.get('/api/trips/:id', async (req) => {
    const id = int((req.params as any).id);
    const vis = visible(sql, 't', await scenarioOf(req, sql));
    const [trip] = await sql`
      select t.id, t.gtfs_id as "gtfsId", t.headsign, t.start_secs as "startSecs", t.end_secs as "endSecs",
             coalesce(t.direction_id, 0) as direction, t.trip_name as "tripName", t.feed_block_id as "feedBlockId",
             r.id as "routeId", r.short_name as "routeShortName", r.long_name as "routeLongName",
             coalesce(r.color, m.color) as color, r.mode_id as "modeId", m.name as "modeName",
             t.vehicle_day_id as "vehicleDayId", vd.label as "vehicleDayLabel", vd.source as "vehicleDaySource",
             v.name as "vehicleType", v.id as "vehicleTypeId", v.seated, v.standing, v.capacity_is_placeholder as "capacityIsPlaceholder",
             tv.assumed as "vehicleAssumed", t.pattern_id as "patternId", (t.scenario_id is not null) as edited, t.pinned,
             coalesce(t.origin_trip_id, t.id) as "linkId", m.rule_set as "ruleSet"
      from trips t
      join routes r on r.id = t.route_id
      join modes m on m.id = r.mode_id
      join trip_vehicle tv on tv.trip_id = t.id
      join vehicle_types v on v.id = tv.vehicle_type_id
      left join vehicle_days vd on vd.id = t.vehicle_day_id
      where t.id = ${id}`;
    if (!trip) throw notFound('Trip');
    const stopTimes = await sql`
      select st.seq, st.arr, st.dep, st.dist, st.pickup_type as "pickupType", st.drop_off_type as "dropOffType",
             s.id as "stopId", s.name, s.platform_code as "platformCode",
             ST_X(s.geom) as lon, ST_Y(s.geom) as lat
      from stop_times st join stops s on s.id = st.stop_id
      where st.trip_id = ${id} order by st.seq`;
    // Links are recorded against baseline trips; an edited trip inherits them through its origin.
    // A link ends when the two trips are no longer in the same stay-aboard group, which is what
    // deleting the stop where they met does (delete-stop.ts).
    const sameGroup = sql`t.feed_block_id is not distinct from ${trip.feedBlockId}`;
    const [stayFrom] = await tripSummary(
      sql`coalesce(t.origin_trip_id, t.id) = (select from_trip_id from stay_aboard_links where to_trip_id = ${trip.linkId} limit 1) and ${vis} and ${sameGroup}`,
    );
    const [stayTo] = await tripSummary(
      sql`coalesce(t.origin_trip_id, t.id) = (select to_trip_id from stay_aboard_links where from_trip_id = ${trip.linkId} limit 1) and ${vis} and ${sameGroup}`,
    );
    return { ...trip, stopTimes, stayAboardFrom: stayFrom ?? null, stayAboardTo: stayTo ?? null };
  });

  app.get('/api/vehicle-days/:id', async (req) => {
    const id = int((req.params as any).id);
    const sc = await scenarioOf(req, sql);
    const vis = visible(sql, 't', sc);
    const [day] = await sql`
      select vd.id, vd.label, vd.source, vd.mode_id as "modeId", m.name as "modeName", vd.trip_count as "tripCount",
             vd.start_secs as "startSecs", vd.end_secs as "endSecs", vd.gap_count as "gapCount",
             v.name as "vehicleType", v.seated, v.standing, v.capacity_is_placeholder as "capacityIsPlaceholder",
             (vd.scenario_id is not null) as "isNew"
      from vehicle_days vd
      join modes m on m.id = vd.mode_id
      left join mode_default_vehicle mdv on mdv.mode_id = vd.mode_id
      left join vehicle_types v on v.id = coalesce(vd.vehicle_type_id, mdv.vehicle_type_id)
      where vd.id = ${id}`;
    if (!day) throw notFound('Vehicle day');
    const trips = await tripSummary(
      sql`t.vehicle_day_id = ${id} and ${vis} order by t.start_secs, t.id`,
    );
    const stayAboard = await sql`
      select a.id as "fromTripId", b.id as "toTripId" from stay_aboard_links l
      join trips a on coalesce(a.origin_trip_id, a.id) = l.from_trip_id
      join trips b on coalesce(b.origin_trip_id, b.id) = l.to_trip_id
      where a.vehicle_day_id = ${id} and ${visible(sql, 'a', sc)} and ${visible(sql, 'b', sc)}
        and a.feed_block_id is not distinct from b.feed_block_id`;
    const startSecs = trips.length ? Math.min(...trips.map((t) => t.startSecs)) : day.startSecs;
    const endSecs = trips.length ? Math.max(...trips.map((t) => t.endSecs)) : day.endSecs;
    return { ...day, tripCount: trips.length, startSecs, endSecs, trips, stayAboard };
  });

  // A station or stop at a glance, for the panel on the right: its platforms and the lines that call there.
  app.get('/api/stations/:id/summary', async (req) => {
    const id = int((req.params as any).id);
    const sc = await scenarioOf(req, sql);
    const vis = visible(sql, 't', sc);
    const [station] = await sql`
      select p.id, p.name, (p.location_type = 1) as "isStation", ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
             (p.scenario_id is not null) as "isNew",
             (p.mode_ids && array['train', 'metro', 'light_rail', 'ferry']) as rail
      from stops s join stops p on p.id = coalesce(s.parent_id, s.id) where s.id = ${id}`;
    if (!station) throw notFound('Station');
    // Stops the scenario has deleted stay listed, marked, so that what was deleted can be seen and undone.
    const gone = sc
      ? await sql`
          select g.stop_id, g.edit_seq, e.summary from scenario_removed_stops g
          join stops s on s.id = g.stop_id
          left join scenario_edits e on e.scenario_id = g.scenario_id and e.seq = g.edit_seq
          where g.scenario_id = ${sc.id} and g.edit_seq <= ${sc.head} and (s.id = ${station.id} or s.parent_id = ${station.id})`
      : [];
    const goneBy = new Map(gone.map((g) => [g.stop_id as number, g]));
    const deletion = (stopId: number) => {
      const g = goneBy.get(stopId);
      // Only the scenario's latest change can be taken back on its own.
      return g
        ? {
            seq: g.edit_seq as number,
            summary: String(g.summary ?? ''),
            latest: g.edit_seq === sc!.head,
          }
        : null;
    };
    const platformRows = await sql<
      { id: number; name: string; platformCode: string | null; calls: number }[]
    >`
      select c.id, c.name, c.platform_code as "platformCode",
             (select count(*)::int from stop_times st join trips t on t.id = st.trip_id
              where st.stop_id = c.id and not (st.pickup_type = 1 and st.drop_off_type = 1) and ${vis}) as calls
      from stops c
      where (c.parent_id = ${station.id} or c.id = ${station.id}) and c.location_type = 0
      order by length(c.platform_code), c.platform_code, c.id`;
    const platforms = platformRows.map((p) => ({
      ...p,
      calls: p.calls as number,
      deleted: deletion(p.id),
    }));
    const used = platforms.filter((p) => p.calls > 0 || p.deleted || platforms.length <= 12);
    const stopIds = platforms.map((p) => p.id);
    const lines = stopIds.length
      ? await sql`
          select r.id as "routeId", r.short_name as "shortName", r.long_name as "longName", coalesce(r.color, m.color) as color,
                 m.name as "modeName", count(*)::int as calls, min(st.dep) as first, max(st.dep) as last
          from stop_times st
          join trips t on t.id = st.trip_id
          join routes r on r.id = t.route_id
          join modes m on m.id = r.mode_id
          where st.stop_id = any(${stopIds}) and not (st.pickup_type = 1 and st.drop_off_type = 1) and ${vis}
          group by r.id, m.name, m.color, m.sort
          order by m.sort, count(*) desc
          limit 80`
      : [];
    const hourly = stopIds.length
      ? await sql`
          select (st.dep / 3600)::int as hour, count(*)::int as calls
          from stop_times st join trips t on t.id = st.trip_id
          where st.stop_id = any(${stopIds}) and not (st.pickup_type = 1 and st.drop_off_type = 1) and ${vis}
          group by 1 order by 1`
      : [];
    return {
      ...station,
      deleted: deletion(station.id),
      platforms: used,
      lines,
      hourly,
      calls: platforms.reduce((sum, p) => sum + p.calls, 0),
    };
  });
}
