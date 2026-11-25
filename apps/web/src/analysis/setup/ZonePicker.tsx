// The setup's zone (FR-4, AC-FR-4.1): the saved zones to pick from, rename or delete, and "Draw a
// zone". Zones belong to no day, so the same list shows on every day (D25).
import { useEffect } from 'react';
import { useStore } from '../../app/store.ts';
import { deleteZone, refreshZones, renameZone, usePlaces } from '../analysis-api.ts';
import { forgetZone, isMapBusy, pickZone, startDrawing } from '../analysis-state.ts';
import { PlaceRow } from './PlaceRow.tsx';
import { ZoneDrawing } from './ZoneDrawing.tsx';

const showError = (e: Error): void => usePlaces.setState({ zoneError: e.message });

export function ZonePicker() {
  const zones = usePlaces((s) => s.zones);
  const error = usePlaces((s) => s.zoneError);
  const zoneId = useStore((s) => s.analysis.setup.zoneId);
  const drawing = useStore((s) => s.analysis.drawing !== null);
  const busy = useStore((s) => isMapBusy(s.analysis));
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
      {drawing ? (
        <ZoneDrawing />
      ) : (
        <>
          {zones === null ? (
            <p className="muted small">Loading the zones…</p>
          ) : zones.length === 0 ? (
            <p className="muted small">No zones yet. Draw one round the area to analyse.</p>
          ) : (
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
          )}
          <button
            className="button small-button analysis-add"
            disabled={busy}
            title="Click the map at each corner of the area, then close the outline"
            onClick={() => {
              usePlaces.setState({ zoneError: null });
              set({ analysis: startDrawing(view()) });
            }}
          >
            Draw a zone
          </button>
        </>
      )}
    </section>
  );
}
