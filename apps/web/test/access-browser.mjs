// A headless Edge or Chrome for the access check (access-check.mjs), driven over the DevTools
// protocol with no extra packages, as ui-smoke.mjs does: run code in the page, wait for something
// to be true, click, type, press keys and save screenshots. The helpers are copied from
// ui-smoke.mjs, not imported, so that neither script depends on the other. Not a test itself.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects to the browser's first page over the DevTools protocol. */
async function connect(port) {
  let target = null;
  for (let i = 0; i < 75 && !target; i++) {
    target = await fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .then((list) => list.find((t) => t.type === 'page'))
      .catch(() => null);
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the browser did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return ws;
}

/**
 * Starts a headless browser `width` × `height` and answers the helpers that drive it. Uncaught
 * errors and console errors in the page are collected in `problems`.
 */
export async function openBrowser({ width = 1600, height = 900 } = {}) {
  const binary = BROWSERS.find((p) => p && existsSync(p));
  if (!binary) throw new Error('no Edge or Chrome found; set BROWSER_PATH');
  const profile = path.join(os.tmpdir(), `gtfs-access-check-${process.pid}-${Date.now()}`);
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const ws = await connect(port);
  let nextId = 1;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const waiting = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error.message));
      else waiting.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      problems.push(`uncaught: ${details.exception?.description ?? details.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const words = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      problems.push(`console.error: ${words.slice(0, 300)}`);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** Runs an expression in the page and answers its value. */
  const js = async (expression) => {
    const r = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const details = r.exceptionDetails;
      throw new Error(`page script failed: ${details.exception?.description ?? details.text}`);
    }
    return r.result.value;
  };

  /** Waits until an expression in the page is truthy, and answers its value. */
  const waitFor = async (expression, what, timeout = 20_000) => {
    const started = Date.now();
    for (;;) {
      const value = await js(expression).catch(() => null);
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(150);
    }
  };

  const mouse = (type, x, y, buttons) =>
    cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  /** A left click at a point of the page, in CSS pixels. */
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, 0);
    await mouse('mousePressed', x, y, 1);
    await mouse('mouseReleased', x, y, 0);
  };

  /** Clicks the first visible, enabled element matching `selector` (and holding `text`). */
  const click = async (selector, text = null) => {
    const find = `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.disabled &&
          (${JSON.stringify(text)} === null || e.textContent.includes(${JSON.stringify(text)}));
      });
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`;
    const what = `${selector}${text === null ? '' : ` holding "${text}"`}`;
    const at = await waitFor(find, `a button or box: ${what}`, 15_000);
    await clickAt(at.x, at.y);
  };

  /** Types into whatever has the focus. */
  const typeText = (text) => cdp('Input.insertText', { text });

  /** Presses and lets go of a key, such as Enter or Escape. */
  const pressKey = async (key, code, vk) => {
    const base = { key, code, windowsVirtualKeyCode: vk };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  /**
   * An expression that runs `code` with the app's own store (useStore) and the map's last seen
   * bounds (mapView), by importing the very modules the page loaded from the dev server.
   */
  const inApp = (code) => `(async () => {
    const load = (name) => import(performance.getEntriesByType('resource').map((e) => e.name)
      .filter((n) => n.includes('/src/' + name)).pop() ?? '/src/' + name);
    const [{ useStore }, { mapView }] = await Promise.all([load('app/store.ts'), load('sim/sim-api.ts')]);
    ${code}
  })()`;

  /** Saves a PNG of the page, or of `clip` ({x, y, width, height}) only, to `file`. */
  const shot = async (file, clip = null) => {
    const params = { format: 'png', ...(clip && { clip: { ...clip, scale: 1 } }) };
    const { data } = await cdp('Page.captureScreenshot', params);
    await writeFile(file, Buffer.from(data, 'base64'));
  };

  const close = async () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
    child.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { cdp, js, waitFor, clickAt, click, typeText, pressKey, inApp, shot, problems, close };
}
