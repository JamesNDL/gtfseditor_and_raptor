// End-to-end check of an access analysis run's progress, cancel and restart (AA-15: FR-10, D20):
// progress shows the drives and then the journeys, done of total, after each batch; cancelling
// part way stops within one batch and marks the analysis cancelled; and an API killed part way
// through a run finishes it when it starts again, with every pair worked out exactly once. The
// fake router (fake-router.mjs, D32) holds a batch to stop the run where the check wants it.
// Run by analysis.e2e.mjs. Needs FAKE_ROUTER and DATABASE_URL; the restart needs E2E_SPARE_PORT.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  FAKE_ROUTER,
  create,
  fake,
  fakeState,
  placesFor,
  send,
  sleep,
  startApi,
  step,
  until,
} from './analysis-e2e-client.mjs';

if (!FAKE_ROUTER || !process.env.DATABASE_URL) {
  console.log('skipped: the analysis progress checks need FAKE_ROUTER and DATABASE_URL');
  process.exit(0);
}
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const PAIRS = 1500; // 500 sample points, three points of interest

/** How many of an analysis's pairs are still pending, and how many rows it has. */
async function rowCounts(id) {
  const [row] = await db`
    select count(*) filter (where status = 'pending') as pending, count(*) as rows
    from analysis_results where analysis_id = ${id}`;
  return { pending: Number(row.pending), rows: Number(row.rows) };
}

/** Waits for a progress of `stage` with `done` pairs. */
const progressed = (id, stage, done, base) =>
  until(
    id,
    (d) => d.progress?.stage === stage && d.progress.done === done,
    `progress ${stage} ${done}`,
    30,
    base,
  );

const places = await placesFor(151.15, -33.95, {});
const made = [];
let spare = null;
try {
  // ---- progress and cancel (AC-FR-10.1) ---------------------------------------------------------
  // One road table (one point of interest's 500 drives) is answered, then the next is held.
  await fake({ resetCounts: true, tableAnswers: 1 });
  const id = await create(places.body);
  made.push(id);
  let detail = await progressed(id, 'drives', 500);
  assert.equal(detail.state, 'running');
  assert.deepEqual(detail.progress, { stage: 'drives', done: 500, total: PAIRS });
  step('AC-FR-10.1 progress shows the drives, done of total, after each batch');

  // The drives finish; one batch of 500 journeys is answered, then the next is held.
  await fake({ tableAnswers: null, bulkAnswers: 1 });
  detail = await progressed(id, 'journeys', 500);
  assert.deepEqual(detail.progress, { stage: 'journeys', done: 500, total: PAIRS });
  assert.deepEqual(await rowCounts(id), { pending: 1000, rows: PAIRS });
  step('AC-FR-10.1 then the journeys, done of total, after each batch of 500');

  // Cancel while the second batch is held: once it is answered, the run stops before a third.
  assert.equal((await send('POST', `/api/analyses/${id}/cancel`)).status, 200);
  await fake({ bulkAnswers: null });
  detail = await until(id, (d) => d.state !== 'running', 'the run stops', 10);
  assert.equal(detail.state, 'cancelled');
  assert.equal(detail.progress, null);
  await sleep(500);
  assert.equal((await fakeState()).counts.bulkRequests, 2, 'no batch after the one in hand');
  assert.deepEqual(await rowCounts(id), { pending: 0, rows: 0 }, 'its results are deleted');
  step('AC-FR-10.1 cancelling part way stops within one batch and marks it cancelled');

  // ---- an API killed part way, then started again (AC 6) ----------------------------------------
  const port = process.env.E2E_SPARE_PORT;
  if (!port) {
    console.log('skipped: the restart check needs E2E_SPARE_PORT');
  } else {
    await fake({ resetCounts: true, bulkAnswers: 1 });
    spare = await startApi(port);
    const resumed = await create(places.body, spare.base);
    made.push(resumed);
    await progressed(resumed, 'journeys', 500, spare.base);
    await spare.kill();
    const [left] = await db`select state from analyses where id = ${resumed}`;
    assert.equal(left.state, 'running', 'a killed run is left running');
    assert.deepEqual(await rowCounts(resumed), { pending: 1000, rows: PAIRS });

    await fake({ bulkAnswers: null });
    spare = await startApi(port);
    const done = await until(resumed, (d) => d.state !== 'running', 'it finishes', 30, spare.base);
    assert.equal(done.state, 'done', done.error);
    assert.deepEqual(await rowCounts(resumed), { pending: 0, rows: PAIRS });
    const { counts } = await fakeState();
    assert.equal(counts.drives, PAIRS, 'every pair is driven once');
    assert.equal(counts.journeys, PAIRS, 'every pair is asked for once');
    assert.equal(counts.bulkRequests, 3, 'the batch lost with the API is asked for again');
    step('AC 6 an API killed part way finishes the run when started again, each pair once');
  }
} finally {
  await spare?.kill();
  await fake({ tableAnswers: null, bulkAnswers: null });
  for (const id of made) await send('DELETE', `/api/analyses/${id}`);
  await places.remove();
  await db.end();
}
console.log('all analysis progress checks passed');
