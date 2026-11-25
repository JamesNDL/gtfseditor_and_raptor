// Keeps a re-import from silently deleting scenarios. Importing a day replaces that day's baseline,
// and its scenarios go with it (on delete cascade), so a day with scenarios is refused unless the
// caller asks to replace it.
import type { Queryable, Sql } from '../db.ts';

/** Why `date` is not a usable YYYYMMDD service day, or undefined when it is one. */
export function dateProblem(date: string): string | undefined {
  const parts = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  if (!parts) return `Dates must be YYYYMMDD, such as 20260707, not ${date}`;
  const [year, month, day] = parts.slice(1).map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return `${date} is not a real date`;
  }
  return undefined;
}

/** YYYYMMDD as YYYY-MM-DD. Throws if it is not a real date. */
export function isoDate(date: string): string {
  const problem = dateProblem(date);
  if (problem) throw new Error(problem);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** Counts the scenarios on the baseline that importing `date` (YYYYMMDD) from this feed would delete. */
export async function countScenariosOnDay(
  sql: Queryable,
  feedId: string,
  date: string,
): Promise<number> {
  const [{ n }] = await sql`
    select count(*)::int as n from scenarios s join baselines b on b.id = s.baseline_id
    where b.feed_id = ${feedId} and b.service_date = ${isoDate(date)}`;
  return n;
}

/** Thrown when a day with scenarios is re-imported without `replace`. Nothing has been deleted. */
export class ReplaceRefusedError extends Error {
  name = 'ReplaceRefusedError';
}

/** The message given when a day with scenarios is re-imported without --replace. */
export function replaceRefusal(date: string, scenarios: number): string {
  const these = scenarios === 1 ? '1 scenario' : `${scenarios} scenarios`;
  return (
    `${isoDate(date)} has ${these}. Re-importing the day deletes ${scenarios === 1 ? 'it' : 'them'}. ` +
    'Run `npm run db:backup` first, then add --replace.'
  );
}

/** The refusal for each of `dates` that has scenarios on this feed. Empty when all may be imported. */
export async function findRefusals(sql: Sql, feedId: string, dates: string[]): Promise<string[]> {
  const refusals: string[] = [];
  for (const date of dates) {
    const scenarios = await countScenariosOnDay(sql, feedId, date);
    if (scenarios > 0) refusals.push(replaceRefusal(date, scenarios));
  }
  return refusals;
}

/**
 * Run just before a day is imported. Throws ReplaceRefusedError if the day has scenarios and
 * `replace` is not set; otherwise logs how many scenarios are about to be deleted, if any.
 */
export async function guardReplace(
  sql: Queryable,
  feedId: string,
  date: string,
  replace: boolean,
  log: (m: string) => void,
): Promise<void> {
  const scenarios = await countScenariosOnDay(sql, feedId, date);
  if (scenarios === 0) return;
  if (!replace) throw new ReplaceRefusedError(replaceRefusal(date, scenarios));
  log(`  replacing ${isoDate(date)}: deleting its ${scenarios} scenario(s)`);
}
