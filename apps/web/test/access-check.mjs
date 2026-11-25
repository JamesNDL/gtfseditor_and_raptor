// The access analysis check in a headless browser (docs/architecture/access-analysis.md §8, "The
// owner's check"; FR-4 to FR-20 end to end): opens the Access pane, draws a zone with the map
// editor's Draw zone tool, places two points of interest with the pin tool (access-editor.mjs),
// switches the basemap, drags the zone and a pin, checks the setup's count line and runs; then
// opens the results, checks the legend, settings line, OpenStreetMap credit and summary, switches
// point of interest, opens a sample point, and saves screenshots 01-zone.png to 08-legend.png,
// and the map editor's 09-basemap-streets.png to 14-reshape-zone.png.
// Usage: run-access-check.mjs starts a stack and runs this; to drive a stack already running:
//   APP=http://localhost:5183 API=http://localhost:3111 OUT=<folder> PLACES=real|fixture \
//   node apps/web/test/access-check.mjs
// Settings: FAKE_ROUTER (the fake router's address: the run is held part way for 04-running.png),
// SPEED=1 (also time 5,000 × 3 through the API, access-speed.mjs), KEEP=1 (leave what it made).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openBrowser, sleep } from './access-browser.mjs';
import { dragPlaces, drawZone, placePois, switchBasemaps } from './access-editor.mjs';
import { clickPlace } from './access-map.mjs';
import { middleOf, placesFor } from './access-places.mjs';
import {
  STARTING_SETTINGS_LINE,
  checkPointDetail,
  checkResults,
  waitForResults,
} from './access-results-checks.mjs';
import { runSpeedCheck } from './access-speed.mjs';

const APP = process.env.APP ?? 'http://localhost:5183';
const API = process.env.API ?? 'http://localhost:3111';
const OUT = path.resolve(process.env.OUT ?? 'data/ui-test/access');
const PLAN = placesFor(process.env.PLACES ?? 'real');
const FAKE_ROUTER = process.env.FAKE_ROUTER ?? null;
const RUN_NAME = 'Access check';

const step = (words) => console.log(`ok  ${words}`);
async function send(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function api(url) {
  const { status, body } = await send('GET', url);
  assert.equal(status, 200, `${url} answered ${status}: ${JSON.stringify(body)}`);
  return body;
}
const fake = (control) =>
  FAKE_ROUTER &&
  fetch(`${FAKE_ROUTER}/fake/control`, { method: 'POST', body: JSON.stringify(control) });
const metres = (a, b) =>
  Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110_540);

const made = { analyses: [], zones: [], pois: [] };
let b = null;
let shotNo = 0;
const shot = async (name, clip) => {
  const file = path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  await b.shot(file, clip);
};
/** The map editor's screenshots, numbered 09 to 14 after the check's own eight. */
const extraShot = (name) => b.shot(path.join(OUT, `${name}.png`));

/** Step 3: checks the setup, runs, and waits for done; answers the finished analysis. */
async function runAnalysis(baselineId) {
  const timetable = await b.js(
    `document.querySelector('.analysis-panel select[aria-label="Timetable"]')?.selectedOptions[0]?.textContent`,
  );
  assert.equal(timetable, 'Published day', 'the setup does not run on the published day');
  const countLine = await b.waitFor(
    `[...document.querySelectorAll('.analysis-run p')].map((p) => p.textContent).find((t) => /sample points?, 2 points of interest/.test(t))`,
    'the count line',
  );
  const pairs = /: ([\d,]+) public transport journeys and ([\d,]+) drives$/.exec(countLine);
  assert.ok(pairs && pairs[1] === pairs[2], `the count line reads oddly: "${countLine}"`);
  await b.click('.analysis-name-field input');
  await b.typeText(RUN_NAME);
  await shot('setup');
  step(`setup says "${countLine}"`);

  // On the fake router the run would be over before the list shows it: answer one road table
  // request, then hold the rest until the screenshot is taken.
  await fake({ tableAnswers: 1 });
  await b.click('.analysis-run button', 'Run');
  await b.waitFor(
    `[...document.querySelectorAll('.analysis-item')].some((li) => li.textContent.includes(${JSON.stringify(RUN_NAME)}))`,
    'the analysis in the list',
  );
  if (FAKE_ROUTER) {
    await b.waitFor(
      `Number(document.querySelector('.analysis-progress')?.getAttribute('aria-valuenow')) > 0`,
      'the progress bar to move',
      30_000,
    );
  }
  await sleep(500);
  await shot('running');
  await fake({ tableAnswers: null });
  const item = (await api(`/api/analyses?baseline=${baselineId}`)).find((a) => a.name === RUN_NAME);
  made.analyses.push(item.id);
  step(`running: ${item.state} ${JSON.stringify(item.progress)}`);

  const deadline = Date.now() + PLAN.runMinutes * 60_000;
  let detail;
  for (;;) {
    detail = await api(`/api/analyses/${item.id}`);
    if (['done', 'failed', 'cancelled'].includes(detail.state)) break;
    assert.ok(Date.now() < deadline, `the analysis is still ${detail.state} after the wait`);
    await sleep(1000);
  }
  assert.equal(detail.state, 'done', `the analysis ended ${detail.state}: ${detail.error ?? ''}`);
  step(`the analysis finished: ${detail.sampleCount} sample points`);
  return detail;
}

