// T-16: reading the numbered migration files from packages/gtfs/sql/migrations.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, readMigrations } from './migration-files.ts';

describe('readMigrations', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gtfs-t16-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const folder = (): URL => pathToFileURL(`${dir}${path.sep}`);

  it('reads the files in number order, with their version, name and text', async () => {
    await writeFile(path.join(dir, '0002_second.sql'), 'select 2;');
    await writeFile(path.join(dir, '0010_tenth.sql'), 'select 10;');
    await writeFile(path.join(dir, '0001_initial.sql'), 'select 1;');
    expect(await readMigrations(folder())).toEqual([
      { version: '0001', name: '0001_initial', sql: 'select 1;' },
      { version: '0002', name: '0002_second', sql: 'select 2;' },
      { version: '0010', name: '0010_tenth', sql: 'select 10;' },
    ]);
  });

  it('ignores files that are not .sql', async () => {
    await writeFile(path.join(dir, '0001_initial.sql'), 'select 1;');
    await writeFile(path.join(dir, 'README.md'), 'notes');
    expect((await readMigrations(folder())).map((m) => m.name)).toEqual(['0001_initial']);
  });

  it('refuses a .sql file not named NNNN_<what>.sql', async () => {
    for (const bad of [
      '1_initial.sql',
      '0002-second.sql',
      '00003_third.sql',
      '0004_.sql',
      'schema.sql',
    ]) {
      await writeFile(path.join(dir, bad), 'select 1;');
      await expect(readMigrations(folder())).rejects.toThrow(bad);
      await rm(path.join(dir, bad));
    }
  });

  it('refuses two files with the same number', async () => {
    await writeFile(path.join(dir, '0002_a.sql'), 'select 1;');
    await writeFile(path.join(dir, '0002_b.sql'), 'select 2;');
    await expect(readMigrations(folder())).rejects.toThrow(/0002/);
  });

  it('finds 0001_initial first in the real folder', async () => {
    const migrations = await readMigrations(MIGRATIONS_DIR);
    expect(migrations[0]?.name).toBe('0001_initial');
    expect(migrations[0]?.sql).toContain('create table if not exists baselines');
  });
});
