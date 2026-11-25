// End-to-end check of the reads behind the results map (AA-16: FR-14, FR-15, FR-19, FR-20; §5.1,
// D28, D30): the summary per point of interest on the analysis, the sample points as GeoJSON, the
// bands and lines of equal ratio for the breaks asked for, and one pair in full with its car path
// from the road router. Reads of an analysis that has not finished are refused. Run by
// analysis.e2e.mjs against the fake router (fake-router.mjs, D32). Needs FAKE_ROUTER, DATABASE_URL.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { summarise } from '../../../packages/core/src/analysis/summary.ts';
import { FAKE_ROUTER, create, fake, placesFor, send, step, until } from './analysis-e2e-client.mjs';
import { checkLines } from './analysis-results-lines.mjs';

if (!FAKE_ROUTER || !process.env.DATABASE_URL) {
  console.log('skipped: the analysis result checks need FAKE_ROUTER and DATABASE_URL');
  process.exit(0);
}
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

/** Every pair of one point of interest with its sample point, in sample point order. */
const pairsOf = (id, poiSeq) => db`
  select p.seq, p.i, p.j, p.lon, p.lat, r.poi_seq, r.status, r.pt_secs, r.walk_secs, r.wait_secs,
         r.ride_secs, r.rides, r.legs, r.drive_secs, r.drive_metres, r.car_secs, r.ratio,
         st_x(o.geom) as poi_lon, st_y(o.geom) as poi_lat
  from analysis_points p
  join analysis_results r on r.analysis_id = p.analysis_id and r.point_seq = p.seq
  join analysis_pois o on o.analysis_id = p.analysis_id and o.seq = r.poi_seq
  where p.analysis_id = ${id} and r.poi_seq = ${poiSeq}
  order by p.seq`;

/** The summary the API should give, as it comes through JSON (an open band end is null). */
const summaryOf = (rows, breaks) => JSON.parse(JSON.stringify(summarise(rows, breaks)));
const minutes = (secs) => (secs === null ? null : Math.round(secs / 6) / 10);

