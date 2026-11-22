// The published days, the modes and the lines of one day.

import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { int } from '../http.ts';
import { scenarioOf, visible } from '../scenarios/scenarios.ts';

export function registerBaselineRoutes(app: FastifyInstance, sql: Sql) {
  // ---------------------------------------------------------------------------
  // Baselines, modes, routes
  // ---------------------------------------------------------------------------
  app.get('/api/baselines', async () => {
    const baselines = await sql`
      select id, label, day_type, to_char(service_date, 'YYYY-MM-DD') as service_date, feed_id, stats
      from baselines where ready order by service_date`;
    const modeCounts = await sql`
      select t.baseline_id, r.mode_id, count(*)::int as trips
      from trips t join routes r on r.id = t.route_id where t.scenario_id is null group by 1, 2`;
    return baselines.map((b) => ({
      id: b.id,
      label: b.label,
      dayType: b.day_type,
      serviceDate: b.service_date,
      feedId: b.feed_id,
      stats: b.stats,
      tripsByMode: Object.fromEntries(
        modeCounts.filter((m) => m.baseline_id === b.id).map((m) => [m.mode_id, m.trips]),
      ),
    }));
  });

  app.get('/api/modes', async () => {
    return sql`select id, name, rule_set as "ruleSet", color from modes order by sort`;
  });

  app.get('/api/baselines/:b/routes', async (req) => {
    const b = int((req.params as any).b);
    const sc = await scenarioOf(req, sql);
    return sql`
      select r.id, r.short_name as "shortName", r.long_name as "longName", r.mode_id as "modeId",
             coalesce(r.color, m.color) as color,
             case when r.scenario_id is null then r.trip_count
                  else (select count(*)::int from trips t where t.route_id = r.id and ${visible(sql, 't', sc)}) end as "tripCount",
             r.agency_name as agency, (r.scenario_id is not null) as "isNew"
      from routes r join modes m on m.id = r.mode_id
      where r.baseline_id = ${b}
        and ((r.scenario_id is null and r.trip_count > 0)
          or ${sc ? sql`(r.scenario_id = ${sc.id} and r.created_edit <= ${sc.head})` : sql`false`})
      order by m.sort, r.short_name`;
  });
}
