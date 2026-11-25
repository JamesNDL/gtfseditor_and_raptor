// Checks that a failed `import --replace` leaves the day and its scenarios as they were (AC-FR-8.1).
// Makes a throwaway database, imports the small test feed (fixtures/mini-feed) into it, adds a
// scenario, then re-imports the day with --replace twice with a fault injected part way: once a bad
// row in staging (the baseline build fails), once a trigger that fails the last step (finish). After
// each, the day and the scenario must be unchanged. A clean --replace must then succeed. Always
// drops the database and removes its temporary folder afterwards, also on Ctrl+C.
// Usage: npm run test:import-replace   (needs only the database container: npm run db:up)
// Settings: IMPORT_TEST_DB (default gtfs_e2e_import), E2E_ADMIN_URL (a database to connect to while
// creating and dropping it; default the editor's Postgres on port 5433).
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FEED = path.join(ROOT, 'packages/gtfs/test/fixtures/mini-feed');
const IMPORTER = 'packages/gtfs/src/cli/import.ts';
const DB = process.env.IMPORT_TEST_DB ?? 'gtfs_e2e_import';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'postgres://gtfs:gtfs@localhost:5433/postgres';
if (!/^gtfs_(e2e|t\d+_)[a-z0-9_]*$/.test(DB) || DB === 'gtfs_editor')
  throw new Error(`IMPORT_TEST_DB must be a throwaway database (gtfs_e2e...), not ${DB}`);
const databaseUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB}`;
  return url.toString();
})();

const started = Date.now();
const say = (message) =>
  console.log(`[import-replace ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`);

/** Runs the importer with these arguments against the throwaway database. Resolves with its exit code. */
function runImport(args, packsDir) {
  const env = { ...process.env, DATABASE_URL: databaseUrl, FEED_PATH: FEED, PACKS_DIR: packsDir };
  delete env.API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [IMPORTER, ...args], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Everything a re-import could lose: the day's baseline, its scenarios and edits, and its timetable. */
async function snapshot(db) {
  const baselines = await db`
    select id, feed_id, service_date::text, ready, stats from baselines order by id`;
  const scenarios = await db`select id, baseline_id, name, head from scenarios order by id`;
  const edits = await db`select scenario_id, seq, kind, summary from scenario_edits order by 1, 2`;
  const [counts] = await db`
    select (select count(*)::int from trips) as trips,
           (select count(*)::int from stop_times) as stop_times,
           (select count(*)::int from routes) as routes,
           (select count(*)::int from stops) as stops,
           (select count(*)::int from patterns) as patterns,
           (select count(*)::int from vehicle_days) as vehicle_days,
           (select count(*)::int from map_lines) as map_lines`;
  return { baselines, scenarios, edits, counts };
}

/** Fails unless the database still matches the snapshot taken before the failed re-import. */
async function expectUnchanged(db, before, fault) {
  const after = await snapshot(db);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)))) {
    console.error('before:', JSON.stringify(before, null, 2));
    console.error('after:', JSON.stringify(after, null, 2));
    throw new Error(`after a failed --replace (${fault}) the day or its scenario changed`);
  }
  say(`after the failed --replace (${fault}) the day and its scenario are as they were`);
}

/** Re-imports the day with --replace while `inject` has broken something; it must fail and change nothing. */
async function failedReplace(db, date, packsDir, fault, inject, undo) {
  const before = await snapshot(db);
  await inject();
  try {
    say(`re-importing ${date} with --replace and a fault: ${fault}`);
    const code = await runImport([date, '--replace'], packsDir);
    if (code === 0) throw new Error(`the --replace with a fault (${fault}) did not fail`);
  } finally {
    await undo();
  }
  await expectUnchanged(db, before, fault);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
let db = null;
let tmp = null;
let failed = true;
let cleaning = null;

/** Drops the database and removes the temp folder. Runs once, however often called. */
function cleanUp() {
  cleaning ??= (async () => {
    if (db) await db.end();
    await admin.unsafe(`drop database if exists ${DB} with (force)`).catch((err) => {
      failed = true;
      console.error(`could not drop ${DB}: ${err.message}`);
    });
    await admin.end();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  })();
  return cleaning;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    say(`stopped (${signal}); cleaning up`);
    await cleanUp();
    process.exit(1);
  });
}

try {
  say(`creating database ${DB}`);
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.unsafe(`create database ${DB}`);
  tmp = await mkdtemp(path.join(os.tmpdir(), `gtfs-import-replace-${process.pid}-`));
  const packsDir = path.join(tmp, 'packs');

  say('importing the test feed');
  if ((await runImport([], packsDir)) !== 0) throw new Error('the first import failed');
  db = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const [baseline] = await db`select id, service_date::text as day from baselines`;
  const date = baseline.day.replaceAll('-', '');

  // A scenario with an edit on the day, which a --replace would delete.
  const [{ id: scenarioId }] = await db`
    insert into scenarios (baseline_id, name, head) values (${baseline.id}, 'kept', 1) returning id`;
  await db`
    insert into scenario_edits (scenario_id, seq, kind, summary)
    values (${scenarioId}, 1, 'shift', 'a made-up edit')`;

  // Fault 1: a stop time whose sequence is not a number. The stop times step fails on it, part
  // way through the baseline build, after the old day has been deleted.
  await failedReplace(
    db,
    date,
    packsDir,
    'a bad row in staging',
    () => db`
      insert into staging.stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence)
      select trip_id, arrival_time, departure_time, stop_id, 'not a number'
      from staging.stop_times limit 1`,
    () => db`delete from staging.stop_times where stop_sequence = 'not a number'`,
  );

  // Fault 2: marking the new baseline ready fails, so everything up to the last step has run.
  await failedReplace(
    db,
    date,
    packsDir,
    'the last step fails',
    () =>
      db.unsafe(`
      create function t13_fault() returns trigger language plpgsql as
        $$ begin raise exception 'fault injected by the test'; end $$;
      create trigger t13_fault before update on baselines
        for each row when (new.ready and not old.ready) execute function t13_fault()`),
    () => db.unsafe(`drop trigger t13_fault on baselines; drop function t13_fault()`),
  );

  say(`re-importing ${date} with --replace and no fault`);
  if ((await runImport([date, '--replace'], packsDir)) !== 0)
    throw new Error('a clean --replace failed');
  const baselines = await db`select id, ready from baselines`;
  const [replaced] = baselines;
  if (baselines.length !== 1 || !replaced.ready || replaced.id === baseline.id)
    throw new Error(`a clean --replace did not leave one new ready baseline`);
  const [{ n }] = await db`select count(*)::int as n from scenarios`;
  if (n !== 0) throw new Error('a clean --replace kept the scenario it should have deleted');
  const packs = await readdir(path.join(packsDir, String(replaced.id))).catch(() => []);
  if (packs.length === 0) throw new Error(`no packs for the new baseline ${replaced.id}`);
  say('a clean --replace replaced the day and wrote its packs');
  failed = false;
} catch (err) {
  console.error(`[import-replace] ${err?.stack ?? err}`);
} finally {
  await cleanUp();
  say(failed ? 'failed; cleaned up' : 'passed; cleaned up');
}
process.exit(failed ? 1 : 0);
