import { useStore } from '../app/store.ts';
import { Badge, fmt } from '../shared/ui/parts.tsx';

/** Shown when a click lands on several overlapping lines. */
export function RouteListPanel({ ids }: { ids: number[] }) {
  const routes = useStore((s) => s.routes);
  const modes = useStore((s) => s.modes);
  const open = useStore((s) => s.open);
  const set = useStore((s) => s.set);
  const list = ids.map((id) => routes.get(id)).filter((r) => r !== undefined);

  return (
    <>
      <div className="title-row">
        <div>
          <h2>{list.length} lines here</h2>
          <div className="muted">Choose one to inspect</div>
        </div>
      </div>
      <ul className="rows clickable">
        {list.map((r) => (
          <li key={r.id}>
            <button
              className="row"
              onClick={() => open({ kind: 'route', id: r.id })}
              onMouseEnter={() => set({ highlightRouteId: r.id })}
            >
              <Badge color={r.color}>{r.shortName ?? '?'}</Badge>
              <div className="grow">
                <div className="ellipsis">{r.longName ?? r.agency}</div>
                <div className="muted">{modes.find((m) => m.id === r.modeId)?.name}</div>
              </div>
              <div className="row-end">{fmt(r.tripCount)} trips</div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
