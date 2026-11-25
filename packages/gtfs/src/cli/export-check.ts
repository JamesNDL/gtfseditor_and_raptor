// Downloads a GTFS export from the running API and checks it.
// Usage: npm run export:check                      (the published day, the first one imported)
//        npm run export:check -- 3                 (scenario 3, on whichever day it belongs to)
//        npm run export:check -- 3 --box=-33.95,151.0,-33.6,151.3 --no-shapes
//                                                  (the same, cut to a box and without shapes.txt: much quicker)
// Writes to data/exports/<name> (check, or --out=<name>); EXPORTS_DIR=<folder> writes there instead.
//
// Checks: every reference resolves, also in the editor's vehicle files; ids are unique; every trip has two or more stop times; times
// and distances never run backwards; and, for the published day, that trips and stop times match
// the original TfNSW feed exactly. For a scenario it also checks the trips the scenario made or
// changed against what a vehicle can do: none runs a stretch faster than its mode can go unless a
// published trip runs that same stretch as fast (TfNSW's own feed has some impossible stretches).
import { DuckDBInstance } from '@duckdb/node-api';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkReferences } from './export-references.ts';
import { vehicleFileProblems } from './export-vehicles.ts';
import { unzip } from '../feed/unzip.ts';

const API = process.env.API ?? 'http://localhost:3001';
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const scenarioArg = args.find((a) => !a.startsWith('--'));
const scenario = scenarioArg ? Number(scenarioArg) : null;
const box = flag('box')?.split('=')[1] ?? null;
const withShapes = !flag('no-shapes');
// Where the files go: a folder of their own when asked, so that a test can run beside a full check.
const outName = flag('out')?.split('=')[1] ?? 'check';

const baselines = (await (await fetch(`${API}/api/baselines`)).json()) as {
  id: number;
  serviceDate: string;
  feedId: string;
}[];
let baseline = baselines[0];
if (scenario !== null) {
  // A scenario is checked on its own day, not on the first day imported.
  const res = await fetch(`${API}/api/scenarios/${scenario}`);
  assert.equal(res.status, 200, `scenario ${scenario} responded ${res.status}`);
  const info = (await res.json()) as { baselineId: number };
  const own = baselines.find((b) => b.id === info.baselineId);
  assert.ok(own, `scenario ${scenario} belongs to a day that is not imported`);
  baseline = own;
}
const exportsDir = process.env.EXPORTS_DIR ?? 'data/exports';
const outDir = path.resolve(exportsDir, outName.replace(/[^A-Za-z0-9_-]/g, ''));
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, 'export.zip');

const started = Date.now();
const query = [
  scenario !== null ? `s=${scenario}` : '',
  box ? `box=${box}` : '',
  withShapes ? '' : 'shapes=0',
]
  .filter(Boolean)
  .join('&');
