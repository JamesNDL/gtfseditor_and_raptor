// Running access analyses in this API process, one at a time, in a queue (D20, docs/architecture/
// access-analysis.md §4.4). An analysis left queued, preparing or running when the API stopped is
// driven again when it starts, from the first pair not yet finished. Cancel sets a flag that the
// run checks between steps and batches; a cancelled or failed run deletes its results.
import type { AnalysisProgress, AnalysisSettings, AnalysisState } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { Scenario } from '../scenarios/engine.ts';
import { ensureTimetable, timetableKey, type Box } from '../sim/timetables.ts';
import { runDrives, type AfterBatch } from './run-drives.ts';
import { runJourneys } from './run-journeys.ts';

/** The states of an analysis that is still to finish. */
export const ACTIVE_STATES: readonly AnalysisState[] = ['queued', 'preparing', 'running'];

/** How far the timetable reaches beyond the zone and the points of interest (D21). */
const BOX_MARGIN_M = 15_000;
/** Metres per degree, the flat-earth factors of the sample grid (D26). */
const METRES_PER_DEGREE_LAT = 110_540;
const METRES_PER_DEGREE_LON_AT_EQUATOR = 111_320;

/** Thrown inside a run when it has been asked to stop. */
class Cancelled extends Error {}

export type Log = (err: unknown, message: string) => void;

/** The queue of analyses to run. */
export interface AnalysisRunner {
  /** Adds an analysis to the end of the queue, unless it is already in it or running. */
  enqueue(id: number): void;
  /** Stops an analysis: at once if it is waiting, between steps if it is running. */
  cancel(id: number): Promise<void>;
  /** Queues every analysis left queued, preparing or running, oldest first. */
  resume(): Promise<void>;
}

/** The parts of an analysis row a run reads. */
interface RunRow {
  state: AnalysisState;
  baselineId: number | null;
  scenarioId: number | null;
  scenarioName: string | null;
  settings: AnalysisSettings;
}

