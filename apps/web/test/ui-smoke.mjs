// Drives the real interface in a headless browser: clicks, typing, keyboard shortcuts and dragging.
// Usage: npm run test:ui     (needs `npm run dev` running, and Microsoft Edge or Chrome installed)
//
// It talks to the browser over the DevTools protocol directly, so it needs no extra packages.
// Screenshots of each step are written to data/ui-test/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const APP = process.env.APP ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:3001';
const BROWSER = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
assert.ok(BROWSER, 'No browser found; set BROWSER_PATH');

const shots = path.resolve('data/ui-test');
await rm(shots, { recursive: true, force: true });
await mkdir(shots, { recursive: true });
const profile = path.join(os.tmpdir(), `gtfs-ui-test-${Date.now()}`);
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(
  BROWSER,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1600,900', '--enable-unsafe-swiftshader', '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let nextId = 1;
const pending = new Map();
const problems = [];
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

/** Runs an expression in the page and returns its value. */
const js = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const waitFor = async (expression, what, timeout = 20000) => {
  const started = Date.now();
  for (;;) {
    const value = await js(expression).catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
};
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const clickAt = async (x, y) => {
  await mouse('mouseMoved', x, y, { buttons: 0 });
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
};
/** Centre of the first visible element matching a selector, optionally containing some text. */
const find = (selector, text) =>
  js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (${JSON.stringify(text ?? null)} === null || e.textContent.includes(${JSON.stringify(text ?? '')}));
    });
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!el.disabled };
  })()`);
const click = async (selector, text) => {
  const at = await waitFor(`(${find.toString()})`, 'nothing', 1).catch(() => null); // no-op: keeps helper shape simple
  void at;
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    target = await find(selector, text);
    if (target && target.disabled) target = null;
    if (!target) await sleep(150);
  }
  assert.ok(target, `could not find ${selector}${text ? ` containing "${text}"` : ''}`);
  await clickAt(target.x, target.y);
};
const type = (text) => cdp('Input.insertText', { text });
const key = (k, code, modifiers = 0, vk = 0) =>
  cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk }).then(() =>
    cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk }),
  );
const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
let shotNo = 0;
const shot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(shots, `${String(++shotNo).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
};
const step = (name) => console.log(`ok  ${name}`);
/** Sweeps the pointer over the map until the tooltip matches, and returns where. */
const findOnMap = async (pattern, box) => {
  for (let y = box.y0; y <= box.y1; y += 14) {
    for (let x = box.x0; x <= box.x1; x += 14) {
      await mouse('mouseMoved', x, y, { buttons: 0 });
      await sleep(60);
      const tip = await js(`(() => { const t = document.querySelector('.map-tooltip'); return t && t.style.display !== 'none' ? t.textContent : ''; })()`);
      if (pattern.test(tip)) return { x, y, tip };
    }
  }
  return null;
};

