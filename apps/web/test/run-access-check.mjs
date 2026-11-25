// The access analysis check (docs/architecture/access-analysis.md §8, "The owner's check"): brings
// up a throwaway stack on spare ports (database, API, journey router or the fake router, web) and
// runs access-check.mjs against it in a headless browser, which saves screenshots 01-zone.png to
// 08-legend.png. Then it always stops everything, drops the database and removes the temporary
// folder (also on Ctrl+C), unless --keep.
// Usage:
//   npm run test:access -- --fixture [--out <folder>] [--speed]
//       the small test feed and the fake router (D32): database gtfs_t24_aa, central Sydney.
//   npm run test:access -- [--feed <zip>] [--date YYYYMMDD] (--router-graph <folder> | --router
//       "<command>") [--out <folder>] [--speed] [--keep]
//       real data: database gtfs_aa_check, the feed imported for the day the owner has (read from
//       gtfs_editor, read only) unless --date; the real router on 3112 with ROUTER_ROAD_GRAPH,
//       started with --router's command, or `npm run router:dev` given only --router-graph.
//   npm run test:access -- --use-running [--fixture]
//       drives a stack already running at APP and API (defaults: 5183 and 3111).
// --out defaults to data/ui-test/access/. --speed also times 5,000 × 3 through the API (NFR-1).
// Ports: API 3111 (API_PUBLIC_URL http://localhost:3111), router 3112, web 5183, fake router any.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { startFakeRouter } from '../../api/test/fake-router.mjs';
import {
  checkDatabaseName,
  checkFree,
  ownersServiceDate,
  runScript,
  startServer,
  stopServer,
  waitUntil,
} from './access-stack.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const { values: opts } = parseArgs({
  options: {
    fixture: { type: 'boolean', default: false },
    'use-running': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(ROOT, 'data/ui-test/access') },
    feed: { type: 'string' },
    date: { type: 'string' },
    router: { type: 'string' },
    'router-graph': { type: 'string' },
    speed: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const PG = 'postgres://gtfs:gtfs@localhost:5433';
const DB = opts.fixture ? 'gtfs_t24_aa' : 'gtfs_aa_check';
const API_PORT = 3111;
const ROUTER_PORT = 3112;
const WEB_PORT = 5183;
const API = `http://localhost:${API_PORT}`;
const APP = `http://localhost:${WEB_PORT}`;
const ROUTER = `http://localhost:${ROUTER_PORT}`;
checkDatabaseName(DB);
// Real mode's choices are checked before anything is made, so a mistake costs no import.
if (!opts.fixture && !opts['use-running']) {
  if (!opts.router && !opts['router-graph']) {
    throw new Error(
      'real mode needs --router-graph <folder> or --router "<command>"; or --fixture',
    );
  }
  if (opts.date && !/^\d{8}$/.test(opts.date)) throw new Error('--date is YYYYMMDD');
}
const databaseUrl = `${PG}/${DB}`;

const started = Date.now();
const say = (words) =>
  console.log(`[access ${((Date.now() - started) / 1000).toFixed(0)}s] ${words}`);

/** The check's own settings for access-check.mjs. */
const checkEnv = (app, api, fakeRouter) => ({
  ...process.env,
  APP: app,
  API: api,
  OUT: path.resolve(opts.out),
  PLACES: opts.fixture ? 'fixture' : 'real',
  SPEED: opts.speed ? '1' : '0',
  KEEP: opts.keep ? '1' : '0',
  ...(fakeRouter && { FAKE_ROUTER: fakeRouter }),
});

if (opts['use-running']) {
  const app = process.env.APP ?? APP;
  const api = process.env.API ?? API;
  say(`driving the stack already running at ${app} and ${api}`);
  const env = checkEnv(app, api, null);
  process.exit(await runScript(ROOT, 'apps/web/test/access-check.mjs', [], env));
}

/** The newest feed zip in data/feeds, when --feed is not given. */
async function newestFeed() {
  const folder = path.join(ROOT, 'data/feeds');
  const zips = (await readdir(folder).catch(() => [])).filter((f) => f.endsWith('.zip')).sort();
  if (zips.length === 0) throw new Error('no feed zip in data/feeds; give --feed');
  return path.join(folder, zips.at(-1));
}

const admin = postgres(`${PG}/postgres`, { max: 1, onnotice: () => {} });
let tmp = null;
let fake = null;
let router = null;
let api = null;
let web = null;
let code = 1;
let cleaning = null;

