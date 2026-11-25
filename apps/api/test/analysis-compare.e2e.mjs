// End-to-end check of comparing two analyses and of the exports (AA-22: FR-17, FR-18; §5.3, D31):
// two runs of one zone on the fake router with settings that change the ratios, compared point by
// point both ways; analyses that cannot be compared refused with the reason; the list marks which
// analyses each can be compared with; then the exports (analysis-export-checks.mjs). Run by
// analysis.e2e.mjs against the fake router (fake-router.mjs, D32). Needs FAKE_ROUTER, DATABASE_URL.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { compareRatios } from '../../../packages/core/src/analysis/compare.ts';
import { checkExports } from './analysis-export-checks.mjs';
import {
  FAKE_ROUTER,
  create,
  fake,
  get,
  placesFor,
  send,
  step,
  until,
} from './analysis-e2e-client.mjs';

if (!FAKE_ROUTER || !process.env.DATABASE_URL) {
  console.log('skipped: the compare and export checks need FAKE_ROUTER and DATABASE_URL');
  process.exit(0);
}
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

/** Each sample point's stored result for the point of interest with this saved id. */
const gridOf = (id, poiId) => db`
  select p.i, p.j, p.lon, p.lat, r.status, r.ratio
  from analysis_points p
  join analysis_results r on r.analysis_id = p.analysis_id and r.point_seq = p.seq
  join analysis_pois o on o.analysis_id = p.analysis_id and o.seq = r.poi_seq
  where p.analysis_id = ${id} and o.poi_id = ${poiId}
  order by p.seq`;

/** Runs an analysis to the end; fails unless it is done. */
async function run(body) {
  const id = await create(body);
  made.push(id);
  const detail = await until(id, (d) => ['done', 'failed'].includes(d.state), `run ${id} ends`);
  assert.equal(detail.state, 'done', detail.error);
  return detail;
}

/** Expects a 409 whose message matches `words`. */
async function refused(query, words, what) {
  const answer = await send('GET', `/api/analyses/compare?${query}`);
  assert.equal(answer.status, 409, `${what}: ${JSON.stringify(answer.body)}`);
  assert.match(answer.body.message, words, `${what}: ${answer.body.message}`);
}

