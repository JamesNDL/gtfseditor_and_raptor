// The map editor steps of the access check (access-check.mjs; D35 to D37): drawing the zone with
// the Draw zone tool and naming it in the name box on the map, placing each point of interest with
// the pin tool, switching the basemap, and reshaping the zone and moving a pin by dragging. Saves
// 09-basemap-streets.png to 14-reshape-zone.png beside the check's own numbered screenshots.
// Not a test itself.
import assert from 'node:assert/strict';
import { sleep } from './access-browser.mjs';
import { clickPlace, dragPlace, showPlaces, toScreen } from './access-map.mjs';

/** How near, in degrees, a click must land to the place it was aimed at (about 30 m). */
const NEAR_DEGREES = 0.0003;
const near = (a, b) => Math.abs(a[0] - b[0]) < NEAR_DEGREES && Math.abs(a[1] - b[1]) < NEAR_DEGREES;

const tool = (name) => `.aa-tool[aria-label^="${name}"]`;
const nameBoxShown = `!!document.querySelector('.aa-name-box input')`;

/** Checks the name box sits wholly on screen, above (or below) its place, and not under a panel. */
async function checkNameBox(b, place, what) {
  const box = await b.waitFor(
    `(() => { const r = document.querySelector('.aa-name-box')?.getBoundingClientRect();
      return r && r.width > 0 && { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`,
    `the name box for ${what}`,
  );
  assert.ok(box.left >= 0 && box.top >= 0 && box.right <= 1600 && box.bottom <= 900, 'off screen');
  const at = await toScreen(b, place);
  assert.ok(at.x >= box.left && at.x <= box.right, `the name box is not over ${what}`);
  assert.ok(box.bottom <= at.y || box.top >= at.y, `the name box covers ${what}`);
  const focused = await b.js(
    `document.activeElement === document.querySelector('.aa-name-box input')`,
  );
  assert.ok(focused, `the name box for ${what} does not have the keyboard`);
}

/** Step 1: draws the zone with the Draw zone tool, corner by corner, and names it on the map. */
export async function drawZone(b, { plan, api, made, shot, extraShot }) {
  await b.click('.rail-button', 'Access');
  await b.click('.analysis-panel button', 'New analysis');
  await showPlaces(b, [...plan.zone.corners, ...plan.pois.map((p) => p.at)]);
  await b.click(tool('Draw zone'));
  await b.waitFor(`!!document.querySelector('${tool('Draw zone')}.on')`, 'Draw zone to light up');
  const [first, ...rest] = plan.zone.corners;
  await clickPlace(b, first, 'corner 1 of the zone');
  for (const [k, corner] of rest.slice(0, -1).entries()) {
    await clickPlace(b, corner, `corner ${k + 2} of the zone`);
  }
  // The pointer over the last corner shows the line on to it before it is clicked.
  const last = await toScreen(b, rest.at(-1));
  await b.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: last.x, y: last.y });
  await sleep(300);
  await extraShot('11-drawing-zone');
  await clickPlace(b, rest.at(-1), `corner ${plan.zone.corners.length} of the zone`);
  await clickPlace(b, first, 'the first corner again, to close the outline');
  await b.waitFor(nameBoxShown, 'the name box over the closed outline');
  const top = Math.max(...plan.zone.corners.map((c) => c[1]));
  const lons = plan.zone.corners.map((c) => c[0]);
  await checkNameBox(b, [(Math.min(...lons) + Math.max(...lons)) / 2, top], 'the zone');
  await sleep(200);
  await extraShot('12-naming-zone');
  await b.typeText(plan.zone.name);
  await b.pressKey('Enter', 'Enter', 13);
  await b.waitFor(
    `[...document.querySelectorAll('.analysis-place')].some((li) => li.textContent.includes(${JSON.stringify(plan.zone.name)}) && li.querySelector('input[type=radio]')?.checked)`,
    `the zone ${plan.zone.name} saved and picked`,
  );
  const zone = (await api('/api/analysis/zones')).find((z) => z.name === plan.zone.name);
  made.zones.push(zone.id);
  plan.zone.corners.forEach((corner, k) =>
    assert.ok(near(zone.ring[k], corner), `corner ${k + 1} landed at ${zone.ring[k]}`),
  );
  assert.equal(await b.js(nameBoxShown), false, 'the name box stays open after saving');
  await sleep(300);
  await shot('zone');
  return zone;
}

