// The setup's points of interest (FR-5, AC-FR-5.1): the saved ones to tick, rename or delete.
// They are placed, moved and renamed on the map with the tool bar (D36). Points of interest
// belong to no day (D25) and may lie outside the zone. The list shows those near the map's view
// and the picked ones (D41).
import { useEffect, useState } from 'react';
import { useStore } from '../../app/store.ts';
import { deletePoi, refreshPois, renamePoi, usePlaces } from '../analysis-api.ts';
import { forgetPoi, togglePoi } from '../analysis-state.ts';
import { isMapBusy } from '../map-work.ts';
import { useMapBounds } from '../../shared/map-bounds.ts';
import { HiddenPlaces } from './HiddenPlaces.tsx';
import { nearbyPois } from './nearby-places.ts';
import { PlaceRow } from './PlaceRow.tsx';

const showError = (e: Error): void => usePlaces.setState({ poiError: e.message });

export function PoiPicker() {
  const pois = usePlaces((s) => s.pois);
  const error = usePlaces((s) => s.poiError);
  const poiIds = useStore((s) => s.analysis.setup.poiIds);
  const busy = useStore((s) => isMapBusy(s.analysis.work));
  const set = useStore((s) => s.set);
  const view = () => useStore.getState().analysis;
  const bounds = useMapBounds((s) => s.bounds);
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = nearbyPois(pois ?? [], bounds, poiIds, showAll);

  useEffect(() => {
    usePlaces.setState({ poiError: null });
    refreshPois().catch(showError);
  }, []);

  return (
    <section className="analysis-section" aria-label="Points of interest">
      <h3 className="analysis-section-title">Points of interest</h3>
      {error && <p className="error-text small">{error}</p>}
      {pois === null ? (
        <p className="muted small">Loading the points of interest…</p>
      ) : shown.length > 0 ? (
        <ul className="analysis-places">
          {shown.map((poi) => (
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
            />
          ))}
        </ul>
      ) : null}
      <HiddenPlaces
        hidden={hidden}
        one="point of interest"
        many="points of interest"
        showAll={showAll}
        onToggle={() => setShowAll(!showAll)}
      />
      <p className="muted small analysis-map-hint">
        {pois?.length === 0 ? 'No points of interest yet. ' : ''}Use Place point of interest (P) on
        the map to add the places people travel to, such as a hospital. Drag a pin to move it.
      </p>
    </section>
  );
}
