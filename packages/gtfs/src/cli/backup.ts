// Backs up and restores a whole database, using pg_dump and pg_restore inside the db container.
// The whole database, because scenario rows refer to baseline rows: a partial dump can't be restored alone.
// Usage:
//   npm run db:backup [-- --db <name>]                    writes data/backups/<db>-<YYYYMMDD-HHMMSS>.dump
//   npm run db:restore -- <file> [--db <name>] [--yes]    --yes is needed for gtfs_editor and DATABASE_URL's database
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATABASE_URL } from '../db.ts';

// docker compose finds the db service from the repo root.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const USER = 'gtfs';
// The owner's database: a restore never replaces it without --yes, whatever DATABASE_URL names.
const OWNER_DB = 'gtfs_editor';

const urlDb = decodeURIComponent(
  new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL).pathname.slice(1),
);

function usage(message: string): never {
  console.error(message);
  console.error('Usage: npm run db:backup [-- --db <name>]');
  console.error('       npm run db:restore -- <file> [--db <name>] [--yes]');
  process.exit(1);
}

function checkName(db: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(db))
    usage(`Database names may use only letters, digits and _: ${db}`);
  return db;
}

/** Runs a command in the db container. stdin and stdout may be file streams. */
function inDb(
  command: string[],
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'db', ...command], {
      cwd: ROOT,
      stdio: [io.input ? 'pipe' : 'ignore', 'pipe', 'inherit'],
    });
    let text = '';
    // stdout is always piped (see stdio above), so it is never null here.
    const stdout = child.stdout!;
    if (io.output) stdout.pipe(io.output);
    else stdout.on('data', (d: Buffer) => (text += d.toString()));
    if (io.input && child.stdin) io.input.pipe(child.stdin);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(text);
      else reject(new Error(`${command[0]} in the db container exited with code ${code}`));
    });
  });
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function size(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : bytes >= 1e6
      ? `${(bytes / 1e6).toFixed(1)} MB`
      : `${(bytes / 1e3).toFixed(0)} kB`;
}

/**
 * Dumps the whole database to a new file under data/backups. Never overwrites a file; a failed
 * dump removes its partial file.
 */
async function backup(db: string): Promise<void> {
  const dir = path.join(ROOT, 'data', 'backups');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${db}-${stamp(new Date())}.dump`);
  // 'wx' fails if the file is already there, so an earlier backup is never replaced.
  const handle = await open(file, 'wx').catch((err: unknown) => {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      throw new Error(`${file} already exists, so it was left alone. Try again in a second.`);
    }
    throw err;
  });
  console.log(`Backing up ${db} ...`);
  const out = handle.createWriteStream();
  try {
    await inDb(['pg_dump', '-U', USER, '-Fc', db], { output: out });
    await new Promise((resolve) => out.end(resolve));
  } catch (err) {
    out.destroy();
    await rm(file, { force: true });
    throw err;
  }
  console.log(`Wrote ${file} (${size((await stat(file)).size)})`);
}

/**
 * Restores a dump into `db`, creating the database if it doesn't exist. The restore is one
 * transaction, so if it fails an existing database is left as it was, and a database this run
 * created is dropped again.
 */
async function restore(file: string, db: string, yes: boolean): Promise<void> {
  if ((db === urlDb || db === OWNER_DB) && !yes) {
    const which = db === OWNER_DB ? "the editor's own database" : 'the database DATABASE_URL names';
    usage(
      `${db} is ${which}. Restoring replaces what is in it. ` +
        'Add --yes to go ahead, or use --db to restore into another database.',
    );
  }
  const bytes = await stat(file).then(
    (s) => s.size,
    () => usage(`No such file: ${file}`),
  );
  const found = await inDb([
    'psql',
    '-U',
    USER,
    '-d',
    'postgres',
    '-tAc',
    `select 1 from pg_database where datname = '${db}'`,
  ]);
  const existed = found.trim() === '1';
  try {
    if (!existed) {
      console.log(`Creating database ${db} ...`);
      await inDb(['createdb', '-U', USER, db]);
      await inDb(['psql', '-U', USER, '-d', db, '-c', 'create extension if not exists postgis']);
    }
    console.log(`Restoring ${file} (${size(bytes)}) into ${db} ...`);
    await inDb(
      ['pg_restore', '-U', USER, '-d', db, '--clean', '--if-exists', '--single-transaction'],
      {
        input: createReadStream(file),
      },
    );
  } catch (err) {
    if (existed) console.error(`The restore failed; ${db} is as it was.`);
    else {
      console.error(`The restore failed; dropping ${db}, which this run created.`);
      await inDb(['dropdb', '-U', USER, '--if-exists', db]).catch((dropErr: unknown) =>
        console.error(
          `Could not drop ${db}: ${dropErr instanceof Error ? dropErr.message : String(dropErr)}`,
        ),
      );
    }
    throw err;
  }
  console.log(`Restored into ${db}`);
}
const [command, ...rest] = process.argv.slice(2);
let db: string | undefined;
let yes = false;
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--db') db = rest[++i] ?? usage('--db needs a database name');
  else if (rest[i] === '--yes') yes = true;
  else positional.push(rest[i]);
}
const target = checkName(db ?? urlDb);

try {
  if (command === 'backup' && positional.length === 0) await backup(target);
  else if (command === 'restore' && positional.length === 1)
    await restore(path.resolve(positional[0]), target, yes);
  else usage(`Unexpected arguments: ${[command, ...rest].join(' ')}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
