import { useEffect, useState } from 'react';
import {
  deleteScenario,
  loadScenarios,
  renameScenario,
  selectScenario,
  type ScenarioSummary,
} from './scenario.ts';
import { useStore } from './store.ts';

/** Every scenario of the chosen day in one place: open, rename, delete. */
export function ScenarioManager() {
  const open = useStore((s) => s.scenariosOpen);
  const scenarios = useStore((s) => s.scenarios);
  const scenarioId = useStore((s) => s.scenarioId);
  const baselineId = useStore((s) => s.baselineId);
  const set = useStore((s) => s.set);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (baselineId !== null) void loadScenarios(baselineId);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && set({ scenariosOpen: false });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, baselineId, set]);

  if (!open) return null;
  const act = (work: Promise<unknown>) =>
    work.then(
      () => setError(null),
      (e: Error) => setError(e.message),
    );

  return (
    <div className="fleet-backdrop" onClick={() => set({ scenariosOpen: false })}>
      <section
        className="panel fleet scenario-manager"
        onClick={(e) => e.stopPropagation()}
        aria-label="Scenarios"
      >
        <header className="fleet-header">
          <div>
            <h2>Scenarios</h2>
            <div className="muted small">
              {scenarios.length} scenario{scenarios.length === 1 ? '' : 's'} of this day. Deleting
              one cannot be undone. The published timetable is never changed.
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => set({ scenariosOpen: false })}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        {error && <p className="error-text small fleet-error">{error}</p>}
        <div className="fleet-scroll">
          {scenarios.length === 0 && (
            <p className="note">
              No scenarios yet. Your first change to the published timetable starts one.
            </p>
          )}
          {scenarios.map((s) => (
            <Row key={s.id} scenario={s} current={s.id === scenarioId} act={act} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Row({
  scenario,
  current,
  act,
}: {
  scenario: ScenarioSummary;
  current: boolean;
  act: (work: Promise<unknown>) => Promise<unknown>;
}) {
  const set = useStore((s) => s.set);
  const [name, setName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const save = () => {
    if (name !== null && name.trim() && name.trim() !== scenario.name)
      void act(renameScenario(scenario.id, name.trim()));
    setName(null);
  };
  return (
    <div className={`sim-run${current ? ' on' : ''}`}>
      <div className="sim-run-main">
        {name === null ? (
          <div className="sim-run-name">
            <strong className="ellipsis">{scenario.name}</strong>
            {current && <span className="tag tag-info">open</span>}
          </div>
        ) : (
          <input
            className="day-select scenario-rename"
            autoFocus
            value={name}
            aria-label="Name of the scenario"
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(null);
              }
            }}
          />
        )}
        <div className="muted small">
          {scenario.head} change{scenario.head === 1 ? '' : 's'}
          {scenario.createdAt
            ? ` · started ${new Date(scenario.createdAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}`
            : ''}
          {scenario.simRuns
            ? ` · ${scenario.simRuns} simulation run${scenario.simRuns === 1 ? '' : 's'}`
            : ''}
        </div>
      </div>
      <div className="sim-run-tools">
        {!current && (
          <button
            className="button small-button on"
            onClick={() =>
              void act(selectScenario(scenario.id)).then(() => set({ scenariosOpen: false }))
            }
          >
            Open
          </button>
        )}
        <button className="button small-button" onClick={() => setName(scenario.name)}>
          Rename
        </button>
        {!deleting ? (
          <button className="button small-button" onClick={() => setDeleting(true)}>
            Delete
          </button>
        ) : (
          <>
            <button
              className="button small-button danger"
              title={
                scenario.simRuns
                  ? 'Its simulation runs are kept in the library, marked out of date'
                  : 'The scenario and all its changes are deleted'
              }
              onClick={() => void act(deleteScenario(scenario.id))}
            >
              Delete for good
            </button>
            <button className="button small-button" onClick={() => setDeleting(false)}>
              Keep
            </button>
          </>
        )}
      </div>
    </div>
  );
}
