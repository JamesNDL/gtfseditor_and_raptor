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
  /** Versions another process records between start() and apply(), as if it ran them first. */
  readonly takenByOthers: Set<string>;
  /** A version whose SQL fails. */
  readonly failing: string | undefined;

  constructor(
    options: {
      recorded?: string[];
      takenByOthers?: string[];
      failing?: string;
    } = {},
  ) {
    this.recorded = new Set(options.recorded ?? []);
    this.takenByOthers = new Set(options.takenByOthers ?? []);
    this.failing = options.failing;
  }

  async start(): Promise<ReadonlySet<string>> {
    this.log.push('start');
    return new Set(this.recorded);
  }

  async apply(m: Migration): Promise<boolean> {
    if (this.takenByOthers.has(m.version)) {
      this.recorded.add(m.version);
      this.log.push(`skip ${m.version}`);
      return false;
    }
    if (m.version === this.failing) throw new Error(`column "no_such_column" does not exist`);
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
    expect(store.log).toEqual(['start', 'apply 0001', 'apply 0002', 'apply 0003']);
  });

  it('runs nothing on a second start', async () => {
    const store = new FakeStore();
    const all = [migration('0001'), migration('0002')];
    await runMigrations(store, all);
    store.log.length = 0;
    expect(await runMigrations(store, all)).toEqual([]);
    expect(store.log).toEqual(['start']);
  });

  it('runs 0001 once on a database with nothing recorded, so an old database is brought level', async () => {
    // AC3 as amended on 25 Nov 2026: an old database (tables, no records) takes the same path
    // as a fresh one. 0001 is idempotent, so running it on today's schema changes nothing.
    const store = new FakeStore();
    expect(await runMigrations(store, [migration('0001')])).toEqual(['0001']);
    expect(store.log).toEqual(['start', 'apply 0001']);
    expect([...store.recorded]).toEqual(['0001']);
  });

  it('runs only the migrations not yet recorded', async () => {
    const store = new FakeStore({ recorded: ['0001'] });
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
    expect(store.log).toEqual(['start', 'skip 0001', 'apply 0002']);
  });

  it('stops at a failing migration and runs none after it', async () => {
    const store = new FakeStore({ failing: '0002' });
    await expect(
      runMigrations(store, [migration('0001'), migration('0002'), migration('0003')]),
    ).rejects.toThrow();
    expect(store.log).toEqual(['start', 'apply 0001']);
    expect([...store.recorded]).toEqual(['0001']);
  });

  it('names the failing migration in the error, with the original message', async () => {
    const store = new FakeStore({ failing: '0002' });
    await expect(runMigrations(store, [migration('0001'), migration('0002')])).rejects.toThrow(
      'Migration 0002_step failed: column "no_such_column" does not exist',
    );
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
