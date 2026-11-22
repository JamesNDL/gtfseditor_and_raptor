// Two tabs of the results window: how people travel (Travel patterns), and the people themselves
// (People), each with their journey before and now. See docs/simulator-plan.md, section 18.
import { formatSecs } from '@gtfs-editor/core';
import type React from 'react';
import { useEffect, useState } from 'react';
import { fmt } from '../shared/ui/parts.tsx';
import { useStore } from '../app/store.ts';
import {
  GROUP_COLORS,
  fetchResults,
  mins,
  resultsUrl,
  signed,
  useResults,
  whoHasSide,
  whoLabel,
  whoPhrase,
  whoParam,
  type Patterns,
  type PeopleList,
  type PersonRow,
  type Who,
} from './results.ts';
import { walkText, type SimJourney, type SimRun } from './simApi.ts';

/** Picks people out: they are followed on the map, and listed in the People tab when asked. */
export function followPeople(who: Who, options: { list?: boolean; map?: boolean } = {}) {
  const s = useStore.getState();
  const onMap = options.map !== false;
  s.set({
    // Shown on the map, the window folds to its title bar: open, it covers what was asked for.
    simResults: {
      ...s.simResults,
      who,
      ...(options.list ? { tab: 'people' as const, small: false } : onMap ? { small: true } : {}),
    },
    simMap: onMap ? { ...s.simMap, layer: 'through' } : s.simMap,
    simPerson: null,
  });
}

// ---------------------------------------------------------------------------
// Travel patterns
// ---------------------------------------------------------------------------
const BOARDED = ['Walk all the way', 'One vehicle', 'Two', 'Three', 'Four or more'];

