// End-to-end check of the access analysis API against a running API (FR-4, FR-5): zones and points
// of interest saved, listed, renamed, moved and deleted, and bad bodies refused with plain-English
// messages; then analysis-runs.e2e.mjs (making and running analyses), analysis-pairs.e2e.mjs (what
// a run stores), analysis-progress.e2e.mjs (progress, cancel and restart) and
// analysis-results.e2e.mjs (the reads behind the results map). Run by
// `npm run test:e2e:fixture`, which passes API, DATABASE_URL and FAKE_ROUTER.
// Usage: node apps/api/test/analysis.e2e.mjs   (needs an API with the 0010 migration run)
import assert from 'node:assert/strict';
import postgres from 'postgres';

const API = process.env.API ?? 'http://localhost:3001';
const get = async (path) => {
  const res = await fetch(API + path);
  assert.equal(res.status, 200, `${path} responded ${res.status}: ${await res.clone().text()}`);
  return res.json();
};
const send = async (method, path, body) => {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const step = (name) => console.log(`ok  ${name}`);

/** Expects a 400 whose message says `words` (a string it must contain, or a pattern). */
const refused = (answer, words, what) => {
  assert.equal(answer.status, 400, `${what}: ${JSON.stringify(answer.body)}`);
  if (typeof words === 'string')
    assert.ok(answer.body.message.includes(words), answer.body.message);
  else assert.match(answer.body.message, words);
};

// ---- the tables (migration 0010) ----------------------------------------------------------------
if (process.env.DATABASE_URL) {
  const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const tables = [
      'analysis_zones',
      'points_of_interest',
      'analyses',
      'analysis_pois',
      'analysis_points',
      'analysis_results',
    ];
    for (const table of tables) {
      const [row] = await db`select to_regclass(${table}) is not null as found`;
      assert.ok(row.found, `table ${table} is missing`);
    }
  } finally {
    await db.end();
  }
  step('the six access analysis tables exist');
}

// ---- zones (FR-4) -------------------------------------------------------------------------------
const square = [
  [151.2, -33.9],
  [151.21, -33.9],
  [151.21, -33.89],
  [151.2, -33.89],
];
const zones = '/api/analysis/zones';
const zonesBefore = (await get(zones)).length;

