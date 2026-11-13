import { useEffect, useState } from 'react';
import { Badge, fmt, shortStop } from './inspector/parts.tsx';
import { applyEdit } from './scenario.ts';
import { useStore, type Closing } from './store.ts';

type Action = 'detour' | 'shortened' | 'split' | 'removed' | 'blocked' | 'failed';

interface Preview {
  label: string;
  zone: GeoJSON.Geometry;
  lines: { routeId: number; name: string; color: string; trips: number; patterns: number; actions: Action[] }[];
  trips: { detour: number; split: number; shortened: number; removed: number; blocked: number };
  closedStops: string[];
  skipped: number;
  paths: [number, number][][];
}

const WHAT = [
  { id: 'road', label: 'A road (buses and coaches)' },
  { id: 'train', label: 'A train line' },
  { id: 'metro', label: 'A metro line' },
  { id: 'light_rail', label: 'A light rail line' },
  { id: 'ferry', label: 'A ferry route' },
];

const REACH = [50, 100, 200, 400];

const ACTION: Record<Action, string> = {
  detour: 'goes another way',
  shortened: 'cut short',
  split: 'runs in two parts',
  removed: 'removed',
  blocked: 'no way round found',
  failed: 'cannot be changed',
};

const trips = (n: number) => `${fmt(n)} trip${n === 1 ? '' : 's'}`;

/** The request the server needs, or null while the closure is not yet placed. */
function requestFor(closing: Closing, baselineId: number): Record<string, unknown> | null {
  if (closing.what === 'road') {
    return closing.point ? { what: 'road', baselineId, lon: closing.point.lon, lat: closing.point.lat, radiusM: closing.radiusM } : null;
  }
  return closing.from && closing.to ? { what: closing.what, baselineId, fromStopId: closing.from.id, toStopId: closing.to.id } : null;
}

