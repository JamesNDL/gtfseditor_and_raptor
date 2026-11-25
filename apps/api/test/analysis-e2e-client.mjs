// What the access analysis run checks (analysis-pairs.e2e.mjs, analysis-progress.e2e.mjs) share:
// calls to the API and to the fake router (fake-router.mjs), waiting for an analysis, a second API
// that can be stopped part way, and a zone with points of interest to run on. Not a test itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
export const API = process.env.API ?? 'http://localhost:3001';
export const FAKE_ROUTER = process.env.FAKE_ROUTER;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const step = (name) => console.log(`ok  ${name}`);

export async function send(method, url, body, base = API) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

export async function get(url, base = API) {
  const answer = await send('GET', url, undefined, base);
  assert.equal(answer.status, 200, `${url} responded ${answer.status}: ${JSON.stringify(answer)}`);
  return answer.body;
}

/** Steers the fake router (see the top of fake-router.mjs). */
export const fake = (control) => send('POST', '/fake/control', control, FAKE_ROUTER);
/** The fake router's last bulk journey request and its counts of what it answered. */
export const fakeState = () => get('/fake/state', FAKE_ROUTER);

/** Polls an analysis until `done(detail)` is true; fails after `secs` seconds. */
export async function until(id, done, what, secs = 30, base = API) {
  const deadline = Date.now() + secs * 1000;
  for (;;) {
    const detail = await get(`/api/analyses/${id}`, base);
    if (done(detail)) return detail;
    if (Date.now() > deadline) {
      assert.fail(`${what}: still ${detail.state} ${JSON.stringify(detail.progress)}`);
    }
    await sleep(100);
  }
}

/** Makes an analysis through `base`; fails unless it is accepted. */
export async function create(body, base = API) {
  const answer = await send('POST', '/api/analyses', body, base);
  assert.equal(answer.status, 202, JSON.stringify(answer.body));
  return answer.body.id;
}

/** Starts another API on `port`, as the dev API is restarted. Resolves once it answers. */
export async function startApi(port) {
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['apps/api/src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const deadline = Date.now() + 60_000;
  const up = () =>
    fetch(`${base}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
  while (!(await up())) {
    assert.ok(child.exitCode === null, `the API on ${port} stopped with ${child.exitCode}`);
    assert.ok(Date.now() < deadline, `the API on ${port} did not start within a minute`);
    await sleep(300);
  }
  /** Kills it at once, as a crash or a restart would, and waits until it has gone. */
  const kill = () =>
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill('SIGKILL');
        });
  return { base, kill };
}

/**
 * Saves a zone 2 km wide and 2.5 km tall (500 sample points at 100 m) south-west of (lon0, lat0),
 * and three points of interest: in the middle, 1 km east of it, and at its north-west corner.
 * Gives the request body to run on them and a function that deletes them again.
 */
export async function placesFor(lon0, lat0, settings) {
  const kmLon = 1000 / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const kmLat = 1000 / 110_540;
  const ring = [
    [lon0, lat0],
    [lon0 + 2 * kmLon, lat0],
    [lon0 + 2 * kmLon, lat0 + 2.5 * kmLat],
    [lon0, lat0 + 2.5 * kmLat],
  ];
  const zone = (await send('POST', '/api/analysis/zones', { name: 'e2e pairs zone', ring })).body;
  const spots = [
    [lon0 + kmLon, lat0 + 1.25 * kmLat],
    [lon0 + 3 * kmLon, lat0 + 1.25 * kmLat],
    [lon0, lat0 + 2.5 * kmLat],
  ];
  const pois = [];
  for (const [k, [lon, lat]] of spots.entries()) {
    pois.push(
      (await send('POST', '/api/analysis/pois', { name: `e2e pairs ${k}`, lon, lat })).body,
    );
  }
  const [baseline] = await get('/api/baselines');
  const body = {
    baselineId: baseline.id,
    scenarioId: null,
    zoneId: zone.id,
    poiIds: pois.map((p) => p.id),
    settings: { spacingM: 100, ...settings },
  };
  const remove = async () => {
    for (const p of pois) await send('DELETE', `/api/analysis/pois/${p.id}`);
    await send('DELETE', `/api/analysis/zones/${zone.id}`);
  };
  return { ring, body, remove };
}
