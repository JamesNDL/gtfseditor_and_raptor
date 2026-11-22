// Runs the scenario e2e suite against the small test feed, with no real data and no dev servers:
// makes a throwaway database, imports packages/gtfs/test/fixtures/mini-feed into it, starts an API
// of its own on a spare port, runs scenarios.e2e.mjs against it, and then always stops the API,
// drops the database and removes the temporary folder.
// Usage: npm run test:e2e:fixture   (needs only the database container: npm run db:up)
// Settings: E2E_PORT (default 3101), E2E_DB (default gtfs_e2e), E2E_ADMIN_URL (a database to
// connect to while creating and dropping it; default the editor's Postgres on port 5433).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FEED = path.join(ROOT, 'packages/gtfs/test/fixtures/mini-feed');
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
function envFor(packsDir) {
  const env = { ...process.env, DATABASE_URL: databaseUrl, FEED_PATH: FEED, PACKS_DIR: packsDir };
  // No road routing server, so the run is the same everywhere; the suite allows for its absence.
  delete env.ROUTER_URL;
  delete env.API_KEY;
  return env;
}

/** Runs a Node script to the end, passing its output through. Resolves with its exit code. */
function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
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
let packsDir = null;
let api = null;
let failed = true;
try {
  // Refuse to run over something already on the port, such as another copy of the API.
  const busy = await fetch(`${API}/api/baselines`).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`something is already listening on ${API}; set E2E_PORT`);

  say(`creating database ${DB}`);
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.unsafe(`create database ${DB}`);
  packsDir = await mkdtemp(path.join(os.tmpdir(), 'gtfs-e2e-packs-'));
  const env = envFor(packsDir);

  say('importing the test feed');
  const imported = await run('packages/gtfs/src/import-cli.ts', [], env);
  if (imported !== 0) throw new Error(`the import failed with code ${imported}`);

  say(`starting the API on ${API}`);
  api = spawn(process.execPath, ['apps/api/src/server.ts'], {
    cwd: ROOT,
    env: { ...env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForApi(api);

  say('running the scenario checks');
  const code = await run('apps/api/test/scenarios.e2e.mjs', [], { ...env, API });
  failed = code !== 0;
  if (failed) console.error(`[fixture ${elapsed()}] the scenario checks failed (code ${code})`);
} catch (err) {
  console.error(`[fixture ${elapsed()}] ${err?.stack ?? err}`);
} finally {
  await stopApi(api);
  await admin.unsafe(`drop database if exists ${DB} with (force)`).catch((err) => {
    failed = true;
    console.error(`could not drop ${DB}: ${err.message}`);
  });
  await admin.end();
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
  say(failed ? 'failed; cleaned up' : 'passed; cleaned up');
}
process.exit(failed ? 1 : 0);
