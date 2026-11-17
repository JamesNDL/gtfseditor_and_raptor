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
      problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)} … ${msg.params.args.slice(1).map((a) => a.value ?? '').join(' ').slice(0, 200)}`);
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
  const station = await findOnMap(/click for station details/, { x0: 640, x1: 1100, y0: 120, y1: 380 });
  assert.ok(station, 'found a station on the map by hovering');
  await clickAt(station.x, station.y);
  await waitFor(`[...document.querySelectorAll('.inspector h3')].some((h) => h.textContent.includes('Lines that call here'))`, 'the station panel');
  await click('.inspector .button', 'Platform chart');
  await waitFor(`document.querySelector('.timeline-tabs .on')?.textContent === 'Platforms'`, 'the platform chart');
  await waitFor(`(document.querySelector('.timeline-context')?.textContent ?? '').length > 2`, 'the station name');
  step(`station click opens its details on the right, and its platform chart from there: ${station.tip.split(' · ')[0]}`);
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

  // 11b. Change the route of the line just drawn: add a third station by clicking it, then take a stop off again.
  await click('.inspector .button', 'Change route');
  await waitFor(`document.querySelector('.inspector strong')?.textContent === 'Change the route'`, 'the route-changing panel');
  await waitFor(`document.querySelectorAll('.inspector .stops li').length === 2`, 'the line\'s two stops');
  // The map has zoomed to fit the line's two stations; zoom out a step so that their neighbours are in view.
  await click('.maplibregl-ctrl-zoom-out');
  await sleep(1500);
  let third = await findOnMap(/click to add to the line/, { x0: 380, x1: 1100, y0: 150, y1: 760 });
  // Two neighbouring stations make a short line and a close view; step out again until another station shows.
  for (let i = 0; i < 2 && !third; i++) {
    await click('.maplibregl-ctrl-zoom-out');
    await sleep(1500);
    third = await findOnMap(/click to add to the line/, { x0: 380, x1: 1100, y0: 150, y1: 760 });
  }
  assert.ok(third, 'found a station that is not on the line yet');
  await clickAt(third.x, third.y);
  await waitFor(`document.querySelectorAll('.inspector .stops li').length === 3`, 'the added stop to be listed');
  await waitFor(`document.querySelector('.reshape-preview')?.textContent.includes('1 stop added')`, 'the preview of the change', 30000);
  const previewText = (await text('.reshape-preview')).replace(/\s+/g, ' ');
  await shot('reshaping');
  await mouse('mouseMoved', third.x, third.y, { buttons: 0 });
  await sleep(200);
  assert.match(await text('.map-tooltip'), /click to take it off the line/, 'a stop on the line offers to come off');
  await click('.inspector .button', 'trips');
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('6 changes')`, 'the route change to apply', 60000);
  await waitFor(`document.querySelector('.inspector h2') && document.querySelector('.inspector .badge')?.textContent === 'UI1'`, 'the line to reopen');
  await shot('reshaped');
  step(`route changed by clicking ${third.tip.split(' · ')[0]}: ${previewText.slice(0, 160)}`);

  // 11c. Add a station that does not exist yet by naming it and clicking the map, and run the line to it.
  await click('.inspector .button', 'Change route');
  await waitFor(`document.querySelector('.inspector strong')?.textContent === 'Change the route'`, 'the route-changing panel again');
  const stopsNow = await waitFor(`document.querySelectorAll('.inspector .stops li').length`, 'the line\'s stops');
  // The panel is still settling when the link first appears, and a click can land where the link was.
  for (let i = 0; i < 5 && !(await find('.new-stop input')); i++) {
    await click('.new-stop-link');
    await sleep(400);
  }
  await click('.new-stop input');
  await type('UI Halt');
  await click('.new-stop .button', 'Place it on the map');
  await waitFor(`document.querySelector('.new-stop')?.textContent.includes('Now click the map')`, 'the prompt to click the map');
  await mouse('mouseMoved', 700, 620, { buttons: 0 });
  await sleep(200);
  assert.match(await text('.map-tooltip'), /Click to place UI Halt here/);
  await clickAt(700, 620);
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('7 changes')`, 'the new station to be added', 30000);
  await waitFor(`document.querySelectorAll('.inspector .stops li').length === ${stopsNow + 1}`, 'the new station to join the line');
  assert.ok((await text('.inspector .stops')).includes('UI Halt'), 'the new station is listed by name');
  await waitFor(`document.querySelector('.reshape-preview')?.textContent.includes('1 stop added')`, 'the preview with the new station', 30000);
  await shot('new-station');
  await click('.inspector .button', 'trips');
  await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('8 changes')`, 'the line to run to the new station', 60000);
  await shot('line-to-new-station');
  step('new station named, placed with a click on the map, and added to the line');

  // 11d. The drawing panel offers a one-way loop, which needs a third stop.
  if (await find('.inspector .icon-button')) await click('.inspector .icon-button');
  await click('.draw-button', 'Draw a new line');
  await waitFor(`document.querySelector('.inspector strong')?.textContent === 'Draw a new line'`, 'the drawing panel again');
  await click('.inspector .timeline-check', 'One-way loop');
  await waitFor(`[...document.querySelectorAll('.inspector .button')].some((b) => b.textContent.includes('Pick at least three stops'))`, 'the loop to ask for three stops');
  assert.ok((await text('.inspector .form')).includes('one way round'), 'the frequency is described as one way round');
  step('the drawing panel offers a one-way loop');
  await click('.inspector .icon-button');

  // 11e. Close a train line between two stations, see what it does, apply it, and undo it.
  await click('.close-button');
  await waitFor(`document.querySelector('.inspector strong')?.textContent === 'Close a road or a line'`, 'the closure panel');
  await js(`(() => { const s = document.querySelector('.inspector select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'train'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('.inspector .stops')?.textContent.includes('Click a station')`, 'the prompt for the first station');
  const published = (tip) => !/UI Halt/.test(tip);
  let sideA = null;
  for (const box of [{ x0: 500, x1: 1100, y0: 150, y1: 450 }, { x0: 380, x1: 1100, y0: 450, y1: 760 }]) {
    const candidate = await findOnMap(/the closure is on one side of here/, box);
    if (candidate && published(candidate.tip)) {
      sideA = candidate;
      break;
    }
  }
  assert.ok(sideA, 'found a station for one side of the closure');
  await clickAt(sideA.x, sideA.y);
  await waitFor(`document.querySelector('.inspector .stops')?.textContent.includes('Click the station on the other side')`, 'the prompt for the second station');
  let sideB = null;
  for (const box of [{ x0: 380, x1: 1100, y0: sideA.y + 30, y1: 760 }, { x0: 380, x1: sideA.x - 30, y0: 150, y1: 760 }, { x0: sideA.x + 30, x1: 1100, y0: 150, y1: 760 }]) {
    const candidate = await findOnMap(/the closure is between here and/, box);
    if (candidate && published(candidate.tip) && candidate.tip.split(' · ')[0] !== sideA.tip.split(' · ')[0]) {
      sideB = candidate;
      break;
    }
  }
  assert.ok(sideB, 'found a station for the other side of the closure');
  await clickAt(sideB.x, sideB.y);
  await waitFor(`/closed between|Nothing runs through|No train service/.test(document.querySelector('.reshape-preview')?.textContent ?? '')`, 'the preview of the closure', 60000);
  const closureText = (await text('.reshape-preview')).replace(/\s+/g, ' ');
  await shot('closing');
  // For part of the day: the preview names the hours, and going back to all day restores it.
  await click('.inspector .speeds button', 'Part of the day');
  await waitFor(`/10:00 to 14:00|between those times/.test(document.querySelector('.reshape-preview')?.textContent ?? '')`, 'the preview of a part-day closure', 60000);
  const partDayText = (await text('.reshape-preview')).replace(/\s+/g, ' ');
  assert.equal(await js(`document.querySelectorAll('.closure-times input[type=time]').length`), 2, 'a start and an end time are offered');
  await shot('closing-part-day');
  await click('.inspector .speeds button', 'All day');
  await waitFor(`(() => { const t = document.querySelector('.reshape-preview')?.textContent ?? ''; return !/10:00 to 14:00|between those times/.test(t) && /closed between|Nothing runs through|No train service/.test(t); })()`, 'the all-day preview again', 60000);
  step(`part-day closure previewed: ${partDayText.slice(18, 160)}`);
  if (/closed between/.test(closureText)) {
    const changesBefore = Number((await text('.scenario-actions')).match(/(\d+) change/)[1]);
    await click('.inspector .button', 'Close it and change');
    await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('${changesBefore + 1} changes')`, 'the closure to apply', 240000);
    await waitFor(`!document.querySelector('.inspector strong') || document.querySelector('.inspector strong').textContent !== 'Close a road or a line'`, 'the closure panel to close');
    await shot('closed');
    step(`line closed between ${sideA.tip.split(' · ')[0]} and ${sideB.tip.split(' · ')[0]}: ${closureText.slice(18, 200)}`);
    await js(`document.activeElement?.blur()`);
    await key('z', 'KeyZ', 2, 90);
    await waitFor(`document.querySelector('.scenario-actions')?.textContent.includes('${changesBefore} changes')`, 'undo to reopen the line', 60000);
    step('Ctrl+Z reopens the line');
  } else {
    step(`closure panel answered for ${sideA.tip.split(' · ')[0]} and ${sideB.tip.split(' · ')[0]}: ${closureText.slice(0, 120)}`);
    await click('.inspector .icon-button');
  }

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

  // 13. The two tool buttons stay in view however far the scenario panel is scrolled.
  await js(`(() => { const b = document.querySelector('.scenario-body'); if (b) b.scrollTop = b.scrollHeight; })()`);
  await sleep(200);
  const drawVisible = await js(`(() => {
    const b = [...document.querySelectorAll('.scenario .draw-button')].find((x) => x.textContent.includes('Draw a new line'));
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && (top === b || b.contains(top));
  })()`);
  assert.ok(drawVisible, '"Draw a new line" should stay visible when the scenario panel is scrolled to the bottom');
  step('the drawing and closing buttons stay in view when the scenario panel is scrolled');

  // 14. A trip added to a line from its panel, at a typed time.
  await click('.search-input');
  await type('T1');
  await waitFor(`document.querySelectorAll('.search-results button').length > 0`, 'search results');
  await click('.search-results button');
  await waitFor(`[...document.querySelectorAll('.inspector .edit-row')].some((r) => r.textContent.includes('Add a trip at'))`, 'the add-a-trip row');
  await click('.inspector .edit-row .button', 'Add');
  await waitFor(`(document.querySelector('.inspector h3')?.textContent ?? '').includes('Edit this trip')`, 'the new trip to open', 60000);
  assert.match(await text('.inspector .title-row .muted'), /^12:00/, 'the new trip leaves at the time typed');
  step(`trip added from the line panel: ${(await text('.inspector .title-row .muted')).split(' · ')[0]}`);
  await key('z', 'KeyZ', 2, 90);
  await sleep(1500);

  // 15. The light version, and back.
  await click('.button', 'Light');
  await waitFor(`document.documentElement.dataset.theme === 'light'`, 'the light theme');
  await waitFor(`!!document.querySelector('.maplibregl-canvas')`, 'the map to be rebuilt');
  await sleep(4000);
  const panelColour = await js(`getComputedStyle(document.querySelector('.panel')).backgroundColor`);
  assert.equal(panelColour, 'rgb(255, 255, 255)', 'panels are white in the light version');
  await shot('light-theme');
  await click('.button', 'Dark');
  await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'the dark theme');
  step('the light version switches on and off');

  // 16. Vehicle chart: drag a trip down onto another vehicle.
  const changeCount = async () => Number((await text('.scenario-actions')).match(/(\d+) changes?/)?.[1] ?? 0);
  const canvasBox = () => js(`(() => { const r = document.querySelector('.timeline-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  /** Sweeps the pointer over the chart until the tooltip matches, and returns where. */
  const findOnChart = async (pattern, box, ys, stepX) => {
    for (const y of ys) {
      for (let x = box.x + 170; x < box.x + box.w - 30; x += stepX) {
        await mouse('mouseMoved', x, y, { buttons: 0 });
        await sleep(30);
        const tip = await js(`(() => { const t = document.querySelector('.timeline-tooltip'); return t && t.style.display !== 'none' ? t.textContent : ''; })()`);
        if (pattern.test(tip)) return { x, y, tip };
      }
    }
    return null;
  };
  /** Presses at a point, moves to another in small steps, and returns the tooltip shown just before letting go. */
  const dragTo = async (from, to) => {
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    await sleep(150);
    return text('.timeline-tooltip');
  };
  await click('.search-input');
  await type('T1');
  await waitFor(`document.querySelectorAll('.search-results button').length > 0`, 'search results');
  await click('.search-results button');
  await waitFor(`document.querySelector('.inspector h2')?.textContent.includes('T1')`, 'the T1 panel');
  await click('.inspector .button', 'Trip diagram');
  await click('.timeline-tabs button', 'Vehicles');
  await waitFor(`document.querySelector('.timeline-tabs .on')?.textContent === 'Vehicles' && !!document.querySelector('.timeline-canvas')`, 'the vehicle chart');
  // The whole day, so that every vehicle has a trip in view.
  await click('.timeline-window .button', 'Day');
  await sleep(2500);
  let box = await canvasBox();
  // Vehicles the scenario added are listed first and may have no trip in the hours shown, so look down every row in view.
  const vehicleRows = [];
  for (let y = box.y + 24 + 11; y < box.y + box.h - 12; y += 22) vehicleRows.push(y);
  const tripBar = await findOnChart(/\d\d:\d\d to \d\d:\d\d/, box, vehicleRows, 12);
  assert.ok(tripBar, 'found a trip to drag on the vehicle chart');
  let before = await changeCount();
  // Two rows down, or up when that would reach the bottom edge (where the rows start to scroll).
  const vehicleDrop = { x: tripBar.x, y: tripBar.y + (tripBar.y + 44 < box.y + box.h - 30 ? 44 : -44) };
  const vehicleTip = await dragTo(tripBar, vehicleDrop);
  assert.match(vehicleTip, /^Move to /, 'the tooltip names the vehicle the trip would move to');
  await shot('dragging-to-vehicle');
  await mouse('mouseReleased', vehicleDrop.x, vehicleDrop.y);
  await waitFor(`Number((document.querySelector('.scenario-actions')?.textContent.match(/(\\d+) changes?/) ?? [])[1]) === ${before + 1}`, 'the move to another vehicle to apply', 30000);
  assert.equal(await js(`document.querySelector('.scenario .error-text')?.textContent ?? ''`), '');
  step(`trip dragged onto another vehicle on the vehicle chart (tooltip while dragging: "${vehicleTip}")`);

  // 17. Platform chart: drag a call up or down onto another platform. The station is the one clicked in step 9.
  await click('.timeline-tabs button', 'Platforms');
  await waitFor(`document.querySelector('.timeline-tabs .on')?.textContent === 'Platforms' && !!document.querySelector('.timeline-canvas')`, 'the platform chart');
  await sleep(2500);
  box = await canvasBox();
  const rowYs = [];
  for (let y = box.y + 32; y < box.y + box.h - 8; y += 8) rowYs.push(y);
  const callBar = await findOnChart(/Stops \d+ min|Starts here|Terminates here/, box, rowYs, 10);
  if (!callBar) {
    step('platform chart: no call in view to drag at this station (not checked)');
  } else {
    before = await changeCount();
    let dropAt = { x: callBar.x, y: callBar.y + 30 };
    let platformTip = await dragTo(callBar, dropAt);
    if (!/^Move to /.test(platformTip)) {
      // The bottom row has nothing below it: go up instead.
      dropAt = { x: callBar.x, y: callBar.y - 30 };
      for (let i = 1; i <= 8; i++) await mouse('mouseMoved', callBar.x, callBar.y + 30 - (60 * i) / 8);
      await sleep(150);
      platformTip = await text('.timeline-tooltip');
    }
    if (!/^Move to /.test(platformTip)) {
      await mouse('mouseReleased', callBar.x, callBar.y);
      step('platform chart: the station in view has one platform, so there is nowhere to drag a call (not checked)');
    } else {
      await shot('dragging-to-platform');
      await mouse('mouseReleased', dropAt.x, dropAt.y);
      await waitFor(`Number((document.querySelector('.scenario-actions')?.textContent.match(/(\\d+) changes?/) ?? [])[1]) === ${before + 1}`, 'the platform change to apply', 30000);
      assert.equal(await js(`document.querySelector('.scenario .error-text')?.textContent ?? ''`), '');
      step(`call dragged onto another platform on the platform chart (tooltip while dragging: "${platformTip}")`);
    }
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
