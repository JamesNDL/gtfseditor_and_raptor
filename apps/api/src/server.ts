import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import compress from '@fastify/compress';
import Fastify from 'fastify';
import { vehicleWaits, type WaitTrip } from '@gtfs-editor/core';
import { connect, migrate } from '@gtfs-editor/gtfs/db';
import { packsDir } from '@gtfs-editor/gtfs/packs';
import { registerExportRoutes } from './export.ts';
import { registerFleetRoutes } from './fleet.ts';
import { registerScenarioRoutes, scenarioOf, visible } from './scenarios.ts';
import { registerSimRoutes } from './sim.ts';
import { registerSimResultRoutes } from './sim-results.ts';
import { stopDeleted } from './stops.ts';

const PORT = Number(process.env.PORT ?? 3001);
// Packs live under <repo>/data/packs regardless of where the server is started from.
const PACKS_ROOT =
  process.env.PACKS_DIR ?? path.resolve(import.meta.dirname, '../../../data/packs');

const sql = connect();
await migrate(sql);

const app = Fastify({ logger: { level: 'warn' } });
await app.register(compress, { threshold: 1024 });

const int = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw Object.assign(new Error('Expected a whole number'), { statusCode: 400 });
  return n;
};
const notFound = (what: string) =>
  Object.assign(new Error(`${what} not found`), { statusCode: 404 });

// ---------------------------------------------------------------------------
// Baselines, modes, routes
// ---------------------------------------------------------------------------
app.get('/api/baselines', async () => {
  const baselines = await sql`
    select id, label, day_type, to_char(service_date, 'YYYY-MM-DD') as service_date, feed_id, stats
    from baselines where ready order by service_date`;
  const modeCounts = await sql`
    select t.baseline_id, r.mode_id, count(*)::int as trips
    from trips t join routes r on r.id = t.route_id where t.scenario_id is null group by 1, 2`;
  return baselines.map((b) => ({
    id: b.id,
    label: b.label,
    dayType: b.day_type,
    serviceDate: b.service_date,
    feedId: b.feed_id,
    stats: b.stats,
    tripsByMode: Object.fromEntries(
      modeCounts.filter((m) => m.baseline_id === b.id).map((m) => [m.mode_id, m.trips]),
    ),
  }));
});

app.get('/api/modes', async () => {
  return sql`select id, name, rule_set as "ruleSet", color from modes order by sort`;
});

app.get('/api/baselines/:b/routes', async (req) => {
  const b = int((req.params as any).b);
  const sc = await scenarioOf(req, sql);
  return sql`
    select r.id, r.short_name as "shortName", r.long_name as "longName", r.mode_id as "modeId",
           coalesce(r.color, m.color) as color,
           case when r.scenario_id is null then r.trip_count
                else (select count(*)::int from trips t where t.route_id = r.id and ${visible(sql, 't', sc)}) end as "tripCount",
           r.agency_name as agency, (r.scenario_id is not null) as "isNew"
    from routes r join modes m on m.id = r.mode_id
    where r.baseline_id = ${b}
      and ((r.scenario_id is null and r.trip_count > 0)
        or ${sc ? sql`(r.scenario_id = ${sc.id} and r.created_edit <= ${sc.head})` : sql`false`})
    order by m.sort, r.short_name`;
});

// ---------------------------------------------------------------------------
// Animation packs (binary, one per mode)
// ---------------------------------------------------------------------------
app.get('/api/baselines/:b/packs/:mode', async (req, reply) => {
  const { b, mode } = req.params as { b: string; mode: string };
  if (!/^[a-z_]+$/.test(mode)) throw notFound('Pack');
  const file = path.join(packsDir(int(b), PACKS_ROOT), `${mode}.bin`);
  const info = await stat(file).catch(() => null);
  if (!info) throw notFound('Pack');
  reply.header('content-type', 'application/octet-stream');
  reply.header('cache-control', 'public, max-age=86400');
  return reply.send(createReadStream(file));
});

/**
 * Waits between trips, so the map keeps a vehicle drawn while it stands at its terminus: pairs of
 * [trip id, the second its vehicle's next trip starts] as 32-bit integers. With ?s= the vehicle days
 * are the scenario's, and its own trips are included.
 */
