// The setup screen (FR-6): the zone and points of interest, the timetable, the settings, the live
// count line and Run. A choice over the limits (NFR-3) shows why and disables Run. Run posts the
// analysis and goes back to the list, where its progress shows (FR-10).
// See docs/architecture/access-analysis.md §5.2.
import { useMemo, useState } from 'react';
import { useStore } from '../../app/store.ts';
import { startAnalysis, usePlaces } from '../analysis-api.ts';
import { backToList, isMapBusy } from '../analysis-state.ts';
import { AnalysisSettingsForm } from './AnalysisSettingsForm.tsx';
import { PoiPicker } from './PoiPicker.tsx';
import { nameSetup, pickTimetable } from './setup-choices.ts';
import { countLine, createBody, setupCount, setupProblem } from './setup-form.ts';
import { ZonePicker } from './ZonePicker.tsx';

/** The timetable to run on: the published day, or one of the day's scenarios. */
function TimetablePicker() {
  const baselineId = useStore((s) => s.baselineId);
  const scenarios = useStore((s) => s.scenarios);
  const scenarioId = useStore((s) => s.analysis.setup.scenarioId);
  const set = useStore((s) => s.set);
  const ofDay = scenarios.filter((s) => s.baselineId === baselineId);

  return (
    <section className="analysis-section" aria-label="Timetable">
      <h3 className="analysis-section-title">Timetable</h3>
      <select
        className="day-select"
        aria-label="Timetable"
        value={scenarioId ?? ''}
        onChange={(e) => {
          const id = e.target.value === '' ? null : Number(e.target.value);
          set({ analysis: pickTimetable(useStore.getState().analysis, id) });
        }}
      >
        <option value="">Published day</option>
        {ofDay.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </section>
  );
}

export function AnalysisSetup() {
  const baselineId = useStore((s) => s.baselineId);
  const setup = useStore((s) => s.analysis.setup);
  const busy = useStore((s) => isMapBusy(s.analysis));
  const set = useStore((s) => s.set);
  const zones = usePlaces((s) => s.zones);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ring = zones?.find((z) => z.id === setup.zoneId)?.ring ?? null;
  const spacingM = setup.settings.spacingM;
  const count = useMemo(() => setupCount(ring, spacingM), [ring, spacingM]);
  const line = countLine(count, setup.poiIds.length);
  const problem = setupProblem(setup, count);
  const body = baselineId === null ? null : createBody(setup, baselineId);

  const run = () => {
    if (body === null) return;
    setStarting(true);
    setError(null);
    startAnalysis(body).then(
      () => {
        const { analysis } = useStore.getState();
        set({ analysis: backToList(analysis) });
      },
      (e: Error) => {
        setStarting(false);
        setError(e.message);
      },
    );
  };

  return (
    <>
      <div className="analysis-body">
        <ZonePicker />
        <PoiPicker />
        <TimetablePicker />
        <AnalysisSettingsForm />
        <label className="analysis-name-field">
          <span>Name</span>
          <input
            className="day-select analysis-name-input"
            placeholder="Left empty, one is made up"
            maxLength={80}
            value={setup.name}
            onChange={(e) =>
              set({ analysis: nameSetup(useStore.getState().analysis, e.target.value) })
            }
          />
        </label>
      </div>
      {/* Below the settings, always in view, so a change shows its count straight away. */}
      <section className="analysis-run" aria-label="Run">
        {line && <p className="small">{line}</p>}
        {problem && <p className="warn-text small">{problem}</p>}
        {error && <p className="error-text small">{error}</p>}
        <button
          className="button on analysis-add"
          disabled={problem !== null || body === null || starting || busy}
          title="Work out every journey and drive in the background; the editor stays usable"
          onClick={run}
        >
          {starting ? 'Starting…' : 'Run'}
        </button>
      </section>
    </>
  );
}