/** Shown while a road or a line is being closed: where it is, and what happens to the services through it. */
export function ClosurePanel() {
  const closing = useStore((s) => s.closing);
  const busy = useStore((s) => s.editBusy);
  const error = useStore((s) => s.editError);
  const set = useStore((s) => s.set);
  const scenarioId = useStore((s) => s.scenarioId);
  const baselineId = useStore((s) => s.baselineId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const body = closing && baselineId !== null ? requestFor(closing, baselineId) : null;
  const request = body ? JSON.stringify(body) : null;

  // Work out what the closure would do a moment after it is placed, and show it on the map.
  useEffect(() => {
    setPreview(null);
    setHint(null);
    set({ closingPreview: null });
    if (!request) return;
    const controller = new AbortController();
    setWorking(true);
    const timer = setTimeout(() => {
      fetch(`/api/close-preview${scenarioId === null ? '' : `?s=${scenarioId}`}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request,
        signal: controller.signal,
      })
        .then(async (r) => ({ ok: r.ok, json: await r.json() }))
        .then(({ ok, json }) => {
          setWorking(false);
          if (!ok) return setHint(json.message ?? 'That cannot be closed');
          const result = json as Preview;
          setPreview(result);
          set({ closingPreview: { zone: result.zone, paths: result.paths } });
        })
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, scenarioId, set]);

  if (!closing) return null;

  const road = closing.what === 'road';
  const update = (patch: Partial<Closing>) => set({ closing: { ...closing, ...patch } });
  const cancel = () => set({ closing: null, closingPreview: null });
  const affected = preview ? preview.trips.detour + preview.trips.split + preview.trips.shortened + preview.trips.removed : 0;

  return (
    <aside className="panel inspector" aria-label="Close a road or a line">
      <div className="inspector-nav">
        <strong>Close a road or a line</strong>
        <button className="icon-button" onClick={cancel} aria-label="Cancel">
          ✕
        </button>
      </div>
      <div className="inspector-body">
        <p className="note">
          {road
            ? 'Click the map where the road is closed. Buses that use it are sent round by other roads and miss the stops inside the closed stretch.'
            : 'Click the station on one side of the closure, then the station on the other. Nothing runs between them: each trip ends at the last station before the closure and starts again from the first one after it.'}
        </p>

        <div className="form">
          <label className="form-wide">
            <span>What is closed</span>
            <select
              className="day-select"
              value={closing.what}
              onChange={(e) => update({ what: e.target.value, point: null, from: null, to: null })}
            >
              {WHAT.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {road ? (
          <section>
            <div className="section-head">
              <h3>How far it reaches each way</h3>
              <div className="speeds">
                {REACH.map((m) => (
                  <button key={m} className={closing.radiusM === m ? 'on' : ''} onClick={() => update({ radiusM: m })}>
                    {m} m
                  </button>
                ))}
              </div>
            </div>
            {!closing.point && <p className="muted">Not placed yet. Zoom in and click the road.</p>}
          </section>
        ) : (
          <section>
            <h3>Between</h3>
            <ol className="stops">
              {[closing.from, closing.to].map((stop, i) => (
                <li key={i}>
                  <span className="stop-time">{i + 1}</span>
                  <span className="stop-dot" style={{ borderColor: '#ff3b30' }} />
                  <span className="stop-name">{stop ? shortStop(stop.name) : <span className="muted">{i === 0 ? 'Click a station' : 'Click the station on the other side'}</span>}</span>
                </li>
              ))}
            </ol>
            {closing.from && (
              <button className="link" onClick={() => update({ from: null, to: null })}>
                Start again
              </button>
            )}
          </section>
        )}

        <section className="reshape-preview">
          <h3>What this does</h3>
          {!request ? (
            <p className="muted">Nothing yet.</p>
          ) : preview ? (
            preview.lines.length === 0 ? (
              <p className="muted">Nothing runs through there on this day.</p>
            ) : (
              <>
                <p>
                  {preview.label}. {trips(affected)} on {fmt(preview.lines.length)} line{preview.lines.length === 1 ? '' : 's'} change:
                  {[
                    preview.trips.detour ? ` ${trips(preview.trips.detour)} go another way` : '',
                    preview.trips.split ? ` ${trips(preview.trips.split)} run in two parts, one either side` : '',
                    preview.trips.shortened ? ` ${trips(preview.trips.shortened)} are cut short` : '',
                    preview.trips.removed ? ` ${trips(preview.trips.removed)} are removed` : '',
                  ]
                    .filter(Boolean)
                    .join(',')}
                  .
                </p>
                {preview.closedStops.length > 0 && (
                  <p>
                    Closed stop{preview.closedStops.length === 1 ? '' : 's'}: {preview.closedStops.slice(0, 8).join(', ')}
                    {preview.closedStops.length > 8 ? ` and ${preview.closedStops.length - 8} more` : ''}.
                  </p>
                )}
                {preview.trips.blocked > 0 && <p className="error-text small">{trips(preview.trips.blocked)} cannot be sent round and will be left as they are.</p>}
                {preview.skipped > 0 && (
                  <p className="error-text small">
                    This closure touches more stop patterns than can be changed at once; {fmt(preview.skipped)} will be left as they are. Close a shorter stretch to change them.
                  </p>
                )}
                {!road && preview.trips.split > 0 && (
                  <p className="muted small">Trips that are split are given vehicles again, because a vehicle cannot cross the closure.</p>
                )}
                <ul className="closure-lines">
                  {preview.lines.slice(0, 40).map((l) => (
                    <li key={l.routeId}>
                      <Badge color={l.color}>{l.name}</Badge>
                      <span>{trips(l.trips)}</span>
                      <span className="muted">{l.actions.map((a) => ACTION[a]).join(', ')}</span>
                    </li>
                  ))}
                </ul>
                {preview.lines.length > 40 && <p className="muted small">and {preview.lines.length - 40} more lines.</p>}
              </>
            )
          ) : (
            <p className="muted">{working ? 'Working it out ...' : (hint ?? '')}</p>
          )}
        </section>

        {error && <p className="error-text small">That did not work: {error}</p>}

        <div className="actions">
          <button
            className="button"
            disabled={busy || !preview || affected === 0}
            onClick={async () => {
              if (await applyEdit({ kind: 'close', ...body })) cancel();
            }}
          >
            {busy ? 'Closing ...' : affected > 0 ? `Close it and change ${trips(affected)}` : 'Close it'}
          </button>
          <button className="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </aside>
  );
}
