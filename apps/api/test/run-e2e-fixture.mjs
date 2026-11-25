// Runs the scenario e2e suite against the small test feed, with no real data and no dev servers:
// makes a throwaway database, imports packages/gtfs/test/fixtures/mini-feed into it, starts an API
// of its own on a spare port, runs scenarios.e2e.mjs against it, and then always stops the API,
// drops the database and removes the temporary folder (also on Ctrl+C).
// On the way it checks that the packs went to PACKS_DIR, and that re-importing a day that has a
// scenario is refused and keeps the scenario.
// Usage: npm run test:e2e:fixture   (needs only the database container: npm run db:up)
// Settings: E2E_PORT (default 3101), E2E_DB (default gtfs_e2e), E2E_ADMIN_URL (a database to
// connect to while creating and dropping it; default the editor's Postgres on port 5433).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FEED = path.join(ROOT, 'packages/gtfs/test/fixtures/mini-feed');
const IMPORTER = 'packages/gtfs/src/cli/import.ts';
const PORT = Number(process.env.E2E_PORT ?? 3101);
const DB = process.env.E2E_DB ?? 'gtfs_e2e';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'postgres://gtfs:gtfs@localhost:5433/postgres';
if (!/^gtfs_(e2e|t3_)[a-z0-9_]*$/.test(DB) || DB === 'gtfs_editor')
  throw new Error(`E2E_DB must be a throwaway database (gtfs_e2e...), not ${DB}`);
const API = `http://localhost:${PORT}`;
const databaseUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB}`;
  return url.toString();
})();

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const say = (message) => console.log(`[fixture ${elapsed()}] ${message}`);

/** The environment the importer and the API run with: this database and folders, no routing server. */
function envFor(tmp) {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    FEED_PATH: FEED,
    PACKS_DIR: path.join(tmp, 'packs'),
    // The suite's export check writes here, not into the checkout's data/exports.
    EXPORTS_DIR: path.join(tmp, 'exports'),
  };
  // No road routing server, so the run is the same everywhere; the suite allows for its absence.
  delete env.ROUTER_URL;
  delete env.API_KEY;
  return env;
}

/** Runs a Node script to the end, passing its output through. Resolves with its exit code and output. */
function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const [from, to] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      from.on('data', (chunk) => {
        output += chunk;
        to.write(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
  });
}

/** Whether a process with this id is still running. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Removes temp folders left by earlier runs that were killed before they could clean up. */
async function removeStaleFolders() {
  for (const name of await readdir(os.tmpdir())) {
    // gtfs-e2e-<pid>-*: this script's folders; gtfs-e2e-packs-*: from before it named them by pid.
    const match = /^gtfs-e2e-(?:packs-|(\d+)-)/.exec(name);
    if (!match || (match[1] && alive(Number(match[1])))) continue;
    say(`removing ${name}, left by an earlier run`);
    await rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
}

/** Fails unless every imported baseline has its packs under PACKS_DIR (issue I5). */
async function checkPacks(packsDir) {
  const db = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const baselines = await db`select id from baselines`;
    if (baselines.length === 0) throw new Error('the import made no baseline');
    for (const { id } of baselines) {
      const files = await readdir(path.join(packsDir, String(id))).catch(() => []);
      if (files.length === 0) {
        throw new Error(`no packs for baseline ${id} in PACKS_DIR (${packsDir})`);
      }
    }
  } finally {
    await db.end();
  }
  say('the packs were written to PACKS_DIR');
}

/** Re-importing a day with a scenario on it, without --replace, must be refused and keep it. */
async function checkReimportRefused(env) {
  const [baseline] = await (await fetch(`${API}/api/baselines`)).json();
  const made = await fetch(`${API}/api/scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baselineId: baseline.id, name: 'guard check' }),
  });
  if (!made.ok) throw new Error(`could not make a scenario: ${made.status}`);
  const { id } = await made.json();
  try {
    const date = baseline.serviceDate.replaceAll('-', '');
    say(`re-importing ${date}, which now has a scenario, without --replace`);
    const { code, output } = await run(IMPORTER, [date], env);
    const refusal = `${baseline.serviceDate} has 1 scenario. Re-importing the day deletes it.`;
    if (code !== 1 || !output.includes(refusal)) {
      throw new Error(`re-importing ${date} with a scenario on it was not refused (code ${code})`);
    }
    const kept = await fetch(`${API}/api/scenarios/${id}`);
    if (kept.status !== 200) throw new Error(`the scenario on ${date} is gone (${kept.status})`);
  } finally {
    await fetch(`${API}/api/scenarios/${id}`, { method: 'DELETE' });
  }
  say('the re-import was refused and the scenario kept');
}

async function waitForApi(child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the API stopped with code ${child.exitCode}`);
    try {
      const res = await fetch(`${API}/api/baselines`);
      if (res.ok && (await res.json()).length > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`the API did not answer on ${API} within a minute`);
}

function stopApi(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
let tmp = null;
let api = null;
let failed = true;
let cleaning = null;

/** Stops the API, drops the database and removes the temp folder. Runs once, however often called. */
function cleanUp() {
  cleaning ??= (async () => {
    await stopApi(api);
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
    say('stopped; cleaned up');
    process.exit(1);
  });
}

try {
  // Refuse to run over something already on the port, such as another copy of the API.
  const busy = await fetch(`${API}/api/baselines`).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`something is already listening on ${API}; set E2E_PORT`);
  await removeStaleFolders();

  say(`creating database ${DB}`);
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.unsafe(`create database ${DB}`);
  tmp = await mkdtemp(path.join(os.tmpdir(), `gtfs-e2e-${process.pid}-`));
  const env = envFor(tmp);
  await mkdir(env.PACKS_DIR);

  say('importing the test feed');
  const imported = await run(IMPORTER, [], env);
  if (imported.code !== 0) throw new Error(`the import failed with code ${imported.code}`);
  await checkPacks(env.PACKS_DIR);

  say(`starting the API on ${API}`);
  api = spawn(process.execPath, ['apps/api/src/server.ts'], {
    cwd: ROOT,
    env: { ...env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForApi(api);
  await checkReimportRefused(env);

  say('running the scenario checks');
  const { code } = await run('apps/api/test/scenarios.e2e.mjs', [], { ...env, API });
  failed = code !== 0;
  if (failed) console.error(`[fixture ${elapsed()}] the scenario checks failed (code ${code})`);
} catch (err) {
  console.error(`[fixture ${elapsed()}] ${err?.stack ?? err}`);
} finally {
  await cleanUp();
  say(failed ? 'failed; cleaned up' : 'passed; cleaned up');
}
process.exit(failed ? 1 : 0);
