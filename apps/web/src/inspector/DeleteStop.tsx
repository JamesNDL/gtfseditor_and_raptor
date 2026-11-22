import { useEffect, useState } from 'react';
import { applyEdit, undo } from '../scenarios/scenario-client.ts';
import { useStore } from '../app/store.ts';
import { Badge, fmt } from '../shared/ui/parts.tsx';

/** What the server says a deletion would do (apps/api/src/scenarios/edits/delete-stop.ts). */
interface DeletePreview {
  what: 'station' | 'stop' | 'platform';
  label: string;
  stopIds: number[];
  platforms: string[];
  /** What to call them together: platforms, stops, or both. */
  placeWord: string;
  totals: {
    trips: number;
    noLongerCall: number;
    cutShort: number;
    removed: number;
    moved: number;
    movedBusy: number;
    movedUnusual: number;
  };
  lines: {
    routeId: number;
    name: string;
    color: string;
    noLongerCall: number;
    cutShort: number;
    removed: number;
    moved: number;
    savingSecs: number;
    estimated: boolean;
    shorterSecs: number;
    tripsLeft: number;
  }[];
  linesInAll: number;
  movedTo: { label: string; calls: number }[];
  vehicles: { noTripsLeft: number; turnShort: number };
  linksEnded: number;
  warnings: string[];
}

export interface Deletion {
  seq: number;
  summary: string;
  /** It was the scenario's latest change, so undoing once brings the stop back. */
  latest: boolean;
}

const trips = (n: number) => `${fmt(n)} trip${n === 1 ? '' : 's'}`;
const time = (secs: number) => {
  if (secs < 60) return `${Math.round(secs)} second${Math.round(secs) === 1 ? '' : 's'}`;
  const m = Math.round(secs / 6) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};

/** What one line loses, in a few words. */
function lineEffect(l: DeletePreview['lines'][number]): string {
  const parts: string[] = [];
  if (l.moved) parts.push(`${fmt(l.moved)} call${l.moved === 1 ? '' : 's'} move platform`);
  if (l.noLongerCall)
    parts.push(
      `${trips(l.noLongerCall)} no longer call, ${l.savingSecs > 0 ? `${time(l.savingSecs)} quicker${l.estimated ? ' (estimated)' : ''}` : 'no quicker'}`,
    );
  if (l.cutShort) parts.push(`${trips(l.cutShort)} cut short, ${time(l.shorterSecs)} shorter`);
  if (l.removed) parts.push(`${trips(l.removed)} removed`);
  return parts.join('; ');
}

/**
 * Shows what deleting a station, a stop or a platform would do, and deletes it only when the person
 * says so. `stopIds` is the station itself for all of it, or the platforms to take away.
 */
