// Compares the router's journeys with the TfNSW trip planner's for the same test journeys.
//
//   node services/router/tools/compare-tfnsw.mjs <journeys.jsonl> [--date 20261117] [--report <file>]
//
// <journeys.jsonl> comes from `RouteCli --random <n> --dump <file>`. Each test journey is asked of
// the TfNSW Trip Planner API (key from API_KEY in .env) between the same two positions at the same
// time. The ends are the positions of stops, not the stops: asked for a stop, TfNSW boards only there. Answers are kept in a folder beside the input, so a second run asks nothing again.
// Only stop positions, a date and a time are sent.
//
// The two planners are not expected to agree everywhere: TfNSW has its own walking and interchange
// rules. The report sorts the differences so that each kind can be read and judged.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
let input = null;
let date = '20261117';
let reportFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date') date = args[++i];
  else if (args[i] === '--report') reportFile = args[++i];
  else input = args[i];
}
if (!input) {
  console.error('Usage: node compare-tfnsw.mjs <journeys.jsonl> [--date 20261117] [--report <file>]');
  process.exit(2);
}

const apiKey = (readFileSync('.env', 'utf8').match(/^API_KEY=(.*)$/m)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
if (!apiKey) {
  console.error('No API_KEY in .env');
  process.exit(1);
}

const cases = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const ourTrips = new Set(readFileSync(input + '.trips', 'utf8').split(/\r?\n/).filter(Boolean));
const cacheDir = join(dirname(input), 'tfnsw-' + date);
mkdirSync(cacheDir, { recursive: true });
reportFile ??= input.replace(/\.jsonl$/, '') + '.report.txt';

// Midnight in Sydney at the start of the service day, as a UTC instant.
const dayStart = (() => {
  const utc = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
  const shown = new Date(utc).toLocaleString('sv-SE', { timeZone: 'Australia/Sydney', hour12: false });
  const offsetHours = +shown.slice(11, 13) + (shown.slice(8, 10) === date.slice(6, 8) ? 0 : -24);
  return utc - offsetHours * 3600_000;
})();
const secs = (iso) => Math.round((Date.parse(iso) - dayStart) / 1000);
const clock = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function ask(c) {
  const file = join(cacheDir, `at_${c.from.id}_${c.to.id}_${c.depart}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const query = new URLSearchParams({
    outputFormat: 'rapidJSON', coordOutputFormat: 'EPSG:4326', depArrMacro: 'dep', itdDate: date,
    itdTime: clock(c.depart).replace(':', ''), type_origin: 'coord', name_origin: `${c.from.lon}:${c.from.lat}:EPSG:4326`,
    type_destination: 'coord', name_destination: `${c.to.lon}:${c.to.lat}:EPSG:4326`, calcNumberOfTrips: '6', TfNSWTR: 'true',
    version: '10.2.1.42',
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.transport.nsw.gov.au/v1/tp/trip?' + query, {
      headers: { Authorization: 'apikey ' + apiKey, Accept: 'application/json' },
    });
    if (res.ok) {
      const body = await res.json();
      writeFileSync(file, JSON.stringify(body));
      await sleep(300);
      return body;
    }
    if (attempt === 4 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`TfNSW responded ${res.status} for ${c.from.id} to ${c.to.id}`);
    }
    await sleep(2000 * attempt);
  }
}

const WALK_CLASSES = new Set([99, 100]);

// A TfNSW journey in the same terms as one of ours.
function theirs(journey) {
  const legs = journey.legs.map((leg) => {
    const t = leg.transportation ?? {};
    const walk = WALK_CLASSES.has(t.product?.class);
    return {
      walk,
      from: leg.origin.name,
      fromId: leg.origin.id,
      to: leg.destination.name,
      toId: leg.destination.id,
      depart: secs(leg.origin.departureTimePlanned),
      arrive: secs(leg.destination.arrivalTimePlanned),
      route: walk ? null : (t.disassembledName ?? t.number ?? t.name ?? '?'),
      kind: t.product?.name ?? '',
      trip: walk ? null : (t.properties?.RealtimeTripId ?? null),
      metres: leg.distance ?? null,
    };
  });
  const rides = legs.filter((leg) => !leg.walk);
  return {
    legs,
    depart: legs[0].depart,
    arrive: legs[legs.length - 1].arrive,
    rides: rides.length,
    walkSecs: legs.filter((leg) => leg.walk).reduce((sum, leg) => sum + leg.arrive - leg.depart, 0),
    trips: rides.map((leg) => leg.trip),
  };
}

function oursText(j) {
  const lines = [`    ours (${j.label}): leave ${clock(j.depart)}, arrive ${clock(j.arrive)}, ${j.rides} rides, ${Math.round(j.walkSecs / 60)} min walking`];
  for (const leg of j.legs) {
    lines.push(leg.kind === 'RIDE'
      ? `      ${clock(leg.depart)}-${clock(leg.arrive)} ${leg.mode} ${leg.route}: ${leg.from.name} [${leg.from.id}] to ${leg.to.name} [${leg.to.id}] (trip ${leg.trip})`
      : `      ${clock(leg.depart)}-${clock(leg.arrive)} walk ${leg.metres} m to ${leg.to?.name ?? 'the destination'}`);
  }
  return lines.join('\n');
}

function theirsText(j) {
  const lines = [`    TfNSW: leave ${clock(j.depart)}, arrive ${clock(j.arrive)}, ${j.rides} rides, ${Math.round(j.walkSecs / 60)} min walking`];
  for (const leg of j.legs) {
    lines.push(leg.walk
      ? `      ${clock(leg.depart)}-${clock(leg.arrive)} walk ${leg.metres ?? '?'} m to ${leg.to}`
      : `      ${clock(leg.depart)}-${clock(leg.arrive)} ${leg.kind} ${leg.route}: ${leg.from} [${leg.fromId}] to ${leg.to} [${leg.toId}] (trip ${leg.trip}${leg.trip && !ourTrips.has(leg.trip) ? ', NOT IN OUR TIMETABLE' : ''})`);
  }
  return lines.join('\n');
}

const groups = { same: [], oursEarlier: [], theirsEarlier: [], onlyOurs: [], onlyTheirs: [], neither: [] };
const rows = [];
let asked = 0;
for (const c of cases) {
  let body;
  try {
    body = await ask(c);
  } catch (err) {
    console.error(String(err.message));
    continue;
  }
  if (++asked % 25 === 0) console.error(`${asked} of ${cases.length}`);
  // TfNSW may list a journey that left before the time asked; those are not answers to the question.
  const tf = (body.journeys ?? []).map(theirs).filter((j) => j.depart >= c.depart);
  const tfBest = tf.reduce((best, j) => (!best || j.arrive < best.arrive ? j : best), null);
  const ours = c.journeys[0] ?? null;
  const row = { c, tf, tfBest, ours, recommended: c.journeys[c.recommended] ?? null };
  rows.push(row);
  if (!ours && !tfBest) groups.neither.push(row);
  else if (!ours) groups.onlyTheirs.push(row);
  else if (!tfBest) groups.onlyOurs.push(row);
  else {
    row.diff = ours.arrive - tfBest.arrive; // above 0: TfNSW gets there sooner
    row.sameTrips = c.journeys.some((j) => {
      const mine = j.legs.filter((leg) => leg.kind === 'RIDE' && !leg.stayAboard).map((leg) => leg.trip).join('|');
      return tf.some((t) => t.trips.join('|') === mine);
    });
    row.missingTrips = tfBest.trips.filter((trip) => !trip || !ourTrips.has(trip)).length;
    // What might explain a difference: how tight our tightest change is, and what ours leans on.
    const rides = ours.legs.filter((leg) => leg.kind === 'RIDE');
    row.tightest = Infinity; // seconds between getting off one vehicle and the next leaving
    row.tightestSpare = Infinity; // the same, less our own walking time between the two
    for (let i = 1; i < ours.legs.length; i++) {
      const leg = ours.legs[i];
      if (leg.kind !== 'RIDE' || leg.stayAboard) continue;
      const before = ours.legs[i - 1];
      const off = before.kind === 'RIDE' ? before : ours.legs[i - 2];
      if (!off || off.kind !== 'RIDE') continue;
      row.tightest = Math.min(row.tightest, leg.depart - off.arrive);
      row.tightestSpare = Math.min(row.tightestSpare, leg.depart - before.arrive);
    }
    row.schoolBus = rides.some((leg) => leg.mode === 'school_bus');
    row.theirSchoolBus = tfBest.legs.some((leg) => /school/i.test(leg.kind));
    (Math.abs(row.diff) <= 60 ? groups.same : row.diff < 0 ? groups.oursEarlier : groups.theirsEarlier).push(row);
  }
}

const both = [...groups.same, ...groups.oursEarlier, ...groups.theirsEarlier];
const percent = (n, of) => (of ? `${((100 * n) / of).toFixed(1)}%` : '-');
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const out = [];
out.push(`${rows.length} test journeys from ${input}, service day ${date}`);
out.push(`  both planners answer         ${both.length}`);
out.push(`  only ours answers            ${groups.onlyOurs.length}`);
out.push(`  only TfNSW answers           ${groups.onlyTheirs.length}`);
out.push(`  neither answers              ${groups.neither.length}`);
out.push(`Where both answer: our fastest arrival against the earliest of TfNSW's (up to 6)`);
out.push(`  within a minute              ${groups.same.length} (${percent(groups.same.length, both.length)})`);
out.push(`  ours arrives sooner          ${groups.oursEarlier.length} (${percent(groups.oursEarlier.length, both.length)}), median ${Math.round(median(groups.oursEarlier.map((r) => -r.diff)) / 60)} min sooner`);
out.push(`  TfNSW arrives sooner         ${groups.theirsEarlier.length} (${percent(groups.theirsEarlier.length, both.length)}), median ${Math.round(median(groups.theirsEarlier.map((r) => r.diff)) / 60)} min sooner`);
for (const limit of [5, 10, 20]) {
  out.push(`    TfNSW sooner by over ${String(limit).padStart(2)} min ${groups.theirsEarlier.filter((r) => r.diff > limit * 60).length}`);
}
out.push(`  one of ours uses exactly the vehicles of one of TfNSW's   ${both.filter((r) => r.sameTrips).length} (${percent(both.filter((r) => r.sameTrips).length, both.length)})`);
out.push(`  TfNSW's best uses a trip our timetable lacks              ${both.filter((r) => r.missingTrips > 0).length}`);
out.push(`  rides, on average            ours fastest ${mean(both.map((r) => r.ours.rides)).toFixed(2)}, ours recommended ${mean(both.map((r) => r.recommended.rides)).toFixed(2)}, TfNSW's earliest ${mean(both.map((r) => r.tfBest.rides)).toFixed(2)}`);
out.push(`  walking, on average          ours fastest ${(mean(both.map((r) => r.ours.walkSecs)) / 60).toFixed(1)} min, ours recommended ${(mean(both.map((r) => r.recommended.walkSecs)) / 60).toFixed(1)} min, TfNSW's earliest ${(mean(both.map((r) => r.tfBest.walkSecs)) / 60).toFixed(1)} min`);
{
  // The journey we would suggest against TfNSW's earliest.
  const gaps = both.map((r) => r.recommended.arrive - r.tfBest.arrive);
  const near = gaps.filter((g) => Math.abs(g) <= 60).length;
  const sooner = gaps.filter((g) => g < -60);
  const later = gaps.filter((g) => g > 60);
  const sameAsRecommended = both.filter((r) => {
    const mine = r.recommended.legs.filter((leg) => leg.kind === 'RIDE' && !leg.stayAboard).map((leg) => leg.trip).join('|');
    return r.tf.some((t) => t.trips.join('|') === mine);
  }).length;
  out.push(`Our recommended journey against the earliest of TfNSW's`);
  out.push(`  within a minute              ${near} (${percent(near, both.length)})`);
  out.push(`  ours arrives sooner          ${sooner.length} (${percent(sooner.length, both.length)}), median ${Math.round(median(sooner.map((g) => -g)) / 60)} min sooner`);
  out.push(`  TfNSW arrives sooner         ${later.length} (${percent(later.length, both.length)}), median ${Math.round(median(later) / 60)} min sooner`);
  out.push(`  recommended uses exactly the vehicles of one of TfNSW's   ${sameAsRecommended} (${percent(sameAsRecommended, both.length)})`);
  out.push(`  recommended is the one that walks less                    ${both.filter((r) => r.recommended.label === 'lessWalking').length}`);
}
// Why ours arrives sooner, by the first of these that fits.
const why = { walk: 0, tight: 0, more: 0, school: 0, other: 0 };
for (const r of groups.oursEarlier) {
  if (r.sameTrips) why.walk++;
  else if (r.schoolBus) why.school++;
  else if (r.ours.rides > r.tfBest.rides) why.more++;
  else if (r.tightestSpare < 60) why.tight++;
  else why.other++;
}
out.push(`Where ours arrives sooner (${groups.oursEarlier.length}), the first of these that fits`);
out.push(`  same vehicles as one of TfNSW's; only the walking at the ends differs   ${why.walk}`);
out.push(`  ours rides a school bus                                                ${why.school}`);
out.push(`  ours changes more often than TfNSW's                                   ${why.more}`);
out.push(`  ours makes a change with under a minute to spare after the walk        ${why.tight}`);
out.push(`  none of these                                                          ${why.other}`);
const over5 = groups.oursEarlier.filter((r) => -r.diff > 300);
out.push(`  ours sooner by over 5 min    ${over5.length}, of which same vehicles ${over5.filter((r) => r.sameTrips).length}`);
// How fast TfNSW walks, from its walks of 200 m or more.
const paces = rows.flatMap((r) => r.tf.flatMap((j) => j.legs.filter((leg) => leg.walk && leg.metres >= 200 && leg.arrive > leg.depart).map((leg) => leg.metres / (leg.arrive - leg.depart)))).sort((x, y) => x - y);
if (paces.length) out.push(`TfNSW's walking pace over ${paces.length} walks of 200 m or more: median ${paces[Math.floor(paces.length / 2)].toFixed(2)} m/s along the path (ours: 1.03 m/s along 1.3 times the straight line)`);
console.log(out.join('\n'));

function section(title, list) {
  out.push('', '='.repeat(100), `${title}: ${list.length}`, '='.repeat(100));
  if (list.length && list[0].diff !== undefined) {
    out.push('  min apart | rides ours/TfNSW | walking min ours/TfNSW | our tightest change, s (spare after walking) | school bus ours/TfNSW');
    for (const r of list) {
      out.push(`  ${String(Math.round(Math.abs(r.diff) / 60)).padStart(9)} | ${r.ours.rides}/${r.tfBest.rides} | ${Math.round(r.ours.walkSecs / 60)}/${Math.round(r.tfBest.walkSecs / 60)} | ${Number.isFinite(r.tightest) ? `${r.tightest} (${r.tightestSpare})` : '-'} | ${r.schoolBus ? 'yes' : 'no'}/${r.theirSchoolBus ? 'yes' : 'no'}   ${r.c.from.id} to ${r.c.to.id} at ${clock(r.c.depart)}`);
    }
  }
  for (const r of list) {
    out.push('', `  ${r.c.from.name} [${r.c.from.id}] to ${r.c.to.name} [${r.c.to.id}] at ${clock(r.c.depart)}` + (r.diff === undefined ? '' : `   (${r.diff > 0 ? 'TfNSW' : 'ours'} sooner by ${Math.round(Math.abs(r.diff) / 60)} min)`));
    for (const j of r.c.journeys) out.push(oursText(j));
    if (r.tfBest) out.push(theirsText(r.tfBest));
  }
}
section('TfNSW arrives sooner', groups.theirsEarlier.sort((a, b) => b.diff - a.diff));
section('Ours arrives sooner', groups.oursEarlier.sort((a, b) => a.diff - b.diff));
section('Only TfNSW answers', groups.onlyTheirs);
section('Only ours answers', groups.onlyOurs);
section('Within a minute but different vehicles', groups.same.filter((r) => !r.sameTrips));
writeFileSync(reportFile, out.join('\n') + '\n');
console.log(`Full report: ${reportFile}`);
