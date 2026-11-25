// End-to-end check of what an access analysis run stores for each pair (AA-15: FR-8, FR-9, FR-11,
// FR-12, NFR-4): every stored row matches the fake router's known answers (car time, public
// transport time and its split, the access ratio, no service and no road); the bulk journey request
// carries the analysis's limits; the same analysis made twice gives identical rows; and a router
// error ends the run failed with the router's words. Run by analysis.e2e.mjs against the fake
// router (fake-router.mjs, D32). Needs FAKE_ROUTER and DATABASE_URL.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { gridCount } from '../../../packages/core/src/analysis/grid.ts';
import {
  FAKE_ROUTER,
  create,
  fake,
  fakeState,
  placesFor,
  send,
  step,
  until,
} from './analysis-e2e-client.mjs';

if (!FAKE_ROUTER || !process.env.DATABASE_URL) {
  console.log('skipped: the analysis pair checks need FAKE_ROUTER and DATABASE_URL');
  process.exit(0);
}
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

// The fake router's answers (see the top of fake-router.mjs), for a pair at straight distance d.
function metresBetween(a, b) {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * 111_320 * Math.cos(midLat);
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}
const tenths = (value) => Math.round(value * 10) / 10;
const multipleOf = (value, n) => Math.round(value * 1e4) % n === 0;
const DEPART = 8 * 3600;
const PEAK_FACTOR = 1.4; // 08:00 is in the morning peak (D34)
const PARKING_SECS = 5 * 60;
const MAX_JOURNEY_SECS = 15 * 60;

/** What the run should store for a pair, worked out from the fake router's rules. */
function expected(point, poi) {
  const d = metresBetween(point, poi);
  const driveSecs = multipleOf(point.lon, 11) ? null : tenths((d * 1.3) / 12);
  const car = driveSecs === null ? null : driveSecs * PEAK_FACTOR + PARKING_SECS;
  const found = !multipleOf(point.lat, 7);
  const rideSecs = Math.round(d / 6);
  const boardAt = DEPART + 240 + 150;
  const pt = found ? 240 + 150 + rideSecs + 150 : null;
  // The trip and stop ids are kept so the ride can be drawn along its path (D39).
  const stop = (p, time) => ({ stop: 'F', name: 'Fake stop', lat: p.lat, lon: p.lon, time });
  const legs = found
    ? [
        { type: 'walk', secs: 150, metres: 155 },
        {
          type: 'ride',
          trip: 'F1-1',
          route: 'F1',
          mode: 'bus',
          board: stop(point, boardAt),
          alight: stop(poi, boardAt + rideSecs),
          secs: rideSecs,
          metres: Math.round(d),
        },
        { type: 'walk', secs: 150, metres: 155 },
      ]
    : null;
  let status = 'ok';
  if (!found || pt > MAX_JOURNEY_SECS) status = 'noService';
  else if (driveSecs === null) status = 'noRoad';
  return {
    status,
    drive_checked: true,
    pt_secs: pt,
    walk_secs: found ? 300 : null,
    wait_secs: found ? 240 : null,
    ride_secs: found ? rideSecs : null,
    rides: found ? 1 : null,
    legs,
    drive_secs: driveSecs,
    drive_metres: driveSecs === null ? null : tenths(d * 1.3),
    car_secs: car,
    ratio: status === 'ok' ? pt / car : null,
  };
}

/** Every result row of an analysis with its two ends, in pair order. */
const rowsOf = (id) => db`
  select r.point_seq, r.poi_seq, r.status, r.drive_checked, r.pt_secs, r.walk_secs, r.wait_secs,
         r.ride_secs, r.rides, r.legs, r.drive_secs, r.drive_metres, r.car_secs, r.ratio,
         p.lon, p.lat, st_x(o.geom) as poi_lon, st_y(o.geom) as poi_lat
  from analysis_results r
  join analysis_points p on p.analysis_id = r.analysis_id and p.seq = r.point_seq
  join analysis_pois o on o.analysis_id = r.analysis_id and o.seq = r.poi_seq
  where r.analysis_id = ${id}
  order by r.poi_seq, r.point_seq`;

/** Real (float4) columns match to about seven figures. */
const near = (actual, wanted, what) => {
  if (wanted === null) return assert.equal(actual, null, what);
  assert.ok(Math.abs(actual - wanted) <= Math.abs(wanted) * 1e-6 + 1e-3, `${what}: ${actual}`);
};

