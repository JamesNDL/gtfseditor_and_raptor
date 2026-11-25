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
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1600,900',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    'about:blank',
  ],
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
  if (r.exceptionDetails)
    throw new Error(
      `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  return r.result.value;
};
// A change that would add ten or more vehicles is described first and waits for "Go ahead"
// (EditConfirm). While waiting for anything, the test reads what is asked and agrees to it.
const confirmsSeen = [];
const agreeIfAsked = async () => {
  const asked = await js(`(() => {
    const go = document.querySelector('.edit-confirm .confirm-go:not([disabled])');
    if (!go) return null;
    const said = document.querySelector('.edit-confirm')?.textContent ?? '';
    go.click();
    return said;
  })()`).catch(() => null);
  if (asked) {
    assert.match(
      asked,
      /This adds [0-9,]+ vehicles/,
      'the question says how many vehicles the change adds',
    );
    assert.match(asked, /Nothing has been changed yet/);
    confirmsSeen.push(asked.match(/This adds [0-9,]+ vehicles/)[0]);
  }
};
const waitFor = async (expression, what, timeout = 20000) => {
  const started = Date.now();
  for (;;) {
    await agreeIfAsked();
    const value = await js(expression).catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
};
const mouse = (type, x, y, extra = {}) =>
  cdp('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    ...extra,
  });
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
  cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: k,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
  }).then(() =>
    cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: k,
      code,
      modifiers,
      windowsVirtualKeyCode: vk,
    }),
  );
const text = (selector) =>
  js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
let shotNo = 0;
const shot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    path.join(shots, `${String(++shotNo).padStart(2, '0')}-${name}.png`),
    Buffer.from(data, 'base64'),
  );
};
const step = (name) => console.log(`ok  ${name}`);
/** Folds a panel out of the rail on the left, unless it is out already: 'Timetable', 'Simulate' or 'Layers'. */
const pane = async (label) => {
  const out = await js(
    `[...document.querySelectorAll('.rail-button.on')].some((b) => b.textContent.includes(${JSON.stringify(label)}))`,
  );
  if (!out) await click('.rail-button', label);
  await sleep(200);
};
/** Sweeps the pointer over the map until the tooltip matches, and returns where. */
const findOnMap = async (pattern, box) => {
  for (let y = box.y0; y <= box.y1; y += 14) {
    for (let x = box.x0; x <= box.x1; x += 14) {
      await mouse('mouseMoved', x, y, { buttons: 0 });
      await sleep(60);
      const tip = await js(
        `(() => { const t = document.querySelector('.map-tooltip'); return t && t.style.display !== 'none' ? t.textContent : ''; })()`,
      );
      if (pattern.test(tip)) return { x, y, tip };
    }
  }
  return null;
};

const api = async (p, method = 'GET') => (await fetch(API + p, { method })).json();
const [baseline] = await api('/api/baselines');
const scenariosBefore = new Set(
  (await api(`/api/scenarios?baseline=${baseline.id}`)).map((s) => s.id),
);
const simRunsBefore = new Set(
  (await api(`/api/sim-runs?baseline=${baseline.id}`).catch(() => [])).map((r) => r.id),
);
const demandBefore = new Set((await api('/api/demand').catch(() => [])).map((d) => d.id));
let failed = null;
try {
  // Connect to the page.
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = await fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .then((l) => l.find((t) => t.type === 'page'))
      .catch(() => null);
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
      problems.push(
        `uncaught: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
      );
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(
        `console.error: ${msg.params.args
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 300)} … ${msg.params.args
          .slice(1)
          .map((a) => a.value ?? '')
          .join(' ')
          .slice(0, 200)}`,
      );
    }
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 1. The app loads and vehicles move.
  await cdp('Page.navigate', { url: APP });
  await waitFor(`document.querySelectorAll('.mode').length >= 5`, 'the mode list');
  await waitFor(
    `Number(document.querySelector('.moving-count')?.textContent.replace(/,/g, '')) > 100`,
    'vehicles on the map',
    60000,
  );
  const clockA = await text('.clock-time');
  await sleep(1500);
  assert.notEqual(await text('.clock-time'), clockA, 'the clock advances while playing');
  await shot('loaded');
  step(`app loads; ${await text('.moving-count')} vehicles moving`);

  // 1a. A vehicle that has finished a trip stays on the map until its next trip leaves. The clock is
  // stopped in the middle of a train's wait at its terminus: the train must still be drawn, at the
  // place its trip ended, and be gone from there the second its next trip starts.
  /** An expression that runs code in the page with the app's own store (s), vehicles (v) and clock. */
  const inApp = (code) => `(async () => {
    const find = (name) => import(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/' + name)).pop() ?? '/src/' + name);
    const [{ useStore }, v, { clock }] = await Promise.all([find('app/store.ts'), find('vehicles/vehicles.ts'), find('shared/clock.ts')]);
    const s = useStore.getState();
    ${code}
  })()`;
  {
    await waitFor(
      inApp(`return !!v.vehicleData.get('train')?.holdUntil.some((until) => until > 0);`),
      'the waits between train trips',
      60000,
    );
    const held = await js(
      inApp(`
      const mv = v.vehicleData.get('train');
      for (let i = 0; i < mv.pack.meta.tripCount; i++) {
        const end = mv.pack.tripEnd[i];
        const wait = mv.holdUntil[i] - end;
        if (end > 8 * 3600 && wait >= 300 && wait <= 900) return { i, id: mv.pack.tripId[i], end, until: mv.holdUntil[i], was: clock.secs };
      }
      return null;`),
    );
    assert.ok(held, 'some train waits 5 to 15 minutes at the end of a trip');
    /** Whether the train's dot is in the frame last drawn, and whether it stands where its trip ended. */
    const drawnAt = (secs) =>
      js(
        inApp(`
      s.set({ playing: false });
      clock.set(${secs});
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const mv = v.vehicleData.get('train');
      const k = Array.from(mv.frameTrip.subarray(0, mv.count)).indexOf(${held.i});
      if (k < 0) return { drawn: false };
      const out = new Float64Array(2);
      v.vehicleAt(mv, ${held.i}, mv.pack.tripEnd[${held.i}], out, 0);
      return { drawn: true, atTheEnd: Math.abs(mv.positions[k * 2] - out[0]) < 1e-9 && Math.abs(mv.positions[k * 2 + 1] - out[1]) < 1e-9, waiting: mv.waiting };`),
      );
    const during = await drawnAt(Math.round((held.end + held.until) / 2));
    assert.ok(
      during.drawn,
      `a train that has finished trip ${held.id} is still drawn while it waits for its next one`,
    );
    assert.ok(during.atTheEnd, 'the waiting train stands where its trip ended');
    assert.ok(during.waiting > 0, 'waiting vehicles are counted');
    assert.match(
      await text('.moving-waiting'),
      /[1-9][\d,]* waiting/,
      'the time bar says how many vehicles are waiting',
    );
    await shot('waiting-vehicle');
    assert.ok(
      !(await drawnAt(held.until)).drawn,
      'the wait ends the second the next trip starts, so the train is not drawn twice',
    );
    await js(inApp(`clock.set(${held.was}); s.set({ playing: true });`));
    step(
      `a train stays on the map between two trips (${Math.round((held.until - held.end) / 60)} min at its terminus); ${during.waiting} trains waiting`,
    );
  }

  // 1b. The passenger simulator (docs/simulator-plan.md, phase S4): make up a few journeys, run them
  // through the published timetable in Newcastle, read the summary, look one person up, and see
  // passengers on a line and on a trip. Needs the journey router (`npm run router:dev`).
  /** Chooses an option of a select by its text, the way a person would. */
  const choose = (selector, optionText) =>
    js(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => [...e.options].some((o) => o.textContent.includes(${JSON.stringify(optionText)})));
      if (!el) return false;
      const option = [...el.options].find((o) => o.textContent.includes(${JSON.stringify(optionText)}));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  /** Replaces what is in a text box. */
  const fill = async (selector, value) => {
    await click(selector);
    await key('a', 'KeyA', 2, 65);
    await type(value);
  };
  /** Opens an address afresh; changing only what follows the # would not load the page again. */
  const goTo = async (url) => {
    await cdp('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await cdp('Page.navigate', { url });
  };
  const simStatus = await api('/api/sim/status');
  let simBauMade = false;
  if (!simStatus.router || process.env.UI_SKIP === 'sim') {
    step(
      simStatus.router
        ? 'simulator: left out (UI_SKIP=sim)'
        : 'simulator: the journey router is not running (not checked)',
    );
  } else {
    await pane('Simulate');
    await click('.sim-head button', 'New simulation');
    await waitFor(`!!document.querySelector('.sim-wizard')`, 'the wizard');
    assert.match(
      await text('.sim-choice.on'),
      /published timetable/,
      'with no scenario open, a BAU run is already chosen',
    );
    await click('.sim-footer button', 'Next');
    await fill('.sim-wizard input[aria-label="How many journeys to make up"]', '2500');
    // The area can be dragged on the map: the wizard steps aside and comes back with the box.
    await click('.sim-wizard button', 'Draw on the map');
    await waitFor(
      `document.querySelector('.sim-wizard')?.offsetParent === null`,
      'the wizard to step aside',
    );
    await mouse('mouseMoved', 700, 300, { buttons: 0 });
    await mouse('mousePressed', 700, 300);
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', 700 + i * 40, 300 + i * 30);
    await shot('sim-drawing-a-box');
    await mouse('mouseReleased', 940, 480);
    await waitFor(
      `document.querySelector('.sim-wizard')?.offsetParent != null`,
      'the wizard to come back',
    );
    // The wizard is back a moment before the box it was given is chosen in the list.
    await waitFor(
      `/box of my own/.test(document.querySelector('.sim-wizard select[aria-label="Area of the run"]')?.selectedOptions[0]?.textContent ?? '')`,
      'the drawn box to be chosen',
      8000,
    ).catch(() => {});
    assert.match(
      await js(
        `document.querySelector('.sim-wizard select[aria-label="Area of the run"]').selectedOptions[0].textContent`,
      ),
      /box of my own/,
    );
    assert.match(
      await text('.sim-wizard'),
      /-3\d\.\d+, 15\d\.\d+ to -3\d\.\d+, 15\d\.\d+/,
      'the box drawn is shown',
    );
    assert.equal(
      await js(`!!document.querySelector('.inspector h2')`),
      false,
      'drawing the box opened nothing on the map',
    );
    assert.ok(
      await choose('.sim-wizard select[aria-label="Area of the run"]', 'Newcastle'),
      'the Newcastle area is offered',
    );
    assert.match(
      await js(
        `document.querySelector('.sim-wizard select[aria-label="Area of the run"]').selectedOptions[0].textContent`,
      ),
      /Newcastle/,
    );
    await click('.sim-wizard button', 'Make up');
    // The first time, the router has to load the published timetable before it can make journeys up.
    await waitFor(
      `/2,500 journeys by/.test(document.querySelector('.sim-report')?.textContent ?? '')`,
      'the made-up journeys',
      240000,
    );
    assert.match(
      await js(
        `document.querySelector('.sim-wizard select[aria-label="Area of the run"]').selectedOptions[0].textContent`,
      ),
      /Newcastle/,
      'the area chosen stays chosen',
    );
    await shot('sim-wizard-who-and-where');
    await click('.sim-footer button', 'Next');
    assert.match(
      await text('.sim-settings'),
      /500 m, about 11 min/,
      'the walk to another stop starts at 500 m',
    );
    await click('.sim-footer button', 'Next');
    await fill('.sim-wizard input[aria-label="Name of the run"]', 'UI test BAU');
    await fill('.sim-wizard input[aria-label="Your name"]', 'ui-test');
    // Journeys made up for an area lie inside it: the last step must not say that none do.
    await waitFor(
      `/about 2,500 journeys, the 100% of journey ends inside Newcastle/.test(document.querySelector('.sim-wizard')?.textContent ?? '')`,
      'the journeys counted inside the area',
      30000,
    );
    await shot('sim-wizard-check');
    await click('.sim-footer button', 'Run the simulation');
    await waitFor(`!document.querySelector('.sim-wizard')`, 'the wizard to close', 20000);
    await waitFor(`!!document.querySelector('.sim-going')`, 'the run in progress');
    await waitFor(
      `!!document.querySelector('.sim-stats')`,
      'the run to finish and its summary to show',
      240000,
    );
    const travel = await text('.sim-stats .stat-value');
    assert.ok(Number(travel.replace(/,/g, '')) > 500, `people travel: ${travel}`);
    assert.match(await text('.sim-summary'), /Journey time/);
    await shot('sim-summary');
    step(`simulation set up in the wizard and run: ${travel} of 2,500 made-up people travel`);

    // One person, by their id, listed and drawn on the map.
    const simRun = (await api(`/api/sim-runs?baseline=${baseline.id}`)).find(
      (r) => r.name === 'UI test BAU',
    );
    let rider = null;
    for (let n = 1; n < 400 && !rider; n++) {
      const user = `u${String(n).padStart(7, '0')}`;
      const journeys = await api(`/api/sim-runs/${simRun.id}/journeys?user=${user}`);
      const journey = journeys.find(
        (j) => j.status === 'ok' && j.legs.some((l) => l.kind === 'ride' && l.routeId),
      );
      if (journey) rider = { user, ride: journey.legs.find((l) => l.kind === 'ride' && l.routeId) };
    }
    assert.ok(rider, 'someone rides something');
    await pane('Simulate');
    await fill('.sim-person input', rider.user);
    await click('.sim-person button', 'Find');
    await waitFor(`document.querySelectorAll('.sim-journeys li').length > 0`, 'their journeys');
    assert.match(await text('.sim-journeys'), / from .+ to /);
    await sleep(1200);
    await shot('sim-one-person');
    step(`one person looked up by user_id (${rider.user}) and drawn on the map`);

    // A link names the run, so passenger figures show on the line and the trip it opens.
    await goTo(`${APP}/#route=${rider.ride.routeId}&sim=${simRun.id}`);
    await waitFor(
      `/passengers a day/.test(document.querySelector('.inspector .sim-figures')?.textContent ?? '')`,
      'passengers on the line panel',
      60000,
    );
    const onLine = await text('.inspector .sim-figures .tile-value');
    await shot('sim-line-passengers');
    await goTo(`${APP}/#trip=${rider.ride.tripId}&sim=${simRun.id}`);
    await waitFor(
      `document.querySelectorAll('.inspector .sim-loads li').length >= 2`,
      'passengers along the trip',
      60000,
    );
    await shot('sim-trip-passengers');
    step(`passenger figures on a line (${onLine} a day) and along a trip`);

    // The results window on that run (docs/simulator-plan.md, section 18), and its flows on the map.
    await goTo(`${APP}/#sim=${simRun.id}&results=1`);
    await waitFor(
      `/people travel/.test(document.querySelector('.results')?.textContent ?? '')`,
      'the results window',
      60000,
    );
    await click('.results .tabs button', 'Lines');
    await waitFor(
      `document.querySelectorAll('.results-line-table tbody tr').length > 0`,
      'lines in the results',
      60000,
    );
    const resultLines = await js(
      `document.querySelectorAll('.results-line-table tbody tr').length`,
    );
    await shot('sim-results-lines');
    await click('.map-key .chips button', 'Passenger flow');
    await waitFor(
      `/Width is passengers: the widest is/.test(document.querySelector('.map-key')?.textContent ?? '')`,
      'passenger flow on the map',
      120000,
    );
    await sleep(1500);
    await shot('sim-results-flow');
    step(`results window: ${resultLines} lines listed, and passenger flow drawn on the map`);

    // Travel patterns and People, one person drawn, a line's riders followed, and vehicles by how full.
    await click('.results .tabs button', 'Travel patterns');
    await waitFor(
      `/Passengers boarding, by mode/.test(document.querySelector('.results-body')?.textContent ?? '') && document.querySelectorAll('.results-compare li').length > 5`,
      'travel patterns',
      60000,
    );
    await shot('sim-results-patterns');
    await click('.results .tabs button', 'People');
    await waitFor(
      `document.querySelectorAll('.results-people-table tbody tr').length > 0`,
      'people in the results',
      60000,
    );
    const listed = await js(`document.querySelectorAll('.results-people-table tbody tr').length`);
    await click('.results-people-table tbody tr');
    await waitFor(
      `document.querySelectorAll('.results-journeys li').length > 0`,
      'the journey of one of them',
      30000,
    );
    await sleep(1500);
    await shot('sim-results-person');
    await click('.results-line-card .icon-button');
    await click('.results .tabs button', 'Lines');
    await click('.results-line-table tbody tr');
    await click('.results-line-card button', 'Its passengers on the map');
    await waitFor(
      `/people:/.test(document.querySelector('.map-key')?.textContent ?? '') && /where they start/.test(document.querySelector('.map-key')?.textContent ?? '')`,
      'the riders of a line followed on the map',
      120000,
    );
    const followed = (await text('.map-key')).match(/([\d,]+) people:/)?.[1];
    await sleep(1500);
    await shot('sim-results-through');
    await click('.map-key button', 'Pick again');
    await waitFor(
      `/Click a stretch or a stop/.test(document.querySelector('.map-key')?.textContent ?? '')`,
      'the stretches to pick from',
    );
    await sleep(600); // the key changes height as its words change; let it settle before clicking in it
    await click('.map-key .chips button', 'How full');
    await waitFor(
      `/under half/.test(document.querySelector('.map-key')?.textContent ?? '') && !/Working it out/.test(document.querySelector('.map-key')?.textContent ?? '')`,
      'vehicles coloured by how full',
      120000,
    );
    await sleep(1000);
    await shot('sim-results-vehicles');
    step(
      `results window: travel patterns, ${listed} people listed and one drawn, ${followed} riders of a line followed on the map, vehicles coloured by how full`,
    );
    simBauMade = true;

    await goTo(APP);
    await waitFor(
      `Number(document.querySelector('.moving-count')?.textContent.replace(/,/g, '')) > 100`,
      'vehicles on the map again',
      60000,
    );
  }
  if (process.env.UI_ONLY === 'sim') throw new Error('UI_ONLY');

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
  await waitFor(
    `document.querySelector('.inspector h2')?.textContent.includes('T1')`,
    'the T1 panel',
  );
  await waitFor(`document.querySelectorAll('.bands tbody tr').length === 5`, 'the frequency card');
  const tripsBefore = await text('.inspector .tile-value');
  await shot('line-open');
  step(`search opens T1 (${tripsBefore} trips), with the frequency card`);

  // 4. Change the daytime frequency: the first edit starts a scenario by itself.
  const daytime = await find('.bands tbody tr:nth-child(3) input');
  await clickAt(daytime.x, daytime.y);
  await type('20');
  await click('.inspector .button', 'Apply to 1 part');
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('1 change')`,
    'the change to be applied',
    60000,
  );
  assert.equal(await js(`document.querySelector('.scenario .error-text')?.textContent ?? ''`), '');
  await waitFor(
    `document.querySelector('.impact-row')?.textContent.includes('T1')`,
    'the impact list',
  );
  const tripsAfter = await waitFor(
    `(() => { const v = document.querySelector('.inspector .tile-value')?.textContent; return v && v !== ${JSON.stringify(tripsBefore)} ? v : null; })()`,
    'the trip count to change',
  );
  await shot('frequency-changed');
  step(
    `frequency change applied without creating a scenario first: ${tripsBefore} to ${tripsAfter} trips`,
  );

  // 5. Ctrl+Z undoes, Ctrl+Y redoes.
  await js(`document.activeElement?.blur()`);
  await key('z', 'KeyZ', 2, 90);
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('0 changes')`,
    'undo',
    30000,
  );
  await waitFor(
    `document.querySelector('.inspector .tile-value')?.textContent === ${JSON.stringify(tripsBefore)}`,
    'the trip count to return',
  );
  await key('y', 'KeyY', 2, 89);
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('1 change')`,
    'redo',
    30000,
  );
  step('Ctrl+Z undoes and Ctrl+Y redoes');

  // 6. Open a trip from the list and move it five minutes later.
  await click('.inspector .rows.clickable .row .time');
  await waitFor(`!!document.querySelector('.edit-tools')`, 'the trip tools');
  const timesBefore = await text('.inspector .title-row .muted');
  await click('.edit-tools .speeds button', '+5 min');
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('2 changes')`,
    'the retime',
    30000,
  );
  await waitFor(
    `document.querySelector('.inspector .title-row .muted')?.textContent !== ${JSON.stringify(timesBefore)}`,
    'the trip to show its new time',
  );
  assert.ok((await text('.edit-tools h3')).includes('changed'), 'the trip is tagged as changed');
  step(
    `trip retimed with a button: "${timesBefore.split(' · ')[0]}" became "${(await text('.inspector .title-row .muted')).split(' · ')[0]}"`,
  );

  // 7. Skip a stop.
  const durationBefore = (await text('.inspector .title-row .muted')).split(' · ')[1];
  const row = await find('.stops li:nth-child(4)');
  await mouse('mouseMoved', row.x, row.y, { buttons: 0 });
  await click('.stops li:nth-child(4) .skip-button');
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('3 changes')`,
    'the skip',
    30000,
  );
  await waitFor(
    `document.querySelector('.stops li:nth-child(4)')?.textContent.includes('passes through')`,
    'the stop to show as passed through',
  );
  step(
    `stop skipped: trip was ${durationBefore}, now ${(await text('.inspector .title-row .muted')).split(' · ')[1]}`,
  );

  // 8. Trip diagram: drag a trip sideways.
  await click('.inspector .badge-button');
  await click('.inspector .button', 'Trip diagram');
  await waitFor(`!!document.querySelector('.timeline-canvas')`, 'the trip diagram');
  await sleep(2500);
  const canvas = await js(
    `(() => { const r = document.querySelector('.timeline-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
  );
  let grab = null;
  for (let fy = 0.3; fy < 0.9 && !grab; fy += 0.07) {
    for (let fx = 0.35; fx < 0.9 && !grab; fx += 0.03) {
      const x = canvas.x + canvas.w * fx;
      const y = canvas.y + canvas.h * fy;
      await mouse('mouseMoved', x, y, { buttons: 0 });
      await sleep(40);
      if ((await js(`document.querySelector('.timeline-canvas').style.cursor`)) === 'pointer')
        grab = { x, y };
    }
  }
  assert.ok(grab, 'found a trip line to drag on the diagram');
  await mouse('mousePressed', grab.x, grab.y);
  for (let dx = 8; dx <= 64; dx += 8) await mouse('mouseMoved', grab.x + dx, grab.y);
  const dragTip = await text('.timeline-tooltip');
  await shot('dragging');
  await mouse('mouseReleased', grab.x + 64, grab.y);
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('4 changes')`,
    'the drag to apply',
    30000,
  );
  await shot('after-drag');
  step(`trip dragged on the diagram (tooltip while dragging: "${dragTip}")`);
  await click('.tl-panel .icon-button');

  // 9. Click a station on the map.
  const station = await findOnMap(/click for station details/, {
    x0: 640,
    x1: 1100,
    y0: 120,
    y1: 380,
  });
  assert.ok(station, 'found a station on the map by hovering');
  await clickAt(station.x, station.y);
  await waitFor(
    `[...document.querySelectorAll('.inspector h3')].some((h) => h.textContent.includes('Lines that call here'))`,
    'the station panel',
  );
  await click('.inspector .button', 'Platform chart');
  await waitFor(
    `document.querySelector('.timeline-tabs .on')?.textContent === 'Platforms'`,
    'the platform chart',
  );
  await waitFor(
    `(document.querySelector('.timeline-context')?.textContent ?? '').length > 2`,
    'the station name',
  );
  step(
    `station click opens its details on the right, and its platform chart from there: ${station.tip.split(' · ')[0]}`,
  );
  await shot('station');
  await click('.tl-panel .icon-button');

  // 10. Draw a new line through two stations.
  await click('.draw-button');
  await waitFor(
    `document.querySelector('.inspector strong')?.textContent === 'Draw a new line'`,
    'the drawing panel',
  );
  await js(
    `(() => { const s = document.querySelector('.inspector select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'train'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  const first = await findOnMap(/click to add/, { x0: 640, x1: 1100, y0: 120, y1: 250 });
  assert.ok(first, 'found a first station to add');
  await clickAt(first.x, first.y);
  await waitFor(
    `document.querySelectorAll('.inspector .stops li').length === 1`,
    'the first stop to be listed',
  );
  let second = null;
  for (const box of [
    { x0: 640, x1: 1100, y0: first.y + 40, y1: 420 },
    { x0: 640, x1: first.x - 40, y0: 120, y1: 420 },
  ]) {
    const candidate = await findOnMap(/click to add/, box);
    if (candidate && candidate.tip !== first.tip) {
      second = candidate;
      break;
    }
  }
  assert.ok(second, 'found a second station to add');
  await clickAt(second.x, second.y);
  await waitFor(
    `document.querySelectorAll('.inspector .stops li').length === 2`,
    'the second stop to be listed',
  );
  await click('.inspector .form input');
  await type('UI1');
  await shot('drawing');
  await click('.inspector .button', 'Create the line');
  await waitFor(
    `document.querySelector('.inspector h2') && document.querySelector('.inspector .badge')?.textContent === 'UI1'`,
    'the new line to open',
    60000,
  );
  await shot('new-line');
  step(
    `new line drawn by clicking two stations: ${first.tip.split(' · ')[0]} to ${second.tip.split(' · ')[0]}, ${await text('.inspector .tile-value')} trips`,
  );

  // 11. Fleet screen opens and closes with Escape.
  await click('.brand .button', 'Fleet');
  await waitFor(
    `document.querySelectorAll('.fleet-table tbody tr').length > 5`,
    'the vehicle catalogue',
  );
  await shot('fleet');
  await key('Escape', 'Escape', 0, 27);
  await waitFor(`!document.querySelector('.fleet')`, 'the catalogue to close');
  step('fleet screen opens and closes with Escape');

  // 11b. Change the route of the line just drawn: add a third station by clicking it, then take a stop off again.
  await click('.inspector .button', 'Change route');
  await waitFor(
    `document.querySelector('.inspector strong')?.textContent === 'Change the route'`,
    'the route-changing panel',
  );
  await waitFor(
    `document.querySelectorAll('.inspector .stops li').length === 2`,
    "the line's two stops",
  );
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
  await waitFor(
    `document.querySelectorAll('.inspector .stops li').length === 3`,
    'the added stop to be listed',
  );
  await waitFor(
    `document.querySelector('.reshape-preview')?.textContent.includes('1 stop added')`,
    'the preview of the change',
    30000,
  );
  const previewText = (await text('.reshape-preview')).replace(/\s+/g, ' ');
  await shot('reshaping');
  await mouse('mouseMoved', third.x, third.y, { buttons: 0 });
  await sleep(200);
  assert.match(
    await text('.map-tooltip'),
    /click to take it off the line/,
    'a stop on the line offers to come off',
  );
  await click('.inspector .button', 'trips');
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('6 changes')`,
    'the route change to apply',
    60000,
  );
  await waitFor(
    `document.querySelector('.inspector h2') && document.querySelector('.inspector .badge')?.textContent === 'UI1'`,
    'the line to reopen',
  );
  await shot('reshaped');
  step(`route changed by clicking ${third.tip.split(' · ')[0]}: ${previewText.slice(0, 160)}`);

  // 11c. Add a station that does not exist yet by naming it and clicking the map, and run the line to it.
  await click('.inspector .button', 'Change route');
  await waitFor(
    `document.querySelector('.inspector strong')?.textContent === 'Change the route'`,
    'the route-changing panel again',
  );
  const stopsNow = await waitFor(
    `document.querySelectorAll('.inspector .stops li').length`,
    "the line's stops",
  );
  // The panel is still settling when the link first appears, and a click can land where the link was.
  for (let i = 0; i < 5 && !(await find('.new-stop input')); i++) {
    await click('.new-stop-link');
    await sleep(400);
  }
  await click('.new-stop input');
  await type('UI Halt');
  await click('.new-stop .button', 'Place it on the map');
  await waitFor(
    `document.querySelector('.new-stop')?.textContent.includes('Now click the map')`,
    'the prompt to click the map',
  );
  await mouse('mouseMoved', 700, 620, { buttons: 0 });
  await sleep(200);
  assert.match(await text('.map-tooltip'), /Click to place UI Halt here/);
  await clickAt(700, 620);
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('7 changes')`,
    'the new station to be added',
    30000,
  );
  await waitFor(
    `document.querySelectorAll('.inspector .stops li').length === ${stopsNow + 1}`,
    'the new station to join the line',
  );
  assert.ok(
    (await text('.inspector .stops')).includes('UI Halt'),
    'the new station is listed by name',
  );
  await waitFor(
    `document.querySelector('.reshape-preview')?.textContent.includes('1 stop added')`,
    'the preview with the new station',
    30000,
  );
  await shot('new-station');
  await click('.inspector .button', 'trips');
  await waitFor(
    `document.querySelector('.scenario-actions')?.textContent.includes('8 changes')`,
    'the line to run to the new station',
    60000,
  );
  await shot('line-to-new-station');
  step('new station named, placed with a click on the map, and added to the line');

  // 11d. The drawing panel offers a one-way loop, which needs a third stop.
  if (await find('.inspector .icon-button')) await click('.inspector .icon-button');
  await click('.draw-button', 'Draw a line');
  await waitFor(
    `document.querySelector('.inspector strong')?.textContent === 'Draw a new line'`,
    'the drawing panel again',
  );
  await click('.inspector .timeline-check', 'One-way loop');
  await waitFor(
    `[...document.querySelectorAll('.inspector .button')].some((b) => b.textContent.includes('Pick at least three stops'))`,
    'the loop to ask for three stops',
  );
  assert.ok(
    (await text('.inspector .form')).includes('one way round'),
    'the frequency is described as one way round',
  );
  step('the drawing panel offers a one-way loop');
  await click('.inspector .icon-button');

  // 11e. Close a line: draw a line on the map round a station, see what it cuts, apply it, and undo it.
  const published = (tip) => !/UI Halt/.test(tip);
  let shut = null;
  for (const box of [
    { x0: 500, x1: 1000, y0: 220, y1: 450 },
    { x0: 500, x1: 1000, y0: 450, y1: 680 },
  ]) {
    const candidate = await findOnMap(/click for station details/, box);
    if (candidate && published(candidate.tip)) {
      shut = candidate;
      break;
    }
  }
  assert.ok(shut, 'found a station to close the line at');
  const shutName = shut.tip.split(' · ')[0];
  assert.ok(
    await js(
      `(() => { const b = document.querySelector('.map-tools .close-button'); const r = b?.getBoundingClientRect(); return !!r && r.height > 30 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.close-button') === b; })()`,
    ),
    'the closing tool is in plain sight on the map',
  );
  await click('.map-tools .close-button');
  await waitFor(
    `document.querySelector('.inspector strong')?.textContent === 'Close a road or a line'`,
    'the closure panel',
  );
  assert.ok((await text('.inspector-body')).includes('Not drawn yet'), 'the panel asks for a line');
  // Four clicks round the station, and a fifth back at the start: whichever way the track runs, the line crosses it.
  // Kept small: how far the map is zoomed out here depends on the line drawn earlier, and a line
  // of more than 20 km is refused.
  const corners = [
    [-30, -30],
    [30, -30],
    [30, 30],
    [-30, 30],
    [-30, -30],
  ];
  for (const [i, [dx, dy]] of corners.entries()) {
    await clickAt(shut.x + dx, shut.y + dy);
    if (i === 0)
      await waitFor(
        `document.querySelector('.inspector-body')?.textContent.includes('One point placed')`,
        'the first point of the line',
      );
  }
  await waitFor(
    `/closed [0-9]+ m either side/.test(document.querySelector('.inspector-body')?.textContent ?? '')`,
    'the line to be drawn',
  );
  const previewReady = `/Closed near|Nothing runs through/.test(document.querySelector('.reshape-preview')?.textContent ?? '')`;
  await waitFor(previewReady, 'the preview of the closure', 180000);
  // The line cuts every kind of service it crosses. To keep this quick, leave all but the trains running.
  const kinds = await js(
    `[...document.querySelectorAll('.closure-modes label')].map((l) => l.textContent.trim())`,
  );
  for (const kind of kinds) {
    if (/^Train/.test(kind)) continue;
    await js(
      `[...document.querySelectorAll('.closure-modes label')].find((l) => l.textContent.trim() === ${JSON.stringify(kind)})?.querySelector('input').click()`,
    );
  }
  if (kinds.some((k) => !/^Train/.test(k)))
    await waitFor(
      `/leaving .* running|Nothing runs through/.test(document.querySelector('.reshape-preview')?.textContent ?? '')`,
      'the preview without the other kinds',
      180000,
    );
  const closureText = (await text('.reshape-preview')).replace(/\s+/g, ' ');
  await shot('closing');
  // Each line is split into a part on each side, named after it; one side can be dropped and brought back.
  const press = (label) =>
    js(
      `[...document.querySelectorAll('.inspector .speeds button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`,
    );
  const settled = `!document.querySelector('.reshape-preview .stale')`;
  const partNames = await js(
    `[...document.querySelectorAll('.closure-part strong')].map((e) => e.textContent.trim())`,
  );
  if (/Train/.test(kinds.join()))
    assert.ok(
      partNames.some((n) => /-[NSEW]$/.test(n)),
      `the parts are named after their line: ${partNames.slice(0, 6).join(', ')}`,
    );
  const sideChoices = await js(
    `[...document.querySelectorAll('[aria-label="Which side to keep"] button')].map((b) => b.textContent.trim())`,
  );
  if (partNames.length > 1 && sideChoices.length === 3) {
    await press(sideChoices[1]);
    await waitFor(
      `document.querySelectorAll('.closure-part.dropped').length > 0 && ${settled}`,
      'the parts on the other side to be dropped',
      60000,
    );
    await shot('closing-one-side');
    await press('Both');
    await waitFor(
      `document.querySelectorAll('.closure-part.dropped').length === 0 && ${settled}`,
      'both sides to be kept again',
      60000,
    );
    step(
      `split into ${partNames.slice(0, 4).join(', ')}; "${sideChoices[1]}" drops the other side, "Both" brings it back`,
    );
  }
  // The list and the map pick out the same line: pointing at a row marks it, and a part clicked on the map is kept, dropped or listed.
  const lineRow = await find('.closure-lines li');
  await mouse('mouseMoved', lineRow.x, lineRow.y, { buttons: 0 });
  await waitFor(
    `!!document.querySelector('.closure-lines li.focus')`,
    'the row under the pointer to be marked',
  );
  await shot('closing-focus');
  const onPart = await findOnMap(/click to drop this part|click to list these lines/, {
    x0: 400,
    x1: 1100,
    y0: 150,
    y1: 760,
  });
  assert.ok(onPart, 'a part of a split line can be pointed at on the map');
  await clickAt(onPart.x, onPart.y);
  await waitFor(
    `!!document.querySelector('.closure-only') || document.querySelectorAll('.closure-part.dropped').length > 0`,
    'the click on the map to act on the part',
    60000,
  );
  await shot('closing-part-clicked');
  if (await js(`!!document.querySelector('.closure-only')`))
    await js(`document.querySelector('.closure-only button').click()`);
  else {
    await clickAt(onPart.x, onPart.y);
    await waitFor(
      `document.querySelectorAll('.closure-part.dropped').length === 0 && ${settled}`,
      'a second click to keep both parts again',
      60000,
    );
  }
  step(`a part pointed at on the map (${onPart.tip.slice(0, 60)}) answers a click`);
  step(`a line drawn round ${shutName} crosses: ${kinds.join(', ') || 'nothing'}`);
  // For part of the day: the preview names the hours, and going back to all day restores it.
  await press('Part of the day');
  await waitFor(
    `/10:00 to 14:00|between those times/.test(document.querySelector('.reshape-preview')?.textContent ?? '')`,
    'the preview of a part-day closure',
    180000,
  );
  const partDayText = (await text('.reshape-preview')).replace(/\s+/g, ' ');
  assert.equal(
    await js(`document.querySelectorAll('.closure-times input[type=time]').length`),
    2,
    'a start and an end time are offered',
  );
  await shot('closing-part-day');
  await press('All day');
  await waitFor(
    `(() => { const t = document.querySelector('.reshape-preview')?.textContent ?? ''; return !/10:00 to 14:00|between those times/.test(t) && /Closed near|Nothing runs through/.test(t); })()`,
    'the all-day preview again',
    180000,
  );
  step(`part-day closure previewed: ${partDayText.slice(18, 160)}`);
  if (/Closed near/.test(closureText) && /Train/.test(kinds.join())) {
    const changesBefore = Number((await text('.scenario-actions')).match(/(\d+) change/)[1]);
    await click('.inspector .button', 'Close it and change');
    await waitFor(
      `document.querySelector('.scenario-actions')?.textContent.includes('${changesBefore + 1} changes')`,
      'the closure to apply',
      240000,
    );
    await waitFor(
      `!document.querySelector('.inspector strong') || document.querySelector('.inspector strong').textContent !== 'Close a road or a line'`,
      'the closure panel to close',
    );
    await shot('closed');
    assert.match(await text('.edits li'), /the parts run as/, 'the change names the parts');
    step(`closed at ${shutName}: ${closureText.slice(18, 200)}`);
    await js(`document.activeElement?.blur()`);
    await key('z', 'KeyZ', 2, 90);
    await waitFor(
      `document.querySelector('.scenario-actions')?.textContent.includes('${changesBefore} changes')`,
      'undo to reopen the line',
      60000,
    );
    step('Ctrl+Z reopens the line');
  } else {
    step(`closure panel answered at ${shutName}: ${closureText.slice(0, 120)}`);
    await click('.inspector .icon-button');
  }

  // 12. Clashes and "Fix all".
  const clashes = Number(
    (
      await js(
        `[...document.querySelectorAll('.scenario-stat')].find((s) => s.textContent.includes('clashes'))?.querySelector('.stat-value')?.textContent ?? '0'`,
      )
    ).replace(/,/g, ''),
  );
  if (clashes > 0) {
    await pane('Timetable');
    await click('.scenario .button', 'Fix all');
    // The Fix all button is disabled while fixes are being applied, and disappears when none are left.
    const fixAllBusy = `(() => { const b = [...document.querySelectorAll('.scenario .button')].find((x) => x.textContent.trim() === 'Fix all'); return !!b && b.disabled; })()`;
    await sleep(1500);
    await waitFor(`!${fixAllBusy}`, 'fix all to finish', 400000);
    await sleep(1500);
    await waitFor(`!${fixAllBusy}`, 'fix all to settle', 400000);
    const left = Number(
      (
        await js(
          `[...document.querySelectorAll('.scenario-stat')].find((s) => s.textContent.includes('clashes'))?.querySelector('.stat-value')?.textContent ?? '0'`,
        )
      ).replace(/,/g, ''),
    );
    await shot('after-fix-all');
    step(`Fix all: ${clashes} clashes before, ${left} after`);
  } else {
    step('no clashes to fix');
  }

  // 13. The two tools are on the map, in view however far the scenario panel is scrolled.
  await js(
    `(() => { const b = document.querySelector('.scenario-body'); if (b) b.scrollTop = b.scrollHeight; })()`,
  );
  await sleep(200);
  const toolsVisible = await js(`['.draw-button', '.close-button'].every((c) => {
    const b = document.querySelector('.map-tools ' + c);
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && (top === b || b.contains(top));
  })`);
  assert.ok(toolsVisible, 'the drawing and closing tools should be in view on the map');
  step('the drawing and closing tools are in view on the map');

  // 14. A trip added to a line from its panel, at a typed time.
  await click('.search-input');
  await type('T1');
  await waitFor(`document.querySelectorAll('.search-results button').length > 0`, 'search results');
  await click('.search-results button');
  await waitFor(
    `[...document.querySelectorAll('.inspector .edit-row')].some((r) => r.textContent.includes('Add a trip at'))`,
    'the add-a-trip row',
  );
  await click('.inspector .edit-row .button', 'Add');
  await waitFor(
    `(document.querySelector('.inspector h3')?.textContent ?? '').includes('Edit this trip')`,
    'the new trip to open',
    60000,
  );
  assert.match(
    await text('.inspector .title-row .muted'),
    /^12:00/,
    'the new trip leaves at the time typed',
  );
  step(
    `trip added from the line panel: ${(await text('.inspector .title-row .muted')).split(' · ')[0]}`,
  );
  await key('z', 'KeyZ', 2, 90);
  await sleep(1500);

  // 15. The light version, and back.
  await click('.button', 'Light');
  await waitFor(`document.documentElement.dataset.theme === 'light'`, 'the light theme');
  await waitFor(`!!document.querySelector('.maplibregl-canvas')`, 'the map to be rebuilt');
  await sleep(4000);
  const panelColour = await js(
    `getComputedStyle(document.querySelector('.panel')).backgroundColor`,
  );
  assert.equal(panelColour, 'rgb(255, 255, 255)', 'panels are white in the light version');
  await shot('light-theme');
  await click('.button', 'Dark');
  await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'the dark theme');
  step('the light version switches on and off');

  // 16. Vehicle chart: drag a trip down onto another vehicle.
  const changeCount = async () =>
    Number((await text('.scenario-actions')).match(/(\d+) changes?/)?.[1] ?? 0);
  const canvasBox = () =>
    js(
      `(() => { const r = document.querySelector('.timeline-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    );
  /** Sweeps the pointer over the chart until the tooltip matches, and returns where. */
  const findOnChart = async (pattern, box, ys, stepX) => {
    for (const y of ys) {
      for (let x = box.x + 170; x < box.x + box.w - 30; x += stepX) {
        await mouse('mouseMoved', x, y, { buttons: 0 });
        await sleep(30);
        const tip = await js(
          `(() => { const t = document.querySelector('.timeline-tooltip'); return t && t.style.display !== 'none' ? t.textContent : ''; })()`,
        );
        if (pattern.test(tip)) return { x, y, tip };
      }
    }
    return null;
  };
  /** Presses at a point, moves to another in small steps, and returns the tooltip shown just before letting go. */
  const dragTo = async (from, to) => {
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 8; i++)
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 8,
        from.y + ((to.y - from.y) * i) / 8,
      );
    await sleep(150);
    return text('.timeline-tooltip');
  };
  await click('.search-input');
  await type('T1');
  await waitFor(`document.querySelectorAll('.search-results button').length > 0`, 'search results');
  await click('.search-results button');
  await waitFor(
    `document.querySelector('.inspector h2')?.textContent.includes('T1')`,
    'the T1 panel',
  );
  await click('.inspector .button', 'Trip diagram');
  await click('.timeline-tabs button', 'Vehicles');
  await waitFor(
    `document.querySelector('.timeline-tabs .on')?.textContent === 'Vehicles' && !!document.querySelector('.timeline-canvas')`,
    'the vehicle chart',
  );
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
  const vehicleDrop = {
    x: tripBar.x,
    y: tripBar.y + (tripBar.y + 44 < box.y + box.h - 30 ? 44 : -44),
  };
  const vehicleTip = await dragTo(tripBar, vehicleDrop);
  assert.match(vehicleTip, /^Move to /, 'the tooltip names the vehicle the trip would move to');
  await shot('dragging-to-vehicle');
  await mouse('mouseReleased', vehicleDrop.x, vehicleDrop.y);
  await waitFor(
    `Number((document.querySelector('.scenario-actions')?.textContent.match(/(\\d+) changes?/) ?? [])[1]) === ${before + 1}`,
    'the move to another vehicle to apply',
    30000,
  );
  assert.equal(await js(`document.querySelector('.scenario .error-text')?.textContent ?? ''`), '');
  step(
    `trip dragged onto another vehicle on the vehicle chart (tooltip while dragging: "${vehicleTip}")`,
  );

  // 17. Platform chart: drag a call up or down onto another platform. The station is the one clicked in step 9.
  await click('.timeline-tabs button', 'Platforms');
  await waitFor(
    `document.querySelector('.timeline-tabs .on')?.textContent === 'Platforms' && !!document.querySelector('.timeline-canvas')`,
    'the platform chart',
  );
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
      for (let i = 1; i <= 8; i++)
        await mouse('mouseMoved', callBar.x, callBar.y + 30 - (60 * i) / 8);
      await sleep(150);
      platformTip = await text('.timeline-tooltip');
    }
    if (!/^Move to /.test(platformTip)) {
      await mouse('mouseReleased', callBar.x, callBar.y);
      step(
        'platform chart: the station in view has one platform, so there is nowhere to drag a call (not checked)',
      );
    } else {
      await shot('dragging-to-platform');
      await mouse('mouseReleased', dropAt.x, dropAt.y);
      await waitFor(
        `Number((document.querySelector('.scenario-actions')?.textContent.match(/(\\d+) changes?/) ?? [])[1]) === ${before + 1}`,
        'the platform change to apply',
        30000,
      );
      assert.equal(
        await js(`document.querySelector('.scenario .error-text')?.textContent ?? ''`),
        '',
      );
      step(
        `call dragged onto another platform on the platform chart (tooltip while dragging: "${platformTip}")`,
      );
    }
  }

  // 17b. Delete a whole line from its panel, in two clicks, and bring it back with Ctrl+Z.
  await key('Escape', 'Escape', 0, 27);
  await click('.search-input');
  await type('F1');
  await click('.search-results button', 'F1');
  await waitFor(
    `/Manly|Circular Quay/.test(document.querySelector('.inspector')?.textContent ?? '') && !!document.querySelector('.inspector .tile-value')`,
    'the F1 panel',
  );
  const ferryTrips = await text('.inspector .tile-value');
  before = await changeCount();
  await click('.inspector .actions button', 'Delete line');
  await click('.inspector .actions button', 'Delete all');
  await waitFor(
    `/no trips in this scenario/.test(document.querySelector('.inspector')?.textContent ?? '')`,
    'the line to be deleted',
    30000,
  );
  assert.equal(await changeCount(), before + 1);
  assert.match(await text('.edits li'), /Deleted line F1/);
  await shot('line-deleted');
  await pane('Timetable');
  await click('.scenario-actions button', 'Undo');
  await waitFor(
    `document.querySelector('.inspector .tile-value')?.textContent === ${JSON.stringify(ferryTrips)}`,
    'undo to bring the line back',
    30000,
  );
  step(`line deleted from its panel (F1, ${ferryTrips} trips) and brought back with undo`);

  // 17b. Delete a station from its panel. The preview says what happens to the trips before anything
  // changes; afterwards the panel says it is deleted, the map still has it (crossed out), and
  // "Put it back" undoes it. The station is the quietest wharf in the middle of the busiest ferry line.
  {
    const ferries = (await api(`/api/baselines/${baseline.id}/routes`))
      .filter((r) => r.modeId === 'ferry')
      .sort((a, b) => b.tripCount - a.tripCount);
    const ferry = await api(`/api/routes/${ferries[0].id}`);
    const wharves = (await api(`/api/patterns/${ferry.patterns[0].id}/stops`)).stops.slice(1, -1);
    let quiet = null;
    for (const w of wharves) {
      const s = await api(`/api/stations/${w.id}/summary`);
      if (s.calls > 0 && (!quiet || s.calls < quiet.calls)) quiet = s;
    }
    assert.ok(quiet, 'found a wharf to delete');
    await pane('Timetable');
    await js(inApp(`s.open({ kind: 'station', id: ${quiet.id} }); return true;`));
    await waitFor(
      `(document.querySelector('.inspector h2')?.textContent ?? '').includes(${JSON.stringify(quiet.name)})`,
      'the station panel',
    );
    before = await changeCount();
    await click('.inspector .actions button', 'Delete this');
    await waitFor(
      `/call there today|Nothing calls there/.test(document.querySelector('[data-testid="delete-preview"]')?.textContent ?? '')`,
      'the preview of the deletion',
      30000,
    );
    const deletePreview = await text('[data-testid="delete-preview"]');
    assert.match(
      deletePreview,
      /Nothing is re-routed, and no vehicle is added/,
      'the preview states the rule before anything changes',
    );
    assert.equal(await changeCount(), before, 'the preview changes nothing');
    await shot('delete-station-preview');
    await click('[data-testid="delete-preview"] .button.danger');
    await waitFor(
      `!!document.querySelector('[data-testid="deleted-note"]')`,
      'the station to be deleted',
      60000,
    );
    assert.equal(await changeCount(), before + 1);
    assert.match(await text('.inspector h2'), /deleted in this scenario/);
    assert.equal(
      await js(`document.querySelector('.scenario .error-text')?.textContent ?? ''`),
      '',
    );
    const openScenario = await js(inApp(`return s.scenarioId;`));
    const crossedOut = (await api(`/api/scenarios/${openScenario}/deleted-stops`)).features.map(
      (f) => f.properties.stop_id,
    );
    assert.ok(
      crossedOut.includes(quiet.id),
      "the deleted station is still in the map's data, to be drawn crossed out",
    );
    await sleep(800);
    await shot('station-deleted');
    await click('[data-testid="deleted-note"] button', 'Put it back');
    await waitFor(
      `!document.querySelector('[data-testid="deleted-note"]') && [...document.querySelectorAll('.inspector .actions button')].some((b) => b.textContent.includes('Delete this'))`,
      'undo to put the station back',
      60000,
    );
    assert.equal((await api(`/api/scenarios/${openScenario}/deleted-stops`)).features.length, 0);
    step(
      `station deleted from its panel after a preview, and put back (${quiet.name}): ${deletePreview.replace(/\s+/g, ' ').slice(0, 140)}`,
    );
  }

  // 18. A scenario run, set up in the wizard against the BAU run of step 1b. The scenario is the one
  // this test has been editing; the same people are sent through it.
  if (simBauMade) {
    await pane('Simulate');
    await click('.sim-head button', 'New simulation');
    await waitFor(`!!document.querySelector('.sim-wizard')`, 'the wizard');
    assert.match(
      await text('.sim-choice.on'),
      /scenario on screen/,
      'with a scenario open, a scenario run is already chosen',
    );
    await click('.sim-footer button', 'Next');
    await waitFor(
      `!!document.querySelector('.sim-wizard select[aria-label="BAU run to compare with"]')`,
      'the BAU runs to compare with',
    );
    assert.ok(
      await choose('.sim-wizard select[aria-label="BAU run to compare with"]', 'UI test BAU'),
      'the BAU run made earlier is offered',
    );
    await waitFor(
      `/Newcastle/.test(document.querySelector('.sim-report')?.textContent ?? '')`,
      'what is taken from that BAU run',
    );
    assert.match(
      await text('.sim-report'),
      /Walk to another stop: 500 m/,
      'what is taken from the BAU run is shown, not asked for',
    );
    await click('.sim-footer button', 'Next');
    assert.match(await text('.sim-settings'), /before they give up/);
    await click('.sim-footer button', 'Next');
    await shot('sim-wizard-scenario-check');
    await click('.sim-footer button', 'Run the simulation');
    await waitFor(`!document.querySelector('.sim-wizard')`, 'the wizard to close', 20000);
    await waitFor(
      `/Against the published timetable/.test(document.querySelector('.sim-summary')?.textContent ?? '')`,
      'the scenario run to finish',
      300000,
    );
    await shot('sim-scenario-summary');
    step(
      `scenario run against the BAU run: ${(await text('.sim-summary .scenario-section')).replace('Against the published timetable', '').slice(0, 90)}`,
    );

    // The library lists the run; it can be removed from there.
    await pane('Simulate');
    await click('.sim-head button', 'Library');
    await waitFor(
      `[...document.querySelectorAll('.sim-run')].some((r) => r.textContent.includes('UI test BAU'))`,
      'the run in the library',
    );
    assert.match(
      await js(
        `[...document.querySelectorAll('.sim-run')].find((r) => r.textContent.includes('UI test BAU')).textContent`,
      ),
      /ui-test/,
      'who made it is shown',
    );
    assert.equal(
      await js(
        `(() => { const rows = [...document.querySelectorAll('.sim-run')]; const i = rows.findIndex((r) => r.querySelector('strong').textContent === 'UI test BAU'); return rows[i + 1]?.style.marginLeft; })()`,
      ),
      '22px',
      'the scenario run is listed under its BAU run',
    );
    await shot('sim-library');
    await js(
      `[...document.querySelectorAll('.sim-run')].find((r) => r.textContent.includes('UI test BAU')).querySelector('.sim-run-tools button:last-of-type').click()`,
    );
    await waitFor(
      `[...document.querySelectorAll('.sim-run button')].some((b) => b.textContent.startsWith('Remove, though'))`,
      'the second click to remove',
    );
    await click('.sim-run button', 'Remove, though 1 run depends on it');
    await waitFor(
      `![...document.querySelectorAll('.sim-run strong')].some((r) => r.textContent === 'UI test BAU')`,
      'the run to go from the library',
      30000,
    );
    assert.equal(
      await js(
        `[...document.querySelectorAll('.sim-run')].some((r) => r.textContent.includes('scenario'))`,
      ),
      true,
      'the scenario run stays, without its BAU run',
    );
    await key('Escape', 'Escape', 0, 27);
    step(
      'the library lists the scenario run under its BAU run, and removes the BAU run on the second click',
    );
  }
} catch (err) {
  if (err.message !== 'UI_ONLY') {
    failed = err;
    await shot('failure').catch(() => {});
  }
} finally {
  if (confirmsSeen.length)
    console.log(`    asked before adding vehicles, and agreed: ${confirmsSeen.join('; ')}`);
  // Remove whatever scenario the test created, and what its simulation left.
  for (const run of await api(`/api/sim-runs?baseline=${baseline.id}`).catch(() => [])) {
    if (!simRunsBefore.has(run.id))
      await api(`/api/sim-runs/${run.id}?force=true`, 'DELETE').catch(() => {});
  }
  for (const set of await api('/api/demand').catch(() => [])) {
    if (set.madeUp && !demandBefore.has(set.id))
      await api(`/api/demand/${set.id}?force=true`, 'DELETE').catch(() => {});
  }
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
if (problems.length)
  console.log(
    `browser errors (${problems.length}):\n  ${[...new Set(problems)].slice(0, 8).join('\n  ')}`,
  );
if (failed) {
  console.error(`FAILED: ${failed.message}`);
  process.exit(1);
}
console.log(
  problems.length ? 'UI checks passed, with browser errors above' : 'all UI checks passed',
);