export function DeletePreviewCard({
  stopIds,
  onClose,
}: {
  stopIds: number[];
  onClose: () => void;
}) {
  const scenarioId = useStore((s) => s.scenarioId);
  const dataVersion = useStore((s) => s.dataVersion);
  const busy = useStore((s) => s.editBusy);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = stopIds.join(',');

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError(null);
    fetch(`/api/delete-stop-preview${scenarioId === null ? '' : `?s=${scenarioId}`}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopIds }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok)
          throw new Error(
            (json as { message?: string }).message ?? `The server answered ${res.status}`,
          );
        setPreview(json as DeletePreview);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(String(err.message ?? err));
      });
    return () => controller.abort();
    // The ids are compared by value (`key`): the list itself is made afresh on every render.
  }, [key, scenarioId, dataVersion]);

  const p = preview;
  const t = p?.totals;
  return (
    <section className="reshape-preview delete-preview" data-testid="delete-preview">
      <h3>What deleting it does</h3>
      {error ? (
        <p className="error-text small">That cannot be deleted: {error}</p>
      ) : !p || !t ? (
        <p className="muted">Working it out ...</p>
      ) : (
        <>
          <p>
            <strong>{p.label[0].toUpperCase() + p.label.slice(1)}</strong> is taken out of this
            scenario
            {p.what === 'station' && p.platforms.length > 1
              ? `, with its ${p.platforms.length} ${p.placeWord}`
              : ''}
            .{' '}
            {t.trips === 0
              ? 'Nothing calls there, so no trip changes.'
              : `${trips(t.trips)} on ${fmt(p.linesInAll)} line${p.linesInAll === 1 ? '' : 's'} call there today.`}
          </p>
          {t.moved > 0 && (
            <p>
              {fmt(t.moved)} call{t.moved === 1 ? '' : 's'} move to another platform of the same
              station ({p.movedTo.map((m) => `${fmt(m.calls)} to ${m.label}`).join(', ')}), at the
              same times.{' '}
              {t.movedBusy > 0
                ? `${fmt(t.movedBusy)} of them land on a platform that is in use within a minute of that time; where two trips are there at once it shows as a clash.`
                : 'Each lands on a platform that is free at that time.'}
              {t.movedUnusual > 0
                ? ` ${fmt(t.movedUnusual)} go to a platform their line does not normally use: whether the track lets a train reach it is not known.`
                : ''}
            </p>
          )}
          {t.noLongerCall > 0 && (
            <p>
              {trips(t.noLongerCall)} that call there in the middle of{' '}
              {t.noLongerCall === 1 ? 'its' : 'their'} run no longer call there. Each keeps to the
              same path, and stops after it are earlier by the time saved: the time published trips
              take to run past without stopping, or otherwise an estimate, held so that no vehicle
              passes faster than it runs there today.
            </p>
          )}
          {t.cutShort > 0 && (
            <p>
              {trips(t.cutShort)} that start or end there {t.cutShort === 1 ? 'is' : 'are'} cut
              short to the next or previous stop, and keep {t.cutShort === 1 ? 'its' : 'their'}{' '}
              times at the stops {t.cutShort === 1 ? 'it keeps' : 'they keep'}.
            </p>
          )}
          {t.removed > 0 && (
            <p>
              {trips(t.removed)} {t.removed === 1 ? 'is' : 'are'} removed, because fewer than two
              stops would be left.
            </p>
          )}
          {t.trips > 0 && (
            <p className="muted small">
              Nothing is re-routed, and no vehicle is added. Vehicles stay on their trips
              {p.vehicles.noTripsLeft > 0
                ? `; ${fmt(p.vehicles.noTripsLeft)} vehicle${p.vehicles.noTripsLeft === 1 ? ' has' : 's have'} no trips left and ${p.vehicles.noTripsLeft === 1 ? 'is' : 'are'} no longer needed`
                : '; the number of vehicles does not change'}
              {p.vehicles.turnShort > 0
                ? `; ${fmt(p.vehicles.turnShort)} now start or end a trip short of there`
                : ''}
              {p.linksEnded > 0
                ? `; ${fmt(p.linksEnded)} stay-aboard link${p.linksEnded === 1 ? ' ends' : 's end'}, because the trips no longer meet there`
                : ''}
              .
            </p>
          )}
          {p.warnings.map((w) => (
            <p key={w} className="error-text small">
              {w}
            </p>
          ))}
          {p.lines.length > 0 && (
            <ul className="closure-lines">
              {p.lines.slice(0, 40).map((l) => (
                <li key={l.routeId}>
                  <div className="closure-line-head">
                    <Badge color={l.color}>{l.name}</Badge>
                    <span className="grow">{lineEffect(l)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {p.linesInAll > 40 && (
            <p className="muted small">and {fmt(p.linesInAll - 40)} more lines.</p>
          )}
        </>
      )}
      <div className="actions">
        <button
          className="button danger"
          disabled={busy || !p}
          title="One change, which Ctrl+Z takes back"
          onClick={async () => {
            if (await applyEdit({ kind: 'deleteStop', stopIds })) onClose();
          }}
        >
          {busy ? 'Deleting ...' : p ? `Delete ${p.label}` : 'Delete'}
        </button>
        <button className="button" onClick={onClose}>
          Keep it
        </button>
      </div>
    </section>
  );
}

/** Says that a stop is deleted in this scenario, by which change, and how to get it back. */
export function DeletedNote({ what, deletion }: { what: string; deletion: Deletion }) {
  const busy = useStore((s) => s.editBusy);
  return (
    <div className="note deleted-note" data-testid="deleted-note">
      <p>
        <strong>{what} is deleted in this scenario</strong> (change {deletion.seq}). Nothing calls
        here. It is still drawn on the map, greyed and crossed out, so that it can be found.
      </p>
      <p className="muted small">{deletion.summary}</p>
      {deletion.latest ? (
        <button className="button small-button" disabled={busy} onClick={() => void undo()}>
          Put it back (undo)
        </button>
      ) : (
        <p className="muted small">
          To put it back, undo back to change {deletion.seq} (Ctrl+Z, or the list of changes under
          Timetable).
        </p>
      )}
    </div>
  );
}
