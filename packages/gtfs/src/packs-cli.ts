// Rebuilds the animation packs for existing baselines. Usage: npm run packs [-- baselineId ...]
import { connect } from './db.ts';
import { buildPacks } from './import/packs.ts';

const sql = connect();
try {
  const ids = process.argv.slice(2).map(Number);
  const baselines = ids.length
    ? ids
    : (await sql`select id from baselines where ready order by id`).map((r) => r.id);
  for (const id of baselines) {
    console.log(`Building packs for baseline ${id} ...`);
    await buildPacks(sql, id, console.log);
  }
} finally {
  await sql.end();
}
