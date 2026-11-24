// Reads the numbered migration files. Each is named NNNN_<what>.sql (four digits, then a short
// lower-case name), and once merged is never edited: a change to the schema is a new file.
import { readdir, readFile } from 'node:fs/promises';
import type { Migration } from './migrate.ts';

/** The folder the migrations live in. */
export const MIGRATIONS_DIR = new URL('../sql/migrations/', import.meta.url);

const NAME = /^(\d{4})_[a-z0-9_]+$/;

/** Reads every .sql file in the folder, in number order. Throws on a badly named file or a reused number. */
export async function readMigrations(dir: URL = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const name = file.slice(0, -'.sql'.length);
    const version = NAME.exec(name)?.[1];
    if (!version) throw new Error(`Migration ${file} is not named NNNN_<what>.sql`);
    const before = migrations.at(-1);
    if (before?.version === version) {
      throw new Error(`Two migrations are numbered ${version}: ${before.name}, ${name}`);
    }
    migrations.push({ version, name, sql: await readFile(new URL(file, dir), 'utf8') });
  }
  return migrations;
}
