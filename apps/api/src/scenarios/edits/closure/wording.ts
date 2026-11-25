// Words and numbers for the closure's label, summary and preview.
import { formatClock } from '@gtfs-editor/core';

export const SIDE_NAME: Record<string, string> = { N: 'north', S: 'south', E: 'east', W: 'west' };

export const tidy = (name: string) => name.replace(/,.*$/, '').replace(/ Station$/, '');
export const clock = (secs: number) => {
  const { time, nextDay } = formatClock(secs);
  return nextDay ? `${time} the next day` : time;
};
export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