/** Stops the web, API and routers, drops the database and removes the temp folder; runs once. */
function cleanUp() {
  cleaning ??= (async () => {
    await stopServer(web, WEB_PORT);
    await stopServer(api, API_PORT);
    if (router) await stopServer(router, ROUTER_PORT);
    await fake?.stop();
    if (opts.keep) say(`kept database ${DB} and ${tmp}`);
    else {
      await admin.unsafe(`drop database if exists ${DB} with (force)`).catch((err) => {
        code = 1;
        console.error(`could not drop ${DB}: ${err.message}`);
      });
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    await admin.end();
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

/** Starts the real router on 3112 and waits until it answers with road routing on. */
async function startRouter(env) {
  const graph = opts['router-graph'] && path.resolve(opts['router-graph']);
  const command = opts.router ?? 'npm run router:dev';
  say(`starting the router on ${ROUTER}: ${command}`);
  router = startServer('router', {
    shell: command,
    cwd: ROOT,
    env: {
      ...env,
      ROUTER_PORT: String(ROUTER_PORT),
      ROUTER_DATA: path.join(tmp, 'router'),
      ...(graph && { ROUTER_ROAD_GRAPH: graph }),
    },
  });
  const health = () => fetch(`${ROUTER}/v1/health`).then((r) => (r.ok ? r.json() : null));
  await waitUntil(router, async () => (await health())?.status === 'up', 'the router', 600);
  if (!(await health()).road?.available) throw new Error('the router is up without road routing');
  return ROUTER;
}

try {
  for (const url of [API, APP, ...(opts.fixture ? [] : [ROUTER])]) await checkFree(url);
  tmp = await mkdtemp(path.join(os.tmpdir(), `gtfs-access-${process.pid}-`));
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PACKS_DIR: path.join(tmp, 'packs'),
    EXPORTS_DIR: path.join(tmp, 'exports'),
    API_PUBLIC_URL: API,
  };
  delete env.API_KEY;
  await mkdir(env.PACKS_DIR);
  await mkdir(path.join(tmp, 'router'));

  const feed = opts.fixture
    ? path.join(ROOT, 'packages/gtfs/test/fixtures/mini-feed')
    : path.resolve(opts.feed ?? (await newestFeed()));
  const dates = opts.fixture ? [] : [opts.date ?? (await ownersServiceDate(`${PG}/gtfs_editor`))];
  say(`creating database ${DB}; importing ${feed} ${dates.join(' ')}`);
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.unsafe(`create database ${DB}`);
  const importer = 'packages/gtfs/src/cli/import.ts';
  const imported = await runScript(ROOT, importer, dates, { ...env, FEED_PATH: feed });
  if (imported !== 0) throw new Error(`the import failed with code ${imported}`);

  if (opts.fixture) {
    fake = await startFakeRouter();
    say(`fake router on ${fake.url}`);
  }
  const routerUrl = fake?.url ?? (await startRouter(env));
  env.ROUTER_SERVICE_URL = routerUrl;
  env.ROUTER_URL = routerUrl;

  say(`starting the API on ${API}`);
  api = startServer('api', {
    node: ['apps/api/src/server.ts'],
    cwd: ROOT,
    env: { ...env, PORT: String(API_PORT) },
  });
  await waitUntil(api, () => fetch(`${API}/api/health`).then((r) => r.ok), 'the API', 120);

  say(`starting the web app on ${APP}`);
  web = startServer('web', {
    node: [
      path.join(ROOT, 'node_modules/vite/bin/vite.js'),
      '--port',
      String(WEB_PORT),
      '--strictPort',
    ],
    cwd: path.join(ROOT, 'apps/web'),
    env: { ...env, WEB_PORT: String(WEB_PORT), API_TARGET: `http://127.0.0.1:${API_PORT}` },
  });
  await waitUntil(web, () => fetch(APP).then((r) => r.ok), 'the web app', 120);

  say('running the access check');
  code = await runScript(ROOT, 'apps/web/test/access-check.mjs', [], checkEnv(APP, API, fake?.url));
} catch (err) {
  console.error(`[access] ${err?.stack ?? err}`);
  code = 1;
} finally {
  await cleanUp();
  say(code === 0 ? 'passed; cleaned up' : 'failed; cleaned up');
}
process.exit(code);
