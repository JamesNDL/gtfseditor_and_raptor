// The setup's points of interest (FR-5, AC-FR-5.1): the saved ones to tick, move, rename or delete,
// and "Add a point of interest", which asks for a name and then places it with the next click on
// the map. Points of interest belong to no day (D25) and may lie outside the zone.
import { useEffect, useState } from 'react';
import { useStore } from '../../app/store.ts';
import { deletePoi, refreshPois, renamePoi, usePlaces } from '../analysis-api.ts';
import {
  cancelMapWork,
  forgetPoi,
  isMapBusy,
  startMovingPoi,
  startPlacingPoi,
  togglePoi,
} from '../analysis-state.ts';
import { NameForm } from './NameForm.tsx';
import { PlaceRow } from './PlaceRow.tsx';

const showError = (e: Error): void => usePlaces.setState({ poiError: e.message });

export function PoiPicker() {
  const pois = usePlaces((s) => s.pois);
  const error = usePlaces((s) => s.poiError);
  const poiIds = useStore((s) => s.analysis.setup.poiIds);
  const placing = useStore((s) => s.analysis.placingPoi);
  const movingId = useStore((s) => s.analysis.movingPoiId);
  const busy = useStore((s) => isMapBusy(s.analysis));
  const set = useStore((s) => s.set);
  const view = () => useStore.getState().analysis;
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    usePlaces.setState({ poiError: null });
    refreshPois().catch(showError);
  }, []);

  /** The name of the point of interest waiting for a click on the map, if one is. */
  const waiting =
    placing ??
    (movingId === null
      ? null
      : (pois?.find((p) => p.id === movingId)?.name ?? 'the point of interest'));

  return (
    <section className="analysis-section" aria-label="Points of interest">
      <h3 className="analysis-section-title">Points of interest</h3>
      {error && <p className="error-text small">{error}</p>}
      {pois === null ? (
        <p className="muted small">Loading the points of interest…</p>
      ) : pois.length === 0 ? (
        <p className="muted small">
          No points of interest yet. Add the places people travel to, such as a hospital.
        </p>
      ) : (
        <ul className="analysis-places">
          {pois.map((poi) => (
            <PlaceRow
              key={poi.id}
              name={poi.name}
              what="point of interest"
              pick="checkbox"
              group="analysis-pois"
              picked={poiIds.includes(poi.id)}
              disabled={busy}
              onPick={() => set({ analysis: togglePoi(view(), poi.id) })}
              onRename={(name) => renamePoi(poi.id, name)}
              onDelete={async () => {
                await deletePoi(poi.id);
                set({ analysis: forgetPoi(view(), poi.id) });
              }}
            >
              <button
                className="button small-button"
                disabled={busy}
                title="Click the map where this point of interest goes"
                onClick={() => {
                  usePlaces.setState({ poiError: null });
                  set({ analysis: startMovingPoi(view(), poi.id) });
                }}
              >
                Move
              </button>
            </PlaceRow>
          ))}
        </ul>
      )}
      {waiting !== null ? (
        <div className="analysis-drawing">
          <p className="small">
            Click the map where {waiting} {placing !== null ? 'goes' : 'moves to'}.
          </p>
          <button
            className="button small-button"
            title="Stop waiting for a click on the map (Escape)"
            onClick={() => set({ analysis: cancelMapWork(view()) })}
          >
            Cancel
          </button>
        </div>
      ) : naming ? (
        <NameForm
          label="Name of the point of interest"
          saveText="Place on the map"
          onSave={(name) => {
            usePlaces.setState({ poiError: null });
            setNaming(false);
            set({ analysis: startPlacingPoi(view(), name) });
          }}
          onCancel={() => setNaming(false)}
        />
      ) : (
        <button
          className="button small-button analysis-add"
          disabled={busy}
          title="Name a place, then click the map where it is"
          onClick={() => setNaming(true)}
        >
          Add a point of interest
        </button>
      )}
    </section>
  );
}
