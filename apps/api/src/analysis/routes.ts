// The access analysis routes (FR-6, FR-10, FR-16; docs/architecture/access-analysis.md §4.4): list
// a day's analyses (each with the others it can be compared with, FR-17), make one, read one,
// cancel one and delete one. The run itself is runner.ts.
import type { FastifyInstance } from 'fastify';
import {
  withTimeMode,
  type AnalysisDetail,
  type AnalysisListEntry,
  type AnalysisListItem,
  type AnalysisPoi,
  type AnalysisState,
  type GeoJsonPosition,
  type StoredAnalysisSettings,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { fail, int, notFound } from '../http.ts';
import { comparableWithOf } from './compare-read.ts';
import { createAnalysis } from './create.ts';
import { summariesOf } from './results-read.ts';
import { ACTIVE_STATES, analysisRunner, type AnalysisRunner } from './runner.ts';

/** An analysis as read for the list, before its dates become text. */
interface ListRow extends Omit<AnalysisListItem, 'createdAt' | 'finishedAt'> {
  createdAt: Date;
  finishedAt: Date | null;
}

/** The rest of an analysis, read for its detail. */
interface DetailRow extends ListRow {
  settings: StoredAnalysisSettings;
  zoneId: number | null;
  zoneRings: GeoJsonPosition[][];
  zoneHash: string;
}

/** One copied point of interest, before its summary is added. */
type PoiRow = Omit<AnalysisPoi, 'summary'>;

/** Route parameters or a query: an object of unknown fields, or nothing. */
const fieldsOf = (value: unknown): Partial<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};

const listItemOf = ({ createdAt, finishedAt, ...row }: ListRow): AnalysisListItem => ({
  ...row,
  createdAt: createdAt.toISOString(),
  finishedAt: finishedAt?.toISOString() ?? null,
});

export function registerAnalysisRoutes(app: FastifyInstance, sql: Sql): AnalysisRunner {
  const runner = analysisRunner(sql, (err, message) => app.log.error(err, message));
  const idOf = (params: unknown): number => int(fieldsOf(params).id);
  // The stored progress is an empty object when nothing is going on; the API gives null then.
  // Settings stored before arrive-by have no time mode: they are depart-at (FR-21, D40).
  const listColumns = sql`
    id, name, baseline_id as "baselineId", scenario_id as "scenarioId",
    scenario_name as "scenarioName", zone_name as "zoneName", state,
    nullif(progress, '{}'::jsonb) as progress, error, sample_count as "sampleCount",
    created_at as "createdAt", finished_at as "finishedAt",
    coalesce(settings ->> 'timeMode', 'depart') as "timeMode",
    (settings ->> 'departSecs')::float8 as "timeSecs"`;

  async function stateOf(id: number): Promise<AnalysisState> {
    const [row] = await sql<
      { state: AnalysisState }[]
    >`select state from analyses where id = ${id}`;
    if (!row) throw notFound('Analysis');
    return row.state;
  }

  app.get('/api/analyses', async (req): Promise<AnalysisListEntry[]> => {
    const baseline = int(fieldsOf(req.query).baseline);
    const rows = await sql<ListRow[]>`
      select ${listColumns} from analyses where baseline_id = ${baseline}
      order by created_at desc, id desc`;
    const comparable = await comparableWithOf(sql, baseline);
    return rows.map((row) => ({
      ...listItemOf(row),
      comparableWith: comparable.get(row.id) ?? [],
    }));
  });

  app.post('/api/analyses', async (req, reply): Promise<{ id: number }> => {
    const id = await createAnalysis(sql, req.body);
    runner.enqueue(id);
    reply.code(202);
    return { id };
  });

  app.get('/api/analyses/:id', async (req): Promise<AnalysisDetail> => {
    const id = idOf(req.params);
    const [row] = await sql<DetailRow[]>`
      select ${listColumns}, settings, zone_id as "zoneId", zone_hash as "zoneHash",
             (st_asgeojson(zone_geom, 15)::json -> 'coordinates') as "zoneRings"
      from analyses where id = ${id}`;
    if (!row) throw notFound('Analysis');
    const pois = await sql<PoiRow[]>`
      select seq, poi_id as "poiId", name, st_x(geom) as lon, st_y(geom) as lat
      from analysis_pois where analysis_id = ${id} order by seq`;
    const { settings: stored, zoneId, zoneRings, zoneHash, zoneName, ...item } = row;
    const settings = withTimeMode(stored);
    // Each point of interest's summary for the analysis's own lines, once it is done (FR-20).
    const summaries = row.state === 'done' ? await summariesOf(sql, id, settings.breaks) : null;
    return {
      ...listItemOf({ ...item, zoneName }),
      settings,
      zone: { id: zoneId, name: zoneName, ring: zoneRings[0].slice(0, -1), hash: zoneHash },
      pois: pois.map((poi) => ({ ...poi, summary: summaries?.get(poi.seq) ?? null })),
    };
  });

  app.post('/api/analyses/:id/cancel', async (req): Promise<{ ok: true }> => {
    const id = idOf(req.params);
    if (!ACTIVE_STATES.includes(await stateOf(id))) {
      throw fail(409, 'This analysis has already finished, so there is nothing to cancel');
    }
    await runner.cancel(id);
    return { ok: true };
  });

  // Its points of interest, sample points and results go with it (on delete cascade).
  app.delete('/api/analyses/:id', async (req): Promise<{ ok: true }> => {
    const id = idOf(req.params);
    if (ACTIVE_STATES.includes(await stateOf(id))) await runner.cancel(id);
    const deleted = await sql`delete from analyses where id = ${id} returning id`;
    if (deleted.length === 0) throw notFound('Analysis');
    return { ok: true };
  });

  return runner;
}
