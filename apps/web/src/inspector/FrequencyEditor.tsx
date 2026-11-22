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

/** How often trips run now in a band: its length divided by the number of departures, in minutes. */
function currentMinutes(starts: number[], from: number, to: number): number | null {
  const inBand = starts.filter((s) => s >= from && s < to).length;
  return inBand === 0 ? null : Math.round((to - from) / 60 / inBand);
}

const gap = (minutes: number) =>
  minutes >= 120 ? `every ${Math.round(minutes / 60)} h` : `every ${minutes} min`;

/** One card for the whole line: how often it runs in each part of the day, both directions together. */
export function FrequencyEditor({ route }: { route: RouteDetail }) {
  const busy = useStore((s) => s.editBusy);
  const now = useMemo(
    () =>
      BANDS.map((b) => {
        const perDirection = route.mainDepartures
          .map((d) => currentMinutes(d.starts, b.from * 3600, b.to * 3600))
          .filter((m) => m !== null);
        return perDirection.length
          ? Math.round(perDirection.reduce((a, m) => a + m, 0) / perDirection.length)
          : null;
      }),
    [route.mainDepartures],
  );
  // Across every stopping pattern, how often anything on the line leaves in the morning peak.
  const directions = Math.max(1, route.directions.length);
  const peakTrips =
    route.hourly.filter((h) => h.hour >= 7 && h.hour < 9).reduce((sum, h) => sum + h.trips, 0) /
    directions;
  const overallPeak = peakTrips > 0 ? Math.max(1, Math.round(120 / peakTrips)) : null;
  const manyPatterns = route.patterns.length > route.mainDepartures.length;
  const main = route.patterns[0];

  // What the user has typed; blank means "leave this part of the day as it is".
  const [typed, setTyped] = useState<string[]>(BANDS.map(() => ''));
  // On a line with branches or short workings: change only the main pattern, or the line as a whole.
  const [allPatterns, setAllPatterns] = useState(false);
  // How often anything on the line leaves in each part of the day, whatever its stop pattern.
  const overall = BANDS.map((b) => {
    const trips =
      route.hourly
        .filter((h) => h.hour >= b.from && h.hour < b.to)
        .reduce((sum, h) => sum + h.trips, 0) / directions;
    return trips > 0 ? Math.max(1, Math.round(((b.to - b.from) * 60) / trips)) : null;
  });
  const shown = manyPatterns && allPatterns ? overall : now;

  const changes = BANDS.map((b, i) => ({ band: b, minutes: Number(typed[i]) })).filter(
    (c, i) =>
      typed[i].trim() !== '' && Number.isFinite(c.minutes) && c.minutes >= 1 && c.minutes <= 240,
  );
  const invalid = typed.some((t) => t.trim() !== '' && !(Number(t) >= 1 && Number(t) <= 240));

  if (route.mainDepartures.length === 0) return null;

  return (
    <section>
      <h3>How often it runs</h3>
      <p className="muted small form-preview">
        Type a new gap between departures for any part of the day. Both directions change together
        and vehicles are worked out for you.
      </p>
      {manyPatterns && (
        <p className="note small">
          This line runs {route.patterns.length} different stop patterns
          {overallPeak !== null && `, about ${gap(overallPeak)} between them in the morning peak`}.
          {allPatterns
            ? ' The gap you type is between departures of any pattern; each keeps the share of departures it has now, so branches and short runs stay in proportion.'
            : ` This card shows and changes only the most common one in each direction${main ? ` (${main.firstStop.replace(/,.*$/, '')} to ${main.lastStop.replace(/,.*$/, '')})` : ''}; branches and express trips stay as they are.`}
        </p>
      )}
      {manyPatterns && (
        <label className="check small">
          <input
            type="checkbox"
            checked={allPatterns}
            onChange={(e) => setAllPatterns(e.target.checked)}
          />{' '}
          Change the whole line, shared between all its stop patterns
        </label>
      )}
      <table className="bands">
        <thead>
          <tr>
            <th>Part of the day</th>
            <th className="n">{manyPatterns && !allPatterns ? 'This pattern now' : 'Now'}</th>
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
              <td className="n muted">{shown[i] === null ? 'no trips' : gap(shown[i]!)}</td>
              <td className="n">
                <input
                  className="day-select edit-number"
                  type="number"
                  min={1}
                  max={240}
                  placeholder={shown[i] === null ? '' : String(shown[i])}
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
      <button
        className="button"
        disabled={busy || invalid || changes.length === 0}
        onClick={async () => {
          const done = await applyEdit({
            kind: 'lineFrequency',
            routeId: route.id,
            allPatterns: manyPatterns && allPatterns,
            bands: changes.map((c) => ({
              fromSecs: c.band.from * 3600,
              toSecs: c.band.to * 3600,
              headwaySecs: c.minutes * 60,
            })),
          });
          if (done) setTyped(BANDS.map(() => ''));
        }}
      >
        {changes.length === 0
          ? 'Type a number to change the frequency'
          : `Apply to ${changes.length} part${changes.length === 1 ? '' : 's'} of the day`}
      </button>
    </section>
  );
}
