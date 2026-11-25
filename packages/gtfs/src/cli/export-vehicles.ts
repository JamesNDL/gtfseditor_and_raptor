// One of the checks export-check.ts runs on an export (FR-9): the editor's own vehicle files,
// editor_vehicle_types.txt and editor_trip_vehicles.txt, name only trips and vehicle types that are
// in the export, and each trip says which published trip it came from.
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { access } from 'node:fs/promises';
import path from 'node:path';

const TYPES = 'editor_vehicle_types.txt';
const TRIP_VEHICLES = 'editor_trip_vehicles.txt';
/** How many offending ids a problem quotes. */
const EXAMPLES = 3;

/** A query's single column of text, one entry per row. */
async function column(db: DuckDBConnection, sql: string): Promise<string[]> {
  const rows = await (await db.run(sql)).getRows();
  return rows.map((row) => String(row[0]));
}

/**
 * Says how many ids broke a rule, with a few of them, or nothing when none did. `what` has {n}
 * for the count and {s} where a plural takes an s.
 */
function problem(ids: string[], what: string): string[] {
  if (!ids.length) return [];
  const shown = ids.slice(0, EXAMPLES).join(', ');
  const said = what.replace('{n}', String(ids.length)).replace('{s}', ids.length === 1 ? '' : 's');
  return [`${said} (for example ${shown})`];
}

/**
 * Checks the vehicle files of an export unzipped into `dir`, and returns what is wrong with them:
 * an empty list when nothing is.
 *
 * - Every trip in editor_trip_vehicles.txt is in trips.txt (AC-FR-9.1).
 * - Every vehicle type it names is in editor_vehicle_types.txt (AC-FR-9.1).
 * - It has an origin_trip_id column (AC-FR-9.2). Where given, that is the published trip the row's
 *   trip was made from: the trip itself, or a trip whose id is the published id, '~' and a mark
 *   of the scenario's edit (`copyTrips` in scenarios.ts names its copies that way).
 */
export async function vehicleFileProblems(dir: string): Promise<string[]> {
  const file = (name: string) => path.join(dir, name);
  const missing: string[] = [];
  for (const name of [TYPES, TRIP_VEHICLES]) {
    await access(file(name)).catch(() => missing.push(`${name} is missing`));
  }
  if (missing.length) return missing;

  const instance = await DuckDBInstance.create(':memory:');
  const db = await instance.connect();
  try {
    const csv = (name: string) =>
      `read_csv('${file(name).split(path.sep).join('/')}', header=true, all_varchar=true)`;
    await db.run(`create table trips as select trip_id from ${csv('trips.txt')}`);
    await db.run(`create table vehicle_types as select vehicle_type_id from ${csv(TYPES)}`);
    await db.run(`create table trip_vehicles as select * from ${csv(TRIP_VEHICLES)}`);
    const columns = await column(
      db,
      `select column_name from information_schema.columns where table_name = 'trip_vehicles'`,
    );
    if (!columns.includes('origin_trip_id'))
      return [`${TRIP_VEHICLES} has no origin_trip_id column`];

    return [
      ...problem(
        await column(
          db,
          `select trip_id from trip_vehicles where trip_id not in (select trip_id from trips) order by 1`,
        ),
        `${TRIP_VEHICLES} names {n} trip{s} not in trips.txt`,
      ),
      ...problem(
        await column(
          db,
          `select distinct vehicle_type_id from trip_vehicles where vehicle_type_id is not null
             and vehicle_type_id not in (select vehicle_type_id from vehicle_types) order by 1`,
        ),
        `${TRIP_VEHICLES} names {n} vehicle type{s} not in ${TYPES}`,
      ),
      ...problem(
        await column(
          db,
          `select trip_id from trip_vehicles where origin_trip_id is not null
             and trip_id <> origin_trip_id and split_part(trip_id, '~', 1) <> origin_trip_id order by 1`,
        ),
        `${TRIP_VEHICLES} has {n} trip{s} whose origin_trip_id is not the published trip it was made from`,
      ),
    ];
  } finally {
    db.closeSync();
    instance.closeSync();
  }
}
