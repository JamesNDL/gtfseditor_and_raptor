import { useState } from 'react';
import { isRoadMode } from './builder.ts';
import { useStore } from '../app/store.ts';

/**
 * Inside the line-drawing and route-changing panels: adds a stop where nothing stops today.
 * The stop is named here, then placed by the next click on the map, and joins the line straight away.
 */
export function NewStopTool() {
  const builder = useStore((s) => s.builder);
  const placing = useStore((s) => s.placing);
  const busy = useStore((s) => s.editBusy);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pair, setPair] = useState(true);
  const [platforms, setPlatforms] = useState(2);
  if (!builder) return null;
  const road = isRoadMode(builder.modeId);

  if (!open && !placing) {
    return (
      <button className="link new-stop-link" onClick={() => setOpen(true)}>
        + Add a {road ? 'stop' : 'station'} that does not exist yet
      </button>
    );
  }

  return (
    <section className="new-stop">
      <h3>New {road ? 'stop' : 'station'}</h3>
      {placing ? (
        <>
          <p className="note">
            {busy ? 'Adding it ...' : `Now click the map where ${placing.name} should be.`}
            {road &&
              placing.pair &&
              !busy &&
              ' Click on the road, or on the side of it this stop is on.'}
          </p>
          <button
            className="button small-button"
            disabled={busy}
            onClick={() => set({ placing: null })}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <div className="form">
            <label className="form-wide">
              <span>Name</span>
              <input
                className="day-select"
                value={name}
                maxLength={60}
                placeholder={road ? 'High St at Smith Rd' : 'Newtown West'}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {!road && (
              <label>
                <span>Platforms</span>
                <select
                  className="day-select"
                  value={platforms}
                  onChange={(e) => setPlatforms(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {road && (
            <label
              className="timeline-check"
              title="The way back then uses the stop on the other side of the road"
            >
              <input type="checkbox" checked={pair} onChange={(e) => setPair(e.target.checked)} />
              Also add the stop across the road
            </label>
          )}
          <div className="actions">
            <button
              className="button small-button"
              disabled={name.trim() === ''}
              onClick={() => {
                set({ placing: { name: name.trim(), pair, platforms }, editError: null });
                setName('');
                setOpen(false);
              }}
            >
              Place it on the map
            </button>
            <button className="button small-button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
