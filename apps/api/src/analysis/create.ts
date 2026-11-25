// Making an access analysis (FR-6, FR-7, NFR-3; docs/architecture/access-analysis.md §4.4): checks
// the body and the limits, checks that both routers answer, then copies the zone and the points of
// interest (D25), lays and stores the sample points (D26) and leaves the analysis queued. Anything
// refused stores nothing.
import {
  analysisProblem,
  ANALYSIS_LIMITS,
  gridCount,
  sampleGrid,
  settingsProblem,
  timeText,
  type AnalysisCreateBody,
  type GeoJsonPosition,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { fail, notFound } from '../http.ts';
import { ROUTER_DOWN, router } from '../sim/router-client.ts';
import { analysisBodyOf } from './create-body.ts';
import { ROAD_DOWN, roadHealth } from './road-client.ts';

/** Sample points stored per insert, well inside Postgres's limit on values in one statement. */
const POINTS_PER_INSERT = 5_000;

/** The zone an analysis is made from, with its outline as read (closed) and its name. */
interface ZoneRow {
  name: string;
  rings: GeoJsonPosition[][];
}

/** The sample point count, or 0 when the spacing is out of range (`analysisProblem` says why). */
function samplePointCount(ring: GeoJsonPosition[], spacingM: number): number {
  const { minSpacingM, maxSpacingM } = ANALYSIS_LIMITS;
  const inRange = Number.isFinite(spacingM) && spacingM >= minSpacingM && spacingM <= maxSpacingM;
  return inRange ? gridCount(ring, spacingM) : 0;
}

/** Both routers must answer before anything is stored; each down router is a 503 naming it. */
async function checkRouters(): Promise<void> {
  const journeys = await router('GET', '/v1/health');
  if (journeys.status !== 200) throw fail(503, ROUTER_DOWN);
  if (!(await roadHealth()).available) throw fail(503, ROAD_DOWN);
}

/** The day must be ready, and the scenario (if any) on it. Gives the scenario's name. */
async function timetableOf(sql: Sql, body: AnalysisCreateBody): Promise<string | null> {
  const [day] = await sql<
    { id: number }[]
  >`select id from baselines where id = ${body.baselineId} and ready`;
  if (!day) throw notFound('Day');
  if (body.scenarioId === null) return null;
  const [scenario] = await sql<{ name: string }[]>`
    select name from scenarios where id = ${body.scenarioId} and baseline_id = ${body.baselineId}`;
  if (!scenario) throw notFound('Scenario');
  return scenario.name;
}

/** Stores the analysis with its copies and sample points, in one transaction. Gives its id. */
async function store(
  sql: Sql,
  body: AnalysisCreateBody,
  name: string,
  scenarioName: string | null,
  ring: GeoJsonPosition[],
): Promise<number> {
  const { points } = sampleGrid(ring, body.settings.spacingM);
  return sql.begin(async (tx) => {
    const [made] = await tx<{ id: number }[]>`
      insert into analyses (name, baseline_id, scenario_id, scenario_name, zone_id, zone_name,
                            zone_geom, zone_hash, settings, sample_count)
      select ${name}, ${body.baselineId}, ${body.scenarioId}, ${scenarioName}, z.id, z.name,
             z.geom, md5(st_astext(z.geom)), ${JSON.stringify(body.settings)}::text::jsonb, ${points.length}
      from analysis_zones z where z.id = ${body.zoneId}
      returning id`;
    if (!made) throw notFound('Zone');
    const id = made.id;
    const pois = await tx<{ seq: number }[]>`
      insert into analysis_pois (analysis_id, seq, poi_id, name, geom)
      select ${id}, chosen.ord - 1, p.id, p.name, p.geom
      from unnest(${body.poiIds}::int[]) with ordinality as chosen(poi_id, ord)
      join points_of_interest p on p.id = chosen.poi_id
      returning seq`;
    if (pois.length !== body.poiIds.length) throw notFound('Point of interest');
    for (let from = 0; from < points.length; from += POINTS_PER_INSERT) {
      const rows = points.slice(from, from + POINTS_PER_INSERT).map((p, k) => ({
        analysis_id: id,
        seq: from + k,
        i: p.i,
        j: p.j,
        lon: p.lon,
        lat: p.lat,
      }));
      await tx`insert into analysis_points ${tx(rows)}`;
    }
    return id;
  });
}

/**
 * Checks a request to make an analysis and stores it, queued. Gives the new analysis's id. A
 * refusal is a 400 (bad settings, NFR-3 limits), 404 (zone, point of interest, day or scenario
 * not found) or 503 (a router is down), and nothing is stored.
 */
export async function createAnalysis(sql: Sql, given: unknown): Promise<number> {
  const body = analysisBodyOf(given);
  const problem = settingsProblem(body.settings);
  if (problem) throw fail(400, problem);

  const [zone] = await sql<ZoneRow[]>`
    select name, (st_asgeojson(geom, 15)::json -> 'coordinates') as rings
    from analysis_zones where id = ${body.zoneId}`;
  if (!zone) throw notFound('Zone');
  const ring = zone.rings[0].slice(0, -1);
  const { spacingM } = body.settings;
  const limits = analysisProblem({
    samplePoints: samplePointCount(ring, spacingM),
    pois: body.poiIds.length,
    spacingM,
  });
  if (limits) throw fail(400, limits);

  const found = await sql<
    { id: number }[]
  >`select id from points_of_interest where id = any(${body.poiIds}::int[])`;
  if (found.length !== body.poiIds.length) throw notFound('Point of interest');
  const scenarioName = await timetableOf(sql, body);
  await checkRouters();

  const timetable = scenarioName ?? 'Published day';
  const name = body.name ?? `${zone.name} · ${timeText(body.settings)} · ${timetable}`;
  return store(sql, body, name, scenarioName, ring);
}
