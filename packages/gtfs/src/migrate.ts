// Brings a database up to date by running each numbered migration (packages/gtfs/sql/migrations)
// that it has not had yet, once. The database side is behind MigrationStore, so that the rules
// here can be tested without one; the Postgres store is in db.ts.

/** One numbered migration file: `0002_add_thing.sql` has version `0002`, name `0002_add_thing`. */
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
}

/** What the runner needs from a database. */
export interface MigrationStore {
  /** Makes the schema_migrations table if it is missing, and returns the versions it records. */
  start(): Promise<ReadonlySet<string>>;
  /**
   * Runs one migration and records it, in one transaction. Returns false, running nothing, when
   * the version is already recorded (another process got there first).
   */
  apply(migration: Migration): Promise<boolean>;
}

/**
 * Runs, in number order, each migration the store has not recorded, and returns the versions it
 * ran. A database made before numbered migrations has no records, so it runs 0001 like a fresh
 * one: 0001 is idempotent, so this changes nothing on today's schema and brings an older one
 * (an old backup, say) level with a fresh database.
 */
export async function runMigrations(
  store: MigrationStore,
  migrations: readonly Migration[],
): Promise<string[]> {
  const ordered = [...migrations].sort((a, b) => a.version.localeCompare(b.version));
  for (let i = 1; i < ordered.length; i++) {
    const [before, after] = [ordered[i - 1], ordered[i]];
    if (before && after && before.version === after.version) {
      throw new Error(
        `Two migrations are numbered ${after.version}: ${before.name}, ${after.name}`,
      );
    }
  }

  const recorded = await store.start();
  const ran: string[] = [];
  for (const migration of ordered) {
    if (recorded.has(migration.version)) continue;
    if (await applyNamed(store, migration)) ran.push(migration.version);
  }
  return ran;
}

/** Applies one migration, naming its file in the error if it fails. */
async function applyNamed(store: MigrationStore, migration: Migration): Promise<boolean> {
  try {
    return await store.apply(migration);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Migration ${migration.name} failed: ${message}`, { cause: err });
  }
}