const made = await send('POST', zones, { name: 'e2e zone b', ring: square });
assert.equal(made.status, 200, JSON.stringify(made.body));
const zone = made.body;
assert.ok(Number.isInteger(zone.id));
assert.equal(zone.name, 'e2e zone b');
assert.deepEqual(zone.ring, square);
assert.ok(!Number.isNaN(Date.parse(zone.createdAt)), 'createdAt is a timestamp');
// A closed ring (first corner repeated at the end) is stored open.
const closed = await send('POST', zones, { name: 'e2e zone a', ring: [...square, square[0]] });
assert.equal(closed.status, 200, JSON.stringify(closed.body));
assert.deepEqual(closed.body.ring, square);
try {
  const listed = await get(zones);
  assert.equal(listed.length, zonesBefore + 2);
  const mine = listed.filter((z) => z.name.startsWith('e2e zone'));
  assert.deepEqual(
    mine.map((z) => z.name),
    ['e2e zone a', 'e2e zone b'],
    'zones are listed by name',
  );
  assert.deepEqual(mine[1], zone);
  step('AC-FR-4.1 a zone made with a name and ring is listed');

  const renamed = await send('PATCH', `${zones}/${zone.id}`, { name: 'e2e zone c' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.name, 'e2e zone c');
  assert.deepEqual(renamed.body.ring, square);
  assert.equal((await get(zones)).find((z) => z.id === zone.id).name, 'e2e zone c');
  refused(await send('PATCH', `${zones}/${zone.id}`, { name: '  ' }), 'name', 'blank rename');
  step('AC-FR-4.1 a zone is renamed');

  // A bow tie: the second and fourth sides cross.
  const bowTie = [square[0], square[1], square[3], square[2]];
  refused(
    await send('POST', zones, { name: 'e2e crossing', ring: bowTie }),
    'The outline crosses itself',
    'crossing ring',
  );
  assert.equal((await get(zones)).length, zonesBefore + 2, 'a refused zone is not stored');
  step('AC-FR-4.2 a crossing ring is a 400 with the reason, and nothing is stored');

  refused(await send('POST', zones, { ring: square }), 'name', 'zone with no name');
  refused(await send('POST', zones, { name: 'e2e', ring: 'square' }), 'corners', 'ring not a list');
  refused(await send('POST', zones, { name: 'e2e' }), 'corners', 'zone with no ring');
  refused(
    await send('POST', zones, { name: 'e2e', ring: [...square.slice(0, 3), [200, -33.89]] }),
    'longitude',
    'corner out of range',
  );
  refused(
    await send('POST', zones, { name: 'e2e', ring: [...square.slice(0, 3), [151.2, -95]] }),
    'latitude',
    'corner out of range',
  );
  refused(
    await send('POST', zones, { name: 'e2e', ring: [square[0], square[1]] }),
    'at least 3 corners',
    'too few corners',
  );
  const many = Array.from({ length: 201 }, (_, k) => {
    const angle = (2 * Math.PI * k) / 201;
    return [151.2 + 0.01 * Math.cos(angle), -33.9 + 0.01 * Math.sin(angle)];
  });
  refused(
    await send('POST', zones, { name: 'e2e', ring: many }),
    'at most 200 corners',
    '201 corners',
  );
  assert.equal((await get(zones)).length, zonesBefore + 2, 'no refused zone is stored');
  step('bad zone bodies are 400s with plain-English messages');

  assert.equal((await send('DELETE', `${zones}/${zone.id}`)).status, 200);
  assert.ok(!(await get(zones)).some((z) => z.id === zone.id), 'the deleted zone is gone');
  assert.equal((await send('DELETE', `${zones}/${zone.id}`)).status, 404);
  assert.equal((await send('PATCH', `${zones}/${zone.id}`, { name: 'x' })).status, 404);
  step('AC-FR-4.1 a zone is deleted');
} finally {
  await send('DELETE', `${zones}/${zone.id}`);
  await send('DELETE', `${zones}/${closed.body.id}`);
}
assert.equal((await get(zones)).length, zonesBefore, 'the test leaves no zones behind');

// ---- points of interest (FR-5) ------------------------------------------------------------------
const pois = '/api/analysis/pois';
const poisBefore = (await get(pois)).length;
const placed = await send('POST', pois, { name: 'e2e hospital', lon: 151.18, lat: -33.88 });
assert.equal(placed.status, 200, JSON.stringify(placed.body));
const poi = placed.body;
assert.ok(Number.isInteger(poi.id));
assert.deepEqual(
  { ...poi, id: 0 },
  { id: 0, name: 'e2e hospital', kind: 'place', source: 'drawn', lon: 151.18, lat: -33.88 },
);
try {
  const listed = await get(pois);
  assert.equal(listed.length, poisBefore + 1);
  assert.deepEqual(
    listed.find((p) => p.id === poi.id),
    poi,
  );
  step('AC-FR-5.1 a point of interest is made and listed');

  const moved = await send('PATCH', `${pois}/${poi.id}`, { lon: 151.19, lat: -33.87 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body, { ...poi, lon: 151.19, lat: -33.87 });
  step('AC-FR-5.1 a point of interest is moved');

  const renamed = await send('PATCH', `${pois}/${poi.id}`, { name: 'e2e school' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(renamed.body, { ...poi, name: 'e2e school', lon: 151.19, lat: -33.87 });
  assert.deepEqual(
    (await get(pois)).find((p) => p.id === poi.id),
    renamed.body,
  );
  step('AC-FR-5.1 a point of interest is renamed');

  refused(await send('POST', pois, { lon: 151.18, lat: -33.88 }), 'name', 'no name');
  refused(await send('POST', pois, { name: 'e2e', lon: 181, lat: -33.88 }), 'longitude', 'lon');
  refused(await send('POST', pois, { name: 'e2e', lon: 151.18, lat: -91 }), 'latitude', 'lat');
  refused(await send('POST', pois, { name: 'e2e', lon: '151', lat: -33.88 }), 'longitude', 'text');
  refused(await send('POST', pois, { name: 'e2e', lat: -33.88 }), 'longitude', 'no lon');
  refused(await send('PATCH', `${pois}/${poi.id}`, { lon: 151.2 }), 'latitude', 'lon alone');
  refused(await send('PATCH', `${pois}/${poi.id}`, { lat: 95, lon: 151.2 }), 'latitude', 'lat');
  refused(await send('PATCH', `${pois}/${poi.id}`, {}), /name|longitude/, 'nothing to change');
  assert.equal((await get(pois)).length, poisBefore + 1, 'no refused point of interest is stored');
  assert.deepEqual(
    (await get(pois)).find((p) => p.id === poi.id),
    renamed.body,
    'a refused change leaves the point of interest as it was',
  );
  step('bad point of interest bodies are 400s with plain-English messages');

  assert.equal((await send('DELETE', `${pois}/${poi.id}`)).status, 200);
  assert.ok(!(await get(pois)).some((p) => p.id === poi.id), 'the deleted point is gone');
  assert.equal((await send('DELETE', `${pois}/${poi.id}`)).status, 404);
  assert.equal((await send('PATCH', `${pois}/${poi.id}`, { name: 'x' })).status, 404);
  step('AC-FR-5.1 a point of interest is deleted');
} finally {
  await send('DELETE', `${pois}/${poi.id}`);
}
assert.equal((await get(pois)).length, poisBefore, 'the test leaves no points of interest behind');

// ---- analyses: made, refused, queued, cancelled and deleted (AA-14) ------------------------------
// In a file of its own to keep each under 300 lines.
await import('./analysis-runs.e2e.mjs');

// ---- runs: what each pair stores, progress, cancel and restart (AA-15) ------------------------
await import('./analysis-pairs.e2e.mjs');
await import('./analysis-progress.e2e.mjs');

// ---- the reads behind the results map (AA-16) ---------------------------------------------------
await import('./analysis-results.e2e.mjs');

console.log('all analysis checks passed');
