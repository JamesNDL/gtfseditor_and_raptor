// The setup's settings (FR-6, FR-8, FR-9): the departure and spacing, the public transport limits
// (longest walk, longest journey, most changes, the modes allowed) and the car settings (parking
// allowance, a traffic factor for each part of the day). They start at D34's values.
import { bandOf, DAY_BANDS } from '@gtfs-editor/core';
import { useState } from 'react';
import { useStore } from '../../app/store.ts';
import { changeFactor, changeSettings, toggleMode } from './setup-choices.ts';
import { bandText, clockSecs, clockText } from './setup-form.ts';

/** A box for one number; left empty, the number is NaN, which the checks refuse. */
function NumberBox({
  label,
  unit,
  value,
  step,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="analysis-field">
      <span>{label}</span>
      <input
        className="day-select analysis-number"
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
      <span className="muted">{unit}</span>
    </label>
  );
}

/** The departure as HH:MM text; text that is not a time leaves the departure unset (NaN). */
function DepartureBox({ secs, onChange }: { secs: number; onChange: (secs: number) => void }) {
  const [text, setText] = useState(() => (Number.isFinite(secs) ? clockText(secs) : ''));
  return (
    <label className="analysis-field">
      <span>Departure</span>
      <input
        className="day-select analysis-number"
        inputMode="numeric"
        placeholder="HH:MM"
        title="Seconds are not used. A time after midnight on the same service day is 24:00 or later."
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(clockSecs(e.target.value) ?? Number.NaN);
        }}
      />
      <span className="muted">HH:MM</span>
    </label>
  );
}

export function AnalysisSettingsForm() {
  const settings = useStore((s) => s.analysis.setup.settings);
  const modes = useStore((s) => s.modes);
  const set = useStore((s) => s.set);
  const view = () => useStore.getState().analysis;
  const change = (part: Parameters<typeof changeSettings>[1]) =>
    set({ analysis: changeSettings(view(), part) });
  const band = Number.isFinite(settings.departSecs) ? DAY_BANDS[bandOf(settings.departSecs)] : null;

  return (
    <>
      <section className="analysis-section" aria-label="When and how close">
        <h3 className="analysis-section-title">When and how close</h3>
        <div className="analysis-fields">
          <DepartureBox
            secs={settings.departSecs}
            onChange={(departSecs) => change({ departSecs })}
          />
          <NumberBox
            label="Spacing of sample points"
            unit="m"
            step={50}
            value={settings.spacingM}
            onChange={(spacingM) => change({ spacingM })}
          />
        </div>
      </section>

      <section className="analysis-section" aria-label="Public transport limits">
        <h3 className="analysis-section-title">Public transport limits</h3>
        <div className="analysis-fields">
          <NumberBox
            label="Longest walk to or from a stop"
            unit="m"
            step={50}
            value={settings.maxWalkM}
            onChange={(maxWalkM) => change({ maxWalkM })}
          />
          <NumberBox
            label="Longest journey"
            unit="min"
            step={5}
            value={settings.maxJourneyMins}
            onChange={(maxJourneyMins) => change({ maxJourneyMins })}
          />
          <NumberBox
            label="Most changes"
            unit=""
            step={1}
            value={settings.maxChanges}
            onChange={(maxChanges) => change({ maxChanges })}
          />
        </div>
        <div className="analysis-modes" role="group" aria-label="Modes allowed">
          {modes.map((mode) => (
            <label key={mode.id} className="check small">
              <input
                type="checkbox"
                checked={settings.modes.includes(mode.id)}
                onChange={() => set({ analysis: toggleMode(view(), mode.id) })}
              />{' '}
              {mode.name}
            </label>
          ))}
        </div>
      </section>

      <section className="analysis-section" aria-label="Car settings">
        <h3 className="analysis-section-title">Car settings</h3>
        <div className="analysis-fields">
          <NumberBox
            label="Parking allowance, added to every car time"
            unit="min"
            step={1}
            value={settings.parkingMins}
            onChange={(parkingMins) => change({ parkingMins })}
          />
        </div>
        <p className="muted small">
          Traffic factors: the drive time with no traffic is multiplied by the factor for the part
          of the day the departure falls in
          {band ? ` (the ${band.label}).` : '.'}
        </p>
        <div className="analysis-fields">
          {DAY_BANDS.map((b) => (
            <NumberBox
              key={b.id}
              label={bandText(b)}
              unit="×"
              step={0.1}
              value={settings.trafficFactors[b.id]}
              onChange={(factor) => set({ analysis: changeFactor(view(), b.id, factor) })}
            />
          ))}
        </div>
      </section>
    </>
  );
}
