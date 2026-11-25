// The words for a reshape: stops added and removed, the change in trip times, and how the new
// stretches were drawn and timed.
import { describeMethod } from '../../../routing/roads.ts';
import { describeTimes } from '../../../routing/timings.ts';
import type { ReshapePlan } from './types.ts';

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 stops added, 1 removed" */
export const describeStops = (plan: { added: number; removed: number }) =>
  [
    plan.added ? `${count(plan.added, 'stop')} added` : '',
    plan.removed
      ? `${plan.removed}${plan.added ? '' : ` stop${plan.removed === 1 ? '' : 's'}`} removed`
      : '',
  ]
    .filter(Boolean)
    .join(', ') || 'stops reordered';

/** "trip times about 4 min longer" */
export const describeChange = (secs: number) => {
  const mins = Math.round(Math.abs(secs) / 60);
  if (mins === 0) return 'trip times about the same';
  return `trip times about ${mins} min ${secs > 0 ? 'longer' : 'shorter'}`;
};

/** How the new stretches were drawn and timed, or '' when the reshape only removed things. */
export const describeNewStretches = (plan: ReshapePlan) => {
  if (plan.pathMethod === null) return '';
  if (!plan.learned && !plan.estimated) return 'new path ' + describeMethod(plan.pathMethod);
  return `new path ${describeMethod(plan.pathMethod)}; run times: ${describeTimes(plan.timed, 'the new stretches take')}`;
};
