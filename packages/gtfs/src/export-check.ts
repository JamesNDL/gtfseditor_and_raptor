// Downloads a GTFS export from the running API and checks it.
// Usage: npm run export:check            (the published day)
//        npm run export:check -- 3       (scenario 3)
//
// Checks: every reference resolves, times never run backwards within a trip, and, for the published
// day, that trips and stop times match the original TfNSW feed exactly.
import { DuckDBInstance } from '@duckdb/node-api';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzip } from './unzip.ts';

const API = process.env.API ?? 'http://localhost:3001';
const scenario = process.argv[2] ? Number(process.argv[2]) : null;

const [baseline] = (await (await fetch(`${API}/api/baselines`)).json()) as { id: number; serviceDate: string; feedId: string }[];
const outDir = path.resolve('data/exports/check');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, 'export.zip');

const started = Date.now();
const res = await fetch(`${API}/api/baselines/${baseline.id}/export${scenario ? `?s=${scenario}` : ''}`);
assert.equal(res.status, 200, `export responded ${res.status}`);
await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));
console.log(`exported ${res.headers.get('content-disposition')} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
await unzip(zipPath, outDir);

const db = await (await DuckDBInstance.create(':memory:')).connect();
const q = async (sql: string) => (await db.run(sql)).getRowObjectsJson() as Record<string, string | number | null>[];
const csv = (name: string, dir = outDir) => `read_csv('${path.join(dir, name).split(path.sep).join('/')}', header=true, all_varchar=true)`;
for (const t of ['agency', 'routes', 'stops', 'calendar', 'trips', 'stop_times', 'shapes', 'pathways']) {
  await db.run(`create table ${t} as select * from ${csv(`${t}.txt`)}`);
}
const count = async (sql: string) => Number((await q(`select count(*) n from (${sql})`))[0].n);
const ok = (name: string) => console.log(`ok  ${name}`);

const sizes = (await q(`select (select count(*) from routes) routes, (select count(*) from trips) trips,
  (select count(*) from stop_times) stop_times, (select count(*) from stops) stops,
  (select count(distinct shape_id) from shapes) shapes, (select count(*) from shapes) shape_points`))[0];
console.log('    ', JSON.stringify(sizes));

// References.
assert.equal(await count(`select 1 from trips where route_id not in (select route_id from routes)`), 0);
assert.equal(await count(`select 1 from trips where service_id not in (select service_id from calendar)`), 0);
assert.equal(await count(`select 1 from trips where shape_id is not null and shape_id not in (select distinct shape_id from shapes)`), 0);
assert.equal(await count(`select 1 from stop_times where trip_id not in (select trip_id from trips)`), 0);
assert.equal(await count(`select 1 from stop_times where stop_id not in (select stop_id from stops)`), 0);
assert.equal(await count(`select 1 from routes where agency_id not in (select agency_id from agency)`), 0);
assert.equal(await count(`select 1 from stops where parent_station is not null and parent_station not in (select stop_id from stops)`), 0);
assert.equal(await count(`select 1 from pathways where from_stop_id not in (select stop_id from stops) or to_stop_id not in (select stop_id from stops)`), 0);
assert.equal(await count(`select 1 from trips where trip_id not in (select trip_id from stop_times)`), 0);
ok('every reference resolves');

// Uniqueness and ordering.
assert.equal(await count(`select trip_id from trips group by 1 having count(*) > 1`), 0);
assert.equal(await count(`select trip_id, stop_sequence from stop_times group by 1, 2 having count(*) > 1`), 0);
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
ok('ids are unique and times and distances never run backwards');

// A block id means passengers stay aboard, so two trips in one block should not overlap. TfNSW's own
// feed contains a few that do, so this is reported rather than failed; the round trip below proves
// the published day's block ids are unchanged.
const overlapping = await count(`
  with span as (select t.block_id, t.trip_id, min(st.departure_time) s, max(st.arrival_time) e
                from trips t join stop_times st using (trip_id) where t.block_id is not null group by 1, 2)
  select 1 from span a join span b on a.block_id = b.block_id and a.trip_id < b.trip_id and a.s < b.e and b.s < a.e`);
console.log(`    blocks with overlapping trips: ${overlapping}`);

if (!scenario) {
  // Round trip: the published day must match the feed it was imported from.
  const manifest = JSON.parse(await readFile(path.resolve('data/feeds/manifest.json'), 'utf8')) as { versions: { id: string; dir: string }[] };
  const feed = manifest.versions.find((v) => v.id === baseline.feedId);
  assert.ok(feed, `original feed ${baseline.feedId} is no longer in data/feeds`);
  const date = baseline.serviceDate.replaceAll('-', '');
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${baseline.serviceDate}T00:00:00Z`).getUTCDay()];
  await db.run(`create table src_trips as select * from ${csv('trips.txt', feed.dir)} where service_id in (
    select service_id from ${csv('calendar.txt', feed.dir)} where ${weekday} = '1' and start_date <= '${date}' and end_date >= '${date}'
      and service_id not in (select service_id from ${csv('calendar_dates.txt', feed.dir)} where date = '${date}' and exception_type = '2')
    union select service_id from ${csv('calendar_dates.txt', feed.dir)} where date = '${date}' and exception_type = '1')`);
  await db.run(`create table src_st as select * from ${csv('stop_times.txt', feed.dir)} where trip_id in (select trip_id from src_trips)`);

  assert.equal(await count(`select trip_id from src_trips except select trip_id from trips`), 0);
  assert.equal(await count(`select trip_id from trips except select trip_id from src_trips`), 0);
  assert.equal(
    await count(`select trip_id, route_id, coalesce(shape_id, ''), coalesce(trip_headsign, ''), coalesce(direction_id, ''), coalesce(block_id, '') from src_trips
                 except select trip_id, route_id, coalesce(shape_id, ''), coalesce(trip_headsign, ''), coalesce(direction_id, ''), coalesce(block_id, '') from trips`),
    0,
  );
  ok('trips match the original feed');
  const stCols = `trip_id, stop_sequence, stop_id, arrival_time, departure_time, coalesce(pickup_type, '0'), coalesce(drop_off_type, '0')`;
  assert.equal(await count(`select ${stCols} from src_st except select ${stCols} from stop_times`), 0);
  assert.equal(await count(`select ${stCols} from stop_times except select ${stCols} from src_st`), 0);
  // Distances are stored as 32-bit numbers, so very long trips lose a few centimetres.
  const [dist] = await q(`
    select max(abs(coalesce(a.shape_dist_traveled, '0')::double - coalesce(b.shape_dist_traveled, '0')::double)) worst
    from src_st a join stop_times b on a.trip_id = b.trip_id and a.stop_sequence = b.stop_sequence`);
  assert.ok(Number(dist.worst) < 0.5, `stop distances drifted by ${dist.worst} m`);
  ok(`stop times match the original feed (largest distance difference: ${Number(dist.worst).toFixed(2)} m)`);
  await db.run(`create table src_shapes as select * from ${csv('shapes.txt', feed.dir)} where shape_id in (select shape_id from src_trips)`);
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
