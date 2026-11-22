// One of the checks export-check.ts runs on an export: every id one file uses is defined in another.
import assert from 'node:assert/strict';

/** Asserts every reference in the export resolves. `count` counts the rows a query returns. */
export async function checkReferences(count: (sql: string) => Promise<number>): Promise<void> {
  assert.equal(
    await count(`select 1 from trips where route_id not in (select route_id from routes)`),
    0,
  );
  assert.equal(
    await count(`select 1 from trips where service_id not in (select service_id from calendar)`),
    0,
  );
  assert.equal(
    await count(
      `select 1 from trips where shape_id is not null and shape_id not in (select distinct shape_id from shapes)`,
    ),
    0,
  );
  assert.equal(
    await count(`select 1 from stop_times where trip_id not in (select trip_id from trips)`),
    0,
  );
  assert.equal(
    await count(`select 1 from stop_times where stop_id not in (select stop_id from stops)`),
    0,
  );
  assert.equal(
    await count(`select 1 from routes where agency_id not in (select agency_id from agency)`),
    0,
  );
  assert.equal(
    await count(
      `select 1 from stops where parent_station is not null and parent_station not in (select stop_id from stops)`,
    ),
    0,
  );
  assert.equal(
    await count(
      `select 1 from pathways where from_stop_id not in (select stop_id from stops) or to_stop_id not in (select stop_id from stops)`,
    ),
    0,
  );
  assert.equal(
    await count(`select 1 from trips where trip_id not in (select trip_id from stop_times)`),
    0,
  );
}