/** A row of label, bar and number: now as a bar, before as a dashed outline, the change in words. */
function CompareRow({
  label,
  a,
  b,
  max,
  compared,
  title,
  onClick,
}: {
  label: React.ReactNode;
  a: number;
  b: number;
  max: number;
  compared: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const d = a - b;
  const inner = (
    <>
      <span className="results-bar-label ellipsis">{label}</span>
      <span className="results-bar-track">
        <i style={{ width: `${(a / max) * 100}%`, background: 'var(--series-1)' }} />
        {compared && <i className="before" style={{ width: `${(b / max) * 100}%` }} />}
      </span>
      <span className="results-bar-n">{fmt(a)}</span>
      {compared && (
        <span className="results-bar-share">
          {d !== 0 && (
            <i
              className="results-dot"
              style={{ background: d < 0 ? GROUP_COLORS[7] : GROUP_COLORS[1] }}
            />
          )}
          {d === 0 ? <span className="muted">same</span> : signed(d)}
        </span>
      )}
    </>
  );
  return onClick ? (
    <li title={title}>
      <button className="results-compare-button" onClick={onClick}>
        {inner}
      </button>
    </li>
  ) : (
    <li title={title}>{inner}</li>
  );
}

export function PatternsTab({ run, compared }: { run: SimRun; compared: boolean }) {
  const state = useStore((s) => s.simResults);
  const modes = useStore((s) => s.modes);
  const { data: d, error } = useResults<Patterns>(resultsUrl(run.id, 'patterns', state));
  if (error) return <p className="note">{error}</p>;
  if (!d) return <p className="muted">Working it out ...</p>;
  const modeMax = Math.max(1, ...d.byMode.flatMap((m) => [m.a, m.b]));
  const boardedMax = d.vehicles ? Math.max(1, ...d.vehicles.a, ...(d.vehicles.b ?? [])) : 1;
  const stationMax = Math.max(1, ...d.stations.flatMap((s) => [s.aOn + s.aOff, s.bOn + s.bOff]));
  const boardings = (side: 'a' | 'b') => d.byMode.reduce((sum, m) => sum + m[side], 0);
  const mean = (counts: number[]) => {
    const people = counts.reduce((x, y) => x + y, 0);
    return people ? counts.reduce((sum, n, i) => sum + n * i, 0) / people : 0;
  };
  const cls = `results-along results-compare${compared ? ' compared' : ''}`;
  return (
    <>
      <div className="results-two">
        <section>
          <h3>Passengers boarding, by mode</h3>
          {d.byMode.length === 0 ? (
            <p className="note">Nobody rides anything in this part of the day.</p>
          ) : (
            <ul className={cls}>
              {d.byMode.map((m) => (
                <CompareRow
                  key={m.modeId}
                  label={modes.find((x) => x.id === m.modeId)?.name ?? m.modeId}
                  a={m.a}
                  b={m.b}
                  max={modeMax}
                  compared={compared}
                  title={compared ? `${fmt(m.a)} now, ${fmt(m.b)} before` : undefined}
                />
              ))}
            </ul>
          )}
          <p className="muted small">
            {fmt(boardings('a'))} boardings in all
            {compared ? `, ${fmt(boardings('b'))} before` : ''}. Someone who changes vehicle is
            counted on each.
          </p>
        </section>
        <section>
          <h3>Vehicles boarded on a journey</h3>
          {!d.vehicles ? (
            <p className="muted small">
              This needs the journeys of both runs; one of them is archived.
            </p>
          ) : (
            <>
              <ul className={cls}>
                {BOARDED.map((label, i) => (
                  <CompareRow
                    key={label}
                    label={label}
                    a={d.vehicles!.a[i]}
                    b={d.vehicles!.b?.[i] ?? 0}
                    max={boardedMax}
                    compared={compared && !!d.vehicles!.b}
                    title={
                      compared
                        ? `${fmt(d.vehicles!.a[i])} people now, ${fmt(d.vehicles!.b?.[i] ?? 0)} before`
                        : undefined
                    }
                  />
                ))}
              </ul>
              <p className="muted small">
                {mean(d.vehicles.a).toFixed(2)} vehicles a journey on average
                {d.vehicles.b ? `, ${mean(d.vehicles.b).toFixed(2)} before` : ''}.
              </p>
            </>
          )}
        </section>
      </div>

      {compared && (
        <section>
          <h3>People who use another stop</h3>
          {!d.stopChange ? (
            <p className="muted small">
              This needs the journeys of both runs; one of them is archived.
            </p>
          ) : d.stopChange.origin + d.stopChange.destination === 0 ? (
            <p className="note">
              Everyone who travels in both runs starts and ends at the stops they used before.
            </p>
          ) : (
            <>
              <p>
                Of the {fmt(d.stopChange.compared)} people who travel in both runs,{' '}
                <b>{fmt(d.stopChange.origin)}</b> set off from another stop than before and{' '}
                <b>{fmt(d.stopChange.destination)}</b> end at another.
              </p>
              <ul className="results-moves">
                {d.stopChange.moves.map((m) => (
                  <li key={`${m.end}-${m.fromId}-${m.toId}`}>
                    <b>{fmt(m.people)}</b> {m.end === 'origin' ? 'now start at' : 'now end at'}{' '}
                    <button
                      className="link"
                      onClick={() => followPeople({ kind: 'stop', id: m.toId, name: m.to })}
                      title="Follow the people who use this stop, on the map"
                    >
                      {m.to}
                    </button>{' '}
                    <span className="muted">in place of</span>{' '}
                    <button
                      className="link"
                      onClick={() => followPeople({ kind: 'stop', id: m.fromId, name: m.from })}
                      title="Follow the people who use this stop, on the map"
                    >
                      {m.from}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section>
        <h3>
          {compared
            ? 'Stations and stops where the most changed'
            : 'The busiest stations and stops'}
        </h3>
        {d.stations.length === 0 ? (
          <p className="note">Nobody gets on or off anything in this part of the day.</p>
        ) : (
          <ul className={cls}>
            {d.stations.map((s) => (
              <CompareRow
                key={s.id}
                label={s.name}
                a={s.aOn + s.aOff}
                b={s.bOn + s.bOff}
                max={stationMax}
                compared={compared}
                title={`${s.name}: ${fmt(s.aOn)} on and ${fmt(s.aOff)} off, ${fmt(s.aChanges)} of them changing vehicle${compared ? ` · before: ${fmt(s.bOn)} on and ${fmt(s.bOff)} off, ${fmt(s.bChanges)} changing` : ''} · click to follow these people on the map`}
                onClick={() => followPeople({ kind: 'stop', id: s.id, name: s.name })}
              />
            ))}
          </ul>
        )}
        <p className="muted small">
          Passengers getting on and off, a platform counted with its station. Click one to see on
          the map where its passengers come from and go to.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
const STATUS: Record<string, string> = {
  noJourney: 'no journey',
  gaveUp: 'gave up',
  stranded: 'stranded',
};
const SETS: { who: Who; label: string }[] = [
  { who: { kind: 'changed' }, label: 'Journey changed' },
  { who: { kind: 'later' }, label: 'Later' },
  { who: { kind: 'sooner' }, label: 'Sooner' },
  { who: { kind: 'lost' }, label: 'Can no longer travel' },
  { who: { kind: 'gained' }, label: 'Can now travel' },
  { who: { kind: 'all' }, label: 'Everyone' },
];

const journeyText = (status: string | null, secs: number | null, vehicles: number | null) =>
  status === null
    ? ''
    : status !== 'ok'
      ? (STATUS[status] ?? status)
      : `${mins((secs ?? 0) / 60)}${vehicles !== null ? ` · ${Math.round(vehicles)} veh.` : ''}`;

function changeText(row: PersonRow): { text: string; tone: 'later' | 'sooner' | 'lost' | null } {
  if (row.later !== null) {
    if (Math.abs(row.later) < 60) return { text: 'the same', tone: null };
    return {
      text: `${mins(Math.abs(row.later) / 60)} ${row.later > 0 ? 'later' : 'sooner'}`,
      tone: row.later > 0 ? 'later' : 'sooner',
    };
  }
  if (row.bStatus === 'ok' && row.aStatus !== 'ok')
    return { text: 'can no longer travel', tone: 'lost' };
  if (row.aStatus === 'ok' && row.bStatus !== null && row.bStatus !== 'ok')
    return { text: 'can now travel', tone: 'sooner' };
  return { text: '', tone: null };
}

export function PeopleTab({ run, compared }: { run: SimRun; compared: boolean }) {
  const state = useStore((s) => s.simResults);
  const side = useStore((s) => s.simMap.side);
  const onMap = useStore((s) => s.simMap.layer === 'through');
  const set = useStore((s) => s.set);
  const [limit, setLimit] = useState(100);
  const [find, setFind] = useState('');
  const [chosen, setChosen] = useState<PersonRow | null>(null);
  // A run on its own has nobody sooner or later: a set of that kind left from a comparison is everyone.
  const kept =
    state.who && (compared || ['all', 'line', 'link', 'stop', 'user'].includes(state.who.kind))
      ? state.who
      : null;
  const who: Who = kept ?? { kind: compared ? 'changed' : 'all' };
  const useSide = compared ? side : 'a';
  const best =
    who.kind === 'sooner' ||
    who.kind === 'soonerTruly' ||
    who.kind === 'soonerNearby' ||
    who.kind === 'gained' ||
    (who.kind === 'group' && who.group < 4);
  const key = whoParam(who, useSide);
  useEffect(() => {
    setLimit(100);
    setChosen(null);
  }, [key, run.id, state.vs, state.band]);
  const list = useResults<PeopleList>(
    resultsUrl(run.id, 'people', state, {
      who: key,
      limit: String(limit),
      ...(best ? { order: 'best' } : {}),
    }),
  );
  const pick = (next: Who) =>
    set({ simResults: { ...useStore.getState().simResults, who: next }, simPerson: null });
  const special = !SETS.some((s) => s.who.kind === who.kind);
  const d = list.data;

  return (
    <div className={`results-lines${chosen ? ' with-detail' : ''}`}>
      <div className="results-lines-list">
        <div className="results-filters">
          <div className="chips results-chips">
            {SETS.filter((s) => compared || s.who.kind === 'all').map((s) => (
              <button
                key={s.who.kind}
                className={who.kind === s.who.kind ? 'on' : ''}
                onClick={() => pick(s.who)}
              >
                {s.label}
              </button>
            ))}
            {special && (
              <button
                className="on"
                onClick={() => pick({ kind: compared ? 'changed' : 'all' })}
                title="Back to everyone whose journey changed"
              >
                {whoLabel(who, useSide, compared)} ✕
              </button>
            )}
          </div>
          <form
            className="results-find"
            onSubmit={(e) => {
              e.preventDefault();
              if (find.trim()) pick({ kind: 'user', id: find.trim() });
            }}
          >
            <input
              className="day-select"
              placeholder="user_id"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              aria-label="Find one person by user id"
            />
            <button className="button small-button" type="submit">
              Find
            </button>
          </form>
        </div>
        <div className="results-filters small">
          <span className="grow">
            {d ? (
              <>
                <b>{fmt(d.people)}</b> {d.people === 1 ? 'person' : 'people'}
                {d.journeys !== d.people ? ` on ${fmt(d.journeys)} journeys` : ''}:{' '}
                {whoPhrase(who, useSide, compared)}
                {compared
                  ? best
                    ? ', most improved first'
                    : ', worst affected first'
                  : ', longest journey first'}
              </>
            ) : (
              <span className="muted">{list.error ? '' : 'Working it out ...'}</span>
            )}
          </span>
          {compared && whoHasSide(who) && (
            <select
              className="day-select"
              value={side}
              aria-label="In which run they use it"
              onChange={(e) =>
                set({
                  simMap: { ...useStore.getState().simMap, side: e.target.value as 'a' | 'b' },
                })
              }
            >
              <option value="b">who used it before</option>
              <option value="a">who use it now</option>
            </select>
          )}
          <button
            className={`button small-button${onMap && state.who ? ' on' : ''}`}
            disabled={!d || d.journeys === 0}
            title="Draws the stretches these people ride, now against before, and where they start and end"
            onClick={() => followPeople(who)}
          >
            {onMap && state.who ? 'Shown on the map' : 'Show them on the map'}
          </button>
        </div>
        {list.error ? (
          <p className="note">{list.error}</p>
        ) : !d ? null : d.rows.length === 0 ? (
          <p className="note">Nobody: {whoPhrase(who, useSide, compared)}.</p>
        ) : (
          <div className="results-scroll">
            <table className="results-table results-line-table results-people-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="n">Sets off</th>
                  {compared && <th className="n">Before</th>}
                  <th className="n">{compared ? 'Now' : 'Journey'}</th>
                  {compared && <th>Change</th>}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((row) => {
                  const change = changeText(row);
                  return (
                    <tr
                      key={row.journeyId}
                      className={chosen?.journeyId === row.journeyId ? 'on' : ''}
                      onClick={() => setChosen(chosen?.journeyId === row.journeyId ? null : row)}
                    >
                      <td>
                        {row.user}
                        {row.people > 1 && (
                          <span className="muted small"> · {fmt(row.people)} people</span>
                        )}
                      </td>
                      <td className="n">{formatSecs(row.start).slice(0, 5)}</td>
                      {compared && (
                        <td className={`n${row.bStatus !== 'ok' ? ' muted' : ''}`}>
                          {journeyText(row.bStatus, row.bJourney, row.bVehicles)}
                        </td>
                      )}
                      <td className={`n${row.aStatus !== 'ok' ? ' warn-text' : ''}`}>
                        {journeyText(row.aStatus, row.aJourney, row.aVehicles)}
                      </td>
                      {compared && (
                        <td>
                          {change.tone && (
                            <i
                              className="results-dot"
                              style={{
                                background:
                                  change.tone === 'sooner'
                                    ? GROUP_COLORS[1]
                                    : change.tone === 'later'
                                      ? GROUP_COLORS[7]
                                      : 'var(--text)',
                              }}
                            />
                          )}
                          {change.text}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {d.rows.length < d.journeys && (
              <p className="muted small">
                The first {fmt(d.rows.length)} of {fmt(d.journeys)}.{' '}
                {limit < 500 ? (
                  <button
                    className="link small"
                    onClick={() => setLimit(Math.min(500, limit + 200))}
                  >
                    Show more
                  </button>
                ) : (
                  'Pick a smaller group to see the rest.'
                )}
              </p>
            )}
          </div>
        )}
      </div>
      {chosen && (
        <PersonCard run={run} row={chosen} compared={compared} onClose={() => setChosen(null)} />
      )}
    </div>
  );
}

interface BothWays {
  journeyId: string;
  a: SimJourney[];
  b: SimJourney[] | null;
}

/** One person's journey before and now, leg by leg, and drawn on the map: now in pink, before in grey. */
function PersonCard({
  run,
  row,
  compared,
  onClose,
}: {
  run: SimRun;
  row: PersonRow;
  compared: boolean;
  onClose: () => void;
}) {
  const vs = useStore((s) => s.simResults.vs);
  const set = useStore((s) => s.set);
  const [both, setBoth] = useState<BothWays | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBoth(null);
    setError(null);
    const controller = new AbortController();
    fetchResults<BothWays>(
      resultsUrl(run.id, `people/${encodeURIComponent(row.journeyId)}`, { vs, band: null }),
      controller.signal,
    ).then(
      (found) => {
        setBoth(found);
        set({ simPerson: { user: row.user, journeys: found.a, before: found.b ?? undefined } });
        const points = [...found.a, ...(found.b ?? [])]
          .flatMap((j) =>
            j.legs.flatMap((l) => [
              [l.fromLon, l.fromLat],
              [l.toLon, l.toLat],
            ]),
          )
          .filter((p) => p[0] !== null && p[1] !== null) as number[][];
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
      },
      (err) => !controller.signal.aborted && setError(String(err.message ?? err)),
    );
    return () => {
      controller.abort();
      set({ simPerson: null });
    };
  }, [run.id, row.journeyId, vs]);
  return (
    <aside className="results-line-card">
      <div className="results-card-head">
        <b className="grow ellipsis">
          {row.user}{' '}
          <span className="muted small">sets off {formatSecs(row.start).slice(0, 5)}</span>
        </b>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close this person"
          title="Close, and take their journeys off the map"
        >
          ✕
        </button>
      </div>
      {error ? (
        <p className="note">{error}</p>
      ) : !both ? (
        <p className="muted small">Working it out ...</p>
      ) : (
        <>
          {compared && both.b && (
            <>
              <h3>
                <i className="results-swatch before" /> Before
              </h3>
              <Journeys parts={both.b} />
            </>
          )}
          <h3>
            <i className="results-swatch now" /> {compared ? 'Now' : 'Their journey'}
          </h3>
          <Journeys parts={both.a} />
          <p className="muted small">
            Both are drawn on the map{compared ? ': now in pink, before in grey underneath' : ''}.
            Legs run straight between stops.
          </p>
        </>
      )}
    </aside>
  );
}

function Journeys({ parts }: { parts: SimJourney[] }) {
  if (!parts.length) return <p className="note">Not in this run.</p>;
  return (
    <ol className="sim-journeys results-journeys">
      {parts.map((j) => (
        <li key={j.part}>
          <div>
            {j.status === 'ok' && j.arrive !== null ? (
              <>
                Arrives {formatSecs(j.arrive).slice(0, 5)}
                {j.journeySecs !== null && (
                  <span className="muted"> · {mins(j.journeySecs / 60)}</span>
                )}
                {j.waitSecs !== null && (
                  <span className="muted"> · waits {mins(j.waitSecs / 60)}</span>
                )}
                <span className="muted"> · walks {mins(j.walkSecs / 60)}</span>
              </>
            ) : (
              <span className="warn-text">
                {j.status === 'gaveUp'
                  ? 'Gave up: the journey is now too much later'
                  : j.status === 'stranded'
                    ? 'Stranded by full vehicles'
                    : 'No journey'}
              </span>
            )}
            {j.people > 1 && <span className="muted"> · {fmt(j.people)} people</span>}
          </div>
          {j.status === 'noJourney' && j.noJourneyReason && (
            <div className="muted small">{j.noJourneyReason}</div>
          )}
          {j.legs.map((l) => (
            <div key={l.leg} className="muted small">
              {formatSecs(l.depart).slice(0, 5)}{' '}
              {l.kind === 'ride'
                ? `${l.stayAboard ? 'stays aboard ' : ''}${l.routeName ?? 'a vehicle'} from ${l.fromStop ?? '?'} to ${l.toStop ?? '?'}, arriving ${formatSecs(l.arrive).slice(0, 5)}`
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
  );
}
