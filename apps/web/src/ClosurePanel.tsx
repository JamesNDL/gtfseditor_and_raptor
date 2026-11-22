import { useEffect, useState } from 'react';
import { distanceM } from '@gtfs-editor/core';
import { Badge, fmt } from './inspector/parts.tsx';
import { togglePart } from './builder.ts';
import { applyEdit } from './scenario.ts';
import { SIDE_COLORS, useStore, type Closing } from './store.ts';

type Action =
  'detour' | 'shortened' | 'split' | 'joined' | 'removed' | 'blocked' | 'failed' | 'left';
type How = 'split' | 'detour' | 'leave';

interface Part {
  side: string;
  trips: number;
  kept: boolean;
  /** The stop where most of its trips turn back, and at how many different stops they do. */
  turnsAt: string;
  turnPlaces: number;
}

interface Line {
  routeId: number;
  name: string;
  color: string;
  modeId: string;
  /** A bus or coach line, which can be sent round by other roads. */
  road: boolean;
  how: How;
  keep: string;
  trips: number;
  patterns: number;
  actions: Action[];
  parts: Part[];
}

interface Preview {
  label: string;
  zone: GeoJSON.Geometry;
  modes: { id: string; name: string; lines: number }[];
  /** The two sides of the line drawn, by compass. */
  sides: { code: string; name: string }[] | null;
  lines: Line[];
  trips: {
    detour: number;
    split: number;
    shortened: number;
    joined: number;
    removed: number;
    blocked: number;
    left: number;
  };
  closedStops: string[];
  skipped: number;
  paths: [number, number][][];
  parts: { side: string; kept: boolean; coords: [number, number][]; routeIds: number[] }[];
  turns: { name: string; lon: number; lat: number; side: string; kept: boolean }[];
}

// How far either side of the drawn line is closed.
const REACH = [10, 20, 50, 100];

const ACTION: Record<Action, string> = {
  detour: 'goes another way',
  shortened: 'one part kept',
  split: 'runs in two parts',
  joined: 'turns round before it',
  removed: 'removed',
  blocked: 'no way round found',
  failed: 'cannot be changed',
  left: 'left running',
};