const res = await fetch(`${API}/api/baselines/${baseline.id}/export${query ? `?${query}` : ''}`);
assert.equal(res.status, 200, `export responded ${res.status}`);
await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));
console.log(
  `exported ${res.headers.get('content-disposition')} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
await unzip(zipPath, outDir);

const db = await (await DuckDBInstance.create(':memory:')).connect();
const q = async (sql: string) =>
  (await (await db.run(sql)).getRowObjectsJson()) as Record<string, string | number | null>[];
const csv = (name: string, dir = outDir) =>
  `read_csv('${path.join(dir, name).split(path.sep).join('/')}', header=true, all_varchar=true)`;
for (const t of ['agency', 'routes', 'stops', 'calendar', 'trips', 'stop_times', 'pathways']) {
  await db.run(`create table ${t} as select * from ${csv(`${t}.txt`)}`);
}
if (withShapes) await db.run(`create table shapes as select * from ${csv('shapes.txt')}`);
else
  await db.run(
    `create table shapes (shape_id varchar, shape_pt_lat varchar, shape_pt_lon varchar, shape_pt_sequence varchar, shape_dist_traveled varchar)`,
  );
const count = async (sql: string) => Number((await q(`select count(*) n from (${sql})`))[0].n);
const ok = (name: string) => console.log(`ok  ${name}`);

const sizes = (
  await q(`select (select count(*) from routes) routes, (select count(*) from trips) trips,
  (select count(*) from stop_times) stop_times, (select count(*) from stops) stops,
  (select count(distinct shape_id) from shapes) shapes, (select count(*) from shapes) shape_points`)
)[0];
console.log('    ', JSON.stringify(sizes));

await checkReferences(count);
ok('every reference resolves');
const vehicleProblems = await vehicleFileProblems(outDir);
assert.deepEqual(
  vehicleProblems,
  [],
  `the vehicle files are wrong:\n${vehicleProblems.join('\n')}`,
);
ok(
  'the vehicle files name only trips and vehicle types in the export, and where each trip came from',
);

// Uniqueness and ordering.
assert.equal(await count(`select trip_id from trips group by 1 having count(*) > 1`), 0);
assert.equal(
  await count(`select trip_id, stop_sequence from stop_times group by 1, 2 having count(*) > 1`),
  0,
);
assert.equal(
  await count(`select trip_id from stop_times group by 1 having count(*) < 2`),
  0,
  'a trip has fewer than two stop times',
);
assert.equal(await count(`select 1 from stop_times where departure_time < arrival_time`), 0);
assert.equal(
  await count(`select 1 from (select arrival_time, lag(departure_time) over (partition by trip_id order by stop_sequence::int) prev
                              from stop_times) where prev is not null and arrival_time < prev`),
  0,
);
assert.equal(
  await count(`select 1 from (select shape_dist_traveled::double d, lag(shape_dist_traveled::double) over
                              (partition by shape_id order by shape_pt_sequence::int) prev from shapes) where d < prev`),
  0,
);
assert.equal(
  await count(`select 1 from (select shape_dist_traveled::double d, lag(shape_dist_traveled::double) over
                              (partition by trip_id order by stop_sequence::int) prev from stop_times
                              where shape_dist_traveled is not null) where d < prev - 0.5`),
  0,
  'a stop is nearer the start of its path than the stop before it',
);
// Only platforms and stops can be called at: location_type 0 or blank.
assert.equal(
  await count(
    `select 1 from stop_times st join stops s using (stop_id) where coalesce(s.location_type, '0') not in ('0', '')`,
  ),
  0,
  'a trip calls at something that is not a stop or a platform',
);
ok(
  'ids are unique, every trip has two or more stop times, and times and distances never run backwards',
);

// A block id means passengers stay aboard, so two trips in one block should not overlap. TfNSW's own
// feed contains a few that do, so on the published day this is reported rather than failed; the
// round trip below proves the published day's block ids are unchanged. A block the scenario has
// touched is written under a new id (the published id, '~' and a number), and those must be right.
const overlaps = (where: string) =>
  count(`
  with span as (select t.block_id, t.trip_id, min(st.departure_time) s, max(st.arrival_time) e
                from trips t join stop_times st using (trip_id) where t.block_id is not null and ${where} group by 1, 2)
  select 1 from span a join span b on a.block_id = b.block_id and a.trip_id < b.trip_id and a.s < b.e and b.s < a.e`);
console.log(`    blocks with overlapping trips: ${await overlaps('true')}`);

// Two trips that are the same in every respect but their id: same line, same stops, same times.
// Reported, not failed: the published feed has some of its own.
const twins = await count(`
  with sig as (select t.route_id, t.trip_id, string_agg(st.stop_id || '@' || st.arrival_time || '/' || st.departure_time, ',' order by st.stop_sequence::int) s
               from trips t join stop_times st using (trip_id) group by 1, 2)
  select 1 from sig group by route_id, s having count(*) > 1`);
console.log(`    sets of trips identical but for their id: ${twins}`);

if (scenario !== null) {
  // Trips the scenario made or changed carry its mark in their id.
  const made = `(trip_id like '%~%' or trip_id like 'NEW%')`;
  assert.equal(
    await overlaps(`t.block_id like '%~%'`),
    0,
    'two trips of a block the scenario changed overlap',
  );
  // The fastest each kind of service can go between two stops, in km/h, by GTFS route type.
  const ceiling = `case when r.route_type::int = 2 or r.route_type::int between 100 and 199 then 165
                        when r.route_type::int between 400 and 499 then 110
                        when r.route_type::int = 0 or r.route_type::int between 900 and 999 then 80
                        when r.route_type::int = 4 or r.route_type::int between 1000 and 1099 then 60
                        when r.route_type::int between 200 and 299 then 115
                        when r.route_type::int = 3 or r.route_type::int between 700 and 799 then 100
                        else 165 end`;
  await db.run(`
    create table hops as
    select st.trip_id, st.stop_id, st.prev_stop, st.secs,
           6371000 * 2 * asin(sqrt(pow(sin(radians(b.stop_lat::double - a.stop_lat::double) / 2), 2)
             + cos(radians(a.stop_lat::double)) * cos(radians(b.stop_lat::double)) * pow(sin(radians(b.stop_lon::double - a.stop_lon::double) / 2), 2))) as metres
    from (
      select trip_id, stop_id, lag(stop_id) over w as prev_stop,
             (split_part(arrival_time, ':', 1)::int * 3600 + split_part(arrival_time, ':', 2)::int * 60 + split_part(arrival_time, ':', 3)::int)
             - lag(split_part(departure_time, ':', 1)::int * 3600 + split_part(departure_time, ':', 2)::int * 60 + split_part(departure_time, ':', 3)::int) over w as secs
      from stop_times window w as (partition by trip_id order by stop_sequence::int)) st
    join stops a on a.stop_id = st.prev_stop join stops b on b.stop_id = st.stop_id
    where st.prev_stop is not null`);
  const tooFast = await q(`
    select h.trip_id, h.prev_stop, h.stop_id, round(h.metres) as metres, h.secs
    from hops h join trips t using (trip_id) join routes r using (route_id)
    where ${made.replaceAll('trip_id', 'h.trip_id')} and h.metres > 300 and h.secs * (${ceiling}) / 3.6 < h.metres
      and not exists (select 1 from hops p where p.prev_stop = h.prev_stop and p.stop_id = h.stop_id and p.secs <= h.secs
                      and not (${made.replaceAll('trip_id', 'p.trip_id')}))
    order by h.metres / greatest(h.secs, 1) desc limit 5`);
  // The export alone cannot settle it: where the scenario replaced every trip over a stretch, no
  // published trip is left in the file to compare with. The editor has the whole published
  // timetable, so its own rule (the "speed" clashes) is the one that must find nothing.
  const { conflicts } = (await (await fetch(`${API}/api/scenarios/${scenario}`)).json()) as {
    conflicts: { kind: string; title: string; detail: string }[];
  };
  const speed = conflicts.filter((c) => c.kind === 'speed');
  assert.equal(
    speed.length,
    0,
    `a trip the scenario made runs faster than its mode can go, or backwards: ${JSON.stringify(speed.slice(0, 3))}`,
  );
  console.log(
    `    stretches of the scenario's trips over the limit for their mode with no published trip in this file as fast: ${tooFast.length ? `at least ${tooFast.length}, each as fast in the published timetable` : 0}`,
  );
  ok(
    'no trip the scenario made runs faster than its mode can go or backwards, and the blocks it changed do not overlap',
  );
}

