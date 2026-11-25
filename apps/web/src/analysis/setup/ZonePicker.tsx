// The setup's zone (FR-4, AC-FR-4.1): the saved zones to pick from, rename or delete. Zones are
// drawn and reshaped on the map with the tool bar (D36). Zones belong to no day, so the same list
// shows on every day (D25).
import { useEffect } from 'react';
import { useStore } from '../../app/store.ts';
import { deleteZone, refreshZones, renameZone, usePlaces } from '../analysis-api.ts';
import { forgetZone, pickZone } from '../analysis-state.ts';
import { isMapBusy } from '../map-work.ts';
import { PlaceRow } from './PlaceRow.tsx';

const showError = (e: Error): void => usePlaces.setState({ zoneError: e.message });

export function ZonePicker() {
  const zones = usePlaces((s) => s.zones);
  const error = usePlaces((s) => s.zoneError);
  const zoneId = useStore((s) => s.analysis.setup.zoneId);
  const busy = useStore((s) => isMapBusy(s.analysis.work));
  const set = useStore((s) => s.set);
  const view = () => useStore.getState().analysis;

  useEffect(() => {
    usePlaces.setState({ zoneError: null });
    refreshZones().catch(showError);
  }, []);

  return (
    <section className="analysis-section" aria-label="Zone">
      <h3 className="analysis-section-title">Zone</h3>
      {error && <p className="error-text small">{error}</p>}
      {zones === null ? (
        <p className="muted small">Loading the zones…</p>
      ) : zones.length > 0 ? (
        <ul className="analysis-places">
          {zones.map((zone) => (
            <PlaceRow
              key={zone.id}
              name={zone.name}
              what="zone"
              pick="radio"
              group="analysis-zone"
              picked={zone.id === zoneId}
              disabled={busy}
              onPick={() => set({ analysis: pickZone(view(), zone.id) })}
              onRename={(name) => renameZone(zone.id, name)}
              onDelete={async () => {
                await deleteZone(zone.id);
                set({ analysis: forgetZone(view(), zone.id) });
              }}
            />
          ))}
        </ul>
      ) : null}
      <p className="muted small analysis-map-hint">
        {zones?.length === 0 ? 'No zones yet. ' : ''}Use Draw zone (Z) on the map to draw one round
        the area to analyse. Drag a picked zone's corners to reshape it.
      </p>
    </section>
  );
}