const trips = (n: number) => `${fmt(n)} trip${n === 1 ? '' : 's'}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function lengthText(line: [number, number][]) {
  let metres = 0;
  for (let i = 1; i < line.length; i++)
    metres += distanceM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
  return metres >= 950
    ? `${(metres / 1000).toFixed(1)} km`
    : `${fmt(Math.max(10, Math.round(metres / 10) * 10))} m`;
}

const secsOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 3600 + m * 60 : null;
};

/** The times of a closure that lasts part of the day. An end at or before the start is the next morning. */
function windowOf(closing: Closing): { fromSecs: number; toSecs: number } | null {
  const fromSecs = secsOf(closing.startAt);
  const end = secsOf(closing.endAt);
  if (fromSecs === null || end === null) return null;
  return { fromSecs, toSecs: end <= fromSecs ? end + 24 * 3600 : end };
}

/** The request the server needs, or null while the closure is not yet drawn. */
function requestFor(closing: Closing, baselineId: number): Record<string, unknown> | null {
  const when = closing.allDay ? {} : windowOf(closing);
  if (!when) return null;
  if (closing.line.length < 2) return null;
  return {
    what: 'cut',
    baselineId,
    line: closing.line,
    widthM: closing.widthM,
    exceptModes: closing.exceptModes,
    roads: closing.roads,
    keep: closing.keep,
    lines: closing.lines,
    ...when,
  };
}

/** Shown while a closure is being drawn: the line, what it cuts, and what becomes of each line it crosses. */
export function ClosurePanel() {
  const closing = useStore((s) => s.closing);
  const busy = useStore((s) => s.editBusy);
  const error = useStore((s) => s.editError);
  const set = useStore((s) => s.set);
  const scenarioId = useStore((s) => s.scenarioId);
  const baselineId = useStore((s) => s.baselineId);
  const focus = useStore((s) => s.closingFocus);
  const only = useStore((s) => s.closingOnly);
  const [preview, setPreview] = useState<Preview | null>(null);
  // The last answer, kept on show while the next is worked out so that the controls do not jump about.
  const [last, setLast] = useState<Preview | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const drawn = (closing?.line.length ?? 0) >= 2;
  useEffect(() => {
    if (!drawn) setLast(null);
  }, [drawn]);

  // Escape puts the tool away.
  const active = closing !== null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        e.key === 'Escape' &&
        !(target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
      )
        set({ closing: null, closingPreview: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, set]);

  const body = closing && baselineId !== null ? requestFor(closing, baselineId) : null;
  const request = body ? JSON.stringify(body) : null;

  // Work out what the closure would do a moment after it is drawn or changed, and show it on the map.
  useEffect(() => {
    setPreview(null);
    setHint(null);
    if (!request) {
      set({ closingPreview: null });
      return;
    }
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
          if (!ok) {
            set({ closingPreview: null });
            setLast(null);
            return setHint(json.message ?? 'That cannot be closed');
          }
          const result = json as Preview;
          setPreview(result);
          setLast(result);
          set({
            closingPreview: {
              zone: result.zone,
              paths: result.paths,
              parts: result.parts,
              turns: result.turns,
              sides: (result.sides ?? []).map((s) => s.code),
              lines: result.lines.map((l) => ({
                routeId: l.routeId,
                name: l.name,
                keep: l.keep,
                parts: l.parts.map((p) => ({ side: p.side, kept: p.kept })),
              })),
            },
          });
        })
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, scenarioId, set]);

  if (!closing) return null;

  const update = (patch: Partial<Closing>) => set({ closing: { ...closing, ...patch } });
  const cancel = () =>
    set({ closing: null, closingPreview: null, closingFocus: null, closingOnly: null });
  const when = closing.allDay ? null : windowOf(closing);
  const overnight = when !== null && when.toSecs > 24 * 3600;
  const shown = preview ?? last;
  const modes = shown?.modes ?? [];
  const sides = shown?.sides ?? null;
  const listed = shown
    ? only
      ? shown.lines.filter((l) => only.includes(l.routeId))
      : shown.lines
    : [];
  const anyRoad = shown ? shown.lines.some((l) => l.road) : false;
  const changing = (p: Preview) =>
    p.trips.detour + p.trips.split + p.trips.shortened + p.trips.joined + p.trips.removed;
  const affected = preview ? changing(preview) : 0;
  const sideColor = (code: string) =>
    SIDE_COLORS[Math.max(0, sides?.findIndex((s) => s.code === code) ?? 0)];
  /** One line's own choice, set apart from the choice for all lines. */
  const choose = (routeId: number, patch: { how?: How | ''; keep?: string }) => {
    const next = { ...closing.lines };
    const mine: { how?: How | ''; keep?: string } = { ...next[routeId], ...patch };
    if (!mine.how) delete mine.how;
    if (!mine.keep) delete mine.keep;
    if (mine.how || mine.keep) next[routeId] = mine as { how?: How; keep?: string };
    else delete next[routeId];
    update({ lines: next });
  };

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
          Click the map on one side of what is closed, then on the other. Every line the red line
          crosses is split there: the part on each side becomes a line of its own, with its own
          timetable, and its vehicles turn back at the last stop before the closure. You choose
          which parts to keep.
        </p>

        <section>
          <div className="section-head">
            <h3>The line</h3>
            <div className="speeds" title="How far either side of the line counts as closed.">
              {REACH.map((m) => (
                <button
                  key={m}
                  className={closing.widthM === m ? 'on' : ''}
                  onClick={() => update({ widthM: m })}
                >
                  {m} m
                </button>
              ))}
            </div>
          </div>
          {closing.line.length < 2 ? (
            <p className="muted">
              {closing.line.length === 0
                ? 'Not drawn yet. Click the map.'
                : 'One point placed. Click the map on the other side.'}
            </p>
          ) : (
            <p className="muted">
              {lengthText(closing.line)} long, closed {closing.widthM} m either side. Click the map
              again to carry it on.
            </p>
          )}
          {closing.line.length > 0 && (
            <div className="sim-run-actions">
              <button className="link" onClick={() => update({ line: closing.line.slice(0, -1) })}>
                Take off the last point
              </button>
              <button
                className="link"
                onClick={() => (
                  set({ closingOnly: null, closingFocus: null }),
                  update({ line: [], lines: {}, keep: 'both' })
                )}
              >
                Start again
              </button>
            </div>
          )}
        </section>

        {modes.length > 0 && (
          <section>
            <h3>What it closes</h3>
            <div className="closure-modes">
              {modes.map((m) => (
                <label
                  key={m.id}
                  className="check"
                  title={`Untick to leave ${m.name.toLowerCase()} services running through, for instance where they pass over or under on a bridge`}
                >
                  <input
                    type="checkbox"
                    checked={!closing.exceptModes.includes(m.id)}
                    onChange={(e) =>
                      update({
                        exceptModes: e.target.checked
                          ? closing.exceptModes.filter((id) => id !== m.id)
                          : [...closing.exceptModes, m.id],
                      })
                    }
                  />{' '}
                  {m.name}{' '}
                  <span className="muted">
                    ({fmt(m.lines)} line{m.lines === 1 ? '' : 's'})
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        {sides && (
          <section>
            <div className="section-head">
              <h3>Which side to keep</h3>
              <div className="speeds" role="group" aria-label="Which side to keep">
                <button
                  className={closing.keep === 'both' ? 'on' : ''}
                  onClick={() => update({ keep: 'both' })}
                >
                  Both
                </button>
                {sides.map((s) => (
                  <button
                    key={s.code}
                    className={closing.keep === s.code ? 'on' : ''}
                    onClick={() => update({ keep: s.code })}
                    title={`Keep only the parts ${s.name} of the closure; the others are removed`}
                  >
                    <span className="side-dot" style={{ background: sideColor(s.code) }} />{' '}
                    {capital(s.name)} only
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small">
              On the map: <span className="side-dot" style={{ background: SIDE_COLORS[0] }} /> the{' '}
              {sides[0].name} parts,{' '}
              <span className="side-dot" style={{ background: SIDE_COLORS[1] }} /> the{' '}
              {sides[1].name} parts, grey for what is dropped. A ring marks each stop where vehicles
              turn back.
            </p>
          </section>
        )}

        {anyRoad && (
          <section>
            <div className="section-head">
              <h3>Buses and coaches</h3>
              <div className="speeds" role="group" aria-label="What happens to buses and coaches">
                <button
                  className={closing.roads === 'split' ? 'on' : ''}
                  onClick={() => update({ roads: 'split' })}
                  title="Each line becomes a part on each side, turning back at the closure"
                >
                  Split at the line
                </button>
                <button
                  className={closing.roads === 'detour' ? 'on' : ''}
                  onClick={() => update({ roads: 'detour' })}
                  title="Each line keeps its stops and goes round by other roads. Slower to work out: a way round is looked for on every line."
                >
                  Send round
                </button>
              </div>
            </div>
            <p className="muted small">
              Trains, trams and ferries cannot go round, so they are always split. Any one line can
              be treated differently in the list below.
            </p>
          </section>
        )}

        <section>
          <div className="section-head">
            <h3>When</h3>
            <div className="speeds">
              <button
                className={closing.allDay ? 'on' : ''}
                onClick={() => update({ allDay: true })}
              >
                All day
              </button>
              <button
                className={closing.allDay ? '' : 'on'}
                onClick={() => update({ allDay: false })}
              >
                Part of the day
              </button>
            </div>
          </div>
          {!closing.allDay && (
            <>
              <div className="closure-times">
                <span>from</span>
                <input
                  className="day-select"
                  type="time"
                  value={closing.startAt}
                  onChange={(e) => update({ startAt: e.target.value })}
                  aria-label="Closure starts"
                />
                <span>to</span>
                <input
                  className="day-select"
                  type="time"
                  value={closing.endAt}
                  onChange={(e) => update({ endAt: e.target.value })}
                  aria-label="Closure ends"
                />
                {overnight && <span className="muted">the next morning</span>}
              </div>
              <p className="muted small">
                Only trips that would be in the closed stretch between these times change. Trips
                before and after run as published.
              </p>
            </>
          )}
        </section>

        <section className="reshape-preview">
          <h3>What this does</h3>
          {!request ? (
            <p className="muted">Nothing yet: draw the line first.</p>
          ) : !shown ? (
            <p className="muted">{working ? 'Working it out ...' : (hint ?? '')}</p>
          ) : shown.lines.length === 0 ? (
            <p className="muted">
              {closing.allDay
                ? 'Nothing runs through there on this day.'
                : 'Nothing runs through there between those times.'}
            </p>
          ) : (
            <div className={preview ? '' : 'stale'}>
              <p>
                {shown.label}. {trips(changing(shown))} on{' '}
                {fmt(shown.lines.filter((l) => l.how !== 'leave').length)} line
                {shown.lines.filter((l) => l.how !== 'leave').length === 1 ? '' : 's'} change:
                {[
                  shown.trips.split
                    ? ` ${trips(shown.trips.split)} run in two parts, one either side`
                    : '',
                  shown.trips.shortened
                    ? ` ${trips(shown.trips.shortened)} keep the part on one side`
                    : '',
                  shown.trips.joined
                    ? ` ${trips(shown.trips.joined)} crossed and came back, and now turn round before it`
                    : '',
                  shown.trips.detour ? ` ${trips(shown.trips.detour)} go another way` : '',
                  shown.trips.removed ? ` ${trips(shown.trips.removed)} are removed` : '',
                ]
                  .filter(Boolean)
                  .join(',')}
                .{!preview && working ? ' Working it out again ...' : ''}
              </p>
              {shown.closedStops.length > 0 && (
                <p>
                  On the closed stretch itself, and no longer served:{' '}
                  {shown.closedStops.slice(0, 8).join(', ')}
                  {shown.closedStops.length > 8 ? ` and ${shown.closedStops.length - 8} more` : ''}.
                </p>
              )}
              {shown.trips.blocked > 0 && (
                <p className="error-text small">
                  {trips(shown.trips.blocked)} cannot be sent round and will be left as they are.
                </p>
              )}
              {shown.skipped > 0 && (
                <p className="error-text small">
                  This closure touches more stop patterns than can be changed at once;{' '}
                  {fmt(shown.skipped)} will be left as they are. Draw a shorter line to change them.
                </p>
              )}
              {shown.trips.split + shown.trips.shortened > 0 && (
                <p className="muted small">
                  Vehicles are worked out again for the parts, because none can cross the closure:
                  each turns back at the last stop before it.
                </p>
              )}
              <p className="muted small">
                Point at a line here to pick it out on the map. On the map, click a part of a line
                to drop it, and again to keep it; where several run together, a click lists them
                here.
              </p>
              {only && (
                <p className="closure-only">
                  Showing the {fmt(listed.length)} line{listed.length === 1 ? '' : 's'} through the
                  place you clicked.{' '}
                  <button className="link" onClick={() => set({ closingOnly: null })}>
                    Show all {fmt(shown.lines.length)}
                  </button>
                </p>
              )}
              <ul className="closure-lines">
                {listed.slice(0, 60).map((l) => {
                  const own = closing.lines[l.routeId] ?? {};
                  return (
                    <li
                      key={l.routeId}
                      className={focus === l.routeId ? 'focus' : ''}
                      onMouseEnter={() => set({ closingFocus: l.routeId })}
                      onMouseLeave={() => set({ closingFocus: null })}
                    >
                      <div className="closure-line-head">
                        <Badge color={l.color}>{l.name}</Badge>
                        <span>{trips(l.trips)}</span>
                        <span className="muted grow">
                          {l.actions.map((a) => ACTION[a]).join(', ')}
                        </span>
                        <select
                          className="day-select closure-choice"
                          value={own.how ?? ''}
                          aria-label={`What happens to ${l.name}`}
                          onChange={(e) => choose(l.routeId, { how: e.target.value as How | '' })}
                        >
                          <option value="">
                            {l.road && closing.roads === 'detour' ? 'Send round' : 'Split'}
                          </option>
                          {l.road && closing.roads === 'detour' && (
                            <option value="split">Split</option>
                          )}
                          {l.road && closing.roads !== 'detour' && (
                            <option value="detour">Send round</option>
                          )}
                          <option value="leave">Leave running</option>
                        </select>
                      </div>
                      {l.parts.length > 0 && (
                        <div className="closure-parts">
                          {l.parts.map((p) => (
                            <button
                              key={p.side}
                              className={`closure-part${p.kept ? '' : ' dropped'}`}
                              title={
                                p.kept
                                  ? `${l.name}-${p.side} is kept. Click to drop it.`
                                  : `${l.name}-${p.side} is dropped. Click to keep it.`
                              }
                              onClick={() => togglePart(l.routeId, p.side)}
                            >
                              <span
                                className="side-dot"
                                style={{ background: p.kept ? sideColor(p.side) : 'var(--muted)' }}
                              />
                              <strong>
                                {l.name}
                                {p.side ? `-${p.side}` : ''}
                              </strong>
                              <span>
                                {p.kept
                                  ? `turns back at ${p.turnsAt}${p.turnPlaces > 1 ? ' and elsewhere' : ''}`
                                  : 'dropped'}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {listed.length > 60 && (
                <p className="muted small">and {listed.length - 60} more lines.</p>
              )}
            </div>
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
            {busy
              ? 'Closing ...'
              : affected > 0
                ? `Close it and change ${trips(affected)}`
                : 'Close it'}
          </button>
          <button className="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </aside>
  );
}
