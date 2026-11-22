// Imports one or more service days from the current TfNSW feed as baselines.
// Usage: npm run import [-- YYYYMMDD ...] [--replace]   (defaults to the first Tuesday the feed covers)
// A day that already has scenarios is refused unless --replace is given, as re-importing deletes them.
// FEED_PATH=<folder or zip> imports a feed already on disk instead, with no API key.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, migrate } from './db.ts';
import { ensureFeed, localFeed, type FeedVersion } from './feed-cache.ts';
import {
  countScenariosOnDay,
  finishBaseline,
  importBaseline,
  replaceRefusal,
  ReplaceRefusedError,
} from './import/baseline.ts';
import { buildPacks } from './import/packs.ts';
import { stageFeed } from './import/stage.ts';
import { importVehicleDays } from './import/vehicle-days.ts';

const apiKey = process.env.API_KEY;
const feedPath = process.env.FEED_PATH;
if (!apiKey && !feedPath) {
  console.error(
    'API_KEY is not set. Add it to .env (see .env.example), or set FEED_PATH to a feed on disk.',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const replace = args.includes('--replace');
let dates = args.filter((a) => a !== '--replace');

/** The newest feed already downloaded (the one ensureFeed returns unless TfNSW has published since). */
async function latestCachedFeedId(): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(path.resolve('data/feeds/manifest.json'), 'utf8'),
    ) as { versions: FeedVersion[] };
    return manifest.versions.at(-1)?.id;
  } catch {
    return undefined;
  }
}

const log = console.log;
const sql = connect();
try {
  await migrate(sql);

  // Check the named days before fetching and staging the feed, so a refusal comes at once.
  // importBaseline checks again against the feed actually used.
  // A feed from FEED_PATH has no cached id to check against; importBaseline still checks it.
  const cachedFeedId =
    dates.length > 0 && !replace && !feedPath ? await latestCachedFeedId() : undefined;
  if (cachedFeedId) {
    const refusals: string[] = [];
    for (const date of dates) {
      const n = await countScenariosOnDay(sql, cachedFeedId, date);
      if (n > 0) refusals.push(replaceRefusal(date, n));
    }
    if (refusals.length > 0) {
      for (const r of refusals) console.error(r);
      process.exitCode = 1;
    }
  }

  if (!process.exitCode) {
    const feed = feedPath
      ? await localFeed(feedPath, log)
      : await ensureFeed({ apiKey: apiKey!, log });
    await stageFeed(sql, feed, log);

    if (dates.length === 0) {
      const [{ start }] = await sql`select min(start_date) as start from staging.calendar`;
      const d = new Date(
        `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`,
      );
      while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
      dates = [d.toISOString().slice(0, 10).replaceAll('-', '')];
    }

    for (const date of dates) {
      const started = Date.now();
      log(`Importing ${date} ...`);
      const baseline = await importBaseline(sql, feed, date, log, { replace });
      await importVehicleDays(sql, baseline.id, log);
      await buildPacks(sql, baseline.id, log);
      const stats = await finishBaseline(sql, baseline.id);
      log(
        `Baseline ${baseline.id} ready: ${baseline.label} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      log(JSON.stringify(stats, null, 2));
    }
  }
} catch (err) {
  // A day with scenarios, found only once the feed is known (the default day, or a newer feed).
  if (!(err instanceof ReplaceRefusedError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
