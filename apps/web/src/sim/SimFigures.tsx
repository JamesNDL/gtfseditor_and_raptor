// Passenger figures from the chosen simulation run, added to the line, trip and station panels.
// Nothing here shows unless a run is chosen and it was made on the timetable now on screen.
import { formatSecs } from '@gtfs-editor/core';
import { useApi, type HourlyRow } from '../shared/api-client.ts';
import { fmt, Tag, Tile } from '../shared/ui/parts.tsx';
import { useStore } from '../app/store.ts';

/**
 * The chosen run, if its figures belong on what is on screen: it has finished, and it was made on
 * the scenario that is open (or on the published timetable, when none is).
 */
export function useShownRun() {
  const run = useStore((s) => s.simRuns.find((r) => r.id === s.simRunId));
  const scenarioId = useStore((s) => s.scenarioId);
  if (!run || run.state !== 'done') return null;
  return (run.kind === 'scenario' ? run.scenarioId : null) === scenarioId ? run : null;
}

function Caveats({ outOfDate, capacity }: { outOfDate: boolean; capacity: boolean }) {
  return (
    <>
      {outOfDate && (
        <Tag
          kind="warn"
          title="The timetable has been edited, or the router's rules for walks and changes have changed, since this run. Trips that changed have no figures."
        >
          out of date
        </Tag>
      )}
      {capacity && (
        <Tag
          kind="warn"
          title="Vehicle capacities are round-number placeholders, so how full a vehicle is, and who is left behind, are illustrative."
        >
          placeholder capacities
        </Tag>
      )}
    </>
  );
}

interface RouteFigures {
  passengers: number;
  trips: number;
  tripsFull: number;
  tripsOver80: number;
  leftBehind: number;
  hourly: { direction: number; hour: number; passengers: number; peakShare: number }[];
  fullest: { stop: string | null; depart: number; load: number; capacity: number } | null;
}

