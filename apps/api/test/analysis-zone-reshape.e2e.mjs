// End-to-end check of reshaping a saved zone (FR-4): a zone's PATCH takes a new outline (`ring`),
// with or without a new name, checked by the same rules as a new zone, and a name alone still
// renames it. An analysis already made keeps its own copy of the outline (D25). Run by
// analysis.e2e.mjs, which `npm run test:e2e:fixture` runs.
import assert from 'node:assert/strict';
import { get, placesFor, send, step } from './analysis-e2e-client.mjs';

const zones = '/api/analysis/zones';
const square = [
  [151.2, -33.9],
  [151.21, -33.9],
  [151.21, -33.89],
  [151.2, -33.89],
];
const pulled = [square[0], square[1], [151.215, -33.885], square[3]];

/** Expects a 400 whose message contains `words`. */
const refused = (answer, words, what) => {
  assert.equal(answer.status, 400, `${what}: ${JSON.stringify(answer.body)}`);
  assert.ok(answer.body.message.includes(words), `${what}: ${answer.body.message}`);
};

const made = await send('POST', zones, { name: 'e2e reshape', ring: square });
assert.equal(made.status, 200, JSON.stringify(made.body));
const id = made.body.id;
try {
  const reshaped = await send('PATCH', `${zones}/${id}`, { ring: pulled });
  assert.equal(reshaped.status, 200, JSON.stringify(reshaped.body));
  assert.deepEqual(reshaped.body.ring, pulled);
  assert.equal(reshaped.body.name, 'e2e reshape', 'a new outline alone keeps the name');
  assert.deepEqual((await get(zones)).find((z) => z.id === id).ring, pulled);
  step('a zone is reshaped by a PATCH with a new outline');

  const added = [...pulled, [151.195, -33.895]];
  const both = await send('PATCH', `${zones}/${id}`, { name: 'e2e reshaped', ring: added });
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.deepEqual(both.body.ring, added);
  assert.equal(both.body.name, 'e2e reshaped');
  step('a zone is renamed and reshaped at once');

  const closedRing = await send('PATCH', `${zones}/${id}`, { ring: [...square, square[0]] });
  assert.equal(closedRing.status, 200, JSON.stringify(closedRing.body));
  assert.deepEqual(closedRing.body.ring, square, 'a closed outline is stored open');

  const renamed = await send('PATCH', `${zones}/${id}`, { name: 'e2e name only' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.name, 'e2e name only');
  assert.deepEqual(renamed.body.ring, square, 'a name alone keeps the outline');
  step('a name alone still renames a zone, keeping its outline');

  const bowTie = [square[0], square[2], square[1], square[3]];
  refused(await send('PATCH', `${zones}/${id}`, { ring: bowTie }), 'crosses itself', 'bow tie');
  refused(await send('PATCH', `${zones}/${id}`, { ring: 'square' }), 'corners', 'ring not a list');
  refused(
    await send('PATCH', `${zones}/${id}`, { ring: [square[0], square[1]] }),
    'at least 3 corners',
    'two corners',
  );
  refused(
    await send('PATCH', `${zones}/${id}`, { ring: [...square.slice(0, 3), [200, -33.89]] }),
    'longitude',
    'corner off the map',
  );
  refused(
    await send('PATCH', `${zones}/${id}`, { name: '  ', ring: pulled }),
    'name',
    'blank name with an outline',
  );
  refused(await send('PATCH', `${zones}/${id}`, {}), 'name', 'nothing to change');
  const after = (await get(zones)).find((z) => z.id === id);
  assert.deepEqual(after.ring, square, 'a refused outline leaves the zone as it was');
  assert.equal(after.name, 'e2e name only');
  assert.equal((await send('PATCH', `${zones}/999999`, { ring: pulled })).status, 404);
  step('bad outlines in a PATCH are 400s with plain-English messages');
} finally {
  await send('DELETE', `${zones}/${id}`);
}

// An analysis copies its zone when it is made (D25): reshaping the zone later changes none.
const places = await placesFor(151.3, -33.95, { spacingM: 500 });
let analysisId = null;
try {
  const answer = await send('POST', '/api/analyses', places.body);
  assert.equal(answer.status, 202, JSON.stringify(answer.body));
  analysisId = answer.body.id;
  const before = (await get(`/api/analyses/${analysisId}`)).zone;
  assert.deepEqual(before.ring, places.ring);
  const smaller = places.ring.map(([lon, lat], k) =>
    k === 2 ? [lon - 0.005, lat - 0.005] : [lon, lat],
  );
  const moved = await send('PATCH', `${zones}/${places.body.zoneId}`, { ring: smaller });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const kept = (await get(`/api/analyses/${analysisId}`)).zone;
  assert.deepEqual(kept.ring, places.ring, "the analysis keeps the zone's old outline");
  assert.equal(kept.hash, before.hash);
  step('reshaping a zone changes no analysis already made from it (D25)');
} finally {
  if (analysisId !== null) await send('DELETE', `/api/analyses/${analysisId}`);
  await places.remove();
}
