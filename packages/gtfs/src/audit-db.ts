// Loads an extracted feed into a DuckDB file so audit queries are fast and repeatable.
import { DuckDBInstance } from '@duckdb/node-api';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function openAuditDb(feedDir: string) {
  const dbPath = path.join(feedDir, '..', path.basename(feedDir) + '.audit.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const db = await instance.connect();
  const existing = new Set(
    (await (await db.run(`select table_name from information_schema.tables`)).getRows()).map((r) => String(r[0])),
  );
  for (const file of await readdir(feedDir)) {
    if (!file.endsWith('.txt')) continue;
    const table = file.replace('.txt', '');
    if (existing.has(table)) continue;
    const csv = path.join(feedDir, file).split(path.sep).join('/').replaceAll("'", "''");
    await db.run(`create table ${table} as select * from read_csv('${csv}', header=true, all_varchar=true)`);
  }
  const query = async (sql: string) => (await db.run(sql)).getRowObjectsJson();
  return { db, query };
}
