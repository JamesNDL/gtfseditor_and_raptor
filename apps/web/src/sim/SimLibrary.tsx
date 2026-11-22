// The simulation library: every run, shared between everyone who uses the editor, by folder or by
// date, with scenario runs listed under the BAU run they were made against. Nothing is removed
// unless someone removes it. See docs/simulator-plan.md, section 6.5.
import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../api.ts';
import { fmt } from '../inspector/parts.tsx';
import { useStore } from '../store.ts';
import {
  bytes,
  isActive,
  progressText,
  refreshRuns,
  send,
  type SimFolder,
  type SimRun,
} from './simApi.ts';

type Where = 'all' | 'unfiled' | number;

/** Which heading a run goes under when the library is listed by date. */
function dateGroup(iso: string): string {
  const made = new Date(iso);
  const now = new Date();
  const days = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(made.getFullYear(), made.getMonth(), made.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) return 'Today';
  if (days < 7) return 'This week';
  return made.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

export function SimLibrary() {
  const open = useStore((s) => s.simScreen === 'library');
  const runs = useStore((s) => s.simRuns);
  const shownId = useStore((s) => s.simRunId);
  const set = useStore((s) => s.set);
  const [folders, setFolders] = useState<SimFolder[]>([]);
  const [where, setWhere] = useState<Where>('all');
  const [byDate, setByDate] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | 'bau' | 'scenario'>('');
  const [who, setWho] = useState('');
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');

  const loadFolders = () => getJson<SimFolder[]>('/api/sim-folders').then(setFolders);
  const reload = () => Promise.all([refreshRuns(), loadFolders()]);
  useEffect(() => {
    if (!open) return;
    void reload();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && set({ simScreen: null });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, set]);
  const act = (work: Promise<unknown>) =>
    work.then(
      () => (setError(null), reload()),
      (e: Error) => setError(e.message),
    );

  // Runs made from another (a scenario run from its BAU run, a capacity run from its plans) are
  // listed under it, wherever each is filed.
  const { tops, under } = useMemo(() => {
    const matches = (r: SimRun) =>
      (where === 'all' || (where === 'unfiled' ? r.folderId === null : r.folderId === where)) &&
      (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())) &&
      (!kind || r.kind === kind) &&
      (!who || r.madeBy === who) &&
      (!stale || r.outOfDate);
    const parentOf = (r: SimRun) => r.plansRunId ?? r.bauRunId;
    const byId = new Map(runs.map((r) => [r.id, r]));
    const under = new Map<number, SimRun[]>();
    const tops: SimRun[] = [];
    for (const run of runs) {
      const parent = parentOf(run);
      if (parent !== null && byId.has(parent))
        under.set(parent, [...(under.get(parent) ?? []), run]);
      else tops.push(run);
    }
    const family = (r: SimRun): SimRun[] => [r, ...(under.get(r.id) ?? []).flatMap(family)];
    return { tops: tops.filter((r) => family(r).some(matches)), under };
  }, [runs, where, q, kind, who, stale]);

  if (!open) return null;
  const makers = [...new Set(runs.map((r) => r.madeBy).filter((m): m is string => !!m))].sort();
  const groups = byDate
    ? [...new Set(tops.map((r) => dateGroup(r.createdAt)))].map((title) => ({
        title,
        runs: tops.filter((r) => dateGroup(r.createdAt) === title),
      }))
    : [{ title: '', runs: tops }];
  const folderPath = (id: number | null): string => {
    const folder = folders.find((f) => f.id === id);
    return folder
      ? `${folder.parentId !== null ? `${folderPath(folder.parentId)} / ` : ''}${folder.name}`
      : 'Unfiled';
  };
  const children = (parent: number | null, depth: number): { folder: SimFolder; depth: number }[] =>
    folders
      .filter((f) => f.parentId === parent)
      .flatMap((folder) => [{ folder, depth }, ...children(folder.id, depth + 1)]);
  const chosenFolder = typeof where === 'number' ? folders.find((f) => f.id === where) : null;

  return (
    <div className="fleet-backdrop" onClick={() => set({ simScreen: null })}>
      <section
        className="panel fleet sim-library"
        onClick={(e) => e.stopPropagation()}
        aria-label="Simulation library"
      >
        <header className="fleet-header">
          <div>
            <h2>Simulation library</h2>
            <div className="muted small">
              Every run, shared with everyone who uses the editor. {fmt(runs.length)} run
              {runs.length === 1 ? '' : 's'}, {bytes(runs.reduce((sum, r) => sum + r.sizeBytes, 0))}{' '}
              in the database. Nothing is removed unless someone removes it.
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => set({ simScreen: null })}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        {error && <p className="error-text small fleet-error">{error}</p>}

        <div className="sim-library-body">
          <nav className="sim-folders" aria-label="Folders">
            <button className={where === 'all' ? 'on' : ''} onClick={() => setWhere('all')}>
              All runs <span className="muted">{runs.length}</span>
            </button>
            <button className={where === 'unfiled' ? 'on' : ''} onClick={() => setWhere('unfiled')}>
              Unfiled{' '}
              <span className="muted">{runs.filter((r) => r.folderId === null).length}</span>
            </button>
            {children(null, 0).map(({ folder, depth }) => (
              <button
                key={folder.id}
                className={where === folder.id ? 'on' : ''}
                style={{ paddingLeft: 10 + depth * 14 }}
                onClick={() => setWhere(folder.id)}
              >
                {folder.name} <span className="muted">{folder.runs}</span>
              </button>
            ))}
            <form
              className="sim-new-folder"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newFolder.trim()) return;
                void act(
                  send('POST', '/api/sim-folders', {
                    name: newFolder.trim(),
                    parentId: typeof where === 'number' ? where : null,
                  }).then(() => setNewFolder('')),
                );
              }}
            >
              <input
                className="day-select"
                placeholder={chosenFolder ? `New folder in ${chosenFolder.name}` : 'New folder'}
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                aria-label="Name of a new folder"
              />
              <button className="button small-button" type="submit" disabled={!newFolder.trim()}>
                Add
              </button>
            </form>
            {chosenFolder && (
              <div className="sim-folder-tools">
                <Rename
                  value={chosenFolder.name}
                  label="Rename folder"
                  onDone={(name) =>
                    act(send('PATCH', `/api/sim-folders/${chosenFolder.id}`, { name }))
                  }
                />
                <button
                  className="button small-button"
                  disabled={
                    chosenFolder.runs > 0 || folders.some((f) => f.parentId === chosenFolder.id)
                  }
                  title="Only an empty folder can be removed"
                  onClick={() =>
                    void act(
                      send('DELETE', `/api/sim-folders/${chosenFolder.id}`).then(() =>
                        setWhere('all'),
                      ),
                    )
                  }
                >
                  Remove folder
                </button>
              </div>
            )}
          </nav>

          <div className="sim-runs">
            <div className="sim-filters">
              <input
                className="day-select grow"
                placeholder="Find a run by name"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Find a run by name"
              />
              <select
                className="day-select"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
                aria-label="Kind of run"
              >
                <option value="">BAU and scenario</option>
                <option value="bau">BAU runs</option>
                <option value="scenario">Scenario runs</option>
              </select>
              {makers.length > 0 && (
                <select
                  className="day-select"
                  value={who}
                  onChange={(e) => setWho(e.target.value)}
                  aria-label="Made by"
                >
                  <option value="">Made by anyone</option>
                  {makers.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              )}
              <label
                className="check small"
                title="Runs made before the timetable they ran on was edited"
              >
                <input
                  type="checkbox"
                  checked={stale}
                  onChange={(e) => setStale(e.target.checked)}
                />{' '}
                out of date
              </label>
              <div className="speeds" role="group" aria-label="How the runs are listed">
                <button className={!byDate ? 'on' : ''} onClick={() => setByDate(false)}>
                  By folder
                </button>
                <button className={byDate ? 'on' : ''} onClick={() => setByDate(true)}>
                  By date
                </button>
              </div>
            </div>

            <div className="sim-run-list">
              {tops.length === 0 && (
                <p className="note">
                  {runs.length
                    ? 'No run matches.'
                    : 'No runs yet. "New simulation" in the Simulation panel makes the first.'}
                </p>
              )}
              {groups.map((group) => (
                <div key={group.title}>
                  {group.title && <h3>{group.title}</h3>}
                  {group.runs.map((run) => (
                    <Family
                      key={run.id}
                      run={run}
                      under={under}
                      depth={0}
                      shownId={shownId}
                      folders={folders}
                      folderPath={folderPath}
                      act={act}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

interface RowProps {
  run: SimRun;
  under: Map<number, SimRun[]>;
  depth: number;
  shownId: number | null;
  folders: SimFolder[];
  folderPath: (id: number | null) => string;
  act: (work: Promise<unknown>) => Promise<unknown>;
}

/** A run and, indented under it, the runs made from it. */
function Family(props: RowProps) {
  return (
    <>
      <Row {...props} />
      {(props.under.get(props.run.id) ?? []).map((child) => (
        <Family key={child.id} {...props} run={child} depth={props.depth + 1} />
      ))}
    </>
  );
}

function Row({ run, depth, shownId, folders, folderPath, act }: RowProps) {
  const set = useStore((s) => s.set);
  const [removing, setRemoving] = useState(false);
  const dependents = run.scenarioRuns + run.capacityRuns;
  const people = run.people;
  return (
    <div className={`sim-run${run.id === shownId ? ' on' : ''}`} style={{ marginLeft: depth * 22 }}>
      <div className="sim-run-main">
        <div className="sim-run-name">
          <strong className="ellipsis">{run.name}</strong>
          <span className="tag tag-info">
            {run.plansRunId ? 'capacity' : run.kind === 'bau' ? 'BAU' : 'scenario'}
          </span>
          {run.outOfDate && (
            <span className="tag tag-warn" title="The timetable it ran on has been edited since">
              out of date
            </span>
          )}
          {run.capacityOutOfDate && (
            <span className="tag tag-warn" title="Vehicle capacities have been edited since">
              capacities changed
            </span>
          )}
          {run.archived && (
            <span
              className="tag tag-info"
              title="Its journeys are kept as files, not in the database"
            >
              archived
            </span>
          )}
          {run.state === 'failed' && <span className="tag tag-warn">failed</span>}
          {run.state === 'stopped' && <span className="tag tag-info">stopped</span>}
        </div>
        <div className="muted small">
          {isActive(run) ? (
            progressText(run)
          ) : run.state === 'failed' ? (
            run.error
          ) : (
            <>
              {run.kind === 'scenario' ? `${run.scenarioName ?? 'a removed scenario'} · ` : ''}
              {run.demandSetName ?? 'journeys removed'} ·{' '}
              {run.area ? (run.area.name ?? 'a box') : 'whole network'}
              {people
                ? ` · ${fmt(people.ok)} of ${fmt(people.ok + people.noJourney + people.gaveUp + people.stranded)} travel`
                : ''}
            </>
          )}
        </div>
        <div className="muted small">
          {new Date(run.createdAt).toLocaleString('en-AU', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
          {run.madeBy ? ` · ${run.madeBy}` : ''} · {folderPath(run.folderId)}
          {run.state === 'done' ? ` · ${bytes(run.sizeBytes)}` : ''}
        </div>
      </div>
      <div className="sim-run-tools">
        {run.state === 'done' && (
          <button
            className="button small-button on"
            onClick={() => set({ simRunId: run.id, simPerson: null, simScreen: null })}
            title="Show this run's figures in the editor"
          >
            Open
          </button>
        )}
        <Rename
          value={run.name}
          label="Rename"
          onDone={(name) => act(send('PATCH', `/api/sim-runs/${run.id}`, { name }))}
        />
        <select
          className="day-select"
          value={run.folderId ?? ''}
          title="Move to a folder"
          aria-label="Folder"
          onChange={(e) =>
            void act(
              send('PATCH', `/api/sim-runs/${run.id}`, {
                folderId: e.target.value ? Number(e.target.value) : null,
              }),
            )
          }
        >
          <option value="">Unfiled</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {folderPath(f.id)}
            </option>
          ))}
        </select>
        {run.state === 'done' &&
          (run.archived ? (
            <button
              className="button small-button"
              onClick={() => void act(send('POST', `/api/sim-runs/${run.id}/restore`))}
              title="Bring its journeys back into the database, so that people can be looked up again"
            >
              Restore
            </button>
          ) : (
            <button
              className="button small-button"
              onClick={() => void act(send('POST', `/api/sim-runs/${run.id}/archive`))}
              title="Take its journeys out of the database to save space. It still opens; looking up one person needs it restored."
            >
              Archive
            </button>
          ))}
        {isActive(run) ? (
          <button
            className="button small-button"
            onClick={() => void act(send('DELETE', `/api/sim-runs/${run.id}`))}
          >
            Stop
          </button>
        ) : !removing ? (
          <button className="button small-button" onClick={() => setRemoving(true)}>
            Remove
          </button>
        ) : (
          <>
            <button
              className="button small-button danger"
              title={
                dependents
                  ? `${dependents} other run${dependents === 1 ? ' was' : 's were'} made from this one. They stay, but lose what they are compared with.`
                  : 'Its results and files are deleted'
              }
              onClick={() =>
                void act(
                  send('DELETE', `/api/sim-runs/${run.id}${dependents ? '?force=true' : ''}`).then(
                    () => {
                      if (useStore.getState().simRunId === run.id)
                        set({ simRunId: null, simPerson: null });
                    },
                  ),
                )
              }
            >
              {dependents
                ? `Remove, though ${dependents} run${dependents === 1 ? ' depends' : 's depend'} on it`
                : 'Remove for good'}
            </button>
            <button className="button small-button" onClick={() => setRemoving(false)}>
              Keep
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** A button that turns into a box to type a new name in. */
export function Rename({
  value,
  label,
  onDone,
}: {
  value: string;
  label: string;
  onDone: (name: string) => unknown;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button className="button small-button" onClick={() => setDraft(value)}>
        {label}
      </button>
    );
  }
  const finish = () => {
    if (draft.trim() && draft.trim() !== value) onDone(draft.trim());
    setDraft(null);
  };
  return (
    <input
      className="day-select sim-rename"
      autoFocus
      value={draft}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}
