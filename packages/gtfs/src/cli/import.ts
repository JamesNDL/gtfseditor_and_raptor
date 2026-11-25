// Imports one or more service days from the current TfNSW feed as baselines.
// Usage: npm run import [-- YYYYMMDD ...] [--replace]   (defaults to the first Tuesday the feed covers)
// A day that already has scenarios is refused unless --replace is given, as re-importing deletes them.
// With several days it is all or nothing: if any is refused, none is imported.
// FEED_PATH=<folder or zip> imports a feed already on disk instead, with no API key.
import { connect, migrate, type Sql } from '../db.ts';
import { ensureFeed, latestCachedFeedId, localFeed, type FeedVersion } from '../feed/feed-cache.ts';
import { importBaseline } from '../import/baseline.ts';
import { finishBaseline } from '../import/finish.ts';
import { buildPacks } from '../import/packs.ts';
import { dateProblem, findRefusals, ReplaceRefusedError } from '../import/replace-guard.ts';
import { stageFeed } from '../import/stage.ts';
import { importVehicleDays } from '../import/vehicle-days.ts';

/** Where the feed comes from: a folder or zip on disk, or the TfNSW download. */
type FeedSource = { kind: 'disk'; path: string } | { kind: 'tfnsw'; apiKey: string };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function chooseSource(): FeedSource {
  const feedPath = process.env.FEED_PATH;
  if (feedPath) return { kind: 'disk', path: feedPath };
  const apiKey = process.env.API_KEY;
  if (apiKey) return { kind: 'tfnsw', apiKey };
  fail(
    'API_KEY is not set. Add it to .env (see .env.example), or set FEED_PATH to a feed on disk.',
  );
}

const source = chooseSource();
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const dates = args.filter((a) => a !== '--replace');
for (const date of dates) {
  const problem = dateProblem(date);
  if (problem) fail(problem);
}
const log = console.log;

/** Prints the refusals for any of `days` that have scenarios on this feed. True if there were any. */
async function refused(sql: Sql, feedId: string, days: string[]): Promise<boolean> {
  if (replace) return false;
  const refusals = await findRefusals(sql, feedId, days);
  for (const r of refusals) console.error(r);
  return refusals.length > 0;
}

/** Fetches (or finds) the feed and stages it. A feed on disk that can't be used is reported plainly. */
async function loadFeed(sql: Sql): Promise<FeedVersion | undefined> {
  if (source.kind === 'tfnsw') {
    const feed = await ensureFeed({ apiKey: source.apiKey, log });
    await stageFeed(sql, feed, log);
    return feed;
  }
  try {
    const feed = await localFeed(source.path, log);
    await stageFeed(sql, feed, log);
    return feed;
  } catch (err) {
    console.error(`Could not use FEED_PATH: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** The first Tuesday the staged feed covers, as YYYYMMDD. */
async function firstTuesday(sql: Sql): Promise<string> {
  const [{ start }] = await sql`select min(start_date) as start from staging.calendar`;
  const d = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Imports the days. Resolves false if they were refused or the feed couldn't be used. */
async function importDays(sql: Sql): Promise<boolean> {
  // Check the named days against the newest downloaded feed before fetching and staging it, so a
  // refusal comes at once. A feed on disk has no id until it is read; it is checked below.
  if (source.kind === 'tfnsw' && dates.length > 0) {
    const cachedId = await latestCachedFeedId();
    if (cachedId && (await refused(sql, cachedId, dates))) return false;
  }

  const feed = await loadFeed(sql);
  if (!feed) return false;
  const days = dates.length > 0 ? dates : [await firstTuesday(sql)];
  // All or nothing: check every day against the feed actually used before importing any.
  if (await refused(sql, feed.id, days)) return false;

  for (const date of days) {
    const started = Date.now();
    log(`Importing ${date} ...`);
    // One transaction per day (FR-8, D12): if any step fails, the old day and its scenarios are
    // kept, and other users see the old day until it commits. importBaseline checks the day
    // again, as the last line of defence.
    const { baseline, stats } = await sql.begin(async (tx) => {
      const baseline = await importBaseline(tx, feed, date, log, { replace });
      await importVehicleDays(tx, baseline.id, log);
      return { baseline, stats: await finishBaseline(tx, baseline.id) };
    });
    // Packs are files, which a rollback could not undo, so they are written after the commit.
    await buildPacks(sql, baseline.id, log);
    log(
      `Baseline ${baseline.id} ready: ${baseline.label} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    log(JSON.stringify(stats, null, 2));
  }
  return true;
}

const sql = connect();
try {
  const ran = await migrate(sql);
  if (ran.length > 0) log(`Ran migrations ${ran.join(', ')}`);
  if (!(await importDays(sql))) process.exitCode = 1;
} catch (err) {
  // A day that gained scenarios between the check above and its import.
  if (!(err instanceof ReplaceRefusedError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
