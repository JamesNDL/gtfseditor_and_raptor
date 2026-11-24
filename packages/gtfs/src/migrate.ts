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
  /** Whether the database already has the tables the first migration makes. */
  hasInitialTables(): Promise<boolean>;
  /** Records a version as applied without running it. */
  mark(version: string): Promise<void>;
  /**
   * Runs one migration and records it, in one transaction. Returns false, running nothing, when
   * the version is already recorded (another process got there first).
   */
  apply(migration: Migration): Promise<boolean>;
}

/** The migration that holds the schema as it was before numbered migrations. */
export const INITIAL_VERSION = '0001';

/**
 * Runs, in number order, each migration the store has not recorded, and returns the versions it
 * ran. A database made before numbered migrations has the tables but no records: it is marked as
 * at 0001 without running it, since everything in 0001 was already run on it at every start.
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

  const recorded = new Set(await store.start());
  if (recorded.size === 0 && (await store.hasInitialTables())) {
    await store.mark(INITIAL_VERSION);
    recorded.add(INITIAL_VERSION);
  }

  const ran: string[] = [];
  for (const migration of ordered) {
    if (recorded.has(migration.version)) continue;
    if (await store.apply(migration)) ran.push(migration.version);
  }
  return ran;
}
