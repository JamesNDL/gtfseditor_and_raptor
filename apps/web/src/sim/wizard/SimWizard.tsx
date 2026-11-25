// The wizard that sets up a simulation: four short steps, each with a sensible choice already
// made. Nothing starts until the last step. See docs/simulator-plan.md, section 7.1.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getJson } from '../../shared/api-client.ts';
import { fmt } from '../../shared/ui/parts.tsx';
import { useStore } from '../../app/store.ts';
import { follow } from '../SimPanel.tsx';
import {
  madeBy,
  mapView,
  refreshRuns,
  send,
  type Coverage,
  type DemandSet,
  type SimArea,
  type SimBox,
  type SimFolder,
  type SimRun,
} from '../sim-api.ts';
import './wizard.css';

/** What was chosen last time, so that repeating a run after an edit is two clicks. */
interface Remembered {
  demandId: number | null;
  area: 'all' | 'box' | number;
  box: SimBox | null;
  walkMetres: number;
  changeMin: number;
  schoolBuses: boolean;
  share: number;
  capacity: boolean;
  thresholdMin: number;
  giveUpMin: number | null;
  bauRunId: number | null;
  folderId: number | null;
}

const DEFAULTS: Remembered = {
  demandId: null,
  area: 'all',
  box: null,
  walkMetres: 500,
  changeMin: 10,
  schoolBuses: false,
  share: 1,
  capacity: false,
  thresholdMin: 10,
  giveUpMin: 60,
  bauRunId: null,
  folderId: null,
};

