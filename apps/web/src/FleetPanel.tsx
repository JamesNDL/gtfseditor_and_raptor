import { useEffect, useState } from 'react';
import { useApi } from './api.ts';
import { applyEdit } from './scenario.ts';
import { useStore } from './store.ts';

export interface VehicleType {
  id: number;
  name: string;
  modeId: string;
  modeName: string;
  cars: number | null;
  seated: number;
  standing: number;
  fleetSize: number | null;
  capacityIsPlaceholder: boolean;
  vehicles: number;
  trips: number;
  isModeDefault: boolean;
}

const fmt = (n: number) => n.toLocaleString('en-AU');

async function save(method: string, url: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return null;
  const json = await res.json().catch(() => ({}));
  return (json as { message?: string }).message ?? `Request failed (${res.status})`;
}

/** The vehicle catalogue for the chosen day, refetched after every change. */
export function useVehicleTypes(enabled = true) {
  const baselineId = useStore((s) => s.baselineId);
  return useApi<VehicleType[]>(
    enabled && baselineId !== null ? `/api/vehicle-types?baseline=${baselineId}` : null,
  );
}

/** The catalogue screen: capacities, fleet sizes and how many of each type are in use. */
export function FleetPanel() {
  const open = useStore((s) => s.fleetOpen);
  const set = useStore((s) => s.set);
  const modes = useStore((s) => s.modes);
  const editing = useStore((s) => s.scenarioId !== null);
  const types = useVehicleTypes(open);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: '',
    modeId: 'bus',
    cars: '',
    seated: '',
    standing: '',
    fleetSize: '',
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && set({ fleetOpen: false });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, set]);

  if (!open) return null;
  const refresh = () => set({ dataVersion: useStore.getState().dataVersion + 1 });
  const listed = types.data ?? [];
  const noLimits = listed.length > 0 && listed.every((t) => t.fleetSize === null);
  const limitsFromDay = async () => {
    const baselineId = useStore.getState().baselineId;
    if (baselineId === null) return;
    setError(await save('POST', `/api/vehicle-types/limits-from-day?baseline=${baselineId}`, {}));
    refresh();
  };
  const commit = async (id: number, patch: Record<string, unknown>) => {
    setError(await save('PATCH', `/api/vehicle-types/${id}`, patch));
    refresh();
  };
  const num = (text: string) => (text.trim() === '' ? null : Number(text));

  return (
    <div className="fleet-backdrop" onClick={() => set({ fleetOpen: false })}>
      <section
        className="panel fleet"
        onClick={(e) => e.stopPropagation()}
        aria-label="Vehicle catalogue"
      >
        <header className="fleet-header">
          <div>
            <h2>Vehicle catalogue</h2>
            <div className="muted small">
              Capacities and fleet sizes apply everywhere. "In use" counts{' '}
              {editing ? 'this scenario' : 'the published timetable'} for the chosen day.
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => set({ fleetOpen: false })}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {error && <p className="error-text small fleet-error">{error}</p>}
        {noLimits && (
          <p className="small fleet-error fleet-limits-note">
            No fleet sizes are set, so nothing can warn that a scenario needs more vehicles than
            exist.{' '}
            <button
              className="button small-button limits-button"
              title="Sets each type's fleet size to the number the published timetable uses on this day. These are the editor's own estimates: correct any you know."
              onClick={() => void limitsFromDay()}
            >
              Set each to what the published timetable uses
            </button>
          </p>
        )}

        <div className="fleet-scroll">
          <table className="fleet-table">
            <thead>
              <tr>
                <th>Vehicle type</th>
                <th>Mode</th>
                <th className="n">Cars</th>
                <th className="n">Seated</th>
                <th className="n">Standing</th>
                <th
                  className="n"
                  title="How many vehicles of this type exist. Leave blank for no limit."
                >
                  Fleet size
                </th>
                <th className="n" title="Vehicles of this type needed on the chosen day">
                  In use
                </th>
                <th className="n">Trips</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(types.data ?? []).map((t) => {
                const over = t.fleetSize !== null && t.vehicles > t.fleetSize;
                return (
                  <tr key={t.id}>
                    <td>
                      <Cell value={t.name} onCommit={(v) => commit(t.id, { name: v })} wide />
                      {t.capacityIsPlaceholder && (
                        <button
                          className="tag tag-warn tag-button"
                          title="These capacity numbers are round-number placeholders. Click once they have been checked against a source."
                          onClick={() => commit(t.id, { capacityIsPlaceholder: false })}
                        >
                          placeholder
                        </button>
                      )}
                    </td>
                    <td className="muted">{t.modeName}</td>
                    <td className="n">
                      <Cell
                        value={t.cars === null ? '' : String(t.cars)}
                        onCommit={(v) => commit(t.id, { cars: num(v) })}
                      />
                    </td>
                    <td className="n">
                      <Cell
                        value={String(t.seated)}
                        onCommit={(v) => commit(t.id, { seated: num(v) })}
                      />
                    </td>
                    <td className="n">
                      <Cell
                        value={String(t.standing)}
                        onCommit={(v) => commit(t.id, { standing: num(v) })}
                      />
                    </td>
                    <td className="n">
                      <Cell
                        value={t.fleetSize === null ? '' : String(t.fleetSize)}
                        placeholder="no limit"
                        onCommit={(v) => commit(t.id, { fleetSize: num(v) })}
                      />
                    </td>
                    <td
                      className={`n${over ? ' warn-text' : ''}`}
                      title={
                        over ? `${t.vehicles - t.fleetSize!} more than the fleet has` : undefined
                      }
                    >
                      {fmt(t.vehicles)}
                      {over && ' !'}
                    </td>
                    <td className="n muted">{fmt(t.trips)}</td>
                    <td className="n">
                      {t.trips === 0 && !t.isModeDefault && (
                        <button
                          className="link small"
                          onClick={async () => {
                            setError(await save('DELETE', `/api/vehicle-types/${t.id}`));
                            refresh();
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <input
                    className="cell wide"
                    placeholder="Add a vehicle type"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    className="cell"
                    value={draft.modeId}
                    onChange={(e) => setDraft({ ...draft, modeId: e.target.value })}
                    aria-label="Mode"
                  >
                    {modes.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </td>
                {(['cars', 'seated', 'standing', 'fleetSize'] as const).map((k) => (
                  <td key={k} className="n">
                    <input
                      className="cell"
                      inputMode="numeric"
                      value={draft[k]}
                      onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                      aria-label={k}
                    />
                  </td>
                ))}
                <td colSpan={3} className="n">
                  <button
                    className="button small-button"
                    disabled={!draft.name.trim() || draft.seated === '' || draft.standing === ''}
                    onClick={async () => {
                      const problem = await save('POST', '/api/vehicle-types', {
                        name: draft.name,
                        modeId: draft.modeId,
                        cars: num(draft.cars),
                        seated: num(draft.seated),
                        standing: num(draft.standing),
                        fleetSize: num(draft.fleetSize),
                      });
                      setError(problem);
                      if (!problem)
                        setDraft({
                          ...draft,
                          name: '',
                          cars: '',
                          seated: '',
                          standing: '',
                          fleetSize: '',
                        });
                      refresh();
                    }}
                  >
                    Add
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <footer className="muted small fleet-footer">
          Click a value to change it; press Enter or click away to save. To run a line, a vehicle or
          a trip with a different type, open it: the type pickers are there whenever a day is open,
          and the first change starts a scenario.
        </footer>
      </section>
    </div>
  );
}

/** A table cell that edits in place and saves on Enter or when focus leaves. */
function Cell({
  value,
  onCommit,
  wide,
  placeholder,
}: {
  value: string;
  onCommit: (value: string) => void;
  wide?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className={`cell${wide ? ' wide' : ''}`}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value);
          e.stopPropagation();
        }
      }}
    />
  );
}

/** "Run this with ..." control, shown while a scenario is being edited. */
export function VehicleTypePicker({
  scope,
  id,
  modeId,
  currentTypeId,
  label,
}: {
  scope: 'route' | 'vehicleDay' | 'trip';
  id: number;
  modeId: string;
  currentTypeId?: number | null;
  label: string;
}) {
  const types = useVehicleTypes();
  const busy = useStore((s) => s.editBusy);
  const set = useStore((s) => s.set);
  const [choice, setChoice] = useState<number | ''>(currentTypeId ?? '');
  useEffect(() => setChoice(currentTypeId ?? ''), [currentTypeId, id]);
  const options = (types.data ?? []).filter((t) => t.modeId === modeId);
  return (
    <div className="edit-row">
      <span className="muted small">{label}</span>
      <select
        className="day-select picker"
        value={choice}
        onChange={(e) => setChoice(e.target.value === '' ? '' : Number(e.target.value))}
        aria-label={label}
      >
        <option value="">Choose a vehicle type</option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} · {fmt(t.seated + t.standing)} places
          </option>
        ))}
      </select>
      <button
        className="button small-button"
        disabled={busy || choice === '' || choice === currentTypeId}
        onClick={() => applyEdit({ kind: 'setVehicleType', scope, id, vehicleTypeId: choice })}
      >
        Apply
      </button>
      <button className="link small" onClick={() => set({ fleetOpen: true })}>
        Catalogue
      </button>
    </div>
  );
}