if (scenario === null && !box && withShapes) {
  // Round trip: the published day must match the feed it was imported from.
  const manifest = JSON.parse(await readFile(path.resolve('data/feeds/manifest.json'), 'utf8')) as {
    versions: { id: string; dir: string }[];
  };
  const feed = manifest.versions.find((v) => v.id === baseline.feedId);
  assert.ok(feed, `original feed ${baseline.feedId} is no longer in data/feeds`);
  const date = baseline.serviceDate.replaceAll('-', '');
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    new Date(`${baseline.serviceDate}T00:00:00Z`).getUTCDay()
  ];
  await db.run(`create table src_trips as select * from ${csv('trips.txt', feed.dir)} where service_id in (
    select service_id from ${csv('calendar.txt', feed.dir)} where ${weekday} = '1' and start_date <= '${date}' and end_date >= '${date}'
      and service_id not in (select service_id from ${csv('calendar_dates.txt', feed.dir)} where date = '${date}' and exception_type = '2')
    union select service_id from ${csv('calendar_dates.txt', feed.dir)} where date = '${date}' and exception_type = '1')`);
  await db.run(
    `create table src_st as select * from ${csv('stop_times.txt', feed.dir)} where trip_id in (select trip_id from src_trips)`,
  );

  assert.equal(await count(`select trip_id from src_trips except select trip_id from trips`), 0);
  assert.equal(await count(`select trip_id from trips except select trip_id from src_trips`), 0);
  assert.equal(
    await count(`select trip_id, route_id, coalesce(shape_id, ''), coalesce(trip_headsign, ''), coalesce(direction_id, ''), coalesce(block_id, '') from src_trips
                 except select trip_id, route_id, coalesce(shape_id, ''), coalesce(trip_headsign, ''), coalesce(direction_id, ''), coalesce(block_id, '') from trips`),
    0,
  );
  ok('trips match the original feed');
  const stCols = `trip_id, stop_sequence, stop_id, arrival_time, departure_time, coalesce(pickup_type, '0'), coalesce(drop_off_type, '0')`;
  assert.equal(
    await count(`select ${stCols} from src_st except select ${stCols} from stop_times`),
    0,
  );
  assert.equal(
    await count(`select ${stCols} from stop_times except select ${stCols} from src_st`),
    0,
  );
  // Distances are stored as 32-bit numbers, so very long trips lose a few centimetres.
  const [dist] = await q(`
    select max(abs(coalesce(a.shape_dist_traveled, '0')::double - coalesce(b.shape_dist_traveled, '0')::double)) worst
    from src_st a join stop_times b on a.trip_id = b.trip_id and a.stop_sequence = b.stop_sequence`);
  assert.ok(Number(dist.worst) < 0.5, `stop distances drifted by ${dist.worst} m`);
  ok(
    `stop times match the original feed (largest distance difference: ${Number(dist.worst).toFixed(2)} m)`,
  );
  await db.run(
    `create table src_shapes as select * from ${csv('shapes.txt', feed.dir)} where shape_id in (select shape_id from src_trips)`,
  );
  assert.equal(await count(`select 1 from src_shapes`), Number(sizes.shape_points));
  const [drift] = await q(`
    select max(abs(a.shape_pt_lat::double - b.shape_pt_lat::double)) lat, max(abs(a.shape_pt_lon::double - b.shape_pt_lon::double)) lon,
           max(abs(a.shape_dist_traveled::double - b.shape_dist_traveled::double)) dist
    from src_shapes a join shapes b on a.shape_id = b.shape_id and a.shape_pt_sequence::int = b.shape_pt_sequence::int`);
  assert.ok(Number(drift.lat) < 1e-6 && Number(drift.lon) < 1e-6, 'shape points moved');
  assert.ok(Number(drift.dist) < 0.01, `shape distances drifted by ${drift.dist} m`);
  ok('shapes match the original feed');
}
console.log('export checks passed');
