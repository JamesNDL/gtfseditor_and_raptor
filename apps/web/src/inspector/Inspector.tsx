import { currentSelection, useStore } from '../app/store.ts';
import { RouteListPanel } from './RouteListPanel.tsx';
import { RoutePanel } from './RoutePanel.tsx';
import { StationPanel } from './StationPanel.tsx';
import { TripPanel } from './TripPanel.tsx';
import { VehicleDayPanel } from './VehicleDayPanel.tsx';

export function Inspector() {
  const selection = useStore(currentSelection);
  const depth = useStore((s) => s.history.length);
  const back = useStore((s) => s.back);
  const close = useStore((s) => s.close);
  // The drawing, route-changing and closure panels take the inspector's place while they are open.
  const drawing = useStore((s) => s.builder !== null || s.closing !== null);
  if (!selection || drawing) return null;

  return (
    <aside className="panel inspector">
      <div className="inspector-nav">
        {depth > 1 ? (
          <button className="link" onClick={back}>
            ← Back
          </button>
        ) : (
          <span />
        )}
        <button className="icon-button" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="inspector-body">
        {selection.kind === 'route' && <RoutePanel key={selection.id} routeId={selection.id} />}
        {selection.kind === 'trip' && <TripPanel key={selection.id} tripId={selection.id} />}
        {selection.kind === 'vehicleDay' && (
          <VehicleDayPanel key={selection.id} vehicleDayId={selection.id} />
        )}
        {selection.kind === 'routeList' && <RouteListPanel ids={selection.ids} />}
        {selection.kind === 'station' && <StationPanel key={selection.id} stopId={selection.id} />}
      </div>
    </aside>
  );
}
