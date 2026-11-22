import { useEffect } from 'react';
import { NewStopTool } from './NewStopTool.tsx';
import { applyEdit } from './scenario.ts';
import { useStore } from './store.ts';

/** Shown while a new line is being drawn: its settings and the stops picked so far. */
export function NewLinePanel() {
  const builder = useStore((s) => s.builder);
  const modes = useStore((s) => s.modes);
  const busy = useStore((s) => s.editBusy);
  const error = useStore((s) => s.editError);
  const set = useStore((s) => s.set);
  const baselineId = useStore((s) => s.baselineId);
  const path = useStore((s) => s.builderPath);
  const wantsRoads = !!builder && builder.followRoads;
  const stopKey = builder
    ? `${builder.modeId}:${builder.loop ? 'loop' : ''}:${builder.stops.map((s) => s.id).join(',')}`
    : '';

  // Work out the road path a moment after the stops change, and show it on the map.
  useEffect(() => {
    if (builder?.reshape) return; // the reshaping panel works out its own path
    set({ builderPath: null });
    if (!wantsRoads || !builder || builder.stops.length < 2 || baselineId === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch('/api/road-path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baselineId,
          modeId: builder.modeId,
          loop: !!builder.loop && builder.stops.length >= 3,
          stopIds: builder.stops.map((s) => s.id),
        }),
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (json) =>
            json && set({ builderPath: { coords: json.coords, description: json.description } }),
        )
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopKey, wantsRoads, baselineId, !!builder?.reshape]);

  if (!builder || builder.reshape) return null;

  const update = (patch: Partial<typeof builder>) => set({ builder: { ...builder, ...patch } });
  const loop = !!builder.loop;
  const enough = builder.stops.length >= (loop ? 3 : 2);
  const ready = builder.name.trim() !== '' && enough && builder.headwayMin >= 1;
  const roadMode = ['bus', 'coach', 'school_bus'].includes(builder.modeId);
  const followLabel = roadMode
    ? 'Follow roads'
    : builder.modeId === 'ferry'
      ? 'Follow existing ferry routes'
      : 'Follow existing track';

  return (
    <aside className="panel inspector" aria-label="New line">
      <div className="inspector-nav">
        <strong>Draw a new line</strong>
        <button
          className="icon-button"
          onClick={() => set({ builder: null, placing: null })}
          aria-label="Cancel"
        >
          ✕
        </button>
      </div>
      <div className="inspector-body">
        <p className="note">
          Click stops on the map in the order the line calls at them.{' '}
          {roadMode ? 'Zoom in until bus stops appear. ' : 'Click a station to stop there. '}
          {roadMode
            ? ''
            : builder.modeId === 'ferry'
              ? 'Between wharves that ferries already link, the line follows their routes; elsewhere it is straight. '
              : 'Between stations that are already linked, the line follows the track; elsewhere it is straight. '}
          Run times are taken from published trips wherever they already run between two of your
          stops; other sections use the typical speed of this mode in the day's timetable.
        </p>

        <div className="form">
          <label>
            <span>Name</span>
            <input
              className="day-select"
              value={builder.name}
              maxLength={12}
              placeholder="X1"
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label>
            <span>Mode</span>
            <select
              className="day-select"
              value={builder.modeId}
              onChange={(e) => update({ modeId: e.target.value })}
            >
              {modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Colour</span>
            <input
              className="day-select colour"
              type="color"
              value={`#${builder.color}`}
              onChange={(e) => update({ color: e.target.value.slice(1) })}
            />
          </label>
          <label className="form-wide">
            <span>
              Runs every (minutes), 06:00 to 22:00, {loop ? 'one way round' : 'both directions'}
            </span>
            <input
              className="day-select"
              type="number"
              min={1}
              max={240}
              value={builder.headwayMin}
              onChange={(e) => update({ headwayMin: Number(e.target.value) })}
            />
          </label>
        </div>

        <label className="timeline-check">
          <input
            type="checkbox"
            checked={builder.followRoads}
            onChange={(e) => update({ followRoads: e.target.checked })}
          />
          {followLabel}
          {wantsRoads && path && <span className="muted"> · {path.description}</span>}
          {wantsRoads && !path && builder.stops.length >= 2 && (
            <span className="muted"> · working out the path ...</span>
          )}
        </label>
        <label
          className="timeline-check"
          title="The line runs round in one direction and returns to its first stop. There is no trip back the other way."
        >
          <input
            type="checkbox"
            checked={loop}
            onChange={(e) => update({ loop: e.target.checked })}
          />
          One-way loop, back to the first stop
        </label>

        <section>
          <h3>Stops ({builder.stops.length})</h3>
          {loop && builder.stops.length >= 2 && (
            <p className="muted small">
              After the last stop the line returns to {builder.stops[0].name}.
            </p>
          )}
          {builder.stops.length === 0 ? (
            <p className="muted">None yet. Click the first stop on the map.</p>
          ) : (
            <ol className="stops">
              {builder.stops.map((s, i) => (
                <li key={`${s.id}-${i}`}>
                  <span className="stop-time">{i + 1}</span>
                  <span className="stop-dot" style={{ borderColor: `#${builder.color}` }} />
                  <span className="stop-name">{s.name}</span>
                  <button
                    className="skip-button always"
                    title="Remove this stop"
                    onClick={() => update({ stops: builder.stops.filter((_, k) => k !== i) })}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <NewStopTool />

        {error && <p className="error-text small">That did not work: {error}</p>}

        <div className="actions">
          <button
            className="button"
            disabled={busy || !ready}
            onClick={async () => {
              const result = await applyEdit({
                kind: 'createLine',
                name: builder.name.trim(),
                modeId: builder.modeId,
                color: builder.color,
                stopIds: builder.stops.map((s) => s.id),
                headwaySecs: builder.headwayMin * 60,
                followRoads: builder.followRoads,
                loop,
              });
              if (result) {
                set({ builder: null, builderPath: null });
                if (result.routeId)
                  useStore
                    .getState()
                    .open({ kind: 'route', id: result.routeId }, { replace: true });
              }
            }}
          >
            {ready
              ? loop
                ? 'Create the loop'
                : 'Create the line'
              : !enough
                ? loop
                  ? 'Pick at least three stops'
                  : 'Pick at least two stops'
                : 'Give it a name'}
          </button>
          <button className="button" onClick={() => set({ builder: null, placing: null })}>
            Cancel
          </button>
        </div>
      </div>
    </aside>
  );
}