/** Step 2: places each point of interest with the pin tool and names it in the name box. */
export async function placePois(b, { plan, api, made, shot, extraShot }) {
  for (const [k, poi] of plan.pois.entries()) {
    await b.click(tool('Place point of interest'));
    await clickPlace(b, poi.at, poi.name);
    await b.waitFor(nameBoxShown, `the name box over ${poi.name}`);
    await checkNameBox(b, poi.at, poi.name);
    await b.typeText(poi.name);
    if (k === 0) await extraShot('13-naming-point');
    await b.pressKey('Enter', 'Enter', 13);
    await b.waitFor(
      `[...document.querySelectorAll('.analysis-place')].some((li) => li.textContent.includes(${JSON.stringify(poi.name)}) && li.querySelector('input[type=checkbox]')?.checked)`,
      `${poi.name} saved and ticked`,
    );
    const saved = (await api('/api/analysis/pois')).find((p) => p.name === poi.name);
    made.pois.push(saved.id);
    assert.ok(
      near([saved.lon, saved.lat], poi.at),
      `${poi.name} landed at ${saved.lon}, ${saved.lat}`,
    );
  }
  await sleep(300);
  await shot('pois');
}

/** Picks a basemap from the picker and waits for the map to come back. */
async function pickBasemap(b, name) {
  await b.click('.basemap-button');
  await b.click('.basemap-item', name);
  await b.waitFor(
    `document.querySelector('.basemap-button')?.getAttribute('aria-label')?.startsWith('Basemap: ${name}')`,
    `the basemap to be ${name}`,
  );
  await b.waitFor(b.inApp('return mapView.bounds !== null;'), 'the map to load again', 30_000);
  // The tiles of the new basemap take a moment to arrive.
  await sleep(3000);
}

/** The basemap picker: Streets and Satellite under the zone and pins, then back to Dark. */
export async function switchBasemaps(b, { extraShot }) {
  await pickBasemap(b, 'Streets');
  await extraShot('09-basemap-streets');
  await pickBasemap(b, 'Satellite');
  await extraShot('10-basemap-satellite');
  await pickBasemap(b, 'Dark');
}

/**
 * Drags a corner of the saved zone outwards and checks the API has the new outline, then drags
 * it back; drags a pin away and back, checking the API each time.
 */
export async function dragPlaces(b, { plan, api, zone, extraShot }) {
  const corner = zone.ring[1];
  const out = [corner[0] + 0.004, corner[1] + 0.003];
  await dragPlace(b, corner, out);
  const moved = await waitForApi(api, `/api/analysis/zones`, (zs) => {
    const z = zs.find((x) => x.id === zone.id);
    return z && near(z.ring[1], out) && z;
  });
  assert.equal(moved.ring.length, zone.ring.length, 'a corner drag added a corner');
  await sleep(300);
  await extraShot('14-reshape-zone');
  await dragPlace(b, out, corner);
  await waitForApi(api, '/api/analysis/zones', (zs) =>
    near(zs.find((x) => x.id === zone.id).ring[1], corner),
  );

  const pin = plan.pois[0];
  const away = [pin.at[0] - 0.003, pin.at[1] - 0.002];
  await dragPlace(b, pin.at, away);
  await waitForApi(api, '/api/analysis/pois', (ps) => {
    const p = ps.find((x) => x.name === pin.name);
    return near([p.lon, p.lat], away);
  });
  await dragPlace(b, away, pin.at);
  await waitForApi(api, '/api/analysis/pois', (ps) => {
    const p = ps.find((x) => x.name === pin.name);
    return near([p.lon, p.lat], pin.at);
  });
}

/** Polls an API read until `ok` gives a truthy answer. */
async function waitForApi(api, url, ok, timeout = 10_000) {
  const started = Date.now();
  for (;;) {
    const answer = ok(await api(url));
    if (answer) return answer;
    assert.ok(Date.now() - started < timeout, `${url} did not change as dragged`);
    await sleep(200);
  }
}
