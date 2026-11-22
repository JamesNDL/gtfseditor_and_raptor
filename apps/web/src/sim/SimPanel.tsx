// The Simulate panel, in the left column: start a run, follow the one in progress, choose a run
// and read its summary, and look up one person. See docs/simulator-plan.md, section 7.
import { formatSecs } from '@gtfs-editor/core';
import { useEffect, useState } from 'react';
import { getJson } from '../shared/api-client.ts';
import { fmt } from '../shared/ui/parts.tsx';
import { selectScenario } from '../scenarios/scenario-client.ts';
import { useStore } from '../app/store.ts';
import { Rename } from './library/SimLibrary.tsx';
import {
  OUT_OF_DATE,
  areaText,
  isActive,
  madeBy,
  progressText,
  refreshRuns,
  send,
  walkText,
  type SimJourney,
  type SimRun,
} from './sim-api.ts';
import './sim.css';

const minutes = (n: number) =>
  `${n.toLocaleString('en-AU', { maximumFractionDigits: n < 10 ? 1 : 0 })} min`;

export function SimPanel() {
  const baselineId = useStore((s) => s.baselineId);
  const runs = useStore((s) => s.simRuns);
  const runId = useStore((s) => s.simRunId);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anyActive = runs.some(isActive);

  // The library is fetched when the day changes, and kept fresh while anything is running.
  useEffect(() => {
    if (baselineId === null) return;
    refreshRuns().catch(() => {});
  }, [baselineId]);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => {
      const before = useStore.getState().simRuns;
      refreshRuns()
        .then((now) => {
          // A run that has just finished becomes the one on show, if it was started from here.
          const finished = now.find(
            (r) => r.state === 'done' && before.some((b) => b.id === r.id && isActive(b)),
          );
          if (finished && follow.has(finished.id))
            useStore.getState().set({ simRunId: finished.id });
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [anyActive]);

  if (baselineId === null) return null;
  const chosen = runs.find((r) => r.id === runId) ?? null;
  const finished = runs.filter((r) => r.state === 'done');
  const going = runs.filter(isActive);

  return (
    <div className={`panel sim-panel${open || chosen || going.length ? ' open' : ''}`}>
      <div className="sim-head">
        <button
          className="sim-title"
          onClick={() => setOpen(!open)}
          aria-expanded={open || !!chosen}
          title="Send a file of journeys through the timetable and see where the passengers go"
        >
          Simulation
        </button>
        <button
          className="button small-button"
          onClick={() => set({ simScreen: 'wizard' })}
          title="Set up and start a simulation"
        >
          New simulation
        </button>
        <button
          className="button small-button"
          onClick={() => set({ simScreen: 'library' })}
          title="Every run, by folder or by date"
        >
          Library
        </button>
      </div>

      {(open || chosen || going.length > 0) && (
        <div className="sim-body">
          {going.map((run) => (
            <div key={run.id} className="sim-going">
              <div className="grow">
                <div className="ellipsis">{run.name}</div>
                <div className="muted small">{progressText(run)}</div>
                {run.state === 'running' && run.progress.total ? (
                  <div className="sim-progress">
                    <span
                      style={{
                        width: `${Math.min(100, (100 * (run.progress.done ?? 0)) / run.progress.total)}%`,
                      }}
                    />
                  </div>
                ) : null}
              </div>
              <button
                className="button small-button"
                title="Stop this run. Nothing of it is kept."
                onClick={() =>
                  send('DELETE', `/api/sim-runs/${run.id}`).then(refreshRuns, (e) =>
                    setError(e.message),
                  )
                }
              >
                Stop
              </button>
            </div>
          ))}

          <select
            className="day-select"
            value={runId ?? ''}
            aria-label="Simulation run to show"
            onChange={(e) =>
              set({
                simRunId: e.target.value === '' ? null : Number(e.target.value),
                simPerson: null,
                // Another run is compared with its own BAU run, and has its own lines.
                simResults: { ...useStore.getState().simResults, vs: null, lineId: null },
              })
            }
          >
            <option value="">{finished.length ? 'No run shown' : 'No finished runs yet'}</option>
            {finished.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.outOfDate ? ' (out of date)' : ''}
              </option>
            ))}
          </select>
          {chosen && <RunTools run={chosen} onError={setError} />}
          {error && <p className="error-text small">{error}</p>}
          {runs
            .filter((r) => r.state === 'failed' || r.state === 'stopped')
            .map((r) => (
              <div key={r.id} className="sim-going">
                <div className="grow">
                  <div className="ellipsis">{r.name}</div>
                  <div className={`small ${r.state === 'failed' ? 'error-text' : 'muted'}`}>
                    {r.state === 'failed' ? `Failed: ${r.error}` : 'Stopped'}
                  </div>
                </div>
                <button
                  className="button small-button"
                  title="Take this run off the list"
                  onClick={() =>
                    send('DELETE', `/api/sim-runs/${r.id}?force=true`).then(refreshRuns, (e) =>
                      setError(e.message),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          {chosen && <Summary run={chosen} onError={setError} />}
        </div>
      )}
    </div>
  );
}

/** Rename or remove the run on show, without a trip to the library. */
function RunTools({ run, onError }: { run: SimRun; onError: (message: string | null) => void }) {
  const set = useStore((s) => s.set);
  const [removing, setRemoving] = useState(false);
  const dependents = run.scenarioRuns + run.capacityRuns;
  const done = (work: Promise<unknown>) =>
    work.then(
      () => (onError(null), refreshRuns()),
      (e: Error) => onError(e.message),
    );
  return (
    <div className="sim-run-actions">
      <button
        className="button small-button on"
        title="Who gains and who loses, line by line, and on the map"
        onClick={() =>
          set({ simResults: { ...useStore.getState().simResults, open: true, small: false } })
        }
      >
        Results
      </button>
      <Rename
        value={run.name}
        label="Rename"
        onDone={(name) => done(send('PATCH', `/api/sim-runs/${run.id}`, { name }))}
      />
      {!removing ? (
        <button
          className="button small-button"
          onClick={() => setRemoving(true)}
          title="Remove this run and its results"
        >
          Remove
        </button>
      ) : (
        <>
          <button
            className="button small-button danger"
            title={
              dependents
                ? 'Runs made from this one stay, but lose what they are compared with'
                : 'Its results and files are deleted'
            }
            onClick={() =>
              void done(
                send('DELETE', `/api/sim-runs/${run.id}${dependents ? '?force=true' : ''}`).then(
                  () => set({ simRunId: null, simPerson: null }),
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
  );
}

/** Runs started from this browser, so that the one that finishes is put on show. */
export const follow = new Set<number>();

function Line({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="sim-line" title={title}>
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The chosen run: what it was, and its figures. */
function Summary({ run, onError }: { run: SimRun; onError: (message: string | null) => void }) {
  const scenarioId = useStore((s) => s.scenarioId);
  const [full, setFull] = useState<SimRun | null>(null);
  useEffect(() => {
    setFull(null);
    getJson<SimRun>(`/api/sim-runs/${run.id}`).then(setFull, () => {});
  }, [run.id]);
  const s = full?.summary;
  const onScenario = run.kind === 'scenario' ? run.scenarioId : null;

  return (
    <div className="sim-summary">
      <div className="muted small">
        {run.kind === 'bau'
          ? 'Published timetable (BAU)'
          : `${run.scenarioName ?? 'A removed scenario'}, against "${run.bauRunName ?? 'a removed BAU run'}"`}
        {' · '}
        {run.area ? (run.area.name ?? 'a box') : 'whole network'}
        {run.capacity ? ' · capacity on' : ''}
        {run.madeUp ? ' · made-up journeys' : ''}
      </div>
      {run.area && <div className="muted small">{areaText(run.area)}.</div>}
      {run.madeUp && (
        <p className="warn-text small">
          Made-up journeys: these people were generated, not observed. The figures show how the
          simulator behaves, not how real travel would change.
        </p>
      )}
      {run.outOfDate && (
        <p className="warn-text small">
          {OUT_OF_DATE} Figures are not shown on trips that changed.
        </p>
      )}
      {onScenario !== scenarioId && (
        <p className="small">
          <span className="muted">
            Its figures show on lines, trips and stations when{' '}
            {run.kind === 'bau' ? 'the published timetable' : 'that scenario'} is open.{' '}
          </span>
          {(run.kind === 'bau' || run.scenarioId !== null) && (
            <button className="link small" onClick={() => void selectScenario(onScenario)}>
              Open it
            </button>
          )}
        </p>
      )}
      {!s ? (
        <div className="muted small">Loading ...</div>
      ) : (
        <>
          <div className="scenario-stats sim-stats">
            <Stat value={fmt(s.people.ok)} label="travel" />
            <Stat
              value={fmt(s.people.noJourney)}
              label="no journey"
              warn={s.people.noJourney > 0}
            />
            {run.kind === 'scenario' && (
              <Stat value={fmt(s.people.gaveUp)} label="gave up" warn={s.people.gaveUp > 0} />
            )}
            {run.capacity && (
              <Stat value={fmt(s.people.stranded)} label="stranded" warn={s.people.stranded > 0} />
            )}
          </div>
          <Line
            label="People in the run"
            value={fmt(s.demand.people)}
            title={`${fmt(s.demand.rows)} journeys by ${fmt(s.demand.users)} users`}
          />
          {s.demand.leftOutWhollyOutsideArea + s.demand.leftOutOneEndInsideArea > 0 && (
            <Line
              label="Left out by the area"
              value={`${fmt(s.demand.leftOutWhollyOutsideArea)} outside, ${fmt(s.demand.leftOutOneEndInsideArea)} across the edge`}
              title="Journeys with one end inside the area are not simulated, so a local change looks smaller than it is"
            />
          )}
          <Line
            label="Journey time"
            value={`${minutes(s.journeys.medianMinutes)} median, ${minutes(s.journeys.percentile90Minutes)} for 9 in 10`}
          />
          <Line
            label="On average"
            value={`${minutes(s.journeys.meanWaitMinutes)} waiting, ${minutes(s.journeys.meanWalkMinutes)} walking, ${s.journeys.meanRides.toFixed(1)} rides`}
          />

          {s.againstBau && (
            <div className="scenario-section">
              <h3>Against the published timetable</h3>
              <Line
                label="Arrive sooner"
                value={`${fmt(s.againstBau.sooner)}${s.againstBau.sooner ? `, by ${minutes(s.againstBau.meanMinutesSooner)}` : ''}`}
                title="This counts everyone who arrives sooner, including people who only moved to a nearby stop that was already quicker on the published timetable. The results window counts those apart."
              />
              <Line
                label="Arrive later"
                value={`${fmt(s.againstBau.later)}${s.againstBau.later ? `, by ${minutes(s.againstBau.meanMinutesLater)}` : ''}`}
              />
              <Line label="Within a minute" value={fmt(s.againstBau.within1Minute)} />
              {s.againstBau.noLongerAbleToTravel + s.againstBau.newlyAbleToTravel > 0 && (
                <Line
                  label="Can no longer travel / now can"
                  value={`${fmt(s.againstBau.noLongerAbleToTravel)} / ${fmt(s.againstBau.newlyAbleToTravel)}`}
                />
              )}
              <Line
                label="Changed stop"
                value={`${fmt(s.stops.changedAtOrigin)} at the start, ${fmt(s.stops.changedAtDestination)} at the end`}
                title={`${fmt(s.stops.becauseTheirStopWasGone)} because their stop was gone, ${fmt(s.stops.becauseAnotherWasBetter)} because another was better`}
              />
            </div>
          )}

          <div className="scenario-section">
            <h3>Crowding</h3>
            <Line
              label="Trips planned over capacity"
              value={fmt(s.plannedLoads.tripsPlannedOverCapacity)}
              title="Counted from what everyone plans to ride, before anyone is left behind"
            />
            {s.plannedLoads.furthestOver.slice(0, 3).map((t) => (
              <div key={t.trip} className="muted small">
                {t.line}: {fmt(t.plannedLoad)} for {fmt(t.limit)} places, from{' '}
                {t.firstOverAt.slice(0, 5)}
              </div>
            ))}
            {s.capacityResults && (
              <>
                <Line
                  label="Left behind at least once"
                  value={`${fmt(s.capacityResults.peopleLeftBehindAtLeastOnce)} (${s.capacityResults.shareLeftBehindPercent.toFixed(1)}%)`}
                />
                <Line label="Times left behind" value={fmt(s.capacityResults.timesLeftBehind)} />
                {s.capacityResults.fullestLines.length > 0 && (
                  <div className="muted small">
                    Fullest lines:{' '}
                    {s.capacityResults.fullestLines
                      .map((l) => `${l.line} ${Math.round(l.peakPercent)}%`)
                      .join(', ')}
                  </div>
                )}
                {s.capacityResults.stopsLeavingMostBehind.length > 0 && (
                  <div className="muted small">
                    Most left behind at:{' '}
                    {s.capacityResults.stopsLeavingMostBehind
                      .slice(0, 5)
                      .map((p) => `${p.name} (${fmt(p.leftBehind)})`)
                      .join('; ')}
                  </div>
                )}
              </>
            )}
            {!run.capacity && !run.plansRunId && !run.outOfDate && (
              <button
                className="button small-button"
                title="Puts the same plans on the vehicles again, this time leaving behind whoever does not fit. No planning is repeated."
                onClick={() =>
                  send<SimRun>('POST', '/api/sim-runs', {
                    fromRunId: run.id,
                    madeBy: madeBy.get() || undefined,
                  }).then(
                    (made) => {
                      follow.add(made.id);
                      onError(null);
                      void refreshRuns();
                    },
                    (e) => onError(e.message),
                  )
                }
              >
                Run again with capacity
              </button>
            )}
            {s.capacities.placeholderOrAssumed > 0 && (
              <p className="warn-text small">
                {s.capacities.placeholderOrAssumed === s.capacities.trips
                  ? 'Every'
                  : fmt(s.capacities.placeholderOrAssumed)}{' '}
                vehicle capacity is a placeholder, so crowding figures are illustrative.
              </p>
            )}
          </div>

          <Person run={run} />

          <details className="sim-limits small muted">
            <summary>What this does not model</summary>
            <ul>
              {s.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function Stat({ value, label, warn }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className="scenario-stat">
      <div className={`stat-value${warn ? ' warn-text' : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

const STATUS: Record<SimJourney['status'], string> = {
  ok: '',
  noJourney: 'no journey',
  gaveUp: 'gave up',
  stranded: 'stranded',
};

/** One person by their id: their journeys listed, and drawn on the map leg by leg. */
function Person({ run }: { run: SimRun }) {
  const person = useStore((s) => s.simPerson);
  const set = useStore((s) => s.set);
  const [user, setUser] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const look = async () => {
    const id = user.trim();
    if (!id) return;
    setNote(null);
    try {
      const journeys = await getJson<SimJourney[]>(
        `/api/sim-runs/${run.id}/journeys?user=${encodeURIComponent(id)}`,
      );
      set({ simPerson: journeys.length ? { user: id, journeys } : null });
      if (!journeys.length) return setNote(`Nobody called ${id} travels in this run.`);
      const points = journeys
        .flatMap((j) =>
          j.legs.flatMap((l) => [
            [l.fromLon, l.fromLat],
            [l.toLon, l.toLat],
          ]),
        )
        .filter((p) => p[0] !== null) as number[][];
      if (points.length) {
        set({
          fitBounds: [
            Math.min(...points.map((p) => p[0])),
            Math.min(...points.map((p) => p[1])),
            Math.max(...points.map((p) => p[0])),
            Math.max(...points.map((p) => p[1])),
          ],
        });
      }
    } catch (err) {
      setNote(
        run.archived
          ? 'This run is archived. Restore it in the library to look people up.'
          : String((err as Error).message),
      );
    }
  };
  return (
    <div className="scenario-section">
      <h3>One person</h3>
      <form
        className="sim-person"
        onSubmit={(e) => {
          e.preventDefault();
          void look();
        }}
      >
        <input
          className="day-select grow"
          placeholder="user_id"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          aria-label="User id to look up"
        />
        <button className="button small-button" type="submit">
          Find
        </button>
        {person && (
          <button
            className="button small-button"
            type="button"
            onClick={() => set({ simPerson: null })}
            title="Take their journeys off the map"
          >
            Clear
          </button>
        )}
      </form>
      {note && <p className="muted small">{note}</p>}
      {person && (
        <ol className="sim-journeys">
          {person.journeys.map((j) => (
            <li key={`${j.journeyId}-${j.part}`}>
              <div>
                {formatSecs(j.start)}
                {j.arrive !== null && <span className="muted"> to {formatSecs(j.arrive)}</span>}
                {STATUS[j.status] && <span className="warn-text"> · {STATUS[j.status]}</span>}
                {j.people > 1 && <span className="muted"> · {fmt(j.people)} people</span>}
                {j.laterSecs !== null && Math.abs(j.laterSecs) >= 60 && (
                  <span className="muted">
                    {' '}
                    · {Math.abs(Math.round(j.laterSecs / 60))} min{' '}
                    {j.laterSecs > 0 ? 'later' : 'sooner'}
                  </span>
                )}
              </div>
              {j.status === 'noJourney' && <div className="muted small">{j.noJourneyReason}</div>}
              {j.legs.map((l) => (
                <div key={l.leg} className="muted small ellipsis">
                  {formatSecs(l.depart).slice(0, 5)}{' '}
                  {l.kind === 'ride'
                    ? `${l.stayAboard ? 'stays aboard ' : ''}${l.routeName ?? 'a vehicle'} from ${l.fromStop ?? '?'} to ${l.toStop ?? '?'}`
                    : `walks ${walkText(l.metres)}${l.toStop ? ` to ${l.toStop}` : ''}`}
                </div>
              ))}
              {j.leftBehind > 0 && (
                <div className="warn-text small">
                  Left behind {j.leftBehind} time{j.leftBehind === 1 ? '' : 's'} by a full vehicle
                </div>
              )}
              {(j.originChanged || j.destinationChanged) && (
                <div className="muted small">
                  Used another stop
                  {j.changeReason === 'gone'
                    ? ': theirs has no service'
                    : j.changeReason === 'better'
                      ? ': it is better by enough'
                      : ''}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
