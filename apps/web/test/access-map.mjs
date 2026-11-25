// Clicking the map at a longitude and latitude, for the access check (access-check.mjs). The app
// keeps no handle on its map that a test can reach, so the check moves the map with the app's own
// fitBounds (the store field the inspector uses), reads back the bounds the map noted when it
// stopped (mapView in sim/sim-api.ts, which the simulation wizard uses), and works out the screen
// point with the Web Mercator projection the map draws with. No test hook in the app is needed.
// Not a test itself.
import { sleep } from './access-browser.mjs';

const mercatorY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** The map's bounds as it last noted them, and where its canvas is on the page. */
const readView = (b) =>
  b.js(
    b.inApp(`
    const canvas = document.querySelector('.maplibregl-canvas')?.getBoundingClientRect();
    if (!canvas || !mapView.bounds) return null;
    return { bounds: mapView.bounds, canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height } };`),
  );

/**
 * Moves the map so that every place in `places` ([lon, lat]) is in view, clear of the panels,
 * and waits until it has stopped.
 */
export async function showPlaces(b, places) {
  const lons = places.map((p) => p[0]);
  const lats = places.map((p) => p[1]);
  const box = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const before = JSON.stringify((await readView(b))?.bounds ?? null);
  await b.js(b.inApp(`useStore.getState().set({ fitBounds: ${JSON.stringify(box)} });`));
  // The map flies there in 0.9 s, then notes its bounds; wait for a change that then holds.
  const started = Date.now();
  let last = before;
  for (;;) {
    await sleep(400);
    const now = JSON.stringify((await readView(b))?.bounds ?? null);
    if (now !== before && now === last) break;
    last = now;
    if (Date.now() - started > 15_000) {
      if (now === before && now !== 'null') break; // already there: fitBounds changed nothing
      throw new Error(`the map did not move to show ${JSON.stringify(box)}`);
    }
  }
}

/** Where a place ([lon, lat]) is on the page, in CSS pixels. */
export async function toScreen(b, [lon, lat]) {
  const view = await readView(b);
  if (!view) throw new Error('the map has not noted where it is looking yet');
  const { bounds, canvas } = view;
  const x = canvas.left + ((lon - bounds.west) / (bounds.east - bounds.west)) * canvas.width;
  const top = mercatorY(bounds.north);
  const y = canvas.top + ((top - mercatorY(lat)) / (top - mercatorY(bounds.south))) * canvas.height;
  return { x, y };
}

/**
 * Clicks the map at a place. Fails, naming `what`, when the place is off the map or a panel
 * covers it, rather than clicking the panel.
 */
export async function clickPlace(b, place, what) {
  const { x, y } = await toScreen(b, place);
  const onMap = await b.js(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    return !!el && !!el.closest('.maplibregl-map') && !el.closest('.maplibregl-ctrl, .panel');
  })()`);
  if (!onMap) {
    throw new Error(`${what} at ${place.join(', ')} is at (${x | 0}, ${y | 0}), not on open map`);
  }
  await b.clickAt(x, y);
  await sleep(250);
}

/** Drags with the mouse from one place on the map to another, in small steps, as a hand would. */
export async function dragPlace(b, from, to) {
  const a = await toScreen(b, from);
  const z = await toScreen(b, to);
  const mouse = (type, x, y, buttons) =>
    b.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  await mouse('mouseMoved', a.x, a.y, 0);
  await mouse('mousePressed', a.x, a.y, 1);
  const steps = 8;
  for (let k = 1; k <= steps; k++) {
    await mouse('mouseMoved', a.x + ((z.x - a.x) * k) / steps, a.y + ((z.y - a.y) * k) / steps, 1);
    await sleep(30);
  }
  await mouse('mouseReleased', z.x, z.y, 0);
  await sleep(300);
}
