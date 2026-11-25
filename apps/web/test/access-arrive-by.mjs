// The arrive-by part of the access check (FR-21, AC-FR-21.1, AC-FR-21.3; access-check.mjs): makes
// a second analysis of the same zone and points of interest with the setup's "Arrive by" switch,
// runs it, and checks that the list, legend and a picked sample point say arrive by, with an early
// wait in the point's time split and a line saying when it arrives. Saves 16-arrive-by-setup.png
// (the switch) and 17-arrive-by-point.png (the point). Not a test itself.
import assert from 'node:assert/strict';
import { sleep } from './access-browser.mjs';
import { clickPlace } from './access-map.mjs';
import { checkPointDetail, waitForResults } from './access-results-checks.mjs';

const RUN_NAME = 'Access check arrive by';

const metres = (a, b) =>
  Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110_540);

/** Sets up the arrive-by analysis on screen, with the switch, and takes 16-arrive-by-setup.png. */
async function setUp(b, { plan, extraShot, time }) {
  await b.click('.analysis-head button', 'Back to the list');
  await b.click('.analysis-head button', 'New analysis');
  await b.click('section[aria-label="Zone"] .analysis-place-name', plan.zone.name);
  for (const poi of plan.pois) {
    await b.click('section[aria-label="Points of interest"] .analysis-place-name', poi.name);
  }
  await b.click('.analysis-time-switch button', 'Arrive by');
  const shown = await b.waitFor(
    `(() => {
      const on = document.querySelector('.analysis-time-switch button[aria-pressed="true"]');
      const label = [...document.querySelectorAll('.analysis-field > span:first-child')]
        .map((s) => s.textContent).find((t) => /time$/.test(t));
      return on?.textContent === 'Arrive by' && label ? label : null;
    })()`,
    'the switch on Arrive by',
  );
  assert.equal(shown, 'Arrive-by time', 'the time box is not named after the switch');
  // The time box: select what is there and type over it.
  await b.click('.analysis-field input[placeholder="HH:MM"]');
  await b.js(`document.querySelector('.analysis-field input[placeholder="HH:MM"]').select()`);
  await b.typeText(time);
  await b.click('.analysis-name-field input');
  await b.typeText(RUN_NAME);
  const note = await b.js(
    `[...document.querySelectorAll('.analysis-panel p')].map((p) => p.textContent).find((t) => t.startsWith('Traffic factors'))`,
  );
  assert.ok(note?.includes('the arrive-by time falls in'), `the traffic note: ${note}`);
  await b.js(
    `document.querySelector('.analysis-time-switch').scrollIntoView({ block: 'start' }); document.querySelector('.analysis-body')?.scrollBy(0, -60)`,
  );
  await sleep(300);
  await extraShot('16-arrive-by-setup');
}

/** Runs it and waits for done; answers the finished analysis. */
async function run(b, { api, baselineId, made, runMinutes }) {
  await b.click('.analysis-run button', 'Run');
  await b.waitFor(
    `[...document.querySelectorAll('.analysis-item')].some((li) => li.textContent.includes(${JSON.stringify(RUN_NAME)}))`,
    'the arrive-by analysis in the list',
  );
  const item = (await api(`/api/analyses?baseline=${baselineId}`)).find((a) => a.name === RUN_NAME);
  made.analyses.push(item.id);
  const deadline = Date.now() + runMinutes * 60_000;
  for (;;) {
    const detail = await api(`/api/analyses/${item.id}`);
    if (['done', 'failed', 'cancelled'].includes(detail.state)) {
      assert.equal(detail.state, 'done', `the arrive-by analysis ended ${detail.state}`);
      return detail;
    }
    assert.ok(Date.now() < deadline, `the arrive-by analysis is still ${detail.state}`);
    await sleep(1000);
  }
}

/**
 * The arrive-by check: set up with the switch, run, check the list line and legend, pick a sample
 * point with an early wait and check its split and arrival line.
 */
export async function checkArriveBy(b, steps) {
  const { api, plan, extraShot, time } = steps;
  await setUp(b, steps);
  const detail = await run(b, { ...steps, runMinutes: plan.runMinutes });
  const said = `Arrive by ${time}`;
  const row = await b.waitFor(
    `[...document.querySelectorAll('.analysis-item')].find((li) => li.textContent.includes(${JSON.stringify(RUN_NAME)}))?.textContent`,
    'the list row',
  );
  assert.ok(row.includes(said), `the list row does not say "${said}": ${row}`);

  const poi = detail.pois[1] ?? detail.pois[0];
  const points = await api(`/api/analyses/${detail.id}/points?poi=${poi.seq}`);
  const usable = points.features.filter((f) => f.properties.status === 'ok');
  assert.ok(usable.length > 0, `no sample point arrives at ${poi.name} by ${time}`);
  // Its own Open, once the list (fetched every 2 s) shows it finished; the depart-at one has one too.
  const open = await b.waitFor(
    `(() => {
      const li = [...document.querySelectorAll('.analysis-item')]
        .find((el) => el.textContent.includes(${JSON.stringify(RUN_NAME)}));
      const button = li && [...li.querySelectorAll('button')].find((el) => el.textContent === 'Open');
      if (!button) return null;
      const r = button.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    'Open on the arrive-by analysis',
  );
  await b.clickAt(open.x, open.y);
  if (poi.seq !== detail.pois[0].seq) {
    await waitForResults(b, detail.pois[0].name);
    await b.click('.analysis-panel label.check', poi.name);
  }
  await waitForResults(b, poi.name);
  await sleep(1200); // the map flies to the zone
  const legend = await b.js(`document.querySelector('.analysis-legend')?.textContent ?? ''`);
  assert.ok(legend.includes(said), `the legend does not say "${said}"`);

  const nearest = usable.reduce((best, f) =>
    metres(f.geometry.coordinates, plan.samplePointNear) <
    metres(best.geometry.coordinates, plan.samplePointNear)
      ? f
      : best,
  );
  await clickPlace(b, nearest.geometry.coordinates, `sample point ${nearest.properties.seq}`);
  const shown = await checkPointDetail(b, poi.name);
  // A journey that arrives on the dot has no early wait part, and says so.
  const early = shown.text.includes('Early wait');
  const arrival = early
    ? new RegExp(`Arrive \\d\\d:\\d\\d, (\\d+ min|under 1 min) before ${time}`)
    : /Arrive \d\d:\d\d, just in time/;
  assert.match(shown.text, arrival, 'the journey does not end with when it arrives');
  if (steps.expectEarlyWait) assert.ok(early, 'the time split has no early wait');
  await sleep(500);
  await extraShot('17-arrive-by-point');
  return { id: detail.id, seq: nearest.properties.seq, poi: poi.name };
}
