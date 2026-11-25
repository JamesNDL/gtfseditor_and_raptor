// End-to-end check of arrive-by analyses (FR-21, AC-FR-21.1, AC-FR-21.3, FR-9, FR-18, D40): an
// analysis set to arrive by 10:00 asks the journey router with `arriveBy` and no `depart`, stores
// each pair's early wait, counts its public transport time to 10:00, takes the traffic factor of
// the part of the day 10:00 falls in, and its detail, list entry, point and exports say arrive by.
// An analysis stored before arrive-by (no time mode in its settings) still reads as depart-at, and
// the two can be compared. The fake router (fake-router.mjs) lands every arrive-by journey on the
// last 10-minute mark at least 150 s before the time, so arriving by 10:00 arrives 09:52:30 with an
// early wait of 450 s. Run by analysis.e2e.mjs. Needs FAKE_ROUTER and DATABASE_URL.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  API,
  FAKE_ROUTER,
  create,
  fakeState,
  get,
  placesFor,
  send,
  step,
  until,
} from './analysis-e2e-client.mjs';

if (!FAKE_ROUTER || !process.env.DATABASE_URL) {
  console.log('skipped: the arrive-by checks need FAKE_ROUTER and DATABASE_URL');
  process.exit(0);
}
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const TEN = 10 * 3600;
const EARLY = 450;

const places = await placesFor(151.21, -33.96, { timeMode: 'arriveBy', departSecs: TEN });
const made = [];
const run = async (body) => {
  const id = await create(body);
  made.push(id);
  const detail = await until(id, (d) => ['done', 'failed'].includes(d.state), 'the run ends');
  assert.equal(detail.state, 'done', detail.error);
  return detail;
};
try {
  const body = { ...places.body, poiIds: places.body.poiIds.slice(0, 1) };
  const detail = await run(body);
  const { lastBulk } = await fakeState();
  assert.ok(lastBulk.queries.length > 0);
  for (const q of lastBulk.queries) {
    assert.equal(q.arriveBy, TEN, 'each query arrives by 10:00');
    assert.ok(!('depart' in q), 'an arrive-by query has no depart');
  }
  assert.deepEqual(lastBulk.capacity, { mode: 'off' }, 'arrive-by needs capacity off');
  step('FR-21 an arrive-by analysis asks the router with arriveBy in place of depart');

  assert.equal(detail.settings.timeMode, 'arriveBy');
  assert.equal(detail.settings.departSecs, TEN);
  assert.ok(detail.name.includes('Arrive by 10:00'), `the name says arrive by: ${detail.name}`);
  const entry = (await get(`/api/analyses?baseline=${body.baselineId}`)).find(
    (a) => a.id === detail.id,
  );
  assert.deepEqual([entry.timeMode, entry.timeSecs], ['arriveBy', TEN]);
  step('AC-FR-21.3 the detail, name and list entry say arrive by 10:00');

  const rows = await db`
    select point_seq, status, pt_secs, walk_secs, wait_secs, ride_secs, early_wait_secs,
           drive_secs, car_secs
    from analysis_results where analysis_id = ${detail.id} order by point_seq`;
  const journeys = rows.filter((r) => r.pt_secs !== null);
  assert.ok(journeys.length > 0, 'some pair has a journey');
  for (const r of journeys) {
    assert.equal(r.early_wait_secs, EARLY, `pair ${r.point_seq}: early wait`);
    assert.equal(
      r.pt_secs,
      r.walk_secs + r.wait_secs + r.ride_secs + r.early_wait_secs,
      `pair ${r.point_seq}: the parts add up to the public transport time`,
    );
  }
  for (const r of rows.filter((row) => row.drive_secs !== null)) {
    // 10:00 is in the middle of the day: traffic factor 1.2, then 5 minutes' parking (FR-9).
    assert.ok(Math.abs(r.car_secs - (r.drive_secs * 1.2 + 300)) < 0.5, `pair ${r.point_seq}`);
  }
  step(`AC-FR-21.1 ${journeys.length} pairs store a 450 s early wait inside their time`);
  step('FR-9 the car time takes the traffic factor of the part of the day 10:00 falls in');

  const ok = journeys.find((r) => r.status === 'ok');
  const point = await get(`/api/analyses/${detail.id}/points/${ok.point_seq}?poi=0`);
  assert.equal(point.pt.earlyWaitSecs, EARLY);
  assert.equal(point.pt.ptSecs, ok.pt_secs);
  assert.equal(point.trafficFactor, 1.2);
  step('FR-15 the picked point gives its early wait in the split');

  const csv = (await (await fetch(`${API}/api/analyses/${detail.id}/export/results.csv`)).text())
    .split('\r\n')
    .filter(Boolean);
  assert.ok(csv[0].endsWith(',ratio,time_mode,time,early_wait_mins'), csv[0]);
  const okLine = csv.find((line) => line.startsWith(`${ok.point_seq},`));
  assert.ok(okLine.endsWith(',arrive_by,10:00,7.5'), okLine);
  const geo = await get(`/api/analyses/${detail.id}/export/points.geojson`);
  const feature = geo.features.find((f) => f.properties.point === ok.point_seq);
  assert.deepEqual(
    [feature.properties.time_mode, feature.properties.time, feature.properties.early_wait_mins],
    ['arrive_by', '10:00', 7.5],
  );
  step('AC-FR-21.3 the CSV and GeoJSON say arrive by 10:00, with the early wait in minutes');

  // A depart-at analysis of the same zone, stored as before arrive-by: no time mode at all.
  const old = await run({ ...body, settings: { spacingM: 100, departSecs: TEN } });
  await db`update analyses set settings = settings - 'timeMode' where id = ${old.id}`;
  const reread = await get(`/api/analyses/${old.id}`);
  assert.equal(reread.settings.timeMode, 'depart');
  assert.equal(reread.timeMode, 'depart');
  const [oldEarly] = await db`
    select count(*)::int as n from analysis_results
    where analysis_id = ${old.id} and early_wait_secs is not null`;
  assert.equal(oldEarly.n, 0, 'a depart-at analysis stores no early wait');
  const oldCsv = await (await fetch(`${API}/api/analyses/${old.id}/export/results.csv`)).text();
  assert.ok(
    oldCsv.split('\r\n')[1].endsWith(',depart,10:00,'),
    'an old analysis exports as depart',
  );
  step('an analysis stored before arrive-by still reads, and exports, as depart-at');

  const list = await get(`/api/analyses?baseline=${body.baselineId}`);
  assert.ok(list.find((a) => a.id === detail.id).comparableWith.includes(old.id));
  const poiId = body.poiIds[0];
  const compared = await send(
    'GET',
    `/api/analyses/compare?a=${detail.id}&b=${old.id}&poi=${poiId}`,
  );
  assert.equal(compared.status, 200, JSON.stringify(compared.body));
  step('AC-FR-21.3 an arrive-by and a depart-at analysis can still be compared');
} finally {
  for (const id of made) await send('DELETE', `/api/analyses/${id}`);
  await places.remove();
  await db.end();
}
console.log('all arrive-by checks passed');