// Journeys over 15 minutes are no service, so the far point of interest has some with a journey.
const places = await placesFor(151.2, -33.95, { maxJourneyMins: 15 });
const body = { ...places.body, poiIds: places.body.poiIds.slice(0, 2) };
const made = [];
try {
  // ---- an analysis that has not finished (AC 5) ------------------------------------------------
  await fake({ tableAnswers: 0 });
  const held = await create(body);
  made.push(held);
  await until(held, (d) => d.state === 'running', 'the held run is running');
  for (const path of ['points?poi=0', 'lines?poi=0', 'lines?poi=0&breaks=1,2', 'points/0?poi=0']) {
    const answer = await send('GET', `/api/analyses/${held}/${path}`);
    assert.equal(answer.status, 409, `${path}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.message, /not finished/, path);
  }
  const running = await send('GET', `/api/analyses/${held}`);
  assert.equal(running.status, 200);
  assert.ok(
    running.body.pois.every((p) => p.summary === null),
    'no summary until it is done',
  );
  await send('POST', `/api/analyses/${held}/cancel`);
  await fake({ tableAnswers: null });
  step('AC 5 reads of an analysis that has not finished are 409 "not finished"');

  const id = await create(body);
  made.push(id);
  const detail = await until(id, (d) => ['done', 'failed'].includes(d.state), 'the run ends');
  assert.equal(detail.state, 'done', detail.error);
  const breaks = detail.settings.breaks;
  assert.deepEqual(breaks, [1, 1.5, 2, 3, 4]);

  // ---- the summary on the analysis (AC 1, AC-FR-20.1) ------------------------------------------
  assert.equal(detail.pois.length, 2);
  for (const poi of detail.pois) {
    const rows = await pairsOf(id, poi.seq);
    const { summary } = poi;
    assert.ok(summary, `point of interest ${poi.seq} has a summary`);
    assert.deepEqual(summary, summaryOf(rows, breaks), `summary of ${poi.seq}`);
    assert.equal(summary.bands.length, breaks.length + 1);
    const banded = summary.bands.reduce((sum, band) => sum + band.count, 0);
    assert.equal(banded + summary.noService + summary.noRoad, detail.sampleCount);
    assert.equal(typeof summary.median, 'number');
  }
  const near = await pairsOf(id, 0);
  const far = await pairsOf(id, 1);
  // Pairs with no road are only those near enough for a journey under 15 minutes, so the near
  // point of interest has them; the far one has journeys over 15 minutes.
  const kindOf = (r) => r.status + (r.pt_secs === null ? ' none' : '');
  const kinds = new Set([...near, ...far].map(kindOf));
  for (const kind of ['ok', 'noService', 'noService none', 'noRoad']) {
    assert.ok(kinds.has(kind), `the checks cover a pair that is ${kind}`);
  }
  step('AC 1, AC-FR-20.1 each point of interest has its summary; the counts add up');

  // ---- the sample points (AC 2) ----------------------------------------------------------------
  const points = await send('GET', `/api/analyses/${id}/points?poi=1`);
  assert.equal(points.status, 200, JSON.stringify(points.body));
  assert.equal(points.body.type, 'FeatureCollection');
  assert.equal(points.body.features.length, detail.sampleCount);
  points.body.features.forEach((feature, k) => {
    const row = far[k];
    assert.deepEqual(feature, {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
      properties: {
        seq: row.seq,
        status: row.status,
        ptMins: minutes(row.pt_secs),
        carMins: minutes(row.car_secs),
        ratio: row.ratio,
      },
    });
  });
  for (const [path, status] of [
    ['points', 400],
    ['points?poi=x', 400],
    ['points?poi=7', 404],
  ]) {
    assert.equal((await send('GET', `/api/analyses/${id}/${path}`)).status, status, path);
  }
  assert.equal((await send('GET', `/api/analyses/999999/points?poi=0`)).status, 404);
  step('AC 2 one feature per sample point with seq, status, ptMins, carMins and ratio');

  // ---- the bands and lines (AC 3) --------------------------------------------------------------
  const ring = detail.zone.ring;
  for (const poiSeq of [0, 1]) {
    const rows = await pairsOf(id, poiSeq);
    for (const asked of [null, [1.6, 1.7], [1.5]]) {
      const query = asked ? `&breaks=${asked.join(',')}` : '';
      const lines = await send('GET', `/api/analyses/${id}/lines?poi=${poiSeq}${query}`);
      assert.equal(lines.status, 200, JSON.stringify(lines.body));
      const used = asked ?? breaks;
      const drawn = checkLines(lines.body, rows, used, ring);
      // The ratios here run from about 1.4 to 1.8, so a line at 1.5 crosses the zone.
      if (poiSeq === 0 && asked?.[0] === 1.5) assert.equal(drawn, 1, 'the line at 1.5 is drawn');
      assert.deepEqual(lines.body.summary, summaryOf(rows, used), 'the summary for these breaks');
    }
  }
  for (const bad of ['2,1', '1,1', 'x', '', '0.05', '1,,2', '21', '1,2,3,4,5,6,7,8,9']) {
    const answer = await send('GET', `/api/analyses/${id}/lines?poi=0&breaks=${bad}`);
    assert.equal(answer.status, 400, `breaks=${bad}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.message, /line/, `breaks=${bad}: ${answer.body.message}`);
  }
  assert.equal((await send('GET', `/api/analyses/${id}/lines?poi=7`)).status, 404);
  step('AC 3 bands and lines for the breaks asked for, with their summary; bad breaks are 400');

  // ---- one pair (AC 4, AC-FR-15.1) -------------------------------------------------------------
  const pick = (kind) => [...far, ...near].find((r) => kindOf(r) === kind);
  // The fake router's trip 'F1-1' is not in the test feed and no trip calls at its stops at its
  // times, so each ride's path is not known and is the straight line, marked so (D35).
  // analysis-ride-paths.e2e.mjs checks rides on real trips.
  const withStraightPath = (leg) =>
    leg.type === 'ride'
      ? {
          ...leg,
          path: [
            [leg.board.lon, leg.board.lat],
            [leg.alight.lon, leg.alight.lat],
          ],
          pathFrom: 'straight',
        }
      : leg;
  const expected = (row) => ({
    seq: row.seq,
    i: row.i,
    j: row.j,
    lon: row.lon,
    lat: row.lat,
    poiSeq: row.poi_seq,
    status: row.status,
    pt:
      row.pt_secs === null
        ? null
        : {
            ptSecs: row.pt_secs,
            walkSecs: row.walk_secs,
            waitSecs: row.wait_secs,
            rideSecs: row.ride_secs,
            rides: row.rides,
          },
    legs: row.legs && row.legs.map(withStraightPath),
    driveSecs: row.drive_secs,
    driveMetres: row.drive_metres,
    carSecs: row.car_secs,
    trafficFactor: 1.4,
    parkingSecs: 300,
    ratio: row.ratio,
  });
  for (const kind of ['ok', 'noService', 'noService none', 'noRoad']) {
    const row = pick(kind);
    const answer = await send('GET', `/api/analyses/${id}/points/${row.seq}?poi=${row.poi_seq}`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const { carPath, carPathMessage, ...rest } = answer.body;
    assert.deepEqual(rest, expected(row), `the ${kind} pair`);
    // The fake router's drive is a straight line from the sample point to the point of interest.
    assert.deepEqual(carPath, [
      [row.lon, row.lat],
      [row.poi_lon, row.poi_lat],
    ]);
    assert.equal(carPathMessage, null);
  }
  step('AC 4, AC-FR-15.1 one pair: times, split, ratio, stored legs and the car path');

  const ok = pick('ok');
  await fake({ down: true });
  const down = await send('GET', `/api/analyses/${id}/points/${ok.seq}?poi=${ok.poi_seq}`);
  await fake({ down: false });
  assert.equal(down.status, 200, JSON.stringify(down.body));
  const { carPath, carPathMessage, ...rest } = down.body;
  assert.deepEqual(rest, expected(ok), 'the pair is still given');
  assert.equal(carPath, null);
  assert.match(carPathMessage, /road router is not running/);
  for (const [path, status] of [
    [`points/${ok.seq}`, 400],
    [`points/${ok.seq}?poi=7`, 404],
    ['points/99999?poi=1', 404],
    ['points/x?poi=1', 400],
  ]) {
    assert.equal((await send('GET', `/api/analyses/${id}/${path}`)).status, status, path);
  }
  step('AC 4 with the road router down the pair comes back with carPath null and a message');
} finally {
  await fake({ tableAnswers: null, down: false });
  for (const id of made) await send('DELETE', `/api/analyses/${id}`);
  await places.remove();
  await db.end();
}
console.log('all analysis result checks passed');