function remembered(): Remembered {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('simWizard') ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

const STEPS = ['What to simulate', 'Who and where', 'How people travel', 'Check and run'];
/** Minutes on foot for a straight-line distance, at the router's pace and detour. */
const walkMinutes = (metres: number) => Math.round((metres * 1.3) / 1.03 / 60);
const roughTime = (secs: number) =>
  secs < 90
    ? 'about a minute'
    : secs < 3600
      ? `about ${Math.round(secs / 60)} minutes`
      : `about ${(secs / 3600).toFixed(1)} hours`;

export function SimWizard() {
  const open = useStore((s) => s.simScreen === 'wizard');
  const drawing = useStore((s) => s.simDrawing);
  if (!open) return null;
  // While a box is being dragged on the map the wizard steps aside, and comes back as it was.
  return (
    <div className="fleet-backdrop" style={drawing ? { display: 'none' } : undefined}>
      <Wizard />
    </div>
  );
}

function Wizard() {
  const baselineId = useStore((s) => s.baselineId)!;
  const scenarioId = useStore((s) => s.scenarioId);
  const scenarioName = useStore(
    (s) => s.scenarios.find((x) => x.id === s.scenarioId)?.name ?? null,
  );
  const runs = useStore((s) => s.simRuns);
  const drawnBox = useStore((s) => s.simBox);
  const set = useStore((s) => s.set);

  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<'bau' | 'scenario'>(scenarioId !== null ? 'scenario' : 'bau');
  const [c, setC] = useState<Remembered>(remembered);
  const choose = (patch: Partial<Remembered>) => setC((now) => ({ ...now, ...patch }));
  const [demand, setDemand] = useState<DemandSet[]>([]);
  const [areas, setAreas] = useState<SimArea[]>([]);
  const [folders, setFolders] = useState<SimFolder[]>([]);
  const [routerUp, setRouterUp] = useState<{ router: boolean; message?: string } | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [unknown, setUnknown] = useState<DemandSet['unknownStops'] | null>(null);
  const [name, setName] = useState('');
  const [who, setWho] = useState(madeBy.get());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [makeUp, setMakeUp] = useState({ journeys: '20000', seed: '1' });
  const [areaName, setAreaName] = useState('');

  const close = () => set({ simScreen: null, simBox: null, simDrawing: false });
  const loadDemand = () => getJson<DemandSet[]>('/api/demand').then(setDemand);
  useEffect(() => {
    void loadDemand();
    void getJson<SimArea[]>('/api/sim-areas').then(setAreas);
    void getJson<SimFolder[]>('/api/sim-folders').then(setFolders);
    void getJson<{ router: boolean; message?: string }>('/api/sim/status').then(setRouterUp);
    void refreshRuns();
  }, []);
  // A set that is still being made is asked after until it is ready.
  const making = demand.some((d) => d.state === 'generating' || d.state === 'checking');
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => void loadDemand(), 1500);
    return () => clearInterval(timer);
  }, [making]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !useStore.getState().simDrawing && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const ready = demand.filter((d) => d.state === 'ready');
  const chosenDemand = ready.find((d) => d.id === c.demandId) ?? null;
  const box: SimBox | null =
    c.area === 'all'
      ? null
      : c.area === 'box'
        ? c.box
        : (areas.find((a) => a.id === c.area) ?? null);
  // BAU runs a scenario run may be measured against: finished, of this day, still in date.
  const bauRuns = runs.filter(
    (r) => r.kind === 'bau' && !r.plansRunId && r.state === 'done' && !r.outOfDate,
  );
  const bau = bauRuns.find((r) => r.id === c.bauRunId) ?? bauRuns[0] ?? null;

  // A box dragged on the map comes back through the store, when the dragging ends.
  const drawing = useStore((s) => s.simDrawing);
  const wasDrawing = useRef(false);
  useEffect(() => {
    if (wasDrawing.current && !drawing && drawnBox) choose({ area: 'box', box: drawnBox });
    wasDrawing.current = drawing;
  }, [drawing]);
  // The box in use is shown on the map behind the wizard.
  useEffect(() => {
    set({ simBox: kind === 'bau' ? box : (bau?.area ?? null) });
  }, [kind, box?.south, box?.west, box?.north, box?.east, bau?.id]);

  // What the last step warns about.
  const coverageUrl = useMemo(() => {
    const set = kind === 'bau' ? chosenDemand?.id : bau?.demandSetId;
    if (!set) return null;
    const area = kind === 'bau' ? box : (bau?.area ?? null);
    const walk = kind === 'bau' ? c.walkMetres : Number(bau?.settings.walkMetres ?? 500);
    return `/api/demand/${set}/coverage?baseline=${baselineId}&walk=${walk}${kind === 'scenario' && scenarioId !== null ? `&s=${scenarioId}` : ''}${
      area ? `&south=${area.south}&west=${area.west}&north=${area.north}&east=${area.east}` : ''
    }`;
  }, [
    kind,
    chosenDemand?.id,
    bau?.id,
    box?.south,
    box?.west,
    box?.north,
    box?.east,
    c.walkMetres,
    scenarioId,
    baselineId,
  ]);
  useEffect(() => {
    setCoverage(null);
    if (coverageUrl) getJson<Coverage>(coverageUrl).then(setCoverage, () => {});
  }, [coverageUrl]);
  useEffect(() => {
    setUnknown(null);
    if (kind === 'bau' && chosenDemand) {
      getJson<DemandSet>(`/api/demand/${chosenDemand.id}?baseline=${baselineId}`).then(
        (d) => setUnknown(d.unknownStops ?? null),
        () => {},
      );
    }
  }, [kind, chosenDemand?.id, baselineId]);

  const suggested =
    kind === 'bau'
      ? box
        ? `BAU bounded ${box.name ?? 'to a box'}`
        : 'BAU, whole network'
      : `${scenarioName ?? 'Scenario'} against ${bau?.name ?? 'a BAU run'}`;
  const folderId = kind === 'scenario' ? (bau?.folderId ?? null) : c.folderId;
  const rates = runs
    .map((r) => r.planRate)
    .filter((n): n is number => typeof n === 'number' && n > 0);
  const insideShare =
    coverage && coverage.journeyEnds ? coverage.endsInside / coverage.journeyEnds : 1;
  const journeys =
    kind === 'bau'
      ? Math.round(((chosenDemand?.rows ?? 0) / c.share) * insideShare)
      : bau?.people
        ? bau.people.ok + bau.people.noJourney + bau.people.gaveUp + bau.people.stranded
        : 0;
  const canGo = [
    true,
    kind === 'bau' ? chosenDemand !== null && (c.area !== 'box' || c.box !== null) : bau !== null,
    true,
    routerUp?.router === true,
  ][step];

  const upload = async (file: File) => {
    setBusy('Checking the file ...');
    setError(null);
    try {
      const made = await send<DemandSet>(
        'POST',
        `/api/demand?name=${encodeURIComponent(file.name.replace(/\.(csv|gz)+$/g, ''))}&madeBy=${encodeURIComponent(who)}`,
        file,
        { 'content-type': file.name.endsWith('.gz') ? 'application/gzip' : 'text/csv' },
      );
      await loadDemand();
      choose({ demandId: made.id });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  };
  const generate = async () => {
    setError(null);
    try {
      const made = await send<DemandSet>('POST', '/api/demand/generate', {
        baselineId,
        journeys: Number(makeUp.journeys),
        seed: Number(makeUp.seed),
        madeBy: who || undefined,
        ...(box ? { area: box } : {}),
      });
      await loadDemand();
      choose({ demandId: made.id });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const run = async () => {
    setBusy('Starting ...');
    setError(null);
    madeBy.set(who);
    try {
      localStorage.setItem(
        'simWizard',
        JSON.stringify(kind === 'scenario' ? { ...c, bauRunId: bau?.id ?? null } : c),
      );
    } catch {
      // Remembering the choices is a convenience only.
    }
    const common = { name: name.trim() || suggested, madeBy: who.trim() || undefined };
    try {
      const made =
        kind === 'bau'
          ? await send<SimRun>('POST', '/api/sim-runs', {
              ...common,
              baselineId,
              demandSetId: chosenDemand!.id,
              folderId,
              ...(c.area === 'all'
                ? {}
                : typeof c.area === 'number'
                  ? { areaId: c.area }
                  : { area: c.box }),
              settings: {
                walkMetres: c.walkMetres,
                changePenaltySecs: c.changeMin * 60,
                schoolBuses: c.schoolBuses,
                shareOneIn: c.share,
                capacity: c.capacity,
              },
            })
          : await send<SimRun>('POST', `/api/sim-runs?s=${scenarioId}`, {
              ...common,
              bauRunId: bau!.id,
              settings: {
                switchThresholdSecs: c.thresholdMin * 60,
                giveUpSecs: c.giveUpMin === null ? null : c.giveUpMin * 60,
                capacity: c.capacity,
              },
            });
      follow.add(made.id);
      await refreshRuns();
      close();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <section className="panel fleet sim-wizard" aria-label="New simulation">
      <header className="fleet-header">
        <div>
          <h2>New simulation</h2>
          <ol className="sim-steps">
            {STEPS.map((title, i) => (
              <li key={title} className={i === step ? 'on' : i < step ? 'done' : ''}>
                {i + 1}. {title}
              </li>
            ))}
          </ol>
        </div>
        <button className="icon-button" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="fleet-scroll sim-step">
        {step === 0 && (
          <div className="sim-choices">
            <label className={`sim-choice${kind === 'bau' ? ' on' : ''}`}>
              <input
                type="radio"
                name="kind"
                checked={kind === 'bau'}
                onChange={() => setKind('bau')}
              />
              <div>
                <strong>The published timetable (BAU)</strong>
                <div className="muted small">
                  Everyone travels between the stops in the journey data. Made once and kept:
                  scenario runs are measured against it.
                </div>
              </div>
            </label>
            <label
              className={`sim-choice${kind === 'scenario' ? ' on' : ''}${scenarioId === null ? ' off' : ''}`}
            >
              <input
                type="radio"
                name="kind"
                checked={kind === 'scenario'}
                disabled={scenarioId === null}
                onChange={() => setKind('scenario')}
              />
              <div>
                <strong>The scenario on screen{scenarioName ? `: ${scenarioName}` : ''}</strong>
                <div className="muted small">
                  {scenarioId === null
                    ? 'Open a scenario first.'
                    : 'The same people, sent through the scenario and compared with a BAU run you pick.'}
                </div>
              </div>
            </label>
          </div>
        )}

        {step === 1 && kind === 'bau' && (
          <>
            <h3>Who is travelling</h3>
            <div className="sim-row">
              <select
                className="day-select grow"
                value={c.demandId ?? ''}
                onChange={(e) =>
                  choose({ demandId: e.target.value ? Number(e.target.value) : null })
                }
                aria-label="Journeys to simulate"
              >
                <option value="">Choose a set of journeys</option>
                {demand.map((d) => (
                  <option key={d.id} value={d.id} disabled={d.state !== 'ready'}>
                    {d.name} ·{' '}
                    {d.state === 'ready'
                      ? `${fmt(d.rows)} journeys`
                      : d.state === 'failed'
                        ? 'failed'
                        : 'being made ...'}
                  </option>
                ))}
              </select>
              <label
                className="button small-button"
                title="A CSV with user_id, start_time, origin_stop and destination_stop; it may be gzipped"
              >
                Upload a CSV
                <input
                  type="file"
                  accept=".csv,.gz"
                  hidden
                  onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
                />
              </label>
            </div>
            <div className="sim-row">
              <span className="muted small">or make some up:</span>
              <input
                className="day-select sim-number"
                value={makeUp.journeys}
                onChange={(e) => setMakeUp({ ...makeUp, journeys: e.target.value })}
                aria-label="How many journeys to make up"
              />
              <span className="muted small">journeys, seed</span>
              <input
                className="day-select sim-number"
                value={makeUp.seed}
                onChange={(e) => setMakeUp({ ...makeUp, seed: e.target.value })}
                aria-label="Seed"
              />
              <button
                className="button small-button"
                onClick={() => void generate()}
                title="Stop pairs picked by how much service each stop has, in the area chosen below. Says nothing about real travel."
              >
                Make up
              </button>
            </div>
            {busy && <p className="muted small">{busy}</p>}
            {demand
              .filter((d) => d.state === 'failed')
              .slice(0, 1)
              .map((d) => (
                <p key={d.id} className="error-text small">
                  "{d.name}" could not be made: {d.error}
                </p>
              ))}
            {chosenDemand && (
              <div className="sim-report small">
                <div>
                  {fmt(chosenDemand.rows)} journeys by {fmt(chosenDemand.users)} users, standing for{' '}
                  {fmt(chosenDemand.people)} people
                  {chosenDemand.madeUp ? ' (made up)' : ''}.
                  {chosenDemand.report.busiestHour !== undefined &&
                    ` Busiest hour ${String(chosenDemand.report.busiestHour).padStart(2, '0')}:00, ${fmt(chosenDemand.report.busiestHourPeople ?? 0)} people.`}
                </div>
                {(chosenDemand.report.rowsRefused ?? 0) > 0 && (
                  <div className="warn-text">
                    {fmt(chosenDemand.report.rowsRefused!)} of{' '}
                    {fmt(chosenDemand.report.rowsRead ?? 0)} rows refused:{' '}
                    {Object.entries(chosenDemand.report.refused ?? {})
                      .map(([why, n]) => `${fmt(n)} with ${why}`)
                      .join('; ')}
                  </div>
                )}
                {(chosenDemand.report.warnings ?? []).map((warning) => (
                  <div key={warning} className="warn-text">
                    {warning}
                  </div>
                ))}
                {chosenDemand.madeUp && (
                  <div className="muted">
                    Made-up journeys show how the simulator behaves, not how real travel would
                    change. Every result of a run on them says so.
                  </div>
                )}
              </div>
            )}

            <h3>The area</h3>
            <div className="sim-row">
              <select
                className="day-select grow"
                value={String(c.area)}
                aria-label="Area of the run"
                onChange={(e) =>
                  choose({
                    area:
                      e.target.value === 'all' || e.target.value === 'box'
                        ? e.target.value
                        : Number(e.target.value),
                  })
                }
              >
                <option value="all">The whole network</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                <option value="box">A box of my own{c.box ? '' : ' (not drawn yet)'}</option>
              </select>
              <button
                className="button small-button"
                disabled={!mapView.bounds}
                onClick={() =>
                  choose({ area: 'box', box: mapView.bounds && { ...mapView.bounds, name: null } })
                }
                title="Use the part of the map now on screen"
              >
                What is on screen
              </button>
              <button
                className="button small-button"
                onClick={() => set({ simDrawing: true })}
                title="Drag a box on the map"
              >
                Draw on the map
              </button>
            </div>
            {c.area === 'box' && c.box && (
              <div className="sim-row">
                <span className="muted small">
                  {c.box.south.toFixed(3)}, {c.box.west.toFixed(3)} to {c.box.north.toFixed(3)},{' '}
                  {c.box.east.toFixed(3)}
                </span>
                <input
                  className="day-select grow"
                  placeholder="Name it to save it"
                  value={areaName}
                  onChange={(e) => setAreaName(e.target.value)}
                  aria-label="Name for this area"
                />
                <button
                  className="button small-button"
                  disabled={!areaName.trim()}
                  onClick={() =>
                    send<SimArea>('POST', '/api/sim-areas', {
                      ...c.box,
                      name: areaName.trim(),
                    }).then(
                      (made) => {
                        setAreas([...areas, made]);
                        choose({ area: made.id });
                        setAreaName('');
                      },
                      (e) => setError(e.message),
                    )
                  }
                >
                  Save area
                </button>
              </div>
            )}
            <p className="muted small">
              {box
                ? 'Only journeys that start and end inside the area are run, on a timetable cut to it. Journeys across its edge are left out, so a local change looks smaller than it is.'
                : 'A whole-network run of a full day is long. For a local change, an area is the practical way to work.'}
              {coverage &&
                chosenDemand &&
                box &&
                ` ${Math.round(100 * insideShare)}% of these journeys' ends are inside it.`}
            </p>
          </>
        )}

        {step === 1 && kind === 'scenario' && (
          <>
            <h3>Compare with</h3>
            {bauRuns.length === 0 ? (
              <>
                <p className="note">
                  There is no BAU run of this published day to measure against.
                </p>
                <button className="button" onClick={() => setKind('bau')}>
                  Make a BAU run first
                </button>
              </>
            ) : (
              <>
                <select
                  className="day-select"
                  value={bau?.id ?? ''}
                  onChange={(e) => choose({ bauRunId: Number(e.target.value) })}
                  aria-label="BAU run to compare with"
                >
                  {bauRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · {r.demandSetName ?? 'journeys removed'} ·{' '}
                      {r.area ? (r.area.name ?? 'a box') : 'whole network'} ·{' '}
                      {new Date(r.createdAt).toLocaleDateString('en-AU')}
                    </option>
                  ))}
                </select>
                {bau && (
                  <div className="sim-report small">
                    <div>Taken from that run, so that the two can be compared:</div>
                    <ul>
                      <li>The journeys: {bau.demandSetName ?? 'a set since removed'}</li>
                      <li>
                        The area: {bau.area ? (bau.area.name ?? 'a box') : 'the whole network'}
                      </li>
                      <li>Walk to another stop: {String(bau.settings.walkMetres ?? 500)} m</li>
                      <li>
                        A change of vehicle must save:{' '}
                        {Number(bau.settings.changePenaltySecs ?? 600) / 60} minutes
                      </li>
                      <li>
                        School buses: {bau.settings.schoolBuses ? 'in' : 'out'}; demand:{' '}
                        {Number(bau.settings.shareOneIn ?? 1) === 1
                          ? 'all of it'
                          : `1 in ${bau.settings.shareOneIn}`}
                      </li>
                    </ul>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {step === 2 && kind === 'bau' && (
          <div className="sim-settings">
            <label>
              <span>How far people will walk to another stop</span>
              <input
                type="range"
                min={0}
                max={2000}
                step={50}
                value={c.walkMetres}
                onChange={(e) => choose({ walkMetres: Number(e.target.value) })}
              />
              <b>
                {c.walkMetres} m
                {c.walkMetres
                  ? `, about ${walkMinutes(c.walkMetres)} min`
                  : ': nobody changes stop'}
              </b>
            </label>
            <label>
              <span>How much time one more change of vehicle must save</span>
              <input
                type="range"
                min={0}
                max={30}
                value={c.changeMin}
                onChange={(e) => choose({ changeMin: Number(e.target.value) })}
              />
              <b>{c.changeMin} min</b>
            </label>
            <label>
              <span>How much of the demand</span>
              <select
                className="day-select"
                value={c.share}
                onChange={(e) => choose({ share: Number(e.target.value) })}
              >
                <option value={1}>All of it</option>
                {[2, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    1 journey in {n}, each standing for {n}
                  </option>
                ))}
              </select>
              <b />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={c.schoolBuses}
                onChange={(e) => choose({ schoolBuses: e.target.checked })}
              />{' '}
              People may ride school buses
            </label>
            <Capacity on={c.capacity} set={(capacity) => choose({ capacity })} />
          </div>
        )}

        {step === 2 && kind === 'scenario' && (
          <div className="sim-settings">
            <label>
              <span>How much better another stop must be before they change to it</span>
              <input
                type="range"
                min={0}
                max={30}
                value={c.thresholdMin}
                onChange={(e) => choose({ thresholdMin: Number(e.target.value) })}
              />
              <b>{c.thresholdMin} min, on top of how much better it already was on the day</b>
            </label>
            <label>
              <span>How much later they will accept arriving before they give up</span>
              <input
                type="range"
                min={10}
                max={180}
                step={5}
                disabled={c.giveUpMin === null}
                value={c.giveUpMin ?? 60}
                onChange={(e) => choose({ giveUpMin: Number(e.target.value) })}
              />
              <b>{c.giveUpMin === null ? 'no limit' : `${c.giveUpMin} min`}</b>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={c.giveUpMin === null}
                onChange={(e) => choose({ giveUpMin: e.target.checked ? null : 60 })}
              />{' '}
              No limit: nobody gives up
            </label>
            <Capacity on={c.capacity} set={(capacity) => choose({ capacity })} />
          </div>
        )}

        {step === 3 && (
          <>
            <div className="sim-settings">
              <label>
                <span>Name</span>
                <input
                  className="day-select"
                  placeholder={suggested}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Name of the run"
                />
                <b />
              </label>
              <label>
                <span>Folder</span>
                {kind === 'scenario' ? (
                  <span className="muted">
                    {folders.find((f) => f.id === folderId)?.name ?? 'Unfiled'}, with its BAU run
                  </span>
                ) : (
                  <select
                    className="day-select"
                    value={c.folderId ?? ''}
                    onChange={(e) =>
                      choose({ folderId: e.target.value ? Number(e.target.value) : null })
                    }
                    aria-label="Folder"
                  >
                    <option value="">Unfiled</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
                <b />
              </label>
              <label>
                <span>Your name</span>
                <input
                  className="day-select"
                  placeholder="So that others can see who made it"
                  value={who}
                  onChange={(e) => setWho(e.target.value)}
                  aria-label="Your name"
                />
                <b />
              </label>
            </div>
            <div className="sim-report small">
              <div>
                <strong>{name.trim() || suggested}</strong>: about {fmt(journeys)} journeys
                {kind === 'bau' && box && coverage
                  ? `, the ${Math.round(100 * insideShare)}% of journey ends inside ${box.name ?? 'the box'}`
                  : ''}
                {kind === 'bau' && c.share > 1 ? `, 1 in ${c.share}` : ''}, capacity{' '}
                {c.capacity ? 'on' : 'off'}.
              </div>
              <div className="muted">
                {rates.length
                  ? `Planning should take ${roughTime(journeys / (rates.reduce((a, b) => a + b, 0) / rates.length))}, going by earlier runs on this machine.`
                  : 'This is the first run on this machine, so there is nothing to judge the time by.'}{' '}
                The timetable takes up to half a minute to prepare if the router does not hold it.
              </div>
              {routerUp && !routerUp.router && <div className="error-text">{routerUp.message}</div>}
              {unknown && unknown.stops > 0 && (
                <div className="warn-text">
                  {fmt(unknown.stops)} stop id{unknown.stops === 1 ? '' : 's'} in the journeys (
                  {fmt(unknown.journeyEnds)} journey ends) are not in this day's timetable, for
                  example {unknown.examples.slice(0, 3).join(', ')}. Those journeys are left out
                  unless the file gave them a position.
                </div>
              )}
              {coverage && coverage.noService.stops > 0 && (
                <div className={kind === 'scenario' ? 'warn-text' : 'muted'}>
                  Nothing calls at {fmt(coverage.noService.stops)} of the stops people use (
                  {fmt(coverage.noService.journeyEnds)} journey ends)
                  {kind === 'scenario' ? ' in this scenario' : ''};{' '}
                  {fmt(coverage.noService.withAnotherNear)} of those have a served stop within the
                  walking distance.
                </div>
              )}
              {c.capacity && (
                <div className="warn-text">
                  Every vehicle capacity is a placeholder until real ones are entered in the fleet
                  screen, so "left behind" and "stranded" are illustrative.
                </div>
              )}
            </div>
          </>
        )}
        {error && <p className="error-text small">{error}</p>}
      </div>

      <footer className="fleet-footer sim-footer">
        <button className="button" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </button>
        <span className="grow" />
        {step < 3 ? (
          <button className="button on" disabled={!canGo} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button
            className="button on"
            disabled={!canGo || busy !== null}
            onClick={() => void run()}
          >
            {busy ?? 'Run the simulation'}
          </button>
        )}
      </footer>
    </section>
  );
}

function Capacity({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return (
    <label
      className="check"
      title="Every run is planned with capacity off. With it on, a full vehicle leaves people behind and they plan again from where they stand. It can also be added afterwards without planning again."
    >
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Capacity on: a
      full vehicle leaves people behind
    </label>
  );
}
