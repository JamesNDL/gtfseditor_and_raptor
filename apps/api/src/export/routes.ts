// GTFS export: one service day, with a scenario's changes applied, as a zip.
//
// Two options, both for the journey router and the simulator (docs/simulator-plan.md, 4.7 and 8):
//   ?shapes=0                      leave out shapes.txt, which is most of the export's time and size
//   ?box=south,west,north,east     keep only the stops inside the box, widened by ?margin= metres
//                                  (2000 unless said); each trip keeps only its calls at those stops,
//                                  and a trip left with fewer than two is dropped
//
// The database writes each file itself (COPY ... TO STDOUT), so the two million stop times never
// pass through JavaScript objects. Files go to a temporary folder, are zipped, then removed.
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import yazl from 'yazl';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { scenarioOf, type Scenario } from '../scenarios/scenarios.ts';
import { fail } from '../http.ts';

/** Same rule as `visible()` in scenarios.ts, as plain SQL text: COPY cannot take parameters. */
function visibleText(alias: string, sc: Scenario | null): string {
  if (!sc) return `${alias}.scenario_id is null`;
  const id = Number(sc.id);
  const head = Number(sc.head);
  if (!Number.isInteger(id) || !Number.isInteger(head)) throw fail(400, 'Bad scenario');
  return `((${alias}.scenario_id is null and not exists (
             select 1 from scenario_removed x where x.scenario_id = ${id} and x.trip_id = ${alias}.id and x.edit_seq <= ${head}))
           or (${alias}.scenario_id = ${id} and ${alias}.created_edit <= ${head}
               and (${alias}.removed_edit is null or ${alias}.removed_edit > ${head})))`;
}

const hms = (col: string) =>
  `lpad((${col} / 3600)::text, 2, '0') || ':' || lpad(((${col} % 3600) / 60)::text, 2, '0') || ':' || lpad((${col} % 60)::text, 2, '0')`;

/**
 * Reads ?box=south,west,north,east and widens it by a margin in metres, so that someone near the
 * edge still has the stops just outside it to walk or change to.
 */
function exportBox(text: string | undefined, marginText: string | undefined) {
  if (!text) return null;
  const parts = text.split(',').map(Number);
  const margin = marginText === undefined ? 2000 : Number(marginText);
  const [south, west, north, east] = parts;
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isFinite(n)) ||
    !(south < north) ||
    !(west < east) ||
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180
  ) {
    throw fail(400, 'box must be south,west,north,east');
  }
  if (!Number.isFinite(margin) || margin < 0 || margin > 50_000)
    throw fail(400, 'margin is 0 to 50000 metres');
  const lat = margin / 111_000;
  const lon = lat / Math.max(0.01, Math.cos((((south + north) / 2) * Math.PI) / 180));
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    south: round(south - lat),
    west: round(west - lon),
    north: round(north + lat),
    east: round(east + lon),
  };
}