const places = await placesFor(151.3, -33.95, {});
const [p0, p1, p2] = places.body.poiIds;
const tricky = (
  await send('POST', '/api/analysis/pois', { name: 'e2e "big", shop', lon: 151.31, lat: -33.94 })
).body;
const otherZone = (
  await send('POST', '/api/analysis/zones', {
    name: 'e2e other zone',
    ring: [...places.ring.slice(0, 3), [places.ring[3][0] + 0.001, places.ring[3][1]]],
  })
).body;
const made = [];
try {
  // A: a short parking allowance and journeys over 15 minutes are no service. B: the defaults, so
  // every ratio falls and the far sample points gain a service.
  const a = await run({
    ...places.body,
    poiIds: [p0, p1],
    settings: { ...places.body.settings, parkingMins: 2, maxJourneyMins: 15 },
  });
  const b = await run({ ...places.body, poiIds: [p0, p1, tricky.id] });
  const spaced = await run({
    ...places.body,
    poiIds: [p0],
    settings: { ...places.body.settings, spacingM: 200 },
  });
  const moved = await run({ ...places.body, zoneId: otherZone.id, poiIds: [p0] });

  // ---- compare (AC-FR-17.1) --------------------------------------------------------------------
  for (const poiId of [p0, p1]) {
    for (const [first, second] of [
      [a, b],
      [b, a],
    ]) {
      const query = `a=${first.id}&b=${second.id}&poi=${poiId}`;
      const answer = await send('GET', `/api/analyses/compare?${query}`);
      assert.equal(answer.status, 200, `${query}: ${JSON.stringify(answer.body)}`);
      const before = await gridOf(first.id, poiId);
      const after = await gridOf(second.id, poiId);
      const expected = compareRatios(before, after);
      const { points, counts } = answer.body;
      assert.equal(points.type, 'FeatureCollection');
      assert.equal(points.features.length, first.sampleCount, 'one feature per sample point');
      points.features.forEach((feature, k) => {
        assert.deepEqual(feature, {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [before[k].lon, before[k].lat] },
          properties: expected[k],
        });
        const { kind, change } = feature.properties;
        if (kind === 'better') assert.ok(after[k].ratio < before[k].ratio, 'better: it fell');
        if (kind === 'worse') assert.ok(after[k].ratio > before[k].ratio, 'worse: it rose');
        if (change !== null)
          assert.ok(Math.abs(change - (after[k].ratio - before[k].ratio)) < 1e-9);
      });
      const kinds = ['better', 'worse', 'same', 'gainedService', 'lostService', 'bothNone'];
      assert.deepEqual(Object.keys(counts).sort(), [...kinds].sort(), 'a count for every kind');
      for (const kind of kinds) {
        const n = expected.filter((p) => p.kind === kind).length;
        assert.equal(counts[kind], n, `${query}: the count of ${kind}`);
      }
      if (first === a) {
        assert.ok(counts.better > 0, 'some sample points are better when the ratio fell');
        assert.equal(counts.worse + counts.lostService, 0, 'nothing got worse');
      } else {
        assert.ok(counts.worse > 0, 'some sample points are worse when the ratio rose');
        assert.equal(counts.better + counts.gainedService, 0, 'nothing got better');
      }
    }
  }
  const forward = (await get(`/api/analyses/compare?a=${a.id}&b=${b.id}&poi=${p1}`)).counts;
  assert.ok(forward.gainedService > 0, 'far sample points gain a service');
  assert.ok(forward.bothNone > 0, 'sample points with no road have no ratio in either');
  step('AC-FR-17.1 compare: each sample point better, worse or the same, with counts');

  // ---- refused (AC 2) --------------------------------------------------------------------------
  await refused(`a=${a.id}&b=${spaced.id}&poi=${p0}`, /spacing/, 'other spacing');
  await refused(`a=${moved.id}&b=${a.id}&poi=${p0}`, /zone outline/, 'other zone outline');
  await refused(`a=${a.id}&b=${b.id}&poi=${tricky.id}`, /point of interest/, 'poi only in b');
  await refused(`a=${a.id}&b=${b.id}&poi=${p2}`, /point of interest/, 'poi in neither');
  await fake({ tableAnswers: 0 });
  const held = await create({ ...places.body, poiIds: [p0] });
  made.push(held);
  await until(held, (d) => d.state === 'running', 'the held run is running');
  await refused(`a=${a.id}&b=${held}&poi=${p0}`, /not finished/, 'b still running');
  await send('POST', `/api/analyses/${held}/cancel`);
  await fake({ tableAnswers: null });
  await until(held, (d) => d.state === 'cancelled', 'the held run is cancelled');
  await refused(`a=${held}&b=${a.id}&poi=${p0}`, /not finished/, 'a cancelled');
  for (const [query, status] of [
    [`a=${a.id}&b=${b.id}`, 400],
    [`a=${a.id}&poi=${p0}`, 400],
    [`a=x&b=${b.id}&poi=${p0}`, 400],
    [`a=999999&b=${b.id}&poi=${p0}`, 404],
    [`a=${a.id}&b=999999&poi=${p0}`, 404],
  ]) {
    assert.equal((await send('GET', `/api/analyses/compare?${query}`)).status, status, query);
  }
  step('AC 2 other spacing, zone outline or point of interest, or not finished: 409 with why');

  // ---- the list marks what can be compared (AC 4) ----------------------------------------------
  const listed = await get(`/api/analyses?baseline=${places.body.baselineId}`);
  const entry = (id) => listed.find((item) => item.id === id);
  assert.deepEqual(entry(a.id).comparableWith, [b.id], 'a can be compared with b only');
  assert.deepEqual(entry(b.id).comparableWith, [a.id], 'b can be compared with a only');
  for (const id of [spaced.id, moved.id, held]) {
    assert.deepEqual(entry(id).comparableWith, [], `analysis ${id} has nothing to compare with`);
  }
  step('AC 4 the list marks which other analyses each can be compared with');

  // ---- exports (AC-FR-18.1) --------------------------------------------------------------------
  await checkExports(db, b);
} finally {
  await fake({ tableAnswers: null });
  for (const id of made) await send('DELETE', `/api/analyses/${id}`);
  await send('DELETE', `/api/analysis/pois/${tricky.id}`);
  await send('DELETE', `/api/analysis/zones/${otherZone.id}`);
  await places.remove();
  await db.end();
}
console.log('all compare and export checks passed');
