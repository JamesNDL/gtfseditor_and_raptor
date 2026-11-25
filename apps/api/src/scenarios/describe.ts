// A trip as the edit summaries name it: line, departure time, and where it runs from and to.
import { formatSecs } from '@gtfs-editor/core';
import type { Tx } from './engine.ts';
import { fail } from '../http.ts';

interface Described {
  label: string;
  line: string;
  start_secs: number;
  route_id: number;
  direction_id: number | null;
  pattern_id: number | null;
  vehicle_day_id: number | null;
  baseline_id: number;
  rule_set: string;
}

/** The row `describe` reads, before it adds the label. */
type DescribeRow = Omit<Described, 'label'> & {
  from: string;
  to: string;
  scenario_id: number | null;
};

export const describe = async (tx: Tx, tripId: number) => {
  const [t] = await tx<DescribeRow[]>`
    select coalesce(r.short_name, r.long_name, 'trip') as line, t.start_secs, f.name as "from", l.name as "to",
           t.route_id, t.direction_id, t.pattern_id, t.vehicle_day_id, t.baseline_id, t.scenario_id, m.rule_set
    from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id
    join stops f on f.id = t.first_stop_id join stops l on l.id = t.last_stop_id
    where t.id = ${tripId}`;
  if (!t) throw fail(404, 'Trip not found');
  const short = (s: string) => s.replace(/ Station.*$/, '').replace(/, Platform.*$/, '');
  return {
    ...t,
    label: `${t.line} ${formatSecs(t.start_secs)} ${short(t.from)} to ${short(t.to)}`,
  };
};
