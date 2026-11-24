// T-16: numbered migrations, run once each. The runner is tested against a fake store; the
// Postgres store in db.ts is checked by hand and by the fixture e2e run.
import { describe, expect, it } from 'vitest';
import { runMigrations, type Migration, type MigrationStore } from './migrate.ts';

const migration = (version: string): Migration => ({
  version,
  name: `${version}_step`,
  sql: `-- ${version}`,
});

/** A store that keeps everything in memory and logs what was asked of it, in order. */
class FakeStore implements MigrationStore {
  readonly log: string[] = [];
  readonly recorded: Set<string>;
  readonly hasTables: boolean;
  /** Versions another process records between start() and apply(), as if it ran them first. */
  readonly takenByOthers: Set<string>;
  /** A version whose SQL fails. */
  readonly failing: string | undefined;

  constructor(
    options: {
      recorded?: string[];
      hasTables?: boolean;
      takenByOthers?: string[];
      failing?: string;
    } = {},
  ) {
    this.recorded = new Set(options.recorded ?? []);
    this.hasTables = options.hasTables ?? false;
    this.takenByOthers = new Set(options.takenByOthers ?? []);
    this.failing = options.failing;
  }

  async start(): Promise<ReadonlySet<string>> {
    this.log.push('start');
    return new Set(this.recorded);
  }

  async hasInitialTables(): Promise<boolean> {
    this.log.push('hasInitialTables');
    return this.hasTables;
  }

  async mark(version: string): Promise<void> {
    this.log.push(`mark ${version}`);
    this.recorded.add(version);
  }

  async apply(m: Migration): Promise<boolean> {
    if (this.takenByOthers.has(m.version)) {
      this.recorded.add(m.version);
      this.log.push(`skip ${m.version}`);
      return false;
    }
    if (m.version === this.failing) throw new Error(`${m.version} failed`);
    this.log.push(`apply ${m.version}`);
    this.recorded.add(m.version);
    return true;
  }
}

describe('runMigrations', () => {
  it('runs every migration on a fresh database, in number order whatever order it is given', async () => {
    const store = new FakeStore();
    const ran = await runMigrations(store, [
      migration('0003'),
      migration('0001'),
      migration('0002'),
    ]);
    expect(ran).toEqual(['0001', '0002', '0003']);
    expect(store.log).toEqual([
      'start',
      'hasInitialTables',
      'apply 0001',
      'apply 0002',
      'apply 0003',
    ]);
  });

  it('runs nothing on a second start', async () => {
    const store = new FakeStore();
    const all = [migration('0001'), migration('0002')];
    await runMigrations(store, all);
    store.log.length = 0;
    expect(await runMigrations(store, all)).toEqual([]);
    expect(store.log).toEqual(['start']);
  });

  it('marks a database that already has the tables but no records as at 0001, without running it', async () => {
    const store = new FakeStore({ hasTables: true });
    const ran = await runMigrations(store, [migration('0001'), migration('0002')]);
    expect(ran).toEqual(['0002']);
    expect(store.log).toEqual(['start', 'hasInitialTables', 'mark 0001', 'apply 0002']);
  });

  it('marks it at 0001 only, even when that is the only migration', async () => {
    const store = new FakeStore({ hasTables: true });
    expect(await runMigrations(store, [migration('0001')])).toEqual([]);
    expect(store.log).toEqual(['start', 'hasInitialTables', 'mark 0001']);
    expect([...store.recorded]).toEqual(['0001']);
  });

  it('does not look for old tables once anything is recorded', async () => {
    const store = new FakeStore({ recorded: ['0001'], hasTables: true });
    const ran = await runMigrations(store, [
      migration('0001'),
      migration('0002'),
      migration('0003'),
    ]);
    expect(ran).toEqual(['0002', '0003']);
    expect(store.log).toEqual(['start', 'apply 0002', 'apply 0003']);
  });

  it('leaves out a migration another process ran first', async () => {
    const store = new FakeStore({ takenByOthers: ['0001'] });
    const ran = await runMigrations(store, [migration('0001'), migration('0002')]);
    expect(ran).toEqual(['0002']);
    expect(store.log).toEqual(['start', 'hasInitialTables', 'skip 0001', 'apply 0002']);
  });

  it('stops at a failing migration and runs none after it', async () => {
    const store = new FakeStore({ failing: '0002' });
    await expect(
      runMigrations(store, [migration('0001'), migration('0002'), migration('0003')]),
    ).rejects.toThrow('0002 failed');
    expect(store.log).toEqual(['start', 'hasInitialTables', 'apply 0001']);
    expect([...store.recorded]).toEqual(['0001']);
  });

  it('refuses two migrations with the same number', async () => {
    const store = new FakeStore();
    await expect(
      runMigrations(store, [
        migration('0001'),
        { ...migration('0002'), name: '0002_a' },
        { ...migration('0002'), name: '0002_b' },
      ]),
    ).rejects.toThrow(/0002/);
    expect(store.log).toEqual([]);
  });
});
