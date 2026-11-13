import { formatSecs } from '@gtfs-editor/core';
import { useMemo, useState } from 'react';
import type { RouteDetail } from '../api.ts';
import { applyEdit } from '../scenario.ts';
import { useStore } from '../store.ts';

// The parts of the day most timetables are planned around.
const BANDS = [
  { name: 'Early', from: 5, to: 7 },
  { name: 'Morning peak', from: 7, to: 9 },
  { name: 'Daytime', from: 9, to: 15 },
  { name: 'Afternoon peak', from: 15, to: 19 },
  { name: 'Evening', from: 19, to: 23 },
];

/** How often the line runs now in a band: the typical gap between departures, in minutes. */
function currentMinutes(starts: number[], from: number, to: number): number | null {
  const inBand = starts.filter((s) => s >= from && s < to);
  if (inBand.length < 2) return null;
  const gaps = inBand.slice(1).map((s, i) => s - inBand[i]).sort((a, b) => a - b);
  return Math.round(gaps[Math.floor(gaps.length / 2)] / 60);
}

/** One card for the whole line: how often it runs in each part of the day, both directions together. */
export function FrequencyEditor({ route }: { route: RouteDetail }) {
  const busy = useStore((s) => s.editBusy);
  const now = useMemo(
    () =>
      BANDS.map((b) => {
        const perDirection = route.mainDepartures.map((d) => currentMinutes(d.starts, b.from * 3600, b.to * 3600)).filter((m) => m !== null);
        return perDirection.length ? Math.round(perDirection.reduce((a, m) => a + m, 0) / perDirection.length) : null;
      }),
    [route.mainDepartures],
  );
  // What the user has typed; blank means "leave this part of the day as it is".
  const [typed, setTyped] = useState<string[]>(BANDS.map(() => ''));

  const changes = BANDS.map((b, i) => ({ band: b, minutes: Number(typed[i]) })).filter(
    (c, i) => typed[i].trim() !== '' && Number.isFinite(c.minutes) && c.minutes >= 1 && c.minutes <= 240,
  );
  const invalid = typed.some((t) => t.trim() !== '' && !(Number(t) >= 1 && Number(t) <= 240));

  if (route.mainDepartures.length === 0) return null;

  return (
    <section>
      <h3>How often it runs</h3>
      <p className="muted small form-preview">
        Type a new gap between departures for any part of the day. Both directions change together and vehicles are worked out for you.
      </p>
      <table className="bands">
        <thead>
          <tr>
            <th>Part of the day</th>
            <th className="n">Now</th>
            <th className="n">Change to</th>
          </tr>
        </thead>
        <tbody>
          {BANDS.map((b, i) => (
            <tr key={b.name}>
              <td>
                {b.name}
                <span className="muted small">
                  {' '}
                  {formatSecs(b.from * 3600)} to {formatSecs(b.to * 3600)}
                </span>
              </td>
              <td className="n muted">{now[i] === null ? 'few trips' : `every ${now[i]} min`}</td>
              <td className="n">
                <input
                  className="day-select edit-number"
                  type="number"
                  min={1}
                  max={240}
                  placeholder={now[i] === null ? '' : String(now[i])}
                  value={typed[i]}
                  onChange={(e) => setTyped(typed.map((t, k) => (k === i ? e.target.value : t)))}
                  aria-label={`${b.name}: minutes between departures`}
                />
                <span className="muted small"> min</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {route.patterns.length > route.mainDepartures.length && (
        <p className="muted small form-preview">
          This line has {route.patterns.length} different stopping patterns. Only the most common one in each direction is changed; branches and
          express trips stay as they are.
        </p>
      )}
      <button
        className="button"
        disabled={busy || invalid || changes.length === 0}
        onClick={async () => {
          const done = await applyEdit({
            kind: 'lineFrequency',
            routeId: route.id,
            bands: changes.map((c) => ({ fromSecs: c.band.from * 3600, toSecs: c.band.to * 3600, headwaySecs: c.minutes * 60 })),
          });
          if (done) setTyped(BANDS.map(() => ''));
        }}
      >
        {changes.length === 0 ? 'Type a number to change the frequency' : `Apply to ${changes.length} part${changes.length === 1 ? '' : 's'} of the day`}
      </button>
    </section>
  );
}
