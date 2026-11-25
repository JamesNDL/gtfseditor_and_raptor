// Which stops a scenario can see: the published ones and its own, less any it has deleted.
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { Scenario } from './engine.ts';

/** SQL condition: this scenario has deleted the stop aliased `alias` (apps/api/src/scenarios/edits/delete-stop.ts). */
export function stopDeleted(sql: Sql, alias: string, sc: Scenario | null) {
  const s = sql(alias);
  if (!sc) return sql`false`;
  return sql`exists (
    select 1 from scenario_removed_stops gone
    where gone.scenario_id = ${sc.id} and gone.stop_id = ${s}.id and gone.edit_seq <= ${sc.head})`;
}

/**
 * SQL condition: the stop aliased `alias` is published, or was added by this scenario and not undone,
 * and the scenario has not deleted it.
 */
export function stopVisible(sql: Sql, alias: string, sc: Scenario | null) {
  const s = sql(alias);
  if (!sc) return sql`${s}.scenario_id is null`;
  return sql`((${s}.scenario_id is null or (${s}.scenario_id = ${sc.id} and ${s}.created_edit <= ${sc.head}))
    and not ${stopDeleted(sql, alias, sc)})`;
}
