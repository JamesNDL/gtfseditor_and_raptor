// The words for deleting a stop: names, counts, times and distances, and the change in a sentence
// or two for the list of changes.
import type { DeleteStopPlan } from './types.ts';

export const tidy = (name: string) => name.replace(/,.*$/, '').replace(/ Station$/, '');
const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;
const minutes = (secs: number) => {
  if (Math.abs(secs) < 60)
    return `${Math.round(Math.abs(secs))} second${Math.round(Math.abs(secs)) === 1 ? '' : 's'}`;
  const m = Math.round(Math.abs(secs) / 6) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};
export const metres = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
export const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
export const platformLabel = (name: string, code: string | null) =>
  code ? `platform ${code}` : name.replace(/^.*, /, '');

/** The change in a sentence or two, for the list of changes. The preview says the same things at more length. */
export function describePlan(plan: DeleteStopPlan): string {
  const t = plan.totals;
  const parts: string[] = [];
  if (t.moved) {
    const where = plan.movedTo
      .map((m) => `${m.calls.toLocaleString('en-AU')} to ${m.label}`)
      .join(', ');
    parts.push(
      `${count(t.moved, 'call')} moved to another platform there (${where})${t.movedBusy ? `, ${t.movedBusy.toLocaleString('en-AU')} of them onto a platform that is in use within a minute of that time (two trips there at once show as clashes)` : ', none onto a platform in use at that time'}${t.movedUnusual ? `; ${t.movedUnusual.toLocaleString('en-AU')} onto a platform their line does not normally use` : ''}`,
    );
  }
  if (t.noLongerCall) {
    const skipping = plan.lines.filter((l) => l.noLongerCall > 0);
    const saving = median(skipping.map((l) => l.savingSecs));
    parts.push(
      `${count(t.noLongerCall, 'trip')} on ${count(skipping.length, 'line')} no longer call${t.noLongerCall === 1 ? 's' : ''} there, ${saving > 0 ? `typically ${minutes(saving)} quicker` : 'typically no quicker'}${skipping.some((l) => l.estimated) ? ' (estimated, and never faster past there than they run today)' : ''}`,
    );
  }
  if (t.cutShort)
    parts.push(
      `${count(t.cutShort, 'trip')} that started or ended there ${t.cutShort === 1 ? 'is' : 'are'} cut short to the next or previous stop, at the times ${t.cutShort === 1 ? 'it' : 'they'} already had`,
    );
  if (t.removed) parts.push(`${count(t.removed, 'trip')} removed, left with fewer than two stops`);
  if (!parts.length) parts.push('nothing called there, so no trip changes');
  const tail: string[] = [];
  if (t.noLongerCall || t.cutShort || t.removed)
    tail.push('Nothing is re-routed and vehicles stay on their trips');
  if (plan.vehicles.noTripsLeft)
    tail.push(
      `${count(plan.vehicles.noTripsLeft, 'vehicle')} ${plan.vehicles.noTripsLeft === 1 ? 'has' : 'have'} no trips left and ${plan.vehicles.noTripsLeft === 1 ? 'is' : 'are'} no longer needed`,
    );
  else if (t.trips) tail.push('the number of vehicles does not change');
  if (plan.vehicles.turnShort)
    tail.push(
      `${count(plan.vehicles.turnShort, 'vehicle')} now ${plan.vehicles.turnShort === 1 ? 'starts or ends' : 'start or end'} a trip short of there`,
    );
  if (plan.linksEnded)
    tail.push(
      `${count(plan.linksEnded, 'stay-aboard link')} ended, because the trips no longer meet there`,
    );
  const head = `Deleted ${plan.label}${plan.what === 'station' && plan.platforms.length > 1 ? ` and its ${plan.platforms.length} ${plan.placeWord}` : ''}`;
  // The preview lists every warning; the list of changes carries the first few.
  const more = plan.warnings.length - 3;
  const warning = plan.warnings.length
    ? `. Warning: ${plan.warnings.slice(0, 3).join(' ').replace(/\.$/, '')}${more > 0 ? `; and ${count(more, 'more warning')}` : ''}`
    : '';
  const after = tail.join('; ');
  return `${head}: ${parts.join('; ')}${after ? `. ${after[0].toUpperCase()}${after.slice(1)}` : ''}${warning}`;
}