/** Steps 4 to 7: the results for each point of interest, a sample point, and the legend. */
async function showResults(detail) {
  await b.click('.analysis-item button', 'Open');
  const [first, second] = detail.pois;
  await waitForResults(b, first.name);
  await sleep(1200); // the map flies to the zone
  const settingsLine = STARTING_SETTINGS_LINE;
  const one = await checkResults(b, { api, analysis: detail, poi: first, settingsLine });
  await shot('city-centre');
  step(`results for ${first.name}: ${one.bands}; legend, settings line and credit shown`);

  await b.click('.analysis-panel label.check', second.name);
  await waitForResults(b, second.name);
  await sleep(800);
  const two = await checkResults(b, { api, analysis: detail, poi: second, settingsLine });
  await shot('kotara');
  step(`switched to ${second.name}: ${two.bands}`);

  const points = await api(`/api/analyses/${detail.id}/points?poi=${second.seq}`);
  const usable = points.features.filter((f) => f.properties.status === 'ok');
  assert.ok(usable.length > 0, `no sample point has both times to ${second.name}`);
  const nearest = usable.reduce((best, f) =>
    metres(f.geometry.coordinates, PLAN.samplePointNear) <
    metres(best.geometry.coordinates, PLAN.samplePointNear)
      ? f
      : best,
  );
  await clickPlace(b, nearest.geometry.coordinates, `sample point ${nearest.properties.seq}`);
  const shown = await checkPointDetail(b, second.name);
  await shot('point-detail');
  step(`opened sample point ${nearest.properties.seq}: ${shown.legs} legs, ratio shown`);

  await b.click('.analysis-point button[aria-label="Close"]');
  await sleep(300);
  // Checked once more with the sample point closed, and cropped with a margin round it.
  const { legendRect: r } = await checkResults(b, {
    api,
    analysis: detail,
    poi: second,
    settingsLine,
  });
  const margin = 8;
  await shot('legend', {
    x: Math.max(0, r.x - margin),
    y: Math.max(0, r.y - margin),
    width: r.width + 2 * margin,
    height: r.height + 2 * margin,
  });
  step('cropped the legend');
}

/** Step 5: the drive from the middle of the zone to the first point of interest is plausible. */
async function checkDrive(detail) {
  const [first] = detail.pois;
  const points = await api(`/api/analyses/${detail.id}/points?poi=${first.seq}`);
  const middle = middleOf(PLAN.zone.corners);
  const withRoad = points.features.filter((f) => f.properties.carMins !== null);
  assert.ok(withRoad.length > 0, `no sample point has a drive to ${first.name}`);
  const nearest = withRoad.reduce((best, f) =>
    metres(f.geometry.coordinates, middle) < metres(best.geometry.coordinates, middle) ? f : best,
  );
  const pair = await api(
    `/api/analyses/${detail.id}/points/${nearest.properties.seq}?poi=${first.seq}`,
  );
  const mins = pair.driveSecs / 60;
  const { fromMins, toMins } = PLAN.drive;
  assert.ok(
    mins >= fromMins && mins <= toMins,
    `the drive from the middle of ${PLAN.zone.name} to ${first.name} is ${mins.toFixed(1)} min, not ${fromMins} to ${toMins}`,
  );
  step(`the drive from the middle of ${PLAN.zone.name} to ${first.name} is ${mins.toFixed(1)} min`);
}

/** Deletes what the check made, newest first. */
async function cleanUp() {
  for (const id of made.analyses) await send('DELETE', `/api/analyses/${id}`).catch(() => {});
  for (const id of made.zones) await send('DELETE', `/api/analysis/zones/${id}`).catch(() => {});
  for (const id of made.pois) await send('DELETE', `/api/analysis/pois/${id}`).catch(() => {});
}

let failed = null;
try {
  await mkdir(OUT, { recursive: true });
  const [baseline] = await api('/api/baselines').catch((err) => {
    throw new Error(`cannot reach the API at ${API}: ${err.message}`);
  });
  assert.ok(baseline, 'the API has no day imported');
  b = await openBrowser({ width: 1600, height: 900 });
  await b.cdp('Page.navigate', { url: APP });
  await b.waitFor(b.inApp('return useStore.getState().baselineId !== null;'), 'the app', 60_000);
  await b.waitFor(b.inApp('return mapView.bounds !== null;'), 'the map to load', 60_000);
  step(`app loaded on ${baseline.serviceDate} (${PLAN.name} places)`);
  const steps = { plan: PLAN, api, made, shot, extraShot };
  const zone = await drawZone(b, steps);
  step(`drew the zone ${PLAN.zone.name} with Draw zone; its corners landed where clicked`);
  await placePois(b, steps);
  step(`placed ${PLAN.pois.map((p) => p.name).join(' and ')} with the pin tool and name box`);
  await switchBasemaps(b, steps);
  step('switched the basemap to Streets, Satellite and back to Dark');
  await dragPlaces(b, { ...steps, zone });
  step('reshaped the zone and moved a pin by dragging, and put them back');
  const detail = await runAnalysis(baseline.id);
  await showResults(detail);
  await checkDrive(detail);
  if (process.env.SPEED === '1') {
    const speed = await runSpeedCheck({ send, baselineId: baseline.id, speed: PLAN.speed });
    for (const key of Object.keys(made)) made[key].push(...speed.made[key]);
  }
} catch (err) {
  failed = err;
  if (b) await shot('failure').catch(() => {});
} finally {
  if (process.env.KEEP !== '1') await cleanUp();
  await b?.close();
}
if (b?.problems.length) {
  console.log(`browser errors (${b.problems.length}):`);
  for (const p of [...new Set(b.problems)].slice(0, 8)) console.log(`  ${p}`);
}
if (failed) {
  console.error(`FAILED: ${failed.message}`);
  process.exit(1);
}
console.log(`all access checks passed; screenshots in ${OUT}`);
