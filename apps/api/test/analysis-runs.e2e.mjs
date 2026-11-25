// End-to-end check of making and running access analyses (AA-14: FR-6 refusals, FR-7, FR-10,
// FR-16, NFR-3): refused settings and routers that are down store nothing; a good request is
// queued, copies its zone and points of interest and lays its sample points; one runs at a time;
// cancel, delete, and runs picked up again when the API starts. Run by analysis.e2e.mjs, against
// the fake router (fake-router.mjs, D32) that `npm run test:e2e:fixture` starts and names in
// FAKE_ROUTER. Needs DATABASE_URL; the restart check also needs E2E_SPARE_PORT.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';
import { gridCount, sampleGrid } from '../../../packages/core/src/analysis/grid.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const API = process.env.API ?? 'http://localhost:3001';
const FAKE_ROUTER = process.env.FAKE_ROUTER;
const send = async (method, url, body, base = API) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const get = async (url, base = API) => {
  const answer = await send('GET', url, undefined, base);
  assert.equal(answer.status, 200, `${url} responded ${answer.status}: ${JSON.stringify(answer)}`);
  return answer.body;
};
const step = (name) => console.log(`ok  ${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fake = (control) => send('POST', '/fake/control', control, FAKE_ROUTER);

/** Polls an analysis until `done(detail)` is true; fails after `secs` seconds. */
async function until(id, done, what, secs = 15, base = API) {
  const deadline = Date.now() + secs * 1000;
  for (;;) {
    const detail = await get(`/api/analyses/${id}`, base);
    if (done(detail)) return detail;
    if (Date.now() > deadline) assert.fail(`${what}: still ${JSON.stringify(detail.state)}`);
    await sleep(200);
  }
}

if (!FAKE_ROUTER || !process.env.DATABASE_URL) {
  console.log('skipped: the analysis run checks need FAKE_ROUTER and DATABASE_URL');
  process.exit(0);
}
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const count = async (table) => Number((await db`select count(*) from ${db(table)}`)[0].count);

// ---- setup: a day, a 1 km square zone, three points of interest ---------------------------------
const [baseline] = await get('/api/baselines');
const lat0 = -33.9;
const kmLon = 1000 / (111_320 * Math.cos((lat0 * Math.PI) / 180));
const kmLat = 1000 / 110_540;
const square = [
  [151.2, lat0],
  [151.2 + kmLon, lat0],
  [151.2 + kmLon, lat0 + kmLat],
  [151.2, lat0 + kmLat],
];
const zone = (await send('POST', '/api/analysis/zones', { name: 'e2e run zone', ring: square }))
  .body;
// 73 columns by 137 rows at 50 m: 10,001 sample points (AC-NFR-3.1).
const big = [
  [151.2, lat0],
  [151.2 + 3.64 * kmLon, lat0],
  [151.2 + 3.64 * kmLon, lat0 + 6.84 * kmLat],
  [151.2, lat0 + 6.84 * kmLat],
];
const bigZone = (await send('POST', '/api/analysis/zones', { name: 'e2e big zone', ring: big }))
  .body;
const pois = [];
for (let k = 0; k < 11; k++) {
  const placed = { name: `e2e run poi ${k}`, lon: 151.21 + k * 0.001, lat: -33.88 };
  pois.push((await send('POST', '/api/analysis/pois', placed)).body);
}
const poiIds = pois.slice(0, 3).map((p) => p.id);
const body = (more = {}) => ({
  baselineId: baseline.id,
  scenarioId: null,
  zoneId: zone.id,
  poiIds,
  settings: { spacingM: 250 },
  ...more,
});
const made = [];
const create = async (more) => {
  const answer = await send('POST', '/api/analyses', body(more));
  assert.equal(answer.status, 202, JSON.stringify(answer.body));
  assert.deepEqual(Object.keys(answer.body), ['id']);
  made.push(answer.body.id);
  return answer.body.id;
};
const scenario = (
  await send('POST', '/api/scenarios', { baselineId: baseline.id, name: 'e2e access' })
).body;

try {
  // ---- refusals: nothing is stored ------------------------------------------------------------
  const stored = async () => [await count('analyses'), await count('analysis_points')];
  const before = await stored();
  const refused = async (more, status, words, what) => {
    const answer = await send('POST', '/api/analyses', body(more));
    assert.equal(answer.status, status, `${what}: ${JSON.stringify(answer.body)}`);
    assert.ok(answer.body.message.includes(words), `${what}: ${answer.body.message}`);
  };
  assert.equal(gridCount(big, 50), 10_001, 'the big zone makes 10,001 points at 50 m');
  await refused(
    { zoneId: bigZone.id, settings: { spacingM: 50 } },
    400,
    'This makes 10,001 sample points; the most is 10,000.',
    '10,001 points',
  );
  await refused(
    { poiIds: pois.map((p) => p.id) },
    400,
    'This has 11 points of interest; the most is 10.',
    '11 points of interest',
  );
  assert.deepEqual(await stored(), before, 'a refused analysis stores nothing');
  step('AC-NFR-3.1 10,001 sample points or 11 points of interest are a 400 with the reason');

  await refused({ poiIds: [] }, 400, 'point of interest', 'no points of interest');
  await refused({ settings: { maxWalkM: 50 } }, 400, 'The longest walk', 'walk out of range');
  await refused({ settings: { maxWalkM: 'far' } }, 400, 'maxWalkM', 'walk not a number');
  await refused({ zoneId: 999_999 }, 404, 'Zone not found', 'no such zone');
  await refused({ poiIds: [poiIds[0], 999_999] }, 404, 'Point of interest not found', 'no poi');
  await refused({ baselineId: 999_999 }, 404, 'Day not found', 'no such day');
  await refused({ scenarioId: 999_999 }, 404, 'Scenario not found', 'no such scenario');
  assert.deepEqual(await stored(), before, 'a refused analysis stores nothing');
  step('bad bodies are refused with plain-English messages, and nothing is stored');

  await fake({ down: true });
  await refused(
    {},
    503,
    'The journey router is not running. Start it with `npm run router:dev`, then try again.',
    'router down',
  );
  await fake({ down: false, road: false });
  await refused({}, 503, 'The road router is not running', 'road side down');
  await refused({}, 503, 'ROUTER_URL', 'road side down');
  await fake({ road: true });
  assert.deepEqual(await stored(), before, 'nothing is stored while a router is down');
  step('a router that is down is a 503 that names it, and nothing is stored');

  // ---- a good request (AC 3) and a second one waiting (AC 6) ----------------------------------
  await fake({ hold: true });
  const first = await create();
  let detail = await get(`/api/analyses/${first}`);
  assert.ok(['queued', 'preparing'].includes(detail.state), detail.state);
  detail = await until(first, (d) => d.state === 'preparing', 'the first run starts preparing');
  assert.equal(detail.sampleCount, gridCount(square, 250));
  assert.equal(detail.sampleCount, 16);
  assert.equal(detail.name, 'e2e run zone · 08:00 · Published day');
  assert.equal(detail.baselineId, baseline.id);
  assert.equal(detail.scenarioId, null);
  assert.equal(detail.zone.id, zone.id);
  assert.equal(detail.zone.name, 'e2e run zone');
  assert.equal(detail.zone.ring.length, 4);
  assert.match(detail.zone.hash, /^[0-9a-f]{32}$/);
  assert.deepEqual(
    detail.pois.map((p) => [p.seq, p.poiId, p.name, p.lon, p.lat, p.summary]),
    pois.slice(0, 3).map((p, seq) => [seq, p.id, p.name, p.lon, p.lat, null]),
  );
  assert.equal(detail.settings.spacingM, 250);
  assert.equal(detail.settings.departSecs, 8 * 3600, 'missing settings take the starting values');
  const points = await db`
    select seq, i, j, lon, lat from analysis_points where analysis_id = ${first} order by seq`;
  assert.deepEqual(
    [...points],
    sampleGrid(square, 250).points.map((p, seq) => ({ seq, ...p })),
  );
  await send('PATCH', `/api/analysis/zones/${zone.id}`, { name: 'e2e run zone renamed' });
  await send('PATCH', `/api/analysis/pois/${poiIds[0]}`, {
    name: 'e2e moved',
    lon: 151.3,
    lat: -33.8,
  });
  const after = await get(`/api/analyses/${first}`);
  assert.equal(after.zone.name, 'e2e run zone', 'renaming the zone does not change the analysis');
  assert.deepEqual(after.pois[0], detail.pois[0], 'moving a point of interest does not either');
  step('AC 3 a good request is 202 {id}, queued then preparing, with its copies and sample points');

  const second = await create({ scenarioId: scenario.id, poiIds: poiIds.slice(0, 1) });
  await sleep(1500);
  const waiting = await get(`/api/analyses/${second}`);
  assert.equal(waiting.state, 'queued', 'a second analysis waits while one runs');
  assert.equal(waiting.scenarioName, 'e2e access');
  assert.equal(waiting.name, 'e2e run zone renamed · 08:00 · e2e access');
  assert.equal((await get(`/api/analyses/${first}`)).state, 'preparing');
  step('AC 6 a second analysis waits (queued) while one runs');

  // ---- the list (AC 4) ------------------------------------------------------------------------
  const listed = await get(`/api/analyses?baseline=${baseline.id}`);
  assert.deepEqual(
    listed.slice(0, 2).map((a) => a.id),
    [second, first],
    'newest first',
  );
  assert.equal(listed[1].sampleCount, 16);
  assert.equal(listed[1].zoneName, 'e2e run zone');
  assert.deepEqual(await get(`/api/analyses?baseline=${baseline.id + 1000}`), []);
  assert.equal((await send('GET', '/api/analyses')).status, 400);
  step("AC 4 GET /api/analyses?baseline= lists the day's analyses, newest first");

  // ---- cancel (AC 5) --------------------------------------------------------------------------
  assert.equal((await send('POST', `/api/analyses/${second}/cancel`)).status, 200);
  await until(second, (d) => d.state === 'cancelled', 'a queued analysis is cancelled', 5);
  await db`
    insert into analysis_results (analysis_id, point_seq, poi_seq, status)
    values (${first}, 0, 0, 'pending')`;
  assert.equal((await send('POST', `/api/analyses/${first}/cancel`)).status, 200);
  const cancelled = await until(first, (d) => d.state === 'cancelled', 'a running one too', 10);
  assert.ok(cancelled.finishedAt, 'a cancelled analysis has a finish time');
  assert.equal(cancelled.progress, null);
  assert.equal(
    Number((await db`select count(*) from analysis_results where analysis_id = ${first}`)[0].count),
    0,
    'cancelling deletes the results',
  );
  assert.equal((await send('POST', `/api/analyses/${first}/cancel`)).status, 409);
  step('AC 5 a queued or running analysis is cancelled, and its results deleted');

  // ---- runs, one at a time, to done -----------------------------------------------------------
  const third = await create();
  const fourth = await create();
  await until(third, (d) => d.state === 'preparing', 'the third run starts');
  assert.equal((await get(`/api/analyses/${fourth}`)).state, 'queued');
  await fake({ hold: false });
  const done = await until(third, (d) => d.state === 'done', 'the third run finishes');
  assert.equal(done.progress, null);
  assert.equal(done.error, null);
  assert.ok(done.finishedAt);
  await until(fourth, (d) => d.state === 'done', 'then the fourth');
  const [stamp] =
    await db`select timetable_id, timetable_version from analyses where id = ${third}`;
  assert.match(stamp.timetable_id, new RegExp(`^b${baseline.id}-a[0-9a-f]{8}$`));
  assert.ok(stamp.timetable_version);
  step('analyses run one at a time: timetable loaded, then done');

  // ---- delete (AC 5) --------------------------------------------------------------------------
  assert.equal((await send('DELETE', `/api/analyses/${third}`)).status, 200);
  assert.equal((await send('GET', `/api/analyses/${third}`)).status, 404);
  for (const table of ['analysis_pois', 'analysis_points', 'analysis_results']) {
    const [row] = await db`select count(*) from ${db(table)} where analysis_id = ${third}`;
    assert.equal(Number(row.count), 0, `${table} rows are deleted with the analysis`);
  }
  assert.equal((await send('DELETE', `/api/analyses/${third}`)).status, 404);
  step('AC 5 DELETE removes an analysis and its rows');

  // ---- picked up again when the API starts (AC 7) ---------------------------------------------
  const spare = process.env.E2E_SPARE_PORT;
  if (!spare) {
    console.log('skipped: the restart check needs E2E_SPARE_PORT');
  } else {
    await db`update analyses set state = 'running', finished_at = null where id = ${fourth}`;
    const base = `http://localhost:${spare}`;
    const restarted = spawn(process.execPath, ['apps/api/src/server.ts'], {
      cwd: ROOT,
      env: { ...process.env, PORT: spare },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    try {
      const deadline = Date.now() + 60_000;
      while (
        !(await fetch(`${base}/api/health`).then(
          (r) => r.ok,
          () => false,
        ))
      ) {
        assert.ok(Date.now() < deadline, 'the second API did not start within a minute');
        await sleep(300);
      }
      await until(fourth, (d) => d.state === 'done', 'a run left going is driven again', 15, base);
    } finally {
      restarted.kill();
    }
    step('AC 7 an analysis left running is driven again when the API starts');
  }
} finally {
  await fake({ down: false, road: true, hold: false });
  for (const id of made) await send('DELETE', `/api/analyses/${id}`);
  await send('DELETE', `/api/scenarios/${scenario.id}`);
  for (const p of pois) await send('DELETE', `/api/analysis/pois/${p.id}`);
  await send('DELETE', `/api/analysis/zones/${zone.id}`);
  await send('DELETE', `/api/analysis/zones/${bigZone.id}`);
  await db.end();
}
console.log('all analysis run checks passed');
