// The setup's "Depart at / Arrive by" switch (FR-6, FR-21): two buttons side by side, one lit, that
// say whether journeys leave at the time below or arrive by it. The time box's name follows it.
import type { TimeMode } from '@gtfs-editor/core';
import './time-switch.css';

const CHOICES: { mode: TimeMode; label: string; title: string }[] = [
  {
    mode: 'depart',
    label: 'Depart at',
    title: 'Journeys leave the sample points at this time; waiting for the first vehicle counts',
  },
  {
    mode: 'arriveBy',
    label: 'Arrive by',
    title:
      'Journeys reach the point of interest by this time, leaving as late as they can; ' +
      'any wait between arriving and this time counts as early wait',
  },
];

export function TimeSwitch({
  mode,
  onChange,
}: {
  mode: TimeMode;
  onChange: (mode: TimeMode) => void;
}) {
  return (
    <div className="analysis-time-switch" role="group" aria-label="Depart at or arrive by">
      {CHOICES.map((c) => (
        <button
          key={c.mode}
          type="button"
          className={mode === c.mode ? 'on' : undefined}
          aria-pressed={mode === c.mode}
          title={c.title}
          onClick={() => onChange(c.mode)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
