// Imports one or more service days from the current TfNSW feed as baselines.
// Usage: npm run import [-- YYYYMMDD ...]   (defaults to the first Tuesday the feed covers)
import { connect, migrate } from './db.ts';
import { ensureFeed } from './feed-cache.ts';
import { finishBaseline, importBaseline } from './import/baseline.ts';
import { buildPacks } from './import/packs.ts';
import { stageFeed } from './import/stage.ts';
import { importVehicleDays } from './import/vehicle-days.ts';

const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

const log = console.log;
const sql = connect();
try {
  await migrate(sql);
  const feed = await ensureFeed({ apiKey, log });
  await stageFeed(sql, feed, log);

  let dates = process.argv.slice(2);
  if (dates.length === 0) {
    const [{ start }] = await sql`select min(start_date) as start from staging.calendar`;
    const d = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`);
    while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
    dates = [d.toISOString().slice(0, 10).replaceAll('-', '')];
  }

  for (const date of dates) {
    const started = Date.now();
    log(`Importing ${date} ...`);
    const baseline = await importBaseline(sql, feed, date, log);
    await importVehicleDays(sql, baseline.id, log);
    await buildPacks(sql, baseline.id, log);
    const stats = await finishBaseline(sql, baseline.id);
    log(
      `Baseline ${baseline.id} ready: ${baseline.label} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    log(JSON.stringify(stats, null, 2));
  }
} finally {
  await sql.end();
}