const api = async (p, method = 'GET') => (await fetch(API + p, { method })).json();
const [baseline] = await api('/api/baselines');
const scenariosBefore = new Set((await api(`/api/scenarios?baseline=${baseline.id}`)).map((s) => s.id));
let failed = null;
try {
  // Connect to the page.
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
    if (!target) await sleep(200);
  }
  assert.ok(target, 'browser did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(`uncaught: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
    }
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  // 1. The app loads and vehicles move.
  await cdp('Page.navigate', { url: APP });
  await waitFor(`document.querySelectorAll('.mode').length >= 5`, 'the mode list');
  await waitFor(`Number(document.querySelector('.moving-count')?.textContent.replace(/,/g, '')) > 100`, 'vehicles on the map', 60000);
  const clockA = await text('.clock-time');
  await sleep(1500);
  assert.notEqual(await text('.clock-time'), clockA, 'the clock advances while playing');
  await shot('loaded');
  step(`app loads; ${await text('.moving-count')} vehicles moving`);

  // 2. Space pauses.
  await clickAt(800, 300); // focus the page without hitting a panel
  await sleep(300);
  await js(`document.activeElement?.blur()`);
  await key(' ', 'Space', 0, 32);
  await sleep(300);
  const paused = await text('.clock-time');
  await sleep(1300);
  assert.equal(await text('.clock-time'), paused, 'Space pauses the clock');
  step('Space pauses the clock');
  if (await find('.inspector .icon-button')) await click('.inspector .icon-button');

  // 3. Search for a line and open it.
  await click('.search-input');
  await type('T1');
  await click('.search-results button', 'T1');
  await waitFor(`document.querySelector('.inspector h2')?.textContent.includes('T1')`, 'the T1 panel');
  await waitFor(`document.querySelectorAll('.bands tbody tr').length === 5`, 'the frequency card');
  const tripsBefore = await text('.inspector .tile-value');
  await shot('line-open');
  step(`search opens T1 (${tripsBefore} trips), with the frequency card`);

  // 4. Change the daytime frequency: the first edit starts a scenario by itself.
  const daytime = await find('.bands tbody tr:nth-child(3) input');
  await clickAt(daytime.x, daytime.y);
  await type('20');
  await click('.inspector .button', 'Apply to 1 part');
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('1 change')`, 'the change to be applied', 60000);
  assert.equal(await js(`document.querySelector('.scenario .error-text')?.textContent ?? ''`), '');
  await waitFor(`document.querySelector('.impact-row')?.textContent.includes('T1')`, 'the impact list');
  const tripsAfter = await waitFor(`(() => { const v = document.querySelector('.inspector .tile-value')?.textContent; return v && v !== ${JSON.stringify(tripsBefore)} ? v : null; })()`, 'the trip count to change');
  await shot('frequency-changed');
  step(`frequency change applied without creating a scenario first: ${tripsBefore} to ${tripsAfter} trips`);

  // 5. Ctrl+Z undoes, Ctrl+Y redoes.
  await js(`document.activeElement?.blur()`);
  await key('z', 'KeyZ', 2, 90);
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('0 changes')`, 'undo', 30000);
  await waitFor(`document.querySelector('.inspector .tile-value')?.textContent === ${JSON.stringify(tripsBefore)}`, 'the trip count to return');
  await key('y', 'KeyY', 2, 89);
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('1 change')`, 'redo', 30000);
  step('Ctrl+Z undoes and Ctrl+Y redoes');

  // 6. Open a trip from the list and move it five minutes later.
  await click('.inspector .rows.clickable .row .time');
  await waitFor(`!!document.querySelector('.edit-tools')`, 'the trip tools');
  const timesBefore = await text('.inspector .title-row .muted');
  await click('.edit-tools .speeds button', '+5 min');
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('2 changes')`, 'the retime', 30000);
  await waitFor(`document.querySelector('.inspector .title-row .muted')?.textContent !== ${JSON.stringify(timesBefore)}`, 'the trip to show its new time');
  assert.ok((await text('.edit-tools h3')).includes('changed'), 'the trip is tagged as changed');
  step(`trip retimed with a button: "${timesBefore.split(' · ')[0]}" became "${(await text('.inspector .title-row .muted')).split(' · ')[0]}"`);

  // 7. Skip a stop.
  const durationBefore = (await text('.inspector .title-row .muted')).split(' · ')[1];
  const row = await find('.stops li:nth-child(4)');
  await mouse('mouseMoved', row.x, row.y, { buttons: 0 });
  await click('.stops li:nth-child(4) .skip-button');
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('3 changes')`, 'the skip', 30000);
  await waitFor(`document.querySelector('.stops li:nth-child(4)')?.textContent.includes('passes through')`, 'the stop to show as passed through');
  step(`stop skipped: trip was ${durationBefore}, now ${(await text('.inspector .title-row .muted')).split(' · ')[1]}`);

  // 8. Trip diagram: drag a trip sideways.
  await click('.inspector .badge-button');
  await click('.inspector .button', 'Trip diagram');
  await waitFor(`!!document.querySelector('.timeline-canvas')`, 'the trip diagram');
  await sleep(2500);
  const canvas = await js(`(() => { const r = document.querySelector('.timeline-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  let grab = null;
  for (let fy = 0.3; fy < 0.9 && !grab; fy += 0.07) {
    for (let fx = 0.35; fx < 0.9 && !grab; fx += 0.03) {
      const x = canvas.x + canvas.w * fx;
      const y = canvas.y + canvas.h * fy;
      await mouse('mouseMoved', x, y, { buttons: 0 });
      await sleep(40);
      if ((await js(`document.querySelector('.timeline-canvas').style.cursor`)) === 'pointer') grab = { x, y };
    }
  }
  assert.ok(grab, 'found a trip line to drag on the diagram');
  await mouse('mousePressed', grab.x, grab.y);
  for (let dx = 8; dx <= 64; dx += 8) await mouse('mouseMoved', grab.x + dx, grab.y);
  const dragTip = await text('.timeline-tooltip');
  await shot('dragging');
  await mouse('mouseReleased', grab.x + 64, grab.y);
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('4 changes')`, 'the drag to apply', 30000);
  await shot('after-drag');
  step(`trip dragged on the diagram (tooltip while dragging: "${dragTip}")`);
  await click('.tl-panel .icon-button');

  // 9. Click a station on the map.
  const station = await findOnMap(/click for platforms/, { x0: 640, x1: 1100, y0: 120, y1: 380 });
  assert.ok(station, 'found a station on the map by hovering');
  await clickAt(station.x, station.y);
  await waitFor(`document.querySelector('.timeline-tabs .on')?.textContent === 'Platforms'`, 'the platform chart');
  await waitFor(`(document.querySelector('.timeline-context')?.textContent ?? '').length > 2`, 'the station name');
  step(`station click opens its platforms: ${station.tip.split(' · ')[0]}`);
  await shot('station');
  await click('.tl-panel .icon-button');

  // 10. Draw a new line through two stations.
  await click('.draw-button');
  await waitFor(`document.querySelector('.inspector strong')?.textContent === 'Draw a new line'`, 'the drawing panel');
  await js(`(() => { const s = document.querySelector('.inspector select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'train'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const first = await findOnMap(/click to add/, { x0: 640, x1: 1100, y0: 120, y1: 250 });
  assert.ok(first, 'found a first station to add');
  await clickAt(first.x, first.y);
  await waitFor(`document.querySelectorAll('.inspector .stops li').length === 1`, 'the first stop to be listed');
  let second = null;
  for (const box of [{ x0: 640, x1: 1100, y0: first.y + 40, y1: 420 }, { x0: 640, x1: first.x - 40, y0: 120, y1: 420 }]) {
    const candidate = await findOnMap(/click to add/, box);
    if (candidate && candidate.tip !== first.tip) {
      second = candidate;
      break;
    }
  }
  assert.ok(second, 'found a second station to add');
  await clickAt(second.x, second.y);
  await waitFor(`document.querySelectorAll('.inspector .stops li').length === 2`, 'the second stop to be listed');
  await click('.inspector .form input');
  await type('UI1');
  await shot('drawing');
  await click('.inspector .button', 'Create the line');
  await waitFor(`document.querySelector('.inspector h2') && document.querySelector('.inspector .badge')?.textContent === 'UI1'`, 'the new line to open', 60000);
  await shot('new-line');
  step(`new line drawn by clicking two stations: ${first.tip.split(' · ')[0]} to ${second.tip.split(' · ')[0]}, ${await text('.inspector .tile-value')} trips`);

  // 11. Fleet screen opens and closes with Escape.
  await click('.brand .button', 'Fleet');
  await waitFor(`document.querySelectorAll('.fleet-table tbody tr').length > 5`, 'the vehicle catalogue');
  await shot('fleet');
  await key('Escape', 'Escape', 0, 27);
  await waitFor(`!document.querySelector('.fleet')`, 'the catalogue to close');
  step('fleet screen opens and closes with Escape');

  // 12. Clashes and "Fix all".
  const clashes = Number((await js(`[...document.querySelectorAll('.scenario-stat')].find((s) => s.textContent.includes('clashes'))?.querySelector('.stat-value')?.textContent ?? '0'`)).replace(/,/g, ''));
  if (clashes > 0) {
    await click('.scenario .button', 'Fix all');
    // The Fix all button is disabled while fixes are being applied, and disappears when none are left.
    const fixAllBusy = `(() => { const b = [...document.querySelectorAll('.scenario .button')].find((x) => x.textContent.trim() === 'Fix all'); return !!b && b.disabled; })()`;
    await sleep(1500);
    await waitFor(`!${fixAllBusy}`, 'fix all to finish', 400000);
    await sleep(1500);
    await waitFor(`!${fixAllBusy}`, 'fix all to settle', 400000);
    const left = Number((await js(`[...document.querySelectorAll('.scenario-stat')].find((s) => s.textContent.includes('clashes'))?.querySelector('.stat-value')?.textContent ?? '0'`)).replace(/,/g, ''));
    await shot('after-fix-all');
    step(`Fix all: ${clashes} clashes before, ${left} after`);
  } else {
    step('no clashes to fix');
  }
} catch (err) {
  failed = err;
  await shot('failure').catch(() => {});
} finally {
  // Remove whatever scenario the test created.
  for (const s of await api(`/api/scenarios?baseline=${baseline.id}`)) {
    if (!scenariosBefore.has(s.id)) await api(`/api/scenarios/${s.id}`, 'DELETE');
  }
  try {
    ws?.close();
  } catch {}
  browser.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
if (problems.length) console.log(`browser errors (${problems.length}):\n  ${[...new Set(problems)].slice(0, 8).join('\n  ')}`);
if (failed) {
  console.error(`FAILED: ${failed.message}`);
  process.exit(1);
}
console.log(problems.length ? 'UI checks passed, with browser errors above' : 'all UI checks passed');
