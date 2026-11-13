import { useEffect, useState } from 'react';
import { useApi, type RouteDetail } from './api.ts';
import { isRoadMode, startReshape } from './builder.ts';
import { Badge, fmt, shortStop, Tag } from './inspector/parts.tsx';
import { applyEdit } from './scenario.ts';
import { useStore } from './store.ts';

interface Side {
  coords: [number, number][];
  trips: number;
  /** "2 stops added, 1 removed" */
  what: string;
  /** "trip times about 4 min longer" */
  change: string;
}

interface Preview extends Side {
  /** How new stretches were drawn and timed; empty when there are none. */
  stretches: string;
  /** Null when the line runs one way only. */
  otherWay: Side | { reason: string } | { same: true } | null;
}

const INSERT_AT = [
  { id: 'best', label: 'Where it fits', title: 'A clicked stop joins the line where it adds the least distance' },
  { id: 'end', label: 'At the end', title: 'A clicked stop becomes the new last stop' },
  { id: 'start', label: 'At the start', title: 'A clicked stop becomes the new first stop' },
] as const;

/** Shown while an existing line's stops are being changed: extend, cut short, re-route, add or remove stops. */
export function ReshapePanel() {
  const builder = useStore((s) => s.builder);
  const busy = useStore((s) => s.editBusy);
  const error = useStore((s) => s.editError);
  const set = useStore((s) => s.set);
  const scenarioId = useStore((s) => s.scenarioId);
  const reshape = builder?.reshape ?? null;
  const route = useApi<RouteDetail>(reshape ? `/api/routes/${reshape.routeId}` : null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const stopKey = builder ? builder.stops.map((s) => s.id).join(',') : '';
  const roads = !!builder && isRoadMode(builder.modeId);
  const request = reshape && builder
    ? JSON.stringify({
        patternId: reshape.patternId,
        stopIds: builder.stops.map((s) => s.id),
        followRoads: builder.followRoads,
        direct: roads && reshape.direct,
        bothWays: reshape.bothWays,
      })
    : null;

  // Work out what the change would do a moment after the stops change, and show its path on the map.
  useEffect(() => {
    if (!request) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setWorking(true);
    const timer = setTimeout(() => {
      fetch(`/api/reshape-preview${scenarioId === null ? '' : `?s=${scenarioId}`}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request,
        signal: controller.signal,
      })
        .then(async (r) => ({ ok: r.ok, json: await r.json() }))
        .then(({ ok, json }) => {
          setWorking(false);
          if (!ok) {
            setPreview(null);
            setHint(json.message ?? 'That change cannot be made');
            set({ builderPath: null });
            return;
          }
          const result = json as Preview;
          setPreview(result);
          setHint(null);
          const other = result.otherWay && 'coords' in result.otherWay ? result.otherWay.coords : null;
          set({ builderPath: { coords: result.coords, description: result.stretches, otherCoords: other } });
        })
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, scenarioId, set]);

  if (!builder || !reshape) return null;

  const update = (patch: Partial<typeof builder>) => set({ builder: { ...builder, ...patch } });
  const option = (patch: Partial<typeof reshape>) => update({ reshape: { ...reshape, ...patch } });
  const cancel = () => set({ builder: null, builderPath: null });
  const original = new Set(reshape.original.map((s) => s.id));
  const changed = stopKey !== reshape.original.map((s) => s.id).join(',');
  const r = route.data;
  const other = preview?.otherWay ?? null;

  return (
    <aside className="panel inspector" aria-label="Change route">
      <div className="inspector-nav">
        <strong>Change the route</strong>
        <button className="icon-button" onClick={cancel} aria-label="Cancel">
          ✕
        </button>
      </div>
      <div className="inspector-body">
        <div className="title-row">
          <Badge color={builder.color}>{builder.name}</Badge>
          <div className="muted">
            Click a stop on the map to add it to the line. Click a stop that is already on the line, or "Remove" below, to take it off.
          </div>
        </div>

        {r && r.patterns.length > 1 && (
          <div className="form">
            <label className="form-wide">
              <span>Which trips (this line runs {r.patterns.length} stop patterns)</span>
              <select
                className="day-select"
                value={reshape.patternId}
                onChange={(e) => void startReshape({ id: reshape.routeId, name: builder.name, modeId: builder.modeId, color: builder.color }, Number(e.target.value))}
              >
                {r.patterns.map((p) => (
                  <option key={p.id} value={p.id}>
                    {shortStop(p.firstStop)} → {shortStop(p.lastStop)} · {p.stopCount} stops · {fmt(p.tripCount)} trips
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <section>
          <div className="section-head">
            <h3>A clicked stop goes</h3>
            <div className="speeds">
              {INSERT_AT.map((o) => (
                <button key={o.id} className={reshape.insertAt === o.id ? 'on' : ''} title={o.title} onClick={() => option({ insertAt: o.id })}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <label className="timeline-check">
            <input type="checkbox" checked={reshape.bothWays} onChange={(e) => option({ bothWays: e.target.checked })} />
            Change the other direction to match
          </label>
          {roads && (
            <>
              <label className="timeline-check">
                <input type="checkbox" checked={builder.followRoads} onChange={(e) => update({ followRoads: e.target.checked })} />
                New stretches follow roads
              </label>
              <label className="timeline-check" title="Otherwise the bus keeps to its published path and simply does not stop">
                <input type="checkbox" checked={reshape.direct} onChange={(e) => option({ direct: e.target.checked })} />
                Where stops are removed, take the direct road
              </label>
            </>
          )}
        </section>

        <section className="reshape-preview">
          <h3>What this does</h3>
          {!changed ? (
            <p className="muted">Nothing yet. The line is as published.</p>
          ) : preview ? (
            <>
              <p>
                {preview.what} on {fmt(preview.trips)} trip{preview.trips === 1 ? '' : 's'}; {preview.change}.
                {preview.stretches && <span className="muted"> {preview.stretches[0].toUpperCase() + preview.stretches.slice(1)}.</span>}
              </p>
              {other && 'coords' in other && (
                <p>
                  Other direction: {other.what} on {fmt(other.trips)} trip{other.trips === 1 ? '' : 's'}; {other.change}.
                </p>
              )}
              {other && 'reason' in other && <p className="muted">The other direction stays as it is: {other.reason}.</p>}
              {other && 'same' in other && <p className="muted">The other direction already matches.</p>}
              {!other && reshape.bothWays && <p className="muted">This stop pattern has no opposite direction to change.</p>}
              <p className="muted small">
                Trips keep their times at the first stop that has not changed. Other stop patterns of this line are not touched.
              </p>
            </>
          ) : (
            <p className="muted">{working ? 'Working it out ...' : (hint ?? '')}</p>
          )}
        </section>

        <section>
          <div className="section-head">
            <h3>Stops ({builder.stops.length})</h3>
            {changed && (
              <button className="link" onClick={() => update({ stops: reshape.original })}>
                Put back the published stops
              </button>
            )}
          </div>
          <ol className="stops">
            {builder.stops.map((s, i) => (
              <li key={`${s.id}-${i}`}>
                <span className="stop-time">{i + 1}</span>
                <span className="stop-dot" style={{ borderColor: `#${builder.color}` }} />
                <span className="stop-name">
                  {shortStop(s.name)}
                  {!original.has(s.id) && <Tag kind="info">new</Tag>}
                </span>
                <button
                  className="skip-button always"
                  title="Take this stop off the line"
                  disabled={builder.stops.length <= 2}
                  onClick={() => update({ stops: builder.stops.filter((_, k) => k !== i) })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        </section>

        {error && <p className="error-text small">Could not change the line: {error}</p>}

        <div className="actions">
          <button
            className="button"
            disabled={busy || !preview || !changed}
            onClick={async () => {
              const result = await applyEdit({ kind: 'reshape', ...JSON.parse(request!) });
              if (result) {
                set({ builder: null, builderPath: null });
                useStore.getState().open({ kind: 'route', id: reshape.routeId }, { replace: true });
              }
            }}
          >
            {busy ? 'Changing ...' : preview && changed ? `Change ${fmt(preview.trips + (other && 'coords' in other ? other.trips : 0))} trips` : 'Change the line'}
          </button>
          <button className="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </aside>
  );
}
