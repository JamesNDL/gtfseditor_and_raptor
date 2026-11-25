// When two analyses can be compared (FR-17, D31; docs/architecture/access-analysis.md §5.3): both
// finished, the same zone outline (its hash) and spacing, and the point of interest in both, by its
// saved id. Used by the compare route (export-routes.ts) and to mark the list (routes.ts).
import type { AnalysisState } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { fail, notFound } from '../http.ts';

/** What decides whether an analysis can be compared with another. */
interface CompareSide {
  id: number;
  state: AnalysisState;
  zoneHash: string;
  spacingM: number;
}

/** The two analyses' seqs for the point of interest they are compared on. */
export interface ComparedPoiSeqs {
  a: number;
  b: number;
}

/** The sample points line up only when the outline and spacing are the same (D31). */
const LINE_UP = 'so their sample points do not line up.';

async function sideOf(sql: Sql, id: number): Promise<CompareSide> {
  const [row] = await sql<CompareSide[]>`
    select id, state, zone_hash as "zoneHash", (settings ->> 'spacingM')::float8 as "spacingM"
    from analyses where id = ${id}`;
  if (!row) throw notFound('Analysis');
  return row;
}

/** The analysis's seq for the saved point of interest; a 409 when it does not have it. */
async function poiSeqOf(sql: Sql, analysisId: number, poiId: number): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`
    select seq from analysis_pois where analysis_id = ${analysisId} and poi_id = ${poiId}
    order by seq limit 1`;
  if (!row) {
    const why = `Analysis ${analysisId} does not have this point of interest`;
    throw fail(409, `${why}, so the two cannot be compared for it.`);
  }
  return row.seq;
}

/**
 * Checks that analyses `aId` and `bId` can be compared for the saved point of interest `poiId`
 * and gives each one's seq for it. A missing analysis is a 404; anything else in the way is a 409
 * with the reason.
 */
export async function comparedPoiSeqs(
  sql: Sql,
  aId: number,
  bId: number,
  poiId: number,
): Promise<ComparedPoiSeqs> {
  const a = await sideOf(sql, aId);
  const b = await sideOf(sql, bId);
  for (const side of [a, b]) {
    if (side.state !== 'done') {
      throw fail(409, `Analysis ${side.id} has not finished, so it cannot be compared yet.`);
    }
  }
  if (a.zoneHash !== b.zoneHash) {
    throw fail(409, `These analyses have different zone outlines, ${LINE_UP}`);
  }
  if (a.spacingM !== b.spacingM) {
    throw fail(
      409,
      `These analyses have different spacings (${a.spacingM} m and ${b.spacingM} m), ${LINE_UP}`,
    );
  }
  return { a: await poiSeqOf(sql, a.id, poiId), b: await poiSeqOf(sql, b.id, poiId) };
}

/**
 * For each finished analysis of a day, the other analyses of that day it can be compared with:
 * finished, the same zone outline and spacing, and at least one saved point of interest in common.
 */
export async function comparableWithOf(
  sql: Sql,
  baselineId: number,
): Promise<Map<number, number[]>> {
  const rows = await sql<{ id: number; others: number[] }[]>`
    select a.id, array_agg(b.id order by b.id) as others
    from analyses a
    join analyses b
      on b.id <> a.id and b.baseline_id = a.baseline_id and b.state = 'done'
     and b.zone_hash = a.zone_hash
     and (b.settings ->> 'spacingM')::float8 = (a.settings ->> 'spacingM')::float8
    where a.baseline_id = ${baselineId} and a.state = 'done'
      and exists (
        select 1 from analysis_pois pa
        join analysis_pois pb on pb.poi_id = pa.poi_id
        where pa.analysis_id = a.id and pb.analysis_id = b.id)
    group by a.id`;
  return new Map(rows.map((row) => [row.id, row.others]));
}
