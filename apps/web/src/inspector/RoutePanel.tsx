import { formatSecs } from '@gtfs-editor/core';
import { useEffect, useMemo, useState } from 'react';
import { useApi, type RouteDetail, type RouteTrip } from '../api.ts';
import { startReshape } from '../builder.ts';
import { applyEdit } from '../scenario.ts';
import { useStore } from '../store.ts';
import { VehicleTypePicker } from '../FleetPanel.tsx';
import { FrequencyEditor } from './FrequencyEditor.tsx';
import { RoutePassengers } from '../sim/SimFigures.tsx';
import { HourlyChart } from './HourlyChart.tsx';
import { Badge, duration, fmt, Loading, shortStop, Tag, Tile } from './parts.tsx';

export function RoutePanel({ routeId }: { routeId: number }) {
  const route = useApi<RouteDetail>(`/api/routes/${routeId}`);
  const trips = useApi<RouteTrip[]>(`/api/routes/${routeId}/trips`);
  const open = useStore((s) => s.open);
  const set = useStore((s) => s.set);
  const openTimeline = useStore((s) => s.openTimeline);
  const editing = useStore((s) => s.baselineId !== null);
  const [tab, setTab] = useState<'trips' | 'patterns'>('trips');
  const [direction, setDirection] = useState<number | 'all'>('all');
  const [metric, setMetric] = useState<'trips' | 'places'>('trips');
  const busy = useStore((s) => s.editBusy);
  const [newTripAt, setNewTripAt] = useState('12:00');
  const [newTripWay, setNewTripWay] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const r = route.data;
  useEffect(() => {
    if (r) set({ highlightRouteId: r.id, highlightTripId: null });
    // An open timeline follows the line being inspected.
    if (r && useStore.getState().timeline.open) openTimeline({ routeId: r.id });
    if (r && r.west !== null && r.south !== null && r.east !== null && r.north !== null) {
      set({ fitBounds: [r.west, r.south, r.east, r.north] });
    }
  }, [r, set, openTimeline]);

  const chart = useMemo(() => {
    if (!r || r.hourly.length === 0) return null;
    const hours: [number, number] = [
      Math.min(...r.hourly.map((h) => h.hour)),
      Math.max(...r.hourly.map((h) => h.hour)),
    ];
    const value = (h: { trips: number; seated: number; standing: number }) =>
      metric === 'trips' ? h.trips : h.seated + h.standing;
    const peak = Math.max(1, ...r.hourly.map(value), ...(r.before?.hourly.map(value) ?? []));
    // Round the axis top up to a tidy number.
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    const step = metric === 'trips' ? (peak <= 5 ? 1 : peak <= 20 ? 5 : 10) : magnitude / 2;
    return { hours, yMax: Math.ceil(peak / step) * step };
  }, [r, metric]);

  if (!r) return <Loading error={route.error} />;

  const anyPlaceholder = r.vehicleTypes.some((v) => v.capacityIsPlaceholder);
  const inferred = trips.data?.some((t) => t.vehicleDaySource === 'inferred') ?? false;
  const shown = (trips.data ?? []).filter((t) => direction === 'all' || t.direction === direction);

  return (
    <>
      <div className="title-row">
        <Badge color={r.color}>{r.shortName ?? '?'}</Badge>
        <div>
          <h2>{r.longName ?? r.shortName}</h2>
          <div className="muted">
            {r.modeName}
            {r.agency ? ` · ${r.agency}` : ''}
          </div>
        </div>
      </div>

      <div className="tiles">
        <Tile
          value={fmt(r.tripCount)}
          label={
            r.before && r.before.tripCount !== r.tripCount
              ? `trips (was ${fmt(r.before.tripCount)})`
              : 'trips'
          }
        />
        <Tile
          value={fmt(r.vehicleDays)}
          label={`${inferred ? 'vehicles (est.)' : 'vehicles'}${r.before && r.before.vehicleDays !== r.vehicleDays ? ` (was ${fmt(r.before.vehicleDays)})` : ''}`}
          note={
            inferred
              ? 'Inferred by chaining trips; not the operator roster'
              : 'From train run numbers in the feed'
          }
        />
        <Tile value={formatSecs(r.firstDeparture)} label="first departure" />
        <Tile value={formatSecs(r.lastArrival)} label="last arrival" />
        <Tile value={duration(r.avgRunSecs)} label="average trip" />
      </div>

      <div className="actions">
        <button
          className="button"
          onClick={() => openTimeline({ tab: 'stringline', routeId: r.id })}
        >
          Trip diagram
        </button>
        <button className="button" onClick={() => openTimeline({ tab: 'vehicles', routeId: r.id })}>
          Vehicle chart
        </button>
        {editing && r.patterns.length > 0 && (
          <button
            className="button"
            title="Extend the line, cut it short, send it a different way, or add and remove stops"
            onClick={() =>
              void startReshape(
                {
                  id: r.id,
                  name: r.shortName ?? r.longName ?? 'Line',
                  modeId: r.modeId,
                  color: r.color,
                },
                r.patterns[0].id,
              )
            }
          >
            Change route
          </button>
        )}
        {editing &&
          r.tripCount > 0 &&
          (confirmDelete ? (
            <>
              <button
                className="button danger"
                disabled={busy}
                title="Takes every trip of this line out of the scenario. Ctrl+Z brings it back."
                onClick={async () => {
                  await applyEdit({ kind: 'deleteLine', routeId: r.id });
                  setConfirmDelete(false);
                }}
              >
                Delete all {fmt(r.tripCount)} trips
              </button>
              <button className="button" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              className="button"
              title="Take this line out of the scenario: every trip, in both directions"
              onClick={() => setConfirmDelete(true)}
            >
              Delete line
            </button>
          ))}
      </div>
      {r.tripCount === 0 && (
        <p className="note">
          This line has no trips in this scenario
          {r.before && r.before.tripCount > 0
            ? `: all ${fmt(r.before.tripCount)} were deleted. Undo (Ctrl+Z) brings them back`
            : ''}
          .
        </p>
      )}

      <RoutePassengers routeId={r.id} places={r.hourly} directions={r.directions} />

      {editing && <FrequencyEditor key={r.id} route={r} />}

      {chart && (
        <section>
          <div className="section-head">
            <h3>{metric === 'trips' ? 'Departures per hour' : 'Places per hour'}</h3>
            <div className="speeds">
              <button className={metric === 'trips' ? 'on' : ''} onClick={() => setMetric('trips')}>
                Departures
              </button>
              <button
                className={metric === 'places' ? 'on' : ''}
                onClick={() => setMetric('places')}
                title="Seated plus standing capacity leaving each hour"
              >
                Capacity
              </button>
            </div>
          </div>
          {r.before && (
            <div className="chart-legend muted small">
              <span className="legend-swatch legend-after" /> this scenario
              <span className="legend-swatch legend-before" /> published, where different
            </div>
          )}
          {r.directions.map((d) => (
            <HourlyChart
              key={d.direction}
              title={d.headsign ? `To ${d.headsign}` : `Direction ${d.direction}`}
              rows={r.hourly.filter((h) => h.direction === d.direction)}
              before={r.before?.hourly.filter((h) => h.direction === d.direction)}
              hours={chart.hours}
              yMax={chart.yMax}
              capacityIsPlaceholder={anyPlaceholder}
              metric={metric}
            />
          ))}
        </section>
      )}

      <section>
        <h3>Vehicles used</h3>
        {editing && (
          <VehicleTypePicker
            scope="route"
            id={r.id}
            modeId={r.modeId}
            label="Run the whole line with"
          />
        )}
        {editing && (
          <div className="edit-row">
            <button
              className="button small-button"
              disabled={busy}
              title="Takes every trip on this line off its vehicle and works the vehicles out again, each trip going to the vehicle that has waited the shortest time in the right place. Worth doing after frequency changes."
              onClick={() => applyEdit({ kind: 'replan', routeId: r.id })}
            >
              Work out the vehicles again
            </button>
          </div>
        )}
        <ul className="rows">
          {r.vehicleTypes.map((v) => (
            <li key={v.id} className="row">
              <div>
                <div>{v.name}</div>
                <div className="muted">
                  {fmt(v.seated)} seated + {fmt(v.standing)} standing
                  {v.capacityIsPlaceholder && (
                    <Tag
                      kind="warn"
                      title="Round-number placeholder. Not a sourced capacity figure."
                    >
                      placeholder
                    </Tag>
                  )}
                  {v.assumed && (
                    <Tag
                      kind="info"
                      title="The feed does not say which vehicle runs these trips; this is the default for the mode."
                    >
                      assumed
                    </Tag>
                  )}
                </div>
              </div>
              <div className="row-end">{fmt(v.trips)} trips</div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="tabs">
          <button className={tab === 'trips' ? 'on' : ''} onClick={() => setTab('trips')}>
            Trips ({fmt(r.tripCount)})
          </button>
          <button className={tab === 'patterns' ? 'on' : ''} onClick={() => setTab('patterns')}>
            Stop patterns ({r.patterns.length})
          </button>
        </div>

        {tab === 'trips' && (
          <>
            {r.directions.length > 1 && (
              <div className="chips">
                <button
                  className={direction === 'all' ? 'on' : ''}
                  onClick={() => setDirection('all')}
                >
                  All
                </button>
                {r.directions.map((d) => (
                  <button
                    key={d.direction}
                    className={direction === d.direction ? 'on' : ''}
                    onClick={() => setDirection(d.direction)}
                  >
                    To {d.headsign ?? `direction ${d.direction}`}
                  </button>
                ))}
              </div>
            )}
            {editing && (
              <div className="edit-row">
                <span className="muted small">Add a trip at</span>
                <input
                  className="day-select"
                  type="time"
                  value={newTripAt}
                  onChange={(e) => setNewTripAt(e.target.value)}
                  aria-label="Departure time of the new trip"
                />
                {r.directions.length > 1 && (
                  <select
                    className="day-select"
                    value={newTripWay}
                    onChange={(e) => setNewTripWay(Number(e.target.value))}
                    aria-label="Direction of the new trip"
                  >
                    {r.directions.map((d) => (
                      <option key={d.direction} value={d.direction}>
                        to {d.headsign ?? `direction ${d.direction}`}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="button small-button"
                  disabled={busy || !newTripAt}
                  title="Adds a trip timed like the nearest one in that direction, and finds it a vehicle"
                  onClick={async () => {
                    const [h, m] = newTripAt.split(':').map(Number);
                    const way = r.directions.some((d) => d.direction === newTripWay)
                      ? newTripWay
                      : (r.directions[0]?.direction ?? 0);
                    const done = await applyEdit({
                      kind: 'addTrip',
                      routeId: r.id,
                      direction: way,
                      startSecs: h * 3600 + m * 60,
                    });
                    if (done?.focusTripId) open({ kind: 'trip', id: done.focusTripId });
                  }}
                >
                  Add
                </button>
              </div>
            )}
            {!trips.data ? (
              <Loading error={trips.error} />
            ) : (
              <ul className="rows clickable">
                {shown.map((t) => (
                  <li key={t.id}>
                    <button className="row" onClick={() => open({ kind: 'trip', id: t.id })}>
                      <div className="time">
                        {formatSecs(t.startSecs)}
                        <span className="muted"> to {formatSecs(t.endSecs)}</span>
                      </div>
                      <div className="grow">
                        <div className="ellipsis">
                          {shortStop(t.firstStop)} → {shortStop(t.lastStop)}
                        </div>
                        <div className="muted ellipsis">
                          {t.stopCount} stops · {t.vehicleDayLabel ?? 'no vehicle yet'}
                          {t.edited && ' · changed'}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'patterns' && (
          <ul className="rows">
            {r.patterns.map((p) => (
              <li key={p.id} className="row">
                <div className="grow">
                  <div className="ellipsis">
                    {shortStop(p.firstStop)} → {shortStop(p.lastStop)}
                  </div>
                  <div className="muted">
                    {p.stopCount} stops{p.headsign ? ` · to ${p.headsign}` : ''}
                  </div>
                </div>
                <div className="row-end">{fmt(p.tripCount)} trips</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