// Up to 400 m walks, 2 changes, no ferries or school buses, journeys up to 15 minutes.
const settings = {
  maxWalkM: 400,
  maxChanges: 2,
  maxJourneyMins: 15,
  modes: ['train', 'metro', 'light_rail', 'bus', 'coach', 'other'],
};
const places = await placesFor(151.1, -33.95, settings);
const made = [];
try {
  // ---- the stored rows (AC-FR-9.1, AC-FR-11.1, AC-FR-12.1) -------------------------------------
  await fake({ resetCounts: true });
  const first = await create(places.body);
  made.push(first);
  const done = await until(first, (d) => ['done', 'failed'].includes(d.state), 'the run ends');
  assert.equal(done.state, 'done', done.error);
  const pairs = gridCount(places.ring, 100) * 3;
  assert.equal(pairs, 1500);
  const rows = await rowsOf(first);
  assert.equal(rows.length, pairs, 'one row per pair');
  const seen = new Set();
  for (const row of rows) {
    const point = { lon: row.lon, lat: row.lat };
    const want = expected(point, { lon: row.poi_lon, lat: row.poi_lat });
    const what = `pair ${row.poi_seq}:${row.point_seq}`;
    seen.add(want.status + (want.pt_secs === null ? ' none' : ''));
    for (const key of ['status', 'drive_checked', 'pt_secs', 'walk_secs', 'wait_secs']) {
      assert.equal(row[key], want[key], `${what} ${key}`);
    }
    for (const key of ['ride_secs', 'rides']) assert.equal(row[key], want[key], `${what} ${key}`);
    assert.deepEqual(row.legs, want.legs, `${what} legs`);
    for (const key of ['drive_secs', 'drive_metres', 'car_secs', 'ratio']) {
      near(row[key], want[key], `${what} ${key}`);
    }
  }
  for (const kind of ['ok', 'noService', 'noService none', 'noRoad']) {
    assert.ok(seen.has(kind), `the checks cover a pair that is ${kind}`);
  }
  const counts = (await fakeState()).counts;
  assert.equal(counts.drives, pairs, 'each pair is driven once');
  assert.equal(counts.journeys, pairs, 'each pair is asked for once');
  assert.equal(counts.tableRequests, 3, 'one road table per point of interest (500 < 1,000)');
  assert.equal(counts.bulkRequests, 3, 'journeys in batches of 500');
  step('AC-FR-9.1, AC-FR-11.1 car time = drive x 1.4 + 5 min; ratio = public transport / car');
  step('AC-FR-12.1 no journey, or one too long, is noService; no drive is noRoad; no ratio');

  // ---- the bulk request (AC-FR-8.1) -------------------------------------------------------------
  const { lastBulk } = await fakeState();
  const [{ timetable_id: timetable }] =
    await db`select timetable_id from analyses where id = ${first}`;
  const { queries, ...shared } = lastBulk;
  assert.deepEqual(shared, {
    timetable,
    maxWalkMetres: 400,
    maxRides: 3,
    avoid: ['ferry', 'school_bus'],
    capacity: { mode: 'off' },
    detail: 'summary',
  });
  assert.equal(queries.length, 500);
  const byPair = new Map(rows.map((r) => [`${r.poi_seq}:${r.point_seq}`, r]));
  for (const query of queries) {
    const row = byPair.get(query.id);
    assert.ok(row, `query id ${query.id} names a pair`);
    assert.deepEqual(query, {
      id: query.id,
      from: { lat: row.lat, lon: row.lon },
      to: { lat: row.poi_lat, lon: row.poi_lon },
      depart: DEPART,
    });
  }
  step('AC-FR-8.1 the bulk request carries the walk, rides, modes avoided, capacity off, summary');

  // ---- the same analysis twice (AC-NFR-4.1) -----------------------------------------------------
  const second = await create(places.body);
  made.push(second);
  const again = await until(second, (d) => ['done', 'failed'].includes(d.state), 'the rerun ends');
  assert.equal(again.state, 'done', again.error);
  assert.deepEqual([...(await rowsOf(second))], [...rows], 'the same rows, value for value');
  step('AC-NFR-4.1 the same analysis made twice gives identical result rows');

  // ---- a router error (AC 7) --------------------------------------------------------------------
  const words = 'Timetable e2e-missing is not loaded';
  await fake({ bulkError: words });
  const broken = await create({ ...places.body, poiIds: places.body.poiIds.slice(0, 1) });
  made.push(broken);
  const failed = await until(broken, (d) => ['done', 'failed'].includes(d.state), 'it fails');
  assert.equal(failed.state, 'failed');
  assert.ok(failed.error.includes(words), `the router's words are kept: ${failed.error}`);
  const [left] = await db`select count(*) from analysis_results where analysis_id = ${broken}`;
  assert.equal(Number(left.count), 0, 'a failed run deletes its results');
  step("a router error ends the run failed, with the router's words");
} finally {
  await fake({ bulkError: null });
  for (const id of made) await send('DELETE', `/api/analyses/${id}`);
  await places.remove();
  await db.end();
}
console.log('all analysis pair checks passed');
