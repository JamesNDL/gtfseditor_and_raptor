import postgres from 'postgres';
import { runMigrations, type Migration, type MigrationStore } from './migrate.ts';
import { readMigrations } from './migration-files.ts';

export const DEFAULT_DATABASE_URL = 'postgres://gtfs:gtfs@localhost:5433/gtfs_editor';

export type Sql = postgres.Sql;

/** A transaction: everything run on it is committed together, or not at all. */
export type Tx = postgres.TransactionSql;

/** The shared connection or a transaction, for queries that may run on either. */
export type Queryable = postgres.ISql;

/** A value a query template takes: text, a number, an array, a fragment and so on. */
export type QueryValue = postgres.ParameterOrFragment<never>;

export function connect(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Sql {
  return postgres(url, {
    max: 4,
    onnotice: () => {},
    // Our ids fit comfortably in a JS number; return bigint columns as numbers, not strings.
    types: {
      int8: {
        to: 20,
        from: [20],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
    },
  }) as unknown as Sql;
}

/**
 * Runs the numbered migrations the database has not had yet (migrate.ts), and returns their
 * versions. Called at every API start and every import.
 */
export async function migrate(sql: Sql): Promise<string[]> {
  return runMigrations(postgresStore(sql), await readMigrations());
}

/**
 * Keeps the record of migrations in schema_migrations. Every step that reads or writes it takes
 * the same transaction lock, so that an API and an import starting together do not both run a
 * migration.
 */
function postgresStore(sql: Sql): MigrationStore {
  const lock = async (tx: postgres.TransactionSql): Promise<void> => {
    await tx`select pg_advisory_xact_lock(hashtext('schema_migrations'))`;
  };
  return {
    start: () =>
      sql.begin(async (tx) => {
        await lock(tx);
        await tx`create table if not exists schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )`;
        const rows = await tx<{ version: string }[]>`select version from schema_migrations`;
        return new Set(rows.map((row) => row.version));
      }),
    apply: (migration: Migration) =>
      sql.begin(async (tx) => {
        await lock(tx);
        const done = await tx`select 1 from schema_migrations where version = ${migration.version}`;
        if (done.length > 0) return false;
        await tx.unsafe(migration.sql);
        await tx`insert into schema_migrations (version) values (${migration.version})`;
        return true;
      }),
  };
}