app.get('/api/baselines/:b/waits', async (req, reply) => {
  const b = int((req.params as any).b);
  const sc = await scenarioOf(req, sql);
  // The published trips and the scenario's own are read separately and put together here: asking the
  // database which of 59,000 trips a scenario can see, one by one, takes several seconds.
  const read = (mine: ReturnType<typeof sql>) => sql<WaitTrip[]>`
    select t.id, t.vehicle_day_id as "vehicleDayId", t.start_secs as "startSecs", t.end_secs as "endSecs",
           t.first_stop_id as "firstStopId", t.last_stop_id as "lastStopId"
    from trips t
    where t.baseline_id = ${b} and ${mine}
      and t.vehicle_day_id is not null and t.start_secs is not null and t.end_secs is not null`;
  let trips: WaitTrip[] = await read(sql`t.scenario_id is null`);
  if (sc) {
    const [removed, own] = await Promise.all([
      sql`select trip_id from scenario_removed where scenario_id = ${sc.id} and edit_seq <= ${sc.head}`,
      read(
        sql`t.scenario_id = ${sc.id} and t.created_edit <= ${sc.head} and (t.removed_edit is null or t.removed_edit > ${sc.head})`,
      ),
    ]);
    const gone = new Set(removed.map((r) => r.trip_id as number));
    trips = [...trips.filter((t) => !gone.has(t.id)), ...own];
  }
  const ends = [
    ...new Set(trips.flatMap((t) => [t.firstStopId, t.lastStopId]).filter((id) => id !== null)),
  ];
  const stopRows = ends.length
    ? await sql`select id, parent_id, ST_X(geom) as lon, ST_Y(geom) as lat from stops where id = any(${ends})`
    : [];
  const stops = new Map(
    stopRows.map((s) => [
      s.id as number,
      { parentId: s.parent_id as number | null, lon: s.lon as number, lat: s.lat as number },
    ]),
  );
  const pairs = vehicleWaits(trips, stops);
  reply.header('content-type', 'application/octet-stream');
  // The published timetable never changes; a scenario does with every edit.
  reply.header('cache-control', sc ? 'no-store' : 'public, max-age=3600');
  return reply.send(Buffer.from(pairs.buffer, pairs.byteOffset, pairs.byteLength));
});

// ---------------------------------------------------------------------------
// Vector tiles: route lines and stops
// ---------------------------------------------------------------------------
const tileCache = new Map<string, Buffer>();
const TILE_CACHE_MAX = 3000;

// The lowest zoom at which each mode's lines and stops are drawn.
const LINE_MIN_ZOOM: Record<string, number> = {
  train: 0,
  metro: 0,
  light_rail: 0,
  ferry: 0,
  coach: 7,
  bus: 10,
  school_bus: 12,
};

app.get('/api/baselines/:b/tiles/:z/:x/:y', async (req, reply) => {
  const p = req.params as Record<string, string>;
  const [b, z, x, y] = [int(p.b), int(p.z), int(p.x), int(p.y.replace('.mvt', ''))];
  if (z > 22 || x >= 2 ** z || y >= 2 ** z) throw notFound('Tile');
  const key = `${b}/${z}/${x}/${y}`;
  let tile = tileCache.get(key);
  if (!tile) {
    const lineModes = Object.keys(LINE_MIN_ZOOM).filter((m) => z >= LINE_MIN_ZOOM[m]);
    const geom = sql(z < 10 ? 'geom_lo' : z < 13 ? 'geom_mid' : 'geom_hi');
    const [row] = await sql`
      with bounds as (
        select ST_TileEnvelope(${z}, ${x}, ${y}) as merc,
               ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}, margin => 0.02), 4326) as wgs),
      lines as (
        select ST_AsMVTGeom(l.${geom}, bounds.merc, 4096, 64, true) as geom,
               l.route_id, l.mode_id as mode, l.color, l.name, l.trips
        from map_lines l, bounds
        where l.baseline_id = ${b} and l.mode_id = any(${lineModes}) and l.${geom} && bounds.merc),
      stations as (
        select ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds.merc, 4096, 64, true) as geom,
               s.id as stop_id, s.name, s.mode_ids[1] as mode, true as station, true as rail, null::text as platform
        from stops s, bounds
        where s.baseline_id = ${b} and s.scenario_id is null and s.location_type = 1 and ${z} >= 9
          and s.mode_ids && array['train', 'metro', 'light_rail', 'ferry'] and s.geom && bounds.wgs),
      road_stops as (
        select ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds.merc, 4096, 64, true) as geom,
               s.id as stop_id, s.name, s.mode_ids[1] as mode, false as station,
               (s.mode_ids && array['train', 'metro', 'light_rail', 'ferry']) as rail, s.platform_code as platform
        from stops s, bounds
        where s.baseline_id = ${b} and s.scenario_id is null and s.location_type = 0 and ${z} >= 14
          and cardinality(s.mode_ids) > 0 and s.geom && bounds.wgs)
      select coalesce((select ST_AsMVT(l, 'lines') from lines l where l.geom is not null), ''::bytea)
          || coalesce((select ST_AsMVT(q, 'stops') from (select * from stations union all select * from road_stops) q
                       where q.geom is not null), ''::bytea) as tile`;
    tile = row.tile as Buffer;
    if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
    tileCache.set(key, tile);
  }
  reply.header('content-type', 'application/vnd.mapbox-vector-tile');
  // Short browser cache: tile contents change whenever the tile query does.
  reply.header('cache-control', 'public, max-age=60');
  return reply.send(tile);
});

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

registerScenarioRoutes(app, sql);
registerFleetRoutes(app, sql);
registerExportRoutes(app, sql);
registerSimRoutes(app, sql);
registerSimResultRoutes(app, sql);

app.get('/api/health', async () => ({ ok: true }));

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`API listening on http://localhost:${PORT}`);
