import { formatSecs } from '@gtfs-editor/core';
import { useEffect, useState } from 'react';
import { useApi, type TripDetail, type TripSummary } from '../api.ts';
import { clock } from '../clock.ts';
import { useStore } from '../store.ts';
import { applyEdit } from '../scenario.ts';
import { Badge, duration, fmt, Loading, shortStop, Tag } from './parts.tsx';
import { TripEditTools } from './TripEditTools.tsx';

/** Re-renders when the simulation clock moves into a different minute. */
function useClockMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(clock.secs / 60));
  useEffect(() => clock.subscribe((secs) => setMinute(Math.floor(secs / 60))), []);
  return minute;
}

export function TripPanel({ tripId }: { tripId: number }) {
  const trip = useApi<TripDetail>(`/api/trips/${tripId}`);
  const open = useStore((s) => s.open);
  const set = useStore((s) => s.set);
  const openTimeline = useStore((s) => s.openTimeline);
  const setView = useStore((s) => s.setView);
  const editing = useStore((s) => s.baselineId !== null);
  const stopScope = useStore((s) => s.stopScope);
  const busy = useStore((s) => s.editBusy);
  const now = useClockMinute() * 60;

  const t = trip.data;
  useEffect(() => {
    if (t) set({ highlightRouteId: t.routeId, highlightTripId: t.id });
    // An open timeline follows the trip's line, unless it is showing a station.
    const timeline = useStore.getState().timeline;
    if (t && timeline.open && timeline.tab !== 'platforms') openTimeline({ routeId: t.routeId });
  }, [t, set, openTimeline]);

  if (!t) return <Loading error={trip.error} />;

  const running = now >= t.startSecs && now <= t.endSecs;
  const status = running ? 'Running now' : now < t.startSecs ? 'Not yet departed' : 'Finished';

  return (
    <>
      <div className="title-row">
        <button className="badge-button" onClick={() => open({ kind: 'route', id: t.routeId })} title="Open this line">
          <Badge color={t.color}>{t.routeShortName ?? '?'}</Badge>
        </button>
        <div>
          <h2>{t.headsign ? `To ${t.headsign}` : t.routeLongName}</h2>
          <div className="muted">
            {formatSecs(t.startSecs)} to {formatSecs(t.endSecs)} · {duration(t.endSecs - t.startSecs)} · {status}
          </div>
        </div>
      </div>

      <div className="actions">
        <button
          className="button"
          onClick={() => {
            clock.set(t.startSecs + 30);
            const first = t.stopTimes[0];
            const last = t.stopTimes[t.stopTimes.length - 1];
            const lons = t.stopTimes.map((s) => s.lon);
            const lats = t.stopTimes.map((s) => s.lat);
            if (first && last) set({ fitBounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] });
          }}
        >
          Jump to departure
        </button>
      </div>

      {editing && <TripEditTools key={t.id} trip={t} />}

      <section>
        <h3>Vehicle</h3>
        <ul className="rows clickable">
          {t.vehicleDayId !== null && (
            <li>
              <button className="row" onClick={() => open({ kind: 'vehicleDay', id: t.vehicleDayId! })}>
                <div className="grow">
                  <div>
                    {t.vehicleDayLabel}
                    {t.vehicleDaySource === 'inferred' && (
                      <Tag kind="info" title="Inferred by chaining trips; not the operator roster.">
                        inferred
                      </Tag>
                    )}
                  </div>
                  <div className="muted">See this vehicle's whole day</div>
                </div>
                <div className="row-end">→</div>
              </button>
            </li>
          )}
        </ul>
        {t.vehicleDayId === null && <p className="note">This trip has no vehicle. Use the vehicle buttons above to give it one.</p>}
        <div className="row">
          <div>
            <div>{t.vehicleType}</div>
            <div className="muted">
              {fmt(t.seated)} seated + {fmt(t.standing)} standing
              {t.capacityIsPlaceholder && (
                <Tag kind="warn" title="Round-number placeholder. Not a sourced capacity figure.">
                  placeholder
                </Tag>
              )}
              {t.vehicleAssumed && (
                <Tag kind="info" title="The feed does not say which vehicle runs this trip; this is the default for the mode.">
                  assumed
                </Tag>
              )}
            </div>
          </div>
        </div>
      </section>

      {(t.stayAboardFrom || t.stayAboardTo) && (
        <section>
          <h3>Passengers stay aboard</h3>
          <ul className="rows clickable">
            {t.stayAboardFrom && <StayRow label="Arrives as" trip={t.stayAboardFrom} />}
            {t.stayAboardTo && <StayRow label="Continues as" trip={t.stayAboardTo} />}
          </ul>
        </section>
      )}

      <section>
        <h3>Stops ({t.stopTimes.length})</h3>
        <ol className="stops">
          {t.stopTimes.map((s, i) => {
            const passed = now > s.dep;
            const next = !passed && (i === 0 || now > t.stopTimes[i - 1].dep) && running;
            const noBoard = s.pickupType === 1 && s.dropOffType === 1;
            return (
              <li key={s.seq} className={`${passed ? 'passed' : ''} ${next ? 'next' : ''}`}>
                <span className="stop-time">{formatSecs(s.dep)}</span>
                <span className="stop-dot" style={{ borderColor: `#${t.color}` }} />
                <span className="stop-name">
                  <button
                    className="stop-link"
                    title="Show this station's platforms"
                    onClick={() => {
                      openTimeline({ tab: 'platforms', stationId: s.stopId });
                      setView(s.arr - 1800, s.arr + 5400);
                    }}
                  >
                    {s.name.replace(/, Platform .*$/, '')}
                  </button>
                  {s.platformCode && <span className="muted"> · platform {s.platformCode}</span>}
                  {noBoard && <span className="muted"> · passes through</span>}
                  {s.dep - s.arr >= 60 && <span className="muted"> · waits {duration(s.dep - s.arr)}</span>}
                </span>
                {editing && i > 0 && i < t.stopTimes.length - 1 && !noBoard && (
                  <button
                    className="skip-button"
                    disabled={busy}
                    title={stopScope === 'pattern' ? 'Every trip like this one runs through here without stopping' : 'This trip runs through here without stopping'}
                    onClick={() => applyEdit({ kind: 'skipStop', tripId: t.id, stopSeq: s.seq, scope: stopScope })}
                  >
                    Skip
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <div className="muted small">Feed trip ID: {t.gtfsId}</div>
    </>
  );
}

function StayRow({ label, trip }: { label: string; trip: TripSummary }) {
  const open = useStore((s) => s.open);
  return (
    <li>
      <button className="row" onClick={() => open({ kind: 'trip', id: trip.id })}>
        <Badge color={trip.color}>{trip.routeShortName ?? '?'}</Badge>
        <div className="grow">
          <div className="ellipsis">
            {label}: {shortStop(trip.firstStop)} → {shortStop(trip.lastStop)}
          </div>
          <div className="muted">
            {formatSecs(trip.startSecs)} to {formatSecs(trip.endSecs)}
          </div>
        </div>
      </button>
    </li>
  );
}
