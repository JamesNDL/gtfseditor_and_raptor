// Check of the road router the editor uses (FR-13, NFR-5): sends the three requests exactly as
// apps/api/src/routing/roads.ts builds them (route, table, nearest) to whatever ROUTER_URL names,
// with Newcastle points, and checks the answers have the shape roads.ts reads. Also checks a
// Mayfield to Newcastle city centre drive (AC-FR-1.1), a 100 by 3 table from the router's own
// endpoint (AC-FR-2.1), and that ROUTER_URL names this machine (AC-NFR-5.1).
// Usage: npm run test:roads   (reads ROUTER_URL from .env; needs the journey router with road data)
// Exits 2 when ROUTER_URL is not set, 1 on the first failed check.
import assert from 'node:assert/strict';

const base = process.env.ROUTER_URL;
if (!base) {
  console.error(
    'ROUTER_URL is not set. Point it at the journey router, e.g. http://localhost:3002',
  );
  process.exit(2);
}
const ROUTER = base.replace(/\/$/, '');
const step = (name) => console.log(`ok  ${name}`);

// The same format as roads.ts's listOf: lon,lat with 6 decimals, ';' between. Copied, not imported.
const listOf = (points) => points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');

/** A GET as roads.ts sends it; the answer must be 200 with code "Ok". */
const ask = async (question) => {
  const res = await fetch(`${ROUTER}/${question}`, { signal: AbortSignal.timeout(30_000) });
  const json = await res.json();
  assert.equal(res.status, 200, `${question} responded ${res.status}: ${JSON.stringify(json)}`);
  assert.equal(json.code, 'Ok', `${question}: ${JSON.stringify(json)}`);
  return json;
};

const isPoint = (p) =>
  Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n));

// [lon, lat]
const MAYFIELD = [151.736, -32.897];
const CITY = [151.772, -32.927];
const HAMILTON = [151.747, -32.922];
const MEREWETHER = [151.757, -32.945];
const WICKHAM = [151.757, -32.923];

// ---- the address names this machine (AC-NFR-5.1) -----------------------------------------------
const host = new URL(ROUTER).hostname;
assert.ok(
  ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host),
  `ROUTER_URL must name this machine (localhost, 127.0.0.1 or ::1), not ${host}`,
);
step(`ROUTER_URL names this machine (${host})`);

// ---- route, as askRouter sends it (AC-FR-1.1) ---------------------------------------------------
const routeQuestion = (points, alternatives) =>
  `route/v1/driving/${listOf(points)}?overview=full&geometries=geojson&steps=false${alternatives ? '&alternatives=3' : ''}`;

const checkRoutes = (json, legs) => {
  assert.ok(Array.isArray(json.routes) && json.routes.length >= 1, 'at least one route');
  for (const r of json.routes) {
    assert.equal(typeof r.distance, 'number');
    assert.ok(Array.isArray(r.geometry?.coordinates), 'geometry.coordinates is a list');
    assert.ok(r.geometry.coordinates.length >= 2, 'a path of at least two points');
    assert.ok(r.geometry.coordinates.every(isPoint), 'every path point is [lon, lat]');
    assert.ok(Array.isArray(r.legs) && r.legs.length === legs, `${legs} legs`);
    assert.ok(
      r.legs.every((l) => typeof l.distance === 'number'),
      'every leg has a distance',
    );
  }
};

const drive = await ask(routeQuestion([MAYFIELD, CITY], false));
checkRoutes(drive, 1);
const [first] = drive.routes;
const minutes = first.duration / 60;
assert.ok(minutes >= 5 && minutes <= 20, `Mayfield to the city took ${minutes.toFixed(1)} minutes`);
assert.ok(first.distance > 0, 'the drive has a distance');
assert.ok(
  first.geometry.coordinates.length >= 20,
  `a path along roads, not ${first.geometry.coordinates.length} points`,
);
step(
  `route Mayfield to the city: ${minutes.toFixed(1)} min, ${Math.round(first.distance)} m, ` +
    `${first.geometry.coordinates.length} points`,
);

const throughStops = await ask(routeQuestion([MAYFIELD, HAMILTON, CITY], false));
checkRoutes(throughStops, 2);
step('route through three stops has a leg between each');

const alternatives = await ask(routeQuestion([MAYFIELD, CITY], true));
checkRoutes(alternatives, 1);
assert.ok(alternatives.routes.length <= 3, 'no more than 3 routes');
step(`route with alternatives=3: ${alternatives.routes.length} route(s)`);

// ---- table, as askTable sends it ----------------------------------------------------------------
const tablePoints = [MAYFIELD, CITY, HAMILTON, MEREWETHER, WICKHAM];
const table = await ask(`table/v1/driving/${listOf(tablePoints)}?annotations=distance`);
assert.ok(Array.isArray(table.distances) && table.distances.length === 5, '5 rows');
for (const row of table.distances) {
  assert.ok(Array.isArray(row) && row.length === 5, '5 columns');
  assert.ok(
    row.every((d) => d === null || typeof d === 'number'),
    'each a number or null',
  );
}
assert.ok(typeof table.distances[0][1] === 'number' && table.distances[0][1] > 0);
step('table of 5 points: 5 by 5 distances');

// ---- nearest, as nearestRoad sends it -----------------------------------------------------------
const nearest = await ask(
  `nearest/v1/driving/${MAYFIELD[0].toFixed(6)},${MAYFIELD[1].toFixed(6)}?number=1`,
);
assert.ok(Array.isArray(nearest.waypoints) && nearest.waypoints.length >= 1, 'a waypoint');
const snapped = nearest.waypoints[0].location;
assert.ok(isPoint(snapped), 'location is [lon, lat]');
assert.ok(
  Math.abs(snapped[0] - MAYFIELD[0]) < 0.01 && Math.abs(snapped[1] - MAYFIELD[1]) < 0.01,
  `the nearest road is near Mayfield, not at ${snapped}`,
);
step(`nearest road to Mayfield: ${snapped.map((n) => n.toFixed(5)).join(', ')}`);

// ---- many drives at once from the router's own endpoint (AC-FR-2.1) ----------------------------
// 100 starting points on a 10 by 10 grid round Mayfield, about 200 m apart.
const sources = [];
for (let i = 0; i < 10; i++)
  for (let j = 0; j < 10; j++)
    sources.push({ lat: MAYFIELD[1] + (i - 4.5) * 0.0018, lon: MAYFIELD[0] + (j - 4.5) * 0.0021 });
const destinations = [CITY, HAMILTON, MEREWETHER].map(([lon, lat]) => ({ lat, lon }));
const res = await fetch(`${ROUTER}/v1/road/table`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sources, destinations, profile: 'car' }),
  signal: AbortSignal.timeout(60_000),
});
const many = await res.json();
assert.equal(
  res.status,
  200,
  `POST /v1/road/table responded ${res.status}: ${JSON.stringify(many)}`,
);
for (const field of ['durationsSecs', 'metres']) {
  const grid = many[field];
  assert.ok(Array.isArray(grid) && grid.length === 100, `${field}: 100 rows`);
  assert.ok(
    grid.every((row) => Array.isArray(row) && row.length === 3),
    `${field}: 3 columns`,
  );
  const values = grid.flat();
  assert.equal(values.length, 300, `${field}: 300 values`);
  assert.ok(
    values.every((v) => v === null || typeof v === 'number'),
    `${field}: numbers or null`,
  );
}
const answered = many.durationsSecs.flat().filter((v) => v !== null).length;
assert.ok(answered > 0, 'some of the 300 drives have a time');
step(`POST /v1/road/table 100 by 3: 300 values, ${answered} with a time`);