/** A line's passengers: totals, how full it gets, and passengers against places by hour. */
export function RoutePassengers({
  routeId,
  places,
  directions,
}: {
  routeId: number;
  places: HourlyRow[];
  directions: { direction: number; headsign: string | null }[];
}) {
  const run = useShownRun();
  const figures = useApi<RouteFigures>(run ? `/api/sim-runs/${run.id}/routes/${routeId}` : null);
  if (!run || !figures.data) return null;
  const f = figures.data;
  if (f.trips === 0) {
    return (
      <section className="sim-figures">
        <h3>Passengers</h3>
        <p className="note">Nobody rides this line in "{run.name}".</p>
      </section>
    );
  }
  const hours = [...places.map((p) => p.hour), ...f.hourly.map((h) => h.hour)];
  const [h0, h1] = [Math.min(...hours), Math.max(...hours)];
  const yMax = Math.max(
    1,
    ...places.map((p) => p.seated + p.standing),
    ...f.hourly.map((h) => h.passengers),
  );
  return (
    <section className="sim-figures">
      <h3>
        Passengers <span className="muted small">in "{run.name}"</span>{' '}
        <Caveats outOfDate={run.outOfDate} capacity />
      </h3>
      <div className="tiles">
        <Tile
          value={fmt(f.passengers)}
          label="passengers a day"
          note="Boardings on this line's trips"
        />
        <Tile
          value={fmt(f.tripsFull)}
          label="trips full"
          note={`Of ${fmt(f.trips)} trips with anyone aboard, those at or over 100% of capacity somewhere`}
        />
        <Tile value={fmt(f.tripsOver80)} label="trips over 80%" />
        {f.leftBehind > 0 && (
          <Tile
            value={fmt(f.leftBehind)}
            label="left behind"
            note="Times a passenger could not board a full vehicle of this line"
          />
        )}
      </div>
      {f.fullest && (
        <p className="muted small">
          Fullest: {fmt(f.fullest.load)} aboard a vehicle that holds {fmt(f.fullest.capacity)} (
          {Math.round((100 * f.fullest.load) / f.fullest.capacity)}%), leaving{' '}
          {f.fullest.stop ?? 'a stop'} at {formatSecs(f.fullest.depart)}.
        </p>
      )}
      <div className="chart-legend muted small">
        <span className="legend-swatch legend-after" /> passengers
        <span className="legend-swatch legend-before" /> places
      </div>
      {directions.map((d) => (
        <figure className="chart" key={d.direction}>
          <figcaption>{d.headsign ? `To ${d.headsign}` : `Direction ${d.direction}`}</figcaption>
          <div
            className="station-hours sim-hours"
            role="img"
            aria-label="Passengers and places in each hour of the day"
          >
            {Array.from({ length: h1 - h0 + 1 }, (_, i) => {
              const hour = h0 + i;
              const row = places.find((p) => p.direction === d.direction && p.hour === hour);
              const room = row ? row.seated + row.standing : 0;
              const riding =
                f.hourly.find((h) => h.direction === d.direction && h.hour === hour)?.passengers ??
                0;
              return (
                <div
                  key={hour}
                  className="station-hour"
                  title={`${String(hour % 24).padStart(2, '0')}:00: ${fmt(riding)} passengers on trips with ${fmt(room)} places`}
                >
                  <div className="sim-places" style={{ height: `${(room / yMax) * 100}%` }}>
                    <div
                      className={`station-bar${riding > room && room > 0 ? ' sim-over' : ''}`}
                      style={{ height: `${room ? Math.min(100, (riding / room) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="muted">
                    {hour % 3 === 0 ? String(hour % 24).padStart(2, '0') : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </figure>
      ))}
    </section>
  );
}

interface TripLoad {
  position: number;
  stop: string | null;
  depart: number;
  boardings: number;
  alightings: number;
  load: number;
  leftBehind: number;
  capacity: number;
}

/** Passengers aboard along one trip's stops, against its capacity, with who got on and off. */
export function TripPassengers({ tripId }: { tripId: number }) {
  const run = useShownRun();
  const loads = useApi<TripLoad[]>(run ? `/api/sim-runs/${run.id}/trips/${tripId}` : null);
  if (!run || !loads.data) return null;
  const rows = loads.data;
  if (rows.length === 0) {
    return (
      <section className="sim-figures">
        <h3>Passengers</h3>
        <p className="note">
          {run.outOfDate
            ? `This trip has changed since "${run.name}" was run, so it has no figures.`
            : `Nobody rides this trip in "${run.name}".`}
        </p>
      </section>
    );
  }
  const capacity = rows[0].capacity;
  const peak = Math.max(...rows.map((r) => r.load));
  const top = Math.max(capacity, peak, 1);
  const left = rows.reduce((sum, r) => sum + r.leftBehind, 0);
  return (
    <section className="sim-figures">
      <h3>
        Passengers <span className="muted small">in "{run.name}"</span>{' '}
        <Caveats outOfDate={run.outOfDate} capacity />
      </h3>
      <div className="tiles">
        <Tile value={fmt(rows.reduce((sum, r) => sum + r.boardings, 0))} label="boardings" />
        <Tile
          value={`${fmt(peak)} of ${fmt(capacity)}`}
          label="most aboard"
          note={`${Math.round((100 * peak) / Math.max(1, capacity))}% of capacity`}
        />
        {left > 0 && <Tile value={fmt(left)} label="left behind" />}
      </div>
      <ol className="sim-loads">
        {rows.map((r) => (
          <li
            key={r.position}
            title={`${fmt(r.load)} aboard on leaving, ${fmt(r.boardings)} on, ${fmt(r.alightings)} off${r.leftBehind ? `, ${fmt(r.leftBehind)} left behind` : ''}`}
          >
            <span className="sim-load-time muted">{formatSecs(r.depart)}</span>
            <span className="sim-load-stop ellipsis">{r.stop ?? 'a stop'}</span>
            <span className="sim-load-bar">
              <span
                className={r.load >= capacity && capacity > 0 ? 'sim-over' : ''}
                style={{ width: `${(r.load / top) * 100}%` }}
              />
              <i style={{ left: `${(capacity / top) * 100}%` }} />
            </span>
            <span className="sim-load-n">{fmt(r.load)}</span>
            <span className="sim-load-change muted">
              {r.boardings ? `+${fmt(r.boardings)}` : ''}
              {r.alightings ? ` −${fmt(r.alightings)}` : ''}
              {r.leftBehind ? ` · ${fmt(r.leftBehind)} left` : ''}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface StopQuarter {
  quarterStart: number;
  boardings: number;
  alightings: number;
  changes: number;
  leftBehind: number;
  /** The most waiting at once at any one of the stops added up here. */
  maxWaiting: number;
  /** The sum of each stop's own most: what all of them together cannot exceed. */
  maxWaitingAtMost: number;
  /** How many of the stops had anyone waiting. */
  platforms: number;
}

/** A stop's or station's passengers by hour: on, off, changing, left behind, and the most waiting at once. */
export function StationPassengers({ stopId }: { stopId: number }) {
  const run = useShownRun();
  const quarters = useApi<StopQuarter[]>(run ? `/api/sim-runs/${run.id}/stops/${stopId}` : null);
  if (!run || !quarters.data) return null;
  if (quarters.data.length === 0) {
    return (
      <section className="sim-figures">
        <h3>Passengers</h3>
        <p className="note">Nobody uses this stop in "{run.name}".</p>
      </section>
    );
  }
  const byHour = new Map<number, { on: number; off: number }>();
  for (const q of quarters.data) {
    const hour = Math.floor(q.quarterStart / 3600);
    const row = byHour.get(hour) ?? { on: 0, off: 0 };
    row.on += q.boardings;
    row.off += q.alightings;
    byHour.set(hour, row);
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const peak = Math.max(1, ...[...byHour.values()].map((h) => Math.max(h.on, h.off)));
  const total = (pick: (q: StopQuarter) => number) =>
    quarters.data!.reduce((sum, q) => sum + pick(q), 0);
  const waiting = quarters.data.reduce((best, q) => (q.maxWaiting > best.maxWaiting ? q : best));
  return (
    <section className="sim-figures">
      <h3>
        Passengers <span className="muted small">in "{run.name}"</span>{' '}
        <Caveats outOfDate={run.outOfDate} capacity={false} />
      </h3>
      <div className="tiles">
        <Tile value={fmt(total((q) => q.boardings))} label="boardings" />
        <Tile value={fmt(total((q) => q.alightings))} label="alightings" />
        <Tile
          value={fmt(total((q) => q.changes))}
          label="changes"
          note="Boardings by passengers who had just left another vehicle"
        />
        <Tile
          value={fmt(waiting.maxWaiting)}
          label={waiting.platforms > 1 ? 'most waiting at one platform' : 'most waiting'}
          note={`At once, around ${formatSecs(waiting.quarterStart)}.${waiting.maxWaitingAtMost > waiting.maxWaiting ? ` Across all its platforms it is between ${fmt(waiting.maxWaiting)} and ${fmt(waiting.maxWaitingAtMost)}: each platform's fullest moment is known, but not whether they fall together.` : ''}`}
        />
        {total((q) => q.leftBehind) > 0 && (
          <Tile value={fmt(total((q) => q.leftBehind))} label="left behind" />
        )}
      </div>
      <div className="chart-legend muted small">
        <span className="legend-swatch legend-after" /> getting on
        <span className="legend-swatch sim-legend-off" /> getting off
      </div>
      <div
        className="station-hours sim-hours"
        role="img"
        aria-label="Boardings and alightings in each hour of the day"
      >
        {Array.from({ length: hours[hours.length - 1] - hours[0] + 1 }, (_, i) => {
          const hour = hours[0] + i;
          const row = byHour.get(hour) ?? { on: 0, off: 0 };
          return (
            <div
              key={hour}
              className="station-hour sim-pair"
              title={`${String(hour % 24).padStart(2, '0')}:00: ${fmt(row.on)} on, ${fmt(row.off)} off`}
            >
              <div className="sim-pair-bars">
                <div className="station-bar" style={{ height: `${(row.on / peak) * 100}%` }} />
                <div
                  className="station-bar sim-off"
                  style={{ height: `${(row.off / peak) * 100}%` }}
                />
              </div>
              <span className="muted">
                {hour % 3 === 0 ? String(hour % 24).padStart(2, '0') : ''}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