/** A box's edges in degrees, before it is widened. */
interface Extent {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Progress as JSON text; sent as text and cast, so Postgres parses it rather than storing a string. */
const progressJson = (progress: AnalysisProgress): string => JSON.stringify(progress);

/** The extent widened by `metres` on every side. */
function widened(extent: Extent, metres: number): Box {
  const midLat = ((extent.south + extent.north) / 2) * (Math.PI / 180);
  const dLat = metres / METRES_PER_DEGREE_LAT;
  const dLon = metres / (METRES_PER_DEGREE_LON_AT_EQUATOR * Math.cos(midLat));
  return {
    name: null,
    south: extent.south - dLat,
    west: extent.west - dLon,
    north: extent.north + dLat,
    east: extent.east + dLon,
  };
}

/** The box the timetable is cut to: the analysis's zone and points of interest, widened (D21). */
async function boxOf(sql: Sql, id: number): Promise<Box> {
  const [extent] = await sql<Extent[]>`
    select st_ymin(e) as south, st_xmin(e) as west, st_ymax(e) as north, st_xmax(e) as east
    from (
      select st_extent(g)::box3d as e from (
        select zone_geom as g from analyses where id = ${id}
        union all
        select geom from analysis_pois where analysis_id = ${id}) parts) box`;
  return widened(extent, BOX_MARGIN_M);
}

/** The scenario the analysis runs on as it stands now, or null for the published day itself. */
async function scenarioOf(sql: Sql, row: RunRow): Promise<Scenario | null> {
  if (row.scenarioId === null && row.scenarioName === null) return null;
  const [scenario] =
    row.scenarioId === null
      ? []
      : await sql<Scenario[]>`
          select id, baseline_id as "baselineId", head from scenarios where id = ${row.scenarioId}`;
  if (!scenario) throw new Error('The scenario was deleted before the analysis could run');
  return scenario;
}

/** Adds one pending result row per pair (sample point and point of interest), unless it has them. */
async function addPendingPairs(sql: Sql, id: number): Promise<void> {
  await sql`
    insert into analysis_results (analysis_id, point_seq, poi_seq, status)
    select ${id}, p.seq, o.seq, 'pending'
    from analysis_points p cross join analysis_pois o
    where p.analysis_id = ${id} and o.analysis_id = ${id}
      and not exists (select 1 from analysis_results where analysis_id = ${id})
    on conflict do nothing`;
}

/**
 * Takes an analysis from wherever it has got to through to the end: the timetable, the drives,
 * then the journeys. Safe to call again after the API restarts: only unfinished pairs are worked.
 */
async function driveAnalysis(
  sql: Sql,
  id: number,
  cancelled: () => boolean,
  log: Log,
): Promise<void> {
  try {
    const [row] = await sql<RunRow[]>`
      select state, baseline_id as "baselineId", scenario_id as "scenarioId",
             scenario_name as "scenarioName", settings
      from analyses where id = ${id}`;
    if (!row || !ACTIVE_STATES.includes(row.state)) return;
    if (cancelled()) throw new Cancelled();
    await sql`
      update analyses
      set state = 'preparing', started_at = coalesce(started_at, now()), finished_at = null,
          error = null, progress = ${progressJson({ stage: 'timetable' })}::text::jsonb
      where id = ${id}`;

    // 1. The timetable, cut to the box round the zone and the points of interest.
    if (row.baselineId === null) {
      throw new Error('The published day was deleted before the analysis could run');
    }
    const key = await timetableKey(
      sql,
      row.baselineId,
      await scenarioOf(sql, row),
      await boxOf(sql, id),
    );
    await sql`
      update analyses set timetable_id = ${key.id}, timetable_version = ${key.version}
      where id = ${id}`;
    await ensureTimetable(key, async (secs) => {
      if (cancelled()) throw new Cancelled();
      await sql`
        update analyses set progress = ${progressJson({ stage: 'timetable', secs })}::text::jsonb
        where id = ${id}`;
    });
    if (cancelled()) throw new Cancelled();

    // 2. The drives, then the journeys, batch by batch, with progress after each (FR-10).
    await addPendingPairs(sql, id);
    await sql`
      update analyses set state = 'running', progress = ${progressJson({ stage: 'drives' })}::text::jsonb
      where id = ${id}`;
    const afterBatch =
      (stage: 'drives' | 'journeys'): AfterBatch =>
      async (done, total) => {
        if (cancelled()) throw new Cancelled();
        await sql`
          update analyses set progress = ${progressJson({ stage, done, total })}::text::jsonb
          where id = ${id}`;
      };
    await runDrives(sql, id, row.settings, afterBatch('drives'));
    await runJourneys(sql, id, key.id, row.settings, afterBatch('journeys'));

    await sql`
      update analyses set state = 'done', finished_at = now(), progress = '{}', error = null
      where id = ${id}`;
  } catch (err) {
    const state: AnalysisState = err instanceof Cancelled ? 'cancelled' : 'failed';
    const message = state === 'failed' ? (err instanceof Error ? err.message : String(err)) : null;
    if (state === 'failed') log(err, `access analysis ${id} failed`);
    await sql`delete from analysis_results where analysis_id = ${id}`.catch(() => {});
    await sql`
      update analyses set state = ${state}, error = ${message}, finished_at = now(), progress = '{}'
      where id = ${id}`.catch((failure: unknown) => log(failure, `could not end analysis ${id}`));
  }
}

/** Makes the queue. Nothing runs until an analysis is queued or `resume` is called. */
export function analysisRunner(sql: Sql, log: Log): AnalysisRunner {
  const waiting: number[] = [];
  const cancelling = new Set<number>();
  let current: number | null = null;

  function next(): void {
    if (current !== null) return;
    const id = waiting.shift();
    if (id === undefined) return;
    current = id;
    void driveAnalysis(sql, id, () => cancelling.has(id), log).finally(() => {
      cancelling.delete(id);
      current = null;
      next();
    });
  }

  function enqueue(id: number): void {
    if (id === current || waiting.includes(id)) return;
    waiting.push(id);
    next();
  }

  return {
    enqueue,

    async cancel(id) {
      if (id === current) {
        cancelling.add(id);
        return;
      }
      const at = waiting.indexOf(id);
      if (at >= 0) waiting.splice(at, 1);
      await sql`delete from analysis_results where analysis_id = ${id}`;
      await sql`
        update analyses set state = 'cancelled', finished_at = now(), progress = '{}'
        where id = ${id} and state = any(${ACTIVE_STATES})`;
    },

    async resume() {
      const rows = await sql<{ id: number }[]>`
        select id from analyses where state = any(${ACTIVE_STATES}) order by id`;
      for (const { id } of rows) enqueue(id);
    },
  };
}
