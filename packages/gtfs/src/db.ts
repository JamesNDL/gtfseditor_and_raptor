import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

export const DEFAULT_DATABASE_URL = 'postgres://gtfs:gtfs@localhost:5433/gtfs_editor';

export type Sql = postgres.Sql;

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

export async function migrate(sql: Sql): Promise<void> {
  const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  await sql.unsafe(schema);
}
