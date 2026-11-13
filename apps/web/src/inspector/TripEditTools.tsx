import { formatSecs } from '@gtfs-editor/core';
import { useState } from 'react';
import type { TripDetail } from '../api.ts';
import { VehicleTypePicker } from '../FleetPanel.tsx';
import { applyEdit } from '../scenario.ts';
import { useStore } from '../store.ts';
import { Tag } from './parts.tsx';

const NUDGES = [-300, -60, 60, 300];

/** Retime, copy and delete controls for the open trip. Shown only while a scenario is being edited. */
export function TripEditTools({ trip }: { trip: TripDetail }) {
  const ripple = useStore((s) => s.ripple);
  const busy = useStore((s) => s.editBusy);
  const stopScope = useStore((s) => s.stopScope);
  const set = useStore((s) => s.set);
  const [copyAfter, setCopyAfter] = useState(10);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clock = (secs: number) => `${String(Math.floor(secs / 3600) % 24).padStart(2, '0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`;
  const [departAt, setDepartAt] = useState(clock(trip.startSecs));

  const rippleNote = ripple === 'vehicle' ? " and its vehicle's later trips" : ripple === 'line' ? ' and every later trip on the line' : '';

  return (
    <section className="edit-tools">
      <h3>
        Edit this trip
        {trip.edited && <Tag kind="info">changed</Tag>}
        {trip.pinned && (
          <Tag kind="info" title="You placed this trip by hand, so frequency changes leave it where it is">
            placed by hand
          </Tag>
        )}
      </h3>

      <div className="edit-row">
        <span className="muted small">Move</span>
        <div className="speeds">
          {NUDGES.map((d) => (
            <button
              key={d}
              disabled={busy}
              title={`Depart at ${formatSecs(trip.startSecs + d)}${rippleNote}`}
              onClick={() => applyEdit({ kind: 'shift', tripIds: [trip.id], delta: d, ripple })}
            >
              {d > 0 ? '+' : '−'}
              {Math.abs(d) / 60} min
            </button>
          ))}
        </div>
      </div>
      <div className="edit-row">
        <span className="muted small">Depart at</span>
        <input className="day-select" type="time" value={departAt} onChange={(e) => setDepartAt(e.target.value)} aria-label="Departure time" />
        <button
          className="button small-button"
          disabled={busy || departAt === clock(trip.startSecs) || !departAt}
          onClick={() => {
            const [h, m] = departAt.split(':').map(Number);
            // Keep the trip on the same side of midnight it is on now.
            const dayStart = Math.floor(trip.startSecs / 86400) * 86400;
            const delta = dayStart + h * 3600 + m * 60 - Math.floor(trip.startSecs / 60) * 60;
            if (delta !== 0) void applyEdit({ kind: 'shift', tripIds: [trip.id], delta, ripple });
          }}
        >
          Set
        </button>
      </div>
      <p className="muted small edit-hint">Or drag it sideways on the trip diagram. {rippleNote && `Moves this trip${rippleNote}.`}</p>

      <div className="edit-row">
        <span className="muted small">Add a copy</span>
        <input
          className="day-select edit-number"
          type="number"
          min={1}
          max={240}
          value={copyAfter}
          onChange={(e) => setCopyAfter(Number(e.target.value))}
          aria-label="Minutes after this trip"
        />
        <span className="muted small">min later</span>
        <button
          className="button small-button"
          disabled={busy || !(copyAfter >= 1)}
          onClick={() => applyEdit({ kind: 'duplicate', tripId: trip.id, startSecs: trip.startSecs + copyAfter * 60 })}
        >
          Add
        </button>
      </div>

      <div className="edit-row">
        <span className="muted small">Skipping a stop applies to</span>
        <div className="speeds">
          <button className={stopScope === 'trip' ? 'on' : ''} onClick={() => set({ stopScope: 'trip' })}>
            This trip
          </button>
          <button
            className={stopScope === 'pattern' ? 'on' : ''}
            disabled={trip.patternId === null}
            title="Every trip that makes the same stops in the same order"
            onClick={() => set({ stopScope: 'pattern' })}
          >
            Every trip like it
          </button>
        </div>
      </div>

      <div className="edit-row">
        <span className="muted small">Vehicle</span>
        <button
          className="button small-button"
          disabled={busy}
          title="Add a vehicle to the fleet just for this trip"
          onClick={() => applyEdit({ kind: 'setVehicle', tripId: trip.id, mode: 'new' })}
        >
          Its own new vehicle
        </button>
        <button
          className="button small-button"
          disabled={busy}
          title="Use a vehicle already on this line that is free and in the right place; adds one if none is"
          onClick={() => applyEdit({ kind: 'setVehicle', tripId: trip.id, mode: 'auto' })}
        >
          Find one with spare time
        </button>
      </div>

      <VehicleTypePicker scope="trip" id={trip.id} modeId={trip.modeId} currentTypeId={trip.vehicleTypeId} label="Vehicle type" />

      <div className="edit-row">
        {confirmDelete ? (
          <>
            <span className="small">Delete this trip?</span>
            <button
              className="button small-button danger"
              disabled={busy}
              onClick={() => applyEdit({ kind: 'delete', tripIds: [trip.id] })}
            >
              Delete
            </button>
            <button className="button small-button" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="button small-button" onClick={() => setConfirmDelete(true)}>
            Delete trip
          </button>
        )}
      </div>
    </section>
  );
}
