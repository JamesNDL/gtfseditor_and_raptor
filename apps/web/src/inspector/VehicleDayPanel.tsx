import { formatSecs } from '@gtfs-editor/core';
import { Fragment } from 'react';
import { useApi, type VehicleDayDetail } from '../api.ts';
import { VehicleTypePicker } from '../FleetPanel.tsx';
import { useStore } from '../store.ts';
import { Badge, duration, fmt, Loading, shortStop, Tag, Tile } from './parts.tsx';

export function VehicleDayPanel({ vehicleDayId }: { vehicleDayId: number }) {
  const day = useApi<VehicleDayDetail>(`/api/vehicle-days/${vehicleDayId}`);
  const open = useStore((s) => s.open);
  const editing = useStore((s) => s.baselineId !== null);
  const d = day.data;
  if (!d) return <Loading error={day.error} />;

  const stay = new Set(d.stayAboard.map((l) => `${l.fromTripId}>${l.toTripId}`));
  const inService = d.trips.reduce((sum, t) => sum + (t.endSecs - t.startSecs), 0);

  return (
    <>
      <div className="title-row">
        <div>
          <h2>{d.label}</h2>
          <div className="muted">
            {d.modeName} · {formatSecs(d.startSecs)} to {formatSecs(d.endSecs)}
          </div>
        </div>
      </div>

      <p className="note">
        {d.isNew
          ? 'This vehicle was added by the scenario to run its new trips. It is not in the published timetable.'
          : d.source === 'run_number'
          ? "This vehicle's day comes from the run number in the feed's trip IDs."
          : "This vehicle's day is inferred: trips were chained where one ends near where the next begins. It is an estimate, not the operator's roster."}
      </p>

      <div className="tiles">
        <Tile value={fmt(d.tripCount)} label="trips" />
        <Tile value={duration(inService)} label="in service" />
        <Tile value={duration(d.endSecs - d.startSecs - inService)} label="between trips" />
        {d.gapCount > 0 && <Tile value={fmt(d.gapCount)} label="empty runs needed" />}
      </div>

      {d.vehicleType && (
        <div className="row">
          <div>
            <div>{d.vehicleType}</div>
            <div className="muted">
              {fmt(d.seated ?? 0)} seated + {fmt(d.standing ?? 0)} standing
              {d.capacityIsPlaceholder && (
                <Tag kind="warn" title="Round-number placeholder. Not a sourced capacity figure.">
                  placeholder
                </Tag>
              )}
            </div>
          </div>
        </div>
      )}

      {editing && <VehicleTypePicker scope="vehicleDay" id={d.id} modeId={d.modeId} label="Run this vehicle as" />}

      <section>
        <h3>The day, in order</h3>
        <ul className="rows clickable">
          {d.trips.map((t, i) => {
            const prev = d.trips[i - 1];
            return (
              <Fragment key={t.id}>
                {prev && (
                  <li className="between">
                    {stay.has(`${prev.id}>${t.id}`) ? (
                      <span>Passengers stay aboard · {duration(t.startSecs - prev.endSecs)}</span>
                    ) : prev.lastStationId !== t.firstStationId ? (
                      <span className="warn-text">
                        Empty run needed: {shortStop(prev.lastStop)} to {shortStop(t.firstStop)} · {duration(t.startSecs - prev.endSecs)}
                      </span>
                    ) : (
                      <span>Waits {duration(t.startSecs - prev.endSecs)}</span>
                    )}
                  </li>
                )}
                <li>
                  <button className="row" onClick={() => open({ kind: 'trip', id: t.id })}>
                    <div className="time">
                      {formatSecs(t.startSecs)}
                      <span className="muted"> to {formatSecs(t.endSecs)}</span>
                    </div>
                    <Badge color={t.color}>{t.routeShortName ?? '?'}</Badge>
                    <div className="grow ellipsis">
                      {shortStop(t.firstStop)} → {shortStop(t.lastStop)}
                    </div>
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      </section>
    </>
  );
}