export function registerExportRoutes(app: FastifyInstance, sql: Sql) {
  // An export that was cut off (the server stopped mid-way) leaves its scratch table behind. No
  // export can be running as the server starts, so anything there now is left over.
  void (async () => {
    const left =
      await sql`select tablename from pg_tables where schemaname = 'staging' and left(tablename, 7) = 'export_'`;
    for (const t of left)
      await sql.unsafe(`drop table if exists staging."${String(t.tablename).replaceAll('"', '')}"`);
  })().catch(() => {});

  app.get('/api/baselines/:b/export', async (req, reply) => {
    const b = Number((req.params as { b: string }).b);
    if (!Number.isInteger(b)) throw fail(400, 'Bad day');
    const [baseline] = await sql`
      select id, to_char(service_date, 'YYYYMMDD') as date, trim(to_char(service_date, 'day')) as weekday, feed_id
      from baselines where id = ${b} and ready`;
    if (!baseline) throw fail(404, 'Day not found');
    const sc = await scenarioOf(req, sql);
    if (sc && sc.baselineId !== b) throw fail(400, 'That scenario belongs to a different day');
    const [scenario] = sc ? await sql`select name from scenarios where id = ${sc.id}` : [null];
    const query = req.query as Record<string, string | undefined>;
    const withShapes = query.shapes !== '0';
    const box = exportBox(query.box, query.margin);
    // Stops inside the box, as SQL on a stops row aliased `alias`. PostGIS takes x (east) first.
    const inBox = (alias: string) =>
      box
        ? `${alias}.geom && ST_MakeEnvelope(${box.west}, ${box.south}, ${box.east}, ${box.north}, 4326)`
        : 'true';

    // Work out which trips are in the export once, into a scratch table, so each file's query is a
    // plain join rather than repeating the scenario rules.
    const scratch = `staging.export_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    await sql.unsafe(
      `create unlogged table ${scratch} as select t.id from trips t where t.baseline_id = ${b} and ${visibleText('t', sc)}${
        box
          ? ` and (select count(*) from stop_times st join stops s on s.id = st.stop_id where st.trip_id = t.id and ${inBox('s')}) >= 2`
          : ''
      }`,
    );
    await sql.unsafe(`alter table ${scratch} add primary key (id); analyze ${scratch}`);
    const vis = `t.id in (select id from ${scratch})`;
    const live = vis;
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const text = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const version =
      (scenario ? `${scenario.name} (${sc!.head} changes)` : 'as published') +
      (box ? `, cut to ${box.south},${box.west},${box.north},${box.east}` : '');
    // A stop the scenario has deleted (delete-stop.ts) is in no file: not in stops.txt, and nothing
    // may name it. The edit that deleted it already took it out of every trip; the conditions on
    // stop_times and pathways below make sure of it whatever was edited afterwards.
    const deleted = (alias: string) =>
      sc
        ? `exists (select 1 from scenario_removed_stops gone where gone.scenario_id = ${Number(sc.id)} and gone.stop_id = ${alias}.id and gone.edit_seq <= ${Number(sc.head)})`
        : 'false';
    const stopVisible = `((scenario_id is null${sc ? ` or (scenario_id = ${Number(sc.id)} and created_edit <= ${Number(sc.head)})` : ''}) and not ${deleted('stops')})`;

    // A block_id tells a journey planner that passengers stay aboard from one trip to the next.
    // In a scenario that is only still true where the two trips still meet: the first ends where
    // and before the second starts. A block the scenario has touched (one of its trips was retimed,
    // cut, split by a closure or removed) is therefore written as the runs of trips that still
    // join, each under its own id, and a trip left on its own has none. Blocks the scenario has not
    // touched are written exactly as published.
    const blockSql = sc
      ? `left join (
           select g.id, g.run, count(*) over (partition by g.feed_block_id, g.run) as size
           from (
             select q.id, q.feed_block_id,
                    sum(case when q.joins then 0 else 1 end) over (partition by q.feed_block_id order by q.start_secs, q.id) as run
             from (
               select x.id, x.feed_block_id, x.start_secs,
                      coalesce(lag(x.end_secs) over w <= x.start_secs
                               and lag(coalesce(ls.parent_id, ls.id)) over w = coalesce(fs.parent_id, fs.id), false) as joins
               from trips x join stops fs on fs.id = x.first_stop_id join stops ls on ls.id = x.last_stop_id
               where x.id in (select id from ${scratch}) and x.feed_block_id is not null
                 and not (x.scenario_id is not null and x.origin_trip_id is null)
                 and x.feed_block_id in (
                   select y.feed_block_id from trips y where y.scenario_id = ${Number(sc.id)} and y.feed_block_id is not null
                   union
                   select y.feed_block_id from scenario_removed gone join trips y on y.id = gone.trip_id
                   where gone.scenario_id = ${Number(sc.id)} and gone.edit_seq <= ${Number(sc.head)} and y.feed_block_id is not null)
               window w as (partition by x.feed_block_id order by x.start_secs, x.id)) q) g) blk on blk.id = t.id`
      : '';
    const blockId = sc
      ? `case when t.scenario_id is not null and t.origin_trip_id is null then null
              when blk.id is null then t.feed_block_id
              when blk.size < 2 then null
              else t.feed_block_id || '~' || blk.run end`
      : `t.feed_block_id`;

    // Every trip in the export runs on the one service day, under a single service id.
    const files: Record<string, string> = {
      'agency.txt': `
        select agency_gtfs_id as agency_id, max(agency_name) as agency_name, 'http://transportnsw.info' as agency_url,
               'Australia/Sydney' as agency_timezone, 'EN' as agency_lang
        from routes r where r.baseline_id = ${b} and r.agency_gtfs_id is not null
          and exists (select 1 from trips t where t.route_id = r.id and ${vis})
        group by 1 order by 1`,
      'routes.txt': `
        select r.gtfs_id as route_id, r.agency_gtfs_id as agency_id, r.short_name as route_short_name,
               r.long_name as route_long_name, r.description as route_desc, r.route_type,
               r.color as route_color, r.text_color as route_text_color
        from routes r where r.baseline_id = ${b}
          and exists (select 1 from trips t where t.route_id = r.id and ${vis})
        order by 1`,
      'stops.txt': `
        select gtfs_id as stop_id, code as stop_code, name as stop_name,
               round(ST_Y(geom)::numeric, 8) as stop_lat, round(ST_X(geom)::numeric, 8) as stop_lon,
               location_type, parent_gtfs_id as parent_station, wheelchair as wheelchair_boarding, platform_code
        from stops where baseline_id = ${b} and ${stopVisible}${
          box
            ? // A stop inside the box, or the parent of one: a parent's own position may lie outside.
              ` and (${inBox('stops')} or gtfs_id in (
                   select parent_gtfs_id from stops where baseline_id = ${b} and ${stopVisible} and ${inBox('stops')}))`
            : ''
        }
        order by 1`,
      'calendar.txt': `
        select 'DAY' as service_id, ${days.map((d) => `${d === baseline.weekday ? 1 : 0} as ${d}`).join(', ')},
               ${text(baseline.date)} as start_date, ${text(baseline.date)} as end_date`,
      'trips.txt': `
        select r.gtfs_id as route_id, 'DAY' as service_id, t.gtfs_id as trip_id, ${withShapes ? 'sh.gtfs_id' : 'null::text'} as shape_id,
               t.headsign as trip_headsign, t.direction_id,
               -- A block_id means "passengers stay aboard". Brand-new trips were copied from another
               -- trip and must not inherit its link; see blockSql above for the rest.
               ${blockId} as block_id,
               t.extra->>'wheelchair_accessible' as wheelchair_accessible, t.extra->>'bikes_allowed' as bikes_allowed
        from trips t join routes r on r.id = t.route_id left join shapes sh on sh.id = t.shape_id
        ${blockSql}
        where ${live} order by 3`,
      'stop_times.txt': `
        select t.gtfs_id as trip_id, ${hms('st.arr')} as arrival_time, ${hms('st.dep')} as departure_time,
               s.gtfs_id as stop_id, st.seq as stop_sequence, st.headsign as stop_headsign,
               st.pickup_type, st.drop_off_type, -- Through float8 first: converting a 32-bit number straight to numeric keeps only six digits.
               round(st.dist::float8::numeric, 2) as shape_dist_traveled, st.timepoint
        from trips t join stop_times st on st.trip_id = t.id join stops s on s.id = st.stop_id
        where ${live} and ${inBox('s')} and not ${deleted('s')} order by 1, 5`,
      // Distances are the feed's own, stored per point at import, so they line up with the stop times.
      'shapes.txt': `
        select s.gtfs_id as shape_id, round(ST_Y((dp).geom)::numeric, 8) as shape_pt_lat,
               round(ST_X((dp).geom)::numeric, 8) as shape_pt_lon, (dp).path[1] as shape_pt_sequence,
               round(s.dists[(dp).path[1]]::numeric, 2) as shape_dist_traveled
        from shapes s
        cross join lateral ST_DumpPoints(s.geom) dp
        where s.baseline_id = ${b} and exists (select 1 from trips t where t.shape_id = s.id and ${vis})
        order by 1, 4`,
      'pathways.txt': `
        select p.gtfs_id as pathway_id, f.gtfs_id as from_stop_id, o.gtfs_id as to_stop_id, p.pathway_mode,
               p.is_bidirectional::int as is_bidirectional, p.traversal_secs as traversal_time
        from pathways p join stops f on f.id = p.from_stop_id join stops o on o.id = p.to_stop_id
        where p.baseline_id = ${b} and ${inBox('f')} and ${inBox('o')} and not ${deleted('f')} and not ${deleted('o')} order by 1`,
      'feed_info.txt': `
        select 'GTFS Editor' as feed_publisher_name, 'http://transportnsw.info' as feed_publisher_url, 'EN' as feed_lang,
               ${text(baseline.date)} as feed_start_date, ${text(baseline.date)} as feed_end_date,
               ${text(`${baseline.feed_id}: ${version}`)} as feed_version`,
      // Not GTFS: what the editor knows about vehicles, for the simulator. Standard readers ignore these.
      'editor_vehicle_types.txt': `
        select id as vehicle_type_id, name, mode_id as mode, cars, seated, standing, fleet_size,
               capacity_is_placeholder::int as capacity_is_placeholder
        from vehicle_types order by 1`,
      'editor_trip_vehicles.txt': `
        select t.gtfs_id as trip_id, t.vehicle_day_id as vehicle_id, vd.label as vehicle_label,
               coalesce(vd.source, '') as vehicle_source, tv.vehicle_type_id, tv.assumed::int as vehicle_type_assumed
        from trips t join trip_vehicle tv on tv.trip_id = t.id left join vehicle_days vd on vd.id = t.vehicle_day_id
        where ${live} order by 1`,
    };

    const dir = await mkdtemp(path.join(os.tmpdir(), 'gtfs-export-'));
    const zip = new yazl.ZipFile();
    const cleanUp = async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await sql.unsafe(`drop table if exists ${scratch}`).catch(() => {});
    };
    zip.outputStream.on('close', () => void cleanUp());

    // Files are added to the zip as each one is written, so the download starts straight away instead
    // of after several minutes of silence.
    void (async () => {
      try {
        for (const [name, query] of Object.entries(files)) {
          if (name === 'shapes.txt' && !withShapes) continue;
          const readable = await sql
            .unsafe(`copy (${query}) to stdout with (format csv, header true)`)
            .readable();
          await pipeline(readable, createWriteStream(path.join(dir, name)));
          zip.addFile(path.join(dir, name), name);
        }
        zip.end();
      } catch (err) {
        req.log.error(err, 'GTFS export failed');
        // Cut the download short so a broken zip is not mistaken for a complete one.
        (zip.outputStream as unknown as { destroy: (e: Error) => void }).destroy(err as Error);
        void cleanUp();
      }
    })();

    const safe =
      (scenario?.name ?? 'published').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
      'scenario';
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="gtfs-${baseline.date}-${safe}.zip"`);
    reply.header('cache-control', 'no-store');
    return reply.send(zip.outputStream);
  });
}
