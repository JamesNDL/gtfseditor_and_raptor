// The parts run-access-check.mjs builds its throwaway stack from: running a script to the end,
// starting a server and waiting until it answers, stopping it (with its children, on Windows), the
// database name guard, and reading the day to import from the owner's database without writing to
// it. Not a test itself.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { sleep } from './access-browser.mjs';

/** The owner's dev servers may be on these; the access check never starts or calls anything on them. */
export const OWNER_PORTS = [3001, 3002, 5173];

/**
 * Refuses any database but a throwaway one: gtfs_t<n>_… or gtfs_aa_check, never gtfs_editor
 * (as run-e2e-fixture.mjs refuses).
 */
export function checkDatabaseName(name) {
  if (name === 'gtfs_editor' || !/^gtfs_(t\d+_[a-z0-9_]*|aa_check)$/.test(name)) {
    throw new Error(`the access check only makes throwaway databases, not ${name}`);
  }
}

/** Fails if something already answers on `url`, such as another copy of the stack. */
export async function checkFree(url) {
  const port = Number(new URL(url).port);
  if (OWNER_PORTS.includes(port)) throw new Error(`port ${port} is kept for the owner's servers`);
  const busy = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`something is already listening on ${url}`);
}

/** Runs a Node script to the end with its output shown. Resolves with its exit code. */
export function runScript(root, script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Starts a long-running server: a Node script (`node: [script, ...args]`) or a shell command
 * (`shell: 'npm run router:dev'`). Its output is shown with a prefix.
 */
export function startServer(name, { node, shell, cwd, env }) {
  const child = node
    ? spawn(process.execPath, node, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(shell, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [from, to] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    from.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line) to.write(`[${name}] ${line}\n`);
    });
  }
  return child;
}

/** Waits until `ready()` answers true; fails if the process stops first or after `secs`. */
export async function waitUntil(child, ready, what, secs) {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null)
      throw new Error(`${what} stopped (code ${child.exitCode})`);
    if (await ready().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`${what} did not answer within ${secs} s`);
}

const exec = promisify(execFile);

/** On Windows, the ids of the processes listening on a port. */
async function listeners(port) {
  const { stdout } = await exec('netstat', ['-ano', '-p', 'TCP']);
  const ids = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[3] === 'LISTENING' && cols[1]?.endsWith(`:${port}`))
    .map((cols) => Number(cols[4]));
  return [...new Set(ids)].filter((id) => id > 0);
}

/**
 * Stops a server and what it started. On Windows a shell or npm leaves its children running when
 * killed, so the whole tree goes, and then whatever still listens on `port` (only ever one of the
 * check's own ports: a router run through Gradle is started by the Gradle daemon, not by npm).
 */
export async function stopServer(child, port = null) {
  if (child && child.exitCode === null) {
    const gone = new Promise((resolve) => child.once('exit', resolve));
    if (process.platform === 'win32') {
      await exec('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => {});
    } else {
      child.kill();
    }
    await Promise.race([gone, sleep(5000)]);
  }
  if (port !== null && !OWNER_PORTS.includes(port) && process.platform === 'win32') {
    for (const id of await listeners(port).catch(() => [])) {
      await exec('taskkill', ['/pid', String(id), '/T', '/F']).catch(() => {});
    }
  }
}

/**
 * The day the owner has imported (the newest ready one), read from `databaseUrl` in a read-only
 * transaction, as YYYYMMDD.
 */
export async function ownersServiceDate(databaseUrl) {
  const db = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await db.begin(
      'read only',
      (tx) => tx`
        select to_char(service_date, 'YYYYMMDD') as date from baselines
        where ready order by imported_at desc limit 1`,
    );
    if (rows.length === 0) throw new Error('the editor database has no day imported; give --date');
    return rows[0].date;
  } finally {
    await db.end();
  }
}
