import { useState } from 'react';
import { startClosing } from './builder.ts';
import { clock } from './clock.ts';
import { applyEdit, createScenario, deleteScenario, fixAll, redo, selectScenario, undo, type Conflict } from './scenario.ts';
import { useStore } from './store.ts';

const fmt = (n: number) => n.toLocaleString('en-AU');
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : 'no change');

const RIPPLE: { id: 'none' | 'vehicle' | 'line'; label: string; title: string }[] = [
  { id: 'none', label: 'Nothing else', title: 'Moving a trip moves only that trip' },
  { id: 'vehicle', label: "Its vehicle's later trips", title: "Moving a trip also moves the same vehicle's later trips" },
  { id: 'line', label: 'All later trips', title: 'Moving a trip also moves every later trip on the line in that direction' },
];

export function ScenarioPanel() {
  const scenarios = useStore((s) => s.scenarios);
  const scenarioId = useStore((s) => s.scenarioId);
  const info = useStore((s) => s.scenarioInfo);
  const ripple = useStore((s) => s.ripple);
  const busy = useStore((s) => s.editBusy);
  const error = useStore((s) => s.editError);
  const baselineId = useStore((s) => s.baselineId);
  const showChanged = useStore((s) => s.showChanged);
  const set = useStore((s) => s.set);
  if (baselineId === null) return null;

  const applied = info ? info.edits.filter((e) => e.applied).length : 0;
  const canRedo = info ? info.edits.length > applied : false;

  return (
    <div className="panel scenario">
      {/* The scenario chooser and the two tools stay put; only what is below them scrolls. */}
      <div className="scenario-tools">
      <div className="scenario-head">
        <select
          className="day-select scenario-select"
          value={scenarioId ?? ''}
          onChange={(e) => selectScenario(e.target.value === '' ? null : Number(e.target.value))}
          aria-label="Scenario"
        >
          <option value="">Timetable as published</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="button small-button" onClick={createScenario} title="Start a new scenario from the published timetable">
          New
        </button>
      </div>

      <button
        className="button draw-button"
        title="Create a new line by clicking stops on the map"
        onClick={() =>
          set({ builder: { name: '', modeId: 'bus', color: 'FF4FA3', headwayMin: 15, followRoads: true, loop: false, stops: [] }, builderPath: null, closing: null, closingPreview: null })
        }
      >
        + Draw a new line
      </button>
      <button className="button draw-button close-button" title="Close a stretch of road, or a line between two stations, and see what happens to the services through it" onClick={startClosing}>
        ✕ Close a road or a line
      </button>
      </div>

      <div className="scenario-body">

      <a
        className="button small-button export-link"
        href={`/api/baselines/${baselineId}/export${scenarioId !== null ? `?s=${scenarioId}` : ''}`}
        title="Download this day as a GTFS zip. It takes a minute or two to build; the download starts when it is ready."
      >
        Export GTFS{scenarioId !== null ? ' with these changes' : ''}
      </a>

      {scenarioId === null && (
        <div className="scenario-hint small">
          <strong>How to play</strong>
          <ol className="howto muted">
            <li>Click a line, a vehicle or a station on the map.</li>
            <li>Change something: how often a line runs, a trip's time, a stop, a vehicle type.</li>
            <li>Watch what it costs here: trips, vehicles, clashes.</li>
            <li>Undo anything with Ctrl+Z. The published timetable is never altered.</li>
          </ol>
          <span className="muted">Your first change starts a scenario automatically.</span>
        </div>
      )}

      {scenarioId !== null && info && (
        <>
          <div className="scenario-actions">
            <button className="button small-button" onClick={undo} disabled={busy || applied === 0} title="Undo the last change">
              ↶ Undo
            </button>
            <button className="button small-button" onClick={redo} disabled={busy || !canRedo} title="Redo">
              ↷ Redo
            </button>
            <span className="muted small grow">
              {applied} change{applied === 1 ? '' : 's'}
            </span>
            <DeleteScenario id={info.id} />
          </div>

          <div className="scenario-stats">
            <Stat label="trips" value={fmt(info.stats.trips)} delta={signed(info.stats.trips - info.stats.baselineTrips)} />
            <Stat
              label="vehicles (est.)"
              value={fmt(info.stats.vehicles)}
              delta={signed(info.stats.vehicles - info.stats.baselineVehicles)}
            />
            <Stat
              label="clashes"
              value={fmt(info.conflicts.length)}
              delta={info.conflicts.length ? 'caused by your changes' : 'none from your changes'}
              warn={info.conflicts.length > 0}
            />
          </div>

          {info.stats.unassigned > 0 && (
            <p className="scenario-note warn-text small">
              {fmt(info.stats.unassigned)} new trip{info.stats.unassigned === 1 ? ' has' : 's have'} no vehicle yet, so the vehicle count above
              leaves {info.stats.unassigned === 1 ? 'it' : 'them'} out.
            </p>
          )}

          <div className="scenario-ripple">
            <span className="muted small">When I move a trip, also move</span>
            <div className="speeds" role="group" aria-label="What moves with a retimed trip">
              {RIPPLE.map((r) => (
                <button key={r.id} className={ripple === r.id ? 'on' : ''} title={r.title} onClick={() => set({ ripple: r.id })}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="scenario-note error-text small">Could not apply that: {error}</p>}

          {info.fleet.length > 0 && (
            <div className="scenario-section">
              <h3>Fleet</h3>
              <ul className="conflicts">
                {info.fleet.map((f) => (
                  <li key={f.id}>
                    <button className="conflict-title" onClick={() => set({ fleetOpen: true })} title="Open the vehicle catalogue">
                      <span className="conflict-mark" aria-hidden="true">
                        !
                      </span>
                      Not enough {f.name}
                    </button>
                    <div className="muted small">
                      Needs {fmt(f.inUse)}, the fleet has {fmt(f.fleetSize)} ({fmt(f.inUse - f.fleetSize)} short)
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {info.impact.length > 0 && (
            <div className="scenario-section">
              <div className="section-head">
                <h3>What changed, by line</h3>
                <label className="check small muted" title="Outline these lines in yellow on the map">
                  <input type="checkbox" checked={showChanged} onChange={(e) => set({ showChanged: e.target.checked })} /> show on map
                </label>
              </div>
              <ul className="impact">
                {info.impact.map((line) => (
                  <ImpactRow key={line.routeId} line={line} />
                ))}
              </ul>
            </div>
          )}

          {info.conflicts.length > 0 && (
            <div className="scenario-section">
              <div className="section-head">
                <h3>Clashes</h3>
                <button
                  className="button small-button"
                  disabled={busy}
                  title="Applies the suggested fix to each clash in turn, re-checking after each one. Every fix can be undone."
                  onClick={() => void fixAll()}
                >
                  Fix all
                </button>
              </div>
              <ul className="conflicts">
                {info.conflicts.slice(0, 30).map((c, i) => (
                  <ConflictRow key={`${c.kind}-${c.tripId}-${c.otherTripId}-${i}`} conflict={c} busy={busy} />
                ))}
              </ul>
              {info.conflicts.length > 30 && <p className="muted small">and {info.conflicts.length - 30} more</p>}
            </div>
          )}

          {applied > 0 && (
            <div className="scenario-section">
              <h3>Changes</h3>
              <ol className="edits">
                {[...info.edits]
                  .reverse()
                  .slice(0, 8)
                  .map((e) => (
                    <li key={e.seq} className={e.applied ? '' : 'undone'}>
                      {e.summary}
                    </li>
                  ))}
              </ol>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}

function ImpactRow({ line }: { line: NonNullable<ReturnType<typeof useStore.getState>['scenarioInfo']>['impact'][number] }) {
  const open = useStore((s) => s.open);
  const openTimeline = useStore((s) => s.openTimeline);
  const change = (before: number, after: number, unit: string) =>
    before === after ? `${fmt(after)} ${unit}` : `${fmt(before)} → ${fmt(after)} ${unit} (${signed(after - before)})`;
  return (
    <li>
      <button
        className="impact-row"
        title="Open this line and its stringline"
        onClick={() => {
          open({ kind: 'route', id: line.routeId }, { replace: true });
          openTimeline({ tab: 'stringline', routeId: line.routeId });
        }}
      >
        <span className="badge" style={{ background: `#${line.color}` }}>
          {line.name}
        </span>
        <span className="impact-text">
          <span>{change(line.tripsBefore, line.tripsAfter, 'trips')}</span>
          <span>{change(line.vehiclesBefore, line.vehiclesAfter, 'vehicles')}</span>
          {line.placesBefore !== line.placesAfter && <span>{change(line.placesBefore, line.placesAfter, 'places a day')}</span>}
          <span className="muted">
            {fmt(line.changedTrips)} trip{line.changedTrips === 1 ? '' : 's'} new or changed
          </span>
        </span>
      </button>
    </li>
  );
}

/** Deleting a scenario cannot be undone, so it takes two clicks. */
function DeleteScenario({ id }: { id: number }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <button className="button small-button" onClick={() => setConfirm(true)} title="Delete this scenario and all its changes">
        Delete
      </button>
    );
  }
  return (
    <>
      <button className="button small-button danger" onClick={() => deleteScenario(id)}>
        Delete for good
      </button>
      <button className="button small-button" onClick={() => setConfirm(false)}>
        Keep
      </button>
    </>
  );
}

function Stat({ label, value, delta, warn }: { label: string; value: string; delta: string; warn?: boolean }) {
  return (
    <div className="scenario-stat">
      <div className={`stat-value${warn ? ' warn-text' : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
      <div className="muted scenario-delta">{delta}</div>
    </div>
  );
}

function ConflictRow({ conflict, busy }: { conflict: Conflict; busy: boolean }) {
  const open = useStore((s) => s.open);
  const openTimeline = useStore((s) => s.openTimeline);
  const setView = useStore((s) => s.setView);
  const show = () => {
    open({ kind: 'trip', id: conflict.tripId }, { replace: true });
    clock.set(conflict.atSecs);
    setView(conflict.atSecs - 1800, conflict.atSecs + 1800);
    if (conflict.kind === 'platform' && conflict.stopId) openTimeline({ tab: 'platforms', stationId: conflict.stopId, focusStopId: conflict.stopId });
    else openTimeline({ tab: 'vehicles' });
  };
  return (
    <li>
      <button className="conflict-title" onClick={show} title="Show this on the map and timeline">
        <span className="conflict-mark" aria-hidden="true">
          !
        </span>
        {conflict.title}
      </button>
      <div className="muted small">{conflict.detail}</div>
      {conflict.fixes.map((f) => (
        <button key={f.label} className="button small-button fix" disabled={busy} onClick={() => applyEdit(f.edit)}>
          Fix: {f.label}
        </button>
      ))}
    </li>
  );
}
