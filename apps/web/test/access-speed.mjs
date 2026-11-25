// The speed part of the access check (--speed; NFR-1, AC-NFR-1.1): through the API only, a zone
// of about 7 × 7 km at 100 m (about 4,900 sample points) and three points of interest, run on the
// published day, timed from the request to done, and printed. On the real routers it should take
// under 5 minutes. Answers what it made, so the caller can delete it. Not a test itself.
import { sleep } from './access-browser.mjs';

/** NFR-1: an analysis of 5,000 sample points and 3 points of interest, within 5 minutes. */
const LIMIT_SECS = 5 * 60;

/**
 * Runs the speed check on `baselineId` and prints the time. `send(method, url, body)` calls the
 * API and answers {status, body}. Fails if the run fails or takes over `waitMinutes`.
 */
export async function runSpeedCheck({ send, baselineId, speed, waitMinutes = 15 }) {
  const made = { analyses: [], zones: [], pois: [] };
  const zone = await send('POST', '/api/analysis/zones', {
    name: speed.zone.name,
    ring: speed.zone.corners,
  });
  if (zone.status !== 201 && zone.status !== 200)
    throw new Error(`the speed check's zone was refused: ${JSON.stringify(zone.body)}`);
  made.zones.push(zone.body.id);
  for (const poi of speed.pois) {
    const placed = await send('POST', '/api/analysis/pois', {
      name: poi.name,
      lon: poi.at[0],
      lat: poi.at[1],
    });
    if (placed.status >= 300) throw new Error(`a point of interest was refused: ${placed.status}`);
    made.pois.push(placed.body.id);
  }
  const started = Date.now();
  const created = await send('POST', '/api/analyses', {
    name: 'Access check: speed',
    baselineId,
    scenarioId: null,
    zoneId: zone.body.id,
    poiIds: made.pois,
    settings: { spacingM: speed.spacingM },
  });
  if (created.status !== 202)
    throw new Error(`the speed check's analysis was refused: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  made.analyses.push(id);

  let detail;
  let lastSaid = '';
  for (;;) {
    detail = (await send('GET', `/api/analyses/${id}`)).body;
    if (['done', 'failed', 'cancelled'].includes(detail.state)) break;
    const said = `${detail.state} ${JSON.stringify(detail.progress)}`;
    if (said !== lastSaid) console.log(`    speed: ${said}`);
    lastSaid = said;
    if (Date.now() - started > waitMinutes * 60_000) {
      throw new Error(`the speed check was still ${detail.state} after ${waitMinutes} minutes`);
    }
    await sleep(1000);
  }
  const secs = (Date.now() - started) / 1000;
  if (detail.state !== 'done') {
    throw new Error(`the speed check's analysis ended ${detail.state}: ${detail.error ?? ''}`);
  }
  const pairs = detail.sampleCount * made.pois.length;
  const verdict = secs <= LIMIT_SECS ? 'within' : 'OVER';
  console.log(
    `speed: ${detail.sampleCount.toLocaleString('en-AU')} sample points × ${made.pois.length} ` +
      `points of interest (${pairs.toLocaleString('en-AU')} journeys and drives) in ` +
      `${secs.toFixed(1)} s, ${verdict} the 5 minutes of NFR-1`,
  );
  return { made, secs, sampleCount: detail.sampleCount };
}
