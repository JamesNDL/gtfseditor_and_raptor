// The results window: one run set against another made on the same people. It sits beside the map
// and not over it, so that what is chosen here can be looked at there. See docs/simulator-plan.md,
// section 18.
import { DAY_BANDS, formatSecs } from '@gtfs-editor/core';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, fmt } from '../inspector/parts.tsx';
import { useStore } from '../store.ts';
import {
  GROUP_COLORS, GROUP_LABELS, SAME_GROUP, divergingColor, lineName, mins, placeholderNote, resultsUrl, signed, useResults, whoPhrase,
  type Capacities, type JourneyTimes, type LineDetail, type LineRow, type Overview, type ResultsTab, type Shift, type Who,
} from './results.ts';
import { OUT_OF_DATE, areaText, type SimRun } from './simApi.ts';
import { PatternsTab, PeopleTab, followPeople } from './SimResultsPeople.tsx';

const TABS: { id: ResultsTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'time', label: 'Travel time' },
  { id: 'lines', label: 'Lines' },
  { id: 'patterns', label: 'Travel patterns' },
  { id: 'people', label: 'People' },
];

const bandLabel = (band: (typeof DAY_BANDS)[number]) =>
  `${band.label[0].toUpperCase()}${band.label.slice(1)} (${band.from ? formatSecs(band.from) : 'start'} to ${Number.isFinite(band.to) ? formatSecs(band.to) : 'end'})`;

export function SimResults() {
  const state = useStore((s) => s.simResults);
  const runId = useStore((s) => s.simRunId);
  const runs = useStore((s) => s.simRuns);
  const set = useStore((s) => s.set);
  const run = runs.find((r) => r.id === runId) ?? null;
  const update = (partial: Partial<typeof state>) => set({ simResults: { ...useStore.getState().simResults, ...partial } });
  const shown = state.open && run !== null && run.state === 'done';

  const overview = useResults<Overview>(shown ? resultsUrl(run.id, 'overview', state) : null);
  const lines = useResults<{ lines: LineRow[]; capacity?: Capacities }>(shown ? resultsUrl(run.id, 'lines', state) : null);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !(target && ['INPUT', 'SELECT'].includes(target.tagName))) update({ small: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!shown) return null;
  const o = overview.data;
  const against = o?.vs ?? null;

  return (
    <section className={`panel results${state.small ? ' small-window' : ''}`} aria-label="Simulation results">
      <header className="results-head">
        <div className="grow">
          <h2 className="ellipsis">{run.name}</h2>
          <div className="muted small ellipsis">
            {against ? `against "${against.name}"` : o ? 'on its own: nothing to compare it with' : ' '}
            {state.band !== null ? ` · ${DAY_BANDS[state.band].label} only` : ''}
            {run.area ? <span title={`${areaText(run.area)}.`}> · bounded to {run.area.name ?? 'a box'}</span> : ''}
            {(o?.madeUp ?? run.madeUp) && (
              <span className="tag tag-warn" title="These people and their journeys were generated, not observed. The figures show how the simulator behaves, not how real travel would change.">
                made-up journeys
              </span>
            )}
          </div>
        </div>
        {state.small ? (
          <button className="button small-button" onClick={() => update({ small: false })} title="Open the results window again">
            Open results
          </button>
        ) : (
          <button className="icon-button" onClick={() => update({ small: true })} title="Fold away to see the whole map (Esc)" aria-label="Fold results away">
            –
          </button>
        )}
        <button className="icon-button" onClick={() => set({ simResults: { ...state, open: false, who: null }, simPerson: null, simMap: { ...useStore.getState().simMap, layer: 'none' } })} title="Close the results and take them off the map" aria-label="Close results">
          ✕
        </button>
      </header>

      {!state.small && (
        <>
          <div className="results-bar">
            <div className="tabs" role="tablist">
              {TABS.map((tab) => (
                <button key={tab.id} role="tab" aria-selected={state.tab === tab.id} className={state.tab === tab.id ? 'on' : ''} onClick={() => update({ tab: tab.id })}>
                  {tab.label}
                </button>
              ))}
            </div>
            <span className="grow" />
            {o && o.others.length > 0 && (
              <label className="results-pick small">
                <span className="muted">Compare with</span>
                <select className="day-select" value={against?.id ?? ''} onChange={(e) => update({ vs: e.target.value === '' ? null : Number(e.target.value), lineId: null })}>
                  {!against && <option value="">nothing</option>}
                  {o.others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="results-pick small">
              <span className="muted">When</span>
              <select className="day-select" value={state.band ?? ''} onChange={(e) => update({ band: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">All day</option>
                {DAY_BANDS.map((band, i) => (
                  <option key={band.id} value={i}>
                    {bandLabel(band)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="results-body">
            {run.outOfDate && <p className="warn-text small">{OUT_OF_DATE}</p>}
            {run.area && <p className="muted small">{areaText(run.area)}. Journeys with an end outside it are not in these figures.</p>}
            {state.tab === 'lines' ? (
              <Lines run={run} rows={lines.data?.lines ?? null} error={lines.error} compared={!!against} capacity={lines.data?.capacity ?? null} />
            ) : state.tab === 'patterns' && (o || overview.error) ? (
              <PatternsTab run={run} compared={!!against} />
            ) : state.tab === 'people' && o ? (
              <PeopleTab run={run} compared={!!against} />
            ) : overview.error ? (
              <p className="note">{overview.error}</p>
            ) : !o ? (
              <p className="muted">Working it out ...</p>
            ) : state.tab === 'overview' ? (
              <OverviewTab o={o} lines={lines.data?.lines ?? null} />
            ) : (
              <TimeTab o={o} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function Figure({ value, label, note, tone }: { value: string; label: string; note?: string; tone?: 'later' | 'sooner' }) {
  return (
    <div className="tile results-figure" title={note}>
      <div className="tile-value">
        {tone && <i className="results-dot" style={{ background: tone === 'later' ? GROUP_COLORS[7] : GROUP_COLORS[1] }} />}
        {value}
      </div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function Headline({ o }: { o: Overview }) {
  if (!o.vs || !o.later || !o.sooner || !o.lost) {
    return (
      <>
        <div className="tiles">
          <Figure value={fmt(o.times.a.people)} label="people travel" />
          <Figure value={mins(o.times.a.meanMinutes)} label="average journey" />
        </div>
        <Honesty o={o} />
      </>
    );
  }
  const truly = o.sooner.truly;
  const nearby = o.sooner.nearby;
  const gaveUp = o.gaveUp ?? { people: 0, hours: 0, meanMinutes: 0, groups: [], atLeast: 0, limitMinutes: 0 };
  const net = o.net ?? { hoursLost: o.later.hours, hoursGained: truly.hours, hours: o.later.hours - truly.hours, atLeast: false };
  const hours = (n: number) => `${n.toLocaleString('en-AU', { maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 })} h`;
  const noJourney = o.lost.people - o.lost.gaveUp;
  return (
    <>
      <div className="tiles">
        <Figure value={fmt(o.times.a.people)} label="people travel" note={`${fmt(o.times.b?.people ?? 0)} in "${o.vs.name}"`} />
        <Figure tone="later" value={fmt(o.later.people)} label={o.later.people ? `arrive later, by ${mins(o.later.meanMinutes)} on average` : 'arrive later'} note="Later by a minute or more" />
        {gaveUp.people > 0 && (
          <Figure
            tone="later"
            value={fmt(gaveUp.people)}
            label={gaveUp.atLeast > 0 ? `gave up: ${mins(gaveUp.limitMinutes)} or more later` : `gave up: it would be ${mins(gaveUp.meanMinutes)} later on average`}
            note={`Their journey is now more than ${mins(gaveUp.limitMinutes)} later than on the published timetable, so they do not travel.${gaveUp.atLeast > 0 ? ' This run did not record how much later, so each is counted at that limit: the least it can be.' : ''}`}
          />
        )}
        <Figure
          tone="sooner"
          value={fmt(truly.people)}
          label={truly.people ? `arrive sooner, by ${mins(truly.meanMinutes)} on average` : 'arrive sooner'}
          note="Sooner by a minute or more, and not just by moving to a nearby stop that was already quicker on the published timetable"
        />
        {nearby.people > 0 && (
          <Figure
            value={fmt(nearby.people)}
            label="now use a nearby stop that was already quicker on the published timetable"
            note={`They arrive ${mins(nearby.meanMinutes)} sooner on average, but the published timetable already offered that from a stop near their own, and they did not take it. The change did not give it to them, so it is not counted as time gained.`}
          />
        )}
        {noJourney > 0 && (
          <Figure
            value={fmt(noJourney)}
            label="can no longer travel"
            note={`${fmt(o.lost.stranded)} were stranded by full vehicles, ${fmt(noJourney - o.lost.stranded)} have no journey. People who gave up are counted apart.`}
          />
        )}
        {(o.gained ?? 0) > 0 && <Figure value={fmt(o.gained!)} label="can now travel" note="They had no journey in the run compared with" />}
        <Figure
          value={`${net.atLeast && net.hours > 0 ? 'at least ' : ''}${hours(Math.abs(net.hours))}`}
          label={net.hours > 0 ? 'lost, all told' : net.hours < 0 ? 'gained, all told' : 'lost or gained, all told'}
          note={`${hours(o.later.hours)} lost by those who arrive later${gaveUp.people > 0 ? ` and ${gaveUp.atLeast > 0 ? 'at least ' : ''}${hours(gaveUp.hours)} by those who gave up` : ''}; ${hours(truly.hours)} gained by those who arrive sooner. Not counted: ${nearby.people > 0 ? `the ${hours(nearby.hours)} by which people who moved to a nearby stop arrive sooner, which the published timetable already offered; and ` : ''}people with no journey at all, whose loss has no length.`}
        />
      </div>
      <Honesty o={o} />
    </>
  );
}

/** What has to be said beside the headline for it to be read rightly. */
function Honesty({ o }: { o: Overview }) {
  const share = o.margin && o.margin.people > 0 ? o.margin.beaten / o.margin.people : 0;
  return (
    <>
      {o.madeUp && (
        <p className="warn-text small">
          Made-up journeys: these people were generated, not observed. The figures show how the simulator behaves, not how real travel would change.
        </p>
      )}
      {o.margin && share >= 0.05 && (
        <p className="muted small">
          On the published timetable, {fmt(o.margin.beaten)} of the {fmt(o.margin.people)} travellers ({Math.round(share * 100)}%) use a stop that one nearby already beats, by{' '}
          {mins(o.margin.meanMinutes)} on average as the simulator scores a journey. {o.madeUp ? 'With made-up journeys that is an accident of how they were drawn. ' : ''}When a change
          sends such a person to the nearby stop they arrive sooner, which is why those people are counted apart above.
        </p>
      )}
    </>
  );
}

function OverviewTab({ o, lines }: { o: Overview; lines: LineRow[] | null }) {
  const set = useStore((s) => s.set);
  const changed = (lines ?? []).filter((l) => l.a !== l.b).slice(0, 6);
  const open = (lineId: number) => set({ simResults: { ...useStore.getState().simResults, tab: 'lines', lineId } });
  return (
    <>
      <Headline o={o} />
      {o.vs && o.groups ? (
        <div className="results-two">
          <section>
            <h3>Change in arrival time</h3>
            <ChangeChart o={o} />
          </section>
          <section>
            <h3>Lines that changed most</h3>
            {!lines ? (
              <p className="muted small">Working it out ...</p>
            ) : changed.length === 0 ? (
              <p className="note">No line carries more or fewer passengers than before.</p>
            ) : (
              <ul className="results-list">
                {changed.map((line) => (
                  <li key={line.id}>
                    <button className="results-row" onClick={() => open(line.id)} title="Open this line">
                      <Badge color={line.color ?? '667085'}>{lineName(line)}</Badge>
                      <span className="grow muted small ellipsis">
                        {fmt(line.b)} before, {fmt(line.a)} now
                      </span>
                      <DeltaBar value={line.a - line.b} max={Math.max(...changed.map((l) => Math.abs(l.a - l.b)))} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">On the map, "Passenger flow" shows where on each line the passengers were gained or lost, and "Who is affected" where the people who gain or lose time start from.</p>
          </section>
        </div>
      ) : (
        <section>
          <h3>Journey times</h3>
          <TimesChart a={o.times.a} b={null} aName={o.run.name} bName="" />
          <p className="muted small">This run has nothing to be set against. A scenario run opens against its BAU run.</p>
        </section>
      )}
    </>
  );
}

/** A bar that grows right for more and left for fewer, on a shared scale. */
function DeltaBar({ value, max }: { value: number; max: number }) {
  const share = max ? Math.min(1, Math.abs(value) / max) : 0;
  return (
    <span className="results-delta" title={`${signed(value)} passengers`}>
      <span className="results-delta-track">
        <i
          style={{
            width: `${share * 50}%`,
            left: value < 0 ? `${50 - share * 50}%` : '50%',
            background: value < 0 ? GROUP_COLORS[7] : GROUP_COLORS[1],
            borderRadius: value < 0 ? '3px 0 0 3px' : '0 3px 3px 0',
          }}
        />
      </span>
      <b>{signed(value)}</b>
    </span>
  );
}

/** People by how much sooner or later they arrive: one bar a group, soonest at the top. */
function ChangeChart({ o }: { o: Overview }) {
  const groups = o.groups!;
  // Two kinds of people are drawn apart within a bar. Among the sooner: those who only moved to a
  // nearby stop that was already quicker. Among the later: those who gave up, placed by how much
  // later the journey they turned down would have been.
  const nearby = o.nearbyGroups ?? groups.map(() => 0);
  const gaveUp = o.gaveUp?.groups ?? groups.map(() => 0);
  const gaveUpPeople = o.gaveUp?.people ?? 0;
  const nearbyPeople = o.sooner?.nearby.people ?? 0;
  const lost = o.lost!.people - o.lost!.gaveUp;
  const gained = o.gained ?? 0;
  const max = Math.max(1, ...groups.map((n, i) => (i === SAME_GROUP ? 0 : n + gaveUp[i])), lost, gained);
  const total = o.compared! + o.lost!.people + gained;
  const share = (n: number) => (total ? `${((100 * n) / total).toLocaleString('en-AU', { maximumFractionDigits: n / total < 0.1 ? 1 : 0 })}%` : '');
  const striped = (color: string) => `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 6px)`;
  // A bar with people behind it can be clicked: they are followed on the map, and can be listed.
  const row = (label: string, parts: { n: number; background: string }[], key: string | number, who: Who, note?: string) => {
    const n = parts.reduce((sum, part) => sum + part.n, 0);
    return (
      <li
        key={key}
        className={n > 0 ? 'results-clickable' : ''}
        title={`${note ?? `${fmt(n)} people: ${label.toLowerCase()}`}${n > 0 ? ' · click to follow them on the map' : ''}`}
        onClick={n > 0 ? () => followPeople(who) : undefined}
      >
        <span className="results-bar-label">{label}</span>
        <span className="results-bar-track" style={{ display: 'flex' }}>
          {parts.map((part, at) => (part.n > 0 || at === 0 ? <i key={at} style={{ width: `${Math.min(100, (part.n / max) * 100)}%`, minWidth: part.n > 0 ? 1 : 0, background: part.background }} /> : null))}
        </span>
        <span className="results-bar-n">{fmt(n)}</span>
        <span className="results-bar-share muted">{share(n)}</span>
      </li>
    );
  };
  const groupRow = (n: number, i: number) => {
    if (i < SAME_GROUP) {
      const moved = Math.min(n, nearby[i]);
      return row(
        GROUP_LABELS[i],
        [{ n: n - moved, background: GROUP_COLORS[i] }, { n: moved, background: striped(GROUP_COLORS[i]) }],
        i,
        { kind: 'group', group: i },
        `${fmt(n)} people arrive ${GROUP_LABELS[i].toLowerCase()}${moved > 0 ? `; ${fmt(moved)} of them only by using a nearby stop that was already quicker on the published timetable` : ''}`,
      );
    }
    const gone = gaveUp[i];
    return row(
      GROUP_LABELS[i],
      [{ n, background: GROUP_COLORS[i] }, { n: gone, background: 'var(--text)' }],
      i,
      n > 0 ? { kind: 'group', group: i } : { kind: 'gaveUp' },
      `${fmt(n)} people arrive ${GROUP_LABELS[i].toLowerCase()}${gone > 0 ? `; ${fmt(gone)} more gave up, because their journey would be this much later${o.gaveUp!.atLeast > 0 ? ' or more (the run recorded only that it was past the limit)' : ''}` : ''}`,
    );
  };
  return (
    <>
      <ul className="results-bars">
        {groups.map((n, i) =>
          i === SAME_GROUP ? (
            <li key={i} className="results-same" title={`${fmt(n)} people arrive within a minute of when they did`}>
              <span className="results-bar-label">{GROUP_LABELS[i]}</span>
              <span className="results-bar-track muted small">not drawn to scale</span>
              <span className="results-bar-n">{fmt(n)}</span>
              <span className="results-bar-share muted">{share(n)}</span>
            </li>
          ) : (
            groupRow(n, i)
          ),
        )}
      </ul>
      <ul className="results-bars results-bars-extra">
        {row('Can no longer travel', [{ n: lost, background: 'var(--text)' }], 'lost', { kind: 'noJourney' }, `${fmt(lost)} people travelled before and now have no journey${o.lost!.stranded > 0 ? ` (${fmt(o.lost!.stranded)} of them stranded by full vehicles)` : ''}. People who gave up are in the bars above.`)}
        {gained > 0 && row('Can now travel', [{ n: gained, background: 'var(--muted)' }], 'gained', { kind: 'gained' }, `${fmt(gained)} people had no journey before and travel now`)}
      </ul>
      {(nearbyPeople > 0 || gaveUpPeople > 0) && (
        <p className="muted small">
          {nearbyPeople > 0 && (
            <>
              <i className="results-dot" style={{ background: striped(GROUP_COLORS[1]), borderRadius: 2 }} />
              Striped: sooner only by using a nearby stop that was already quicker on the published timetable ({fmt(nearbyPeople)} people).{' '}
              <button className="link small" onClick={() => followPeople({ kind: 'soonerNearby' })}>
                Follow them
              </button>{' '}
              <button className="link small" onClick={() => followPeople({ kind: 'soonerTruly' })}>
                Follow the rest
              </button>{' '}
            </>
          )}
          {gaveUpPeople > 0 && (
            <>
              <i className="results-dot" style={{ background: 'var(--text)', borderRadius: 2 }} />
              Dark: gave up, placed by how much later their journey would be{o.gaveUp!.atLeast > 0 ? ', or by the limit where the run did not record it' : ''} ({fmt(gaveUpPeople)} people).{' '}
              <button className="link small" onClick={() => followPeople({ kind: 'gaveUp' })}>
                Follow them
              </button>
            </>
          )}
        </p>
      )}
      <WhoNote />
    </>
  );
}

/** Says who has been picked out, with the way on to the list of them. */
function WhoNote() {
  const who = useStore((s) => s.simResults.who);
  const side = useStore((s) => s.simMap.side);
  const onMap = useStore((s) => s.simMap.layer === 'through');
  const set = useStore((s) => s.set);
  if (!who) return <p className="muted small">Click a bar to follow those people on the map.</p>;
  return (
    <p className="small results-who">
      <span>
        {onMap ? 'On the map' : 'Picked out'}: {whoPhrase(who, side, true)}.
      </span>
      <button className="link small" onClick={() => followPeople(who, { list: true, map: false })}>
        List them
      </button>
      <button className="link small" onClick={() => set({ simResults: { ...useStore.getState().simResults, who: null } })}>
        Clear
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Travel time
// ---------------------------------------------------------------------------
const LENGTHS = ['Under 15 min', '15 to 30 min', '30 to 60 min', 'Over an hour'];

function TimeTab({ o }: { o: Overview }) {
  const [who, setWho] = useState<'changed' | 'all'>('changed');
  if (!o.vs || !o.groups || !o.parts || !o.byHour || !o.byLength) {
    return (
      <section>
        <h3>Journey times</h3>
        <TimesChart a={o.times.a} b={null} aName={o.run.name} bName="" />
        <p className="muted small">This run has nothing to be set against, so there is no change to show.</p>
      </section>
    );
  }
  const parts = o.parts[who];
  const partRows: { label: string; a: number; b: number; unit: 'min' | 'n' }[] = [
    { label: 'Waiting', a: parts.a.waitMinutes, b: parts.b.waitMinutes, unit: 'min' },
    { label: 'Walking', a: parts.a.walkMinutes, b: parts.b.walkMinutes, unit: 'min' },
    { label: 'Riding', a: parts.a.rideMinutes, b: parts.b.rideMinutes, unit: 'min' },
    { label: 'The whole journey', a: parts.a.journeyMinutes, b: parts.b.journeyMinutes, unit: 'min' },
    { label: 'Vehicles boarded', a: parts.a.vehicles, b: parts.b.vehicles, unit: 'n' },
  ];
  return (
    <>
      <Headline o={o} />
      <div className="results-two">
        <section>
          <h3>Change in arrival time</h3>
          <ChangeChart o={o} />
          <p className="muted small">Everyone sets off when they did, so arriving later is the same as a longer journey.</p>
        </section>
        <section>
          <h3>
            What the change is made of
            <span className="chips results-chips">
              <button className={who === 'changed' ? 'on' : ''} onClick={() => setWho('changed')} title="Only people who arrive a minute or more sooner or later">
                People whose time changed
              </button>
              <button className={who === 'all' ? 'on' : ''} onClick={() => setWho('all')}>
                Everyone
              </button>
            </span>
          </h3>
          {parts.people === 0 ? (
            <p className="note">Nobody's journey time changed.</p>
          ) : (
            <table className="results-table">
              <thead>
                <tr>
                  <th>Average for {fmt(parts.people)} people</th>
                  <th className="n">Before</th>
                  <th className="n">Now</th>
                  <th className="n">Change</th>
                </tr>
              </thead>
              <tbody>
                {partRows.map((r) => {
                  const d = r.a - r.b;
                  const show = (n: number) => (r.unit === 'min' ? mins(n) : n.toFixed(2));
                  const small = Math.abs(d) < (r.unit === 'min' ? 0.05 : 0.005);
                  return (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="n">{show(r.b)}</td>
                      <td className="n">{show(r.a)}</td>
                      <td className="n">
                        {!small && <i className="results-dot" style={{ background: d > 0 ? GROUP_COLORS[7] : GROUP_COLORS[1] }} />}
                        {small ? 'none' : `${d > 0 ? '+' : '−'}${show(Math.abs(d))}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <h3>Who it changed for, by length of journey before</h3>
          <ul className="results-stacks">
            {o.byLength.map((l) => (
              <li key={l.length}>
                <span className="results-bar-label">{LENGTHS[l.length]}</span>
                <Stack groups={l.groups} />
                <span className="results-bar-n" title="People whose arrival time changed by a minute or more, of everyone whose journey was this long">
                  {fmt(l.people - l.groups[SAME_GROUP])} <span className="muted">of {fmt(l.people)}</span>
                </span>
              </li>
            ))}
          </ul>
          <GroupLegend />
        </section>
      </div>
      <section>
        <h3>By the hour people set off</h3>
        <HourChart rows={o.byHour} />
      </section>
      <section>
        <h3>Journey times, before and now</h3>
        <TimesChart a={o.times.a} b={o.times.b} aName={o.run.name} bName={o.vs.name} />
      </section>
    </>
  );
}

/** One bar split into the groups of change, as shares of the people whose time changed. */
function Stack({ groups }: { groups: number[] }) {
  const total = groups.reduce((x, y, i) => x + (i === SAME_GROUP ? 0 : y), 0);
  return (
    <span className="results-stack">
      {total > 0 &&
        groups.map((n, i) =>
          n > 0 && i !== SAME_GROUP ? (
            <i
              key={i}
              title={`${GROUP_LABELS[i]}: ${fmt(n)} people (${Math.round((100 * n) / total)}% of those whose time changed)`}
              style={{ flexGrow: n, background: GROUP_COLORS[i] }}
            />
          ) : null,
        )}
    </span>
  );
}

function GroupLegend() {
  return (
    <div className="results-legend muted small">
      <span>sooner</span>
      {GROUP_COLORS.map((color, i) => (
        <i key={i} title={GROUP_LABELS[i]} style={{ background: i === SAME_GROUP ? 'transparent' : color }} className={i === SAME_GROUP ? 'same' : ''} />
      ))}
      <span>later</span>
    </div>
  );
}

/** For each hour: people arriving later above the line, sooner below it. */
function HourChart({ rows }: { rows: NonNullable<Overview['byHour']> }) {
  const [hover, setHover] = useState<number | null>(null);
  const cols = rows.map((r) => {
    const sooner = r.groups.slice(0, SAME_GROUP);
    const later = r.groups.slice(SAME_GROUP + 1);
    return { ...r, sooner, later, up: later.reduce((x, y) => x + y, 0) + r.lost, down: sooner.reduce((x, y) => x + y, 0) };
  });
  const maxUp = Math.max(1, ...cols.map((c) => c.up));
  const maxDown = Math.max(0, ...cols.map((c) => c.down));
  const H = 150;
  const upH = maxDown ? (H * maxUp) / (maxUp + maxDown) : H;
  const scale = upH / maxUp;
  const shown = hover !== null ? cols.find((c) => c.hour === hover) : null;
  if (!cols.some((c) => c.up + c.down > 0)) return <p className="note">Nobody arrives sooner or later in any hour.</p>;
  return (
    <figure className="chart results-hours">
      <div className="results-hours-plot" style={{ height: H + 16 }} onMouseLeave={() => setHover(null)}>
        <div className="results-hours-zero" style={{ top: upH }} />
        {cols.map((c) => (
          <div key={c.hour} className={`results-hour${hover === c.hour ? ' hover' : ''}`} onMouseEnter={() => setHover(c.hour)}>
            <div className="results-hour-up" style={{ height: upH }}>
              {c.lost > 0 && <i style={{ height: Math.max(1, c.lost * scale), background: 'var(--text)' }} />}
              {[...c.later].reverse().map((n, i) => (n > 0 ? <i key={i} style={{ height: Math.max(1, n * scale), background: GROUP_COLORS[8 - i] }} /> : null))}
            </div>
            <div className="results-hour-down" style={{ height: H - upH }}>
              {[...c.sooner].reverse().map((n, i) => (n > 0 ? <i key={i} style={{ height: Math.max(1, n * scale), background: GROUP_COLORS[SAME_GROUP - 1 - i] }} /> : null))}
            </div>
            <span className="muted">{c.hour % 2 === 0 ? String(c.hour % 24).padStart(2, '0') : ''}</span>
          </div>
        ))}
      </div>
      <div className="results-legend muted small">
        {shown ? (
          <span className="results-hover-text">
            {String(shown.hour % 24).padStart(2, '0')}:00 to {String((shown.hour + 1) % 24).padStart(2, '0')}:00 · {fmt(shown.up - shown.lost)} later · {fmt(shown.down)} sooner
            {shown.nearby ? ` (${fmt(shown.nearby)} only by a nearby stop that was already quicker)` : ''}
            {shown.lost ? ` · ${fmt(shown.lost)} can no longer travel${shown.gaveUp ? ` (${fmt(shown.gaveUp)} gave up)` : ''}` : ''} · {fmt(shown.groups[SAME_GROUP])} the same
          </span>
        ) : (
          <>
            <span>
              Above the line: people who arrive later (darker is later), and in the text colour those who can no longer travel or gave up. Below: sooner, including those who only moved to a
              nearby stop that was already quicker.
            </span>
          </>
        )}
      </div>
    </figure>
  );
}

/** People by journey time in ten-minute steps: this run as bars, the other as an outline. */
function TimesChart({ a, b, aName, bName }: { a: JourneyTimes; b: JourneyTimes | null; aName: string; bName: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...a.steps, ...(b?.steps ?? []));
  const label = (i: number) => (i === a.steps.length - 1 ? `${i * 10} min or more` : `${i * 10} to ${i * 10 + 10} min`);
  return (
    <figure className="chart">
      <div className="chart-legend muted small">
        <span className="legend-swatch legend-after" /> {b ? 'now' : aName} ({mins(a.meanMinutes)} on average)
        {b && (
          <>
            <span className="legend-swatch legend-before" /> before, in "{bName}" ({mins(b.meanMinutes)})
          </>
        )}
      </div>
      <div className="results-times" onMouseLeave={() => setHover(null)}>
        {a.steps.map((n, i) => (
          <div key={i} className={`results-time${hover === i ? ' hover' : ''}`} onMouseEnter={() => setHover(i)}>
            <div className="results-time-bars">
              <i className="now" style={{ height: `${(n / max) * 100}%` }} />
              {b && <i className="before" style={{ height: `${(b.steps[i] / max) * 100}%` }} />}
            </div>
            <span className="muted">{i === a.steps.length - 1 ? `${i * 10}+` : i * 10}</span>
          </div>
        ))}
      </div>
      <div className="muted small results-hover-text">
        {hover !== null ? `${label(hover)}: ${fmt(a.steps[hover])} people${b ? ` now, ${fmt(b.steps[hover])} before` : ''}` : 'Minutes from setting off to arriving'}
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------
type Sort = 'change' | 'now' | 'name' | 'full';

function Lines({ run, rows, error, compared, capacity }: { run: SimRun; rows: LineRow[] | null; error: string | null; compared: boolean; capacity: Capacities }) {
  const state = useStore((s) => s.simResults);
  const modes = useStore((s) => s.modes);
  const set = useStore((s) => s.set);
  const [sort, setSort] = useState<Sort>(compared ? 'change' : 'now');
  const [find, setFind] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(compared);
  const open = (lineId: number | null) => {
    set({ simResults: { ...useStore.getState().simResults, lineId }, highlightRouteId: lineId });
  };
  const list = useMemo(() => {
    const wanted = find.trim().toLowerCase();
    const kept = (rows ?? []).filter(
      (l) => (!onlyChanged || !compared || l.a !== l.b) && (!wanted || `${l.shortName ?? ''} ${l.longName ?? ''}`.toLowerCase().includes(wanted)),
    );
    const by: Record<Sort, (x: LineRow, y: LineRow) => number> = {
      change: (x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b),
      now: (x, y) => y.a - x.a,
      name: (x, y) => lineName(x).localeCompare(lineName(y), 'en', { numeric: true }),
      full: (x, y) => (y.aPeak ?? 0) - (x.aPeak ?? 0),
    };
    return kept.sort(by[sort]);
  }, [rows, sort, find, onlyChanged, compared]);

  if (error) return <p className="note">{error}</p>;
  if (!rows) return <p className="muted">Working it out ...</p>;
  const max = Math.max(1, ...list.map((l) => Math.abs(l.a - l.b)));
  const maxNow = Math.max(1, ...list.map((l) => l.a));
  const changedCount = rows.filter((l) => l.a !== l.b).length;
  const percent = (share: number | null) => (share === null ? '' : `${Math.round(share * 100)}%`);
  const chosen = state.lineId !== null ? (rows.find((l) => l.id === state.lineId) ?? null) : null;
  const placeholders = placeholderNote(capacity ?? (run.capacities ? { trips: run.capacities.trips, placeholder: run.capacities.placeholderOrAssumed } : null));

  return (
    <div className={`results-lines${chosen ? ' with-detail' : ''}`}>
      <div className="results-lines-list">
        <div className="results-filters">
          <input className="day-select grow" placeholder="Find a line" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a line" />
          {compared && (
            <label className="check small" title="Leave out lines that carry exactly as many passengers as before">
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only lines that changed ({fmt(changedCount)} of {fmt(rows.length)})
            </label>
          )}
          <select className="day-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Order of the lines">
            {compared && <option value="change">Biggest change first</option>}
            <option value="now">Most passengers first</option>
            <option value="full">Fullest first</option>
            <option value="name">By name</option>
          </select>
        </div>
        {list.length === 0 ? (
          <p className="note">{rows.length === 0 ? 'Nobody rides anything in this part of the day.' : compared && onlyChanged && !find ? 'No line carries more or fewer passengers than before.' : 'No line matches.'}</p>
        ) : (
          <div className="results-scroll">
            {placeholders && <p className="warn-text small">"Fullest" rests on vehicle capacities. {placeholders}</p>}
            <table className="results-table results-line-table">
              <thead>
                <tr>
                  <th>Line</th>
                  {compared && <th className="n">Before</th>}
                  <th className="n">{compared ? 'Now' : 'Passengers'}</th>
                  <th>{compared ? 'Change in passengers' : ''}</th>
                  <th className="n" title={`The fullest any of its vehicles gets: passengers aboard as a share of its places.${placeholders ? ` ${placeholders}` : ''}`}>
                    Fullest{compared ? ', before and now' : ''}
                    {placeholders && (
                      <span className="tag tag-warn" title={placeholders}>
                        placeholder capacities
                      </span>
                    )}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, 400).map((line) => (
                  <tr key={line.id} className={state.lineId === line.id ? 'on' : ''} onClick={() => open(state.lineId === line.id ? null : line.id)}>
                    <td>
                      <Badge color={line.color ?? '667085'}>{lineName(line)}</Badge>
                      <span className="muted small"> {modes.find((m) => m.id === line.modeId)?.name ?? line.modeId}</span>
                      {line.isNew && <span className="tag tag-info">new</span>}
                      {line.parts > 1 && (
                        <span className="tag tag-info" title="Cut by a closure: its parts are counted together">
                          {line.parts} parts
                        </span>
                      )}
                    </td>
                    {compared && <td className="n">{fmt(line.b)}</td>}
                    <td className="n">{fmt(line.a)}</td>
                    <td className="results-change">
                      {compared ? (
                        <DeltaBar value={line.a - line.b} max={max} />
                      ) : (
                        <span className="results-bar-track">
                          <i style={{ width: `${(line.a / maxNow) * 100}%`, background: 'var(--series-1)' }} />
                        </span>
                      )}
                    </td>
                    <td className={`n${(line.aPeak ?? 0) >= 1 ? ' warn-text' : ''}`}>
                      {compared && line.bPeak !== null ? `${percent(line.bPeak)}, ` : ''}
                      {percent(line.aPeak)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.length > 400 && <p className="muted small">The first 400 of {fmt(list.length)} lines. Narrow the list by name to see the rest.</p>}
          </div>
        )}
      </div>
      {chosen && <LineCard run={run} line={chosen} compared={compared} onClose={() => open(null)} />}
    </div>
  );
}

function LineCard({ run, line, compared, onClose }: { run: SimRun; line: LineRow; compared: boolean; onClose: () => void }) {
  const state = useStore((s) => s.simResults);
  const openInspector = useStore((s) => s.open);
  // The day is always shown whole here: the hours are the chart.
  const detail = useResults<LineDetail>(resultsUrl(run.id, `lines/${line.id}`, { vs: state.vs, band: null }));
  const d = detail.data;
  return (
    <aside className="results-line-card">
      <div className="results-card-head">
        <Badge color={line.color ?? '667085'}>{lineName(line)}</Badge>
        <span className="grow ellipsis">{line.shortName ? line.longName : ''}</span>
        <button className="icon-button" onClick={onClose} aria-label="Close this line">
          ✕
        </button>
      </div>
      <div className="results-card-links">
        <button className="link small" onClick={() => followPeople({ kind: 'line', id: line.id, name: lineName(line) })} title="Draws on the map the stretches its passengers ride, now against before, and where they start and end">
          Its passengers on the map
        </button>
        <button className="link small" onClick={() => followPeople({ kind: 'line', id: line.id, name: lineName(line) }, { list: true, map: false })} title="Lists the people who ride it, worst affected first">
          List them
        </button>
        <button className="link small" onClick={() => openInspector({ kind: 'route', id: line.id }, { replace: true })} title="Open the line's own panel, with its trips and timetable">
          Open the line
        </button>
      </div>
      {detail.error ? (
        <p className="note">{detail.error}</p>
      ) : !d || d.line !== line.id ? (
        <p className="muted small">Working it out ...</p>
      ) : (
        <>
          <p className="muted small">
            Everything in this card is for the whole day{state.band !== null ? `, not only the ${DAY_BANDS[state.band].label} chosen above` : ''}.
          </p>
          <h3>Passengers boarding, by hour, whole day</h3>
          <BoardingsByHour rows={d.hourly} compared={compared} />
          {compared && (d.went || d.cameFrom) && (
            <>
              {d.went && d.went.people > 0 && (
                <ShiftList
                  title={`${fmt(d.went.people)} of the ${fmt(d.went.riders)} people who rode it before no longer do. They now ride`}
                  shift={d.went}
                  none="No longer travel"
                  rest="Only lines they already rode, or they walk"
                />
              )}
              {d.cameFrom && d.cameFrom.people > 0 && (
                <ShiftList
                  title={`${fmt(d.cameFrom.people)} of the ${fmt(d.cameFrom.riders)} people who ride it now did not before. Before, they rode`}
                  shift={d.cameFrom}
                  none="Did not travel"
                  rest="Only lines they still ride, or they walked"
                />
              )}
              {d.went && d.cameFrom && d.went.people + d.cameFrom.people === 0 && <p className="note">The same people ride it as before.</p>}
            </>
          )}
          {compared && !d.went && <p className="muted small">Where its passengers went needs the journeys of both runs; one of them is archived.</p>}
          <h3>Stations on the line, whole day, {compared ? 'biggest change first' : 'busiest first'}</h3>
          <Along stops={d.stops} compared={compared} />
        </>
      )}
    </aside>
  );
}

function BoardingsByHour({ rows, compared }: { rows: LineDetail['hourly']; compared: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return <p className="note">Nobody boards this line.</p>;
  const hours = rows.map((r) => r.hour);
  const [h0, h1] = [Math.min(...hours), Math.max(...hours)];
  const max = Math.max(1, ...rows.map((r) => r.boardings));
  const at = (hour: number, isA: boolean) => rows.find((r) => r.hour === hour && r.isA === isA)?.boardings ?? 0;
  return (
    <figure className="chart">
      {compared && (
        <div className="chart-legend muted small">
          <span className="legend-swatch legend-after" /> now
          <span className="legend-swatch legend-before" /> before
        </div>
      )}
      <div className="results-times results-times-short" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: h1 - h0 + 1 }, (_, i) => h0 + i).map((hour) => (
          <div key={hour} className={`results-time${hover === hour ? ' hover' : ''}`} onMouseEnter={() => setHover(hour)}>
            <div className="results-time-bars">
              <i className="now" style={{ height: `${(at(hour, true) / max) * 100}%` }} />
              {compared && <i className="before" style={{ height: `${(at(hour, false) / max) * 100}%` }} />}
            </div>
            <span className="muted">{hour % 3 === 0 ? String(hour % 24).padStart(2, '0') : ''}</span>
          </div>
        ))}
      </div>
      <div className="muted small results-hover-text">
        {hover !== null ? `${String(hover % 24).padStart(2, '0')}:00: ${fmt(at(hover, true))} board${compared ? ` now, ${fmt(at(hover, false))} before` : ''}` : ' '}
      </div>
    </figure>
  );
}

function ShiftList({ title, shift, none, rest }: { title: string; shift: Shift; none: string; rest: string }) {
  const max = Math.max(1, shift.people);
  const row = (key: string | number, label: React.ReactNode, n: number, color: string, note?: string) => (
    <li key={key} title={note}>
      <span className="results-bar-label ellipsis">{label}</span>
      <span className="results-bar-track">
        <i style={{ width: `${(n / max) * 100}%`, background: color }} />
      </span>
      <span className="results-bar-n">{fmt(n)}</span>
    </li>
  );
  return (
    <>
      <p className="results-lead">{title}</p>
      <ul className="results-bars results-shift">
        {shift.lines.map((l) => row(l.id, <Badge color={l.color ?? '667085'}>{lineName(l)}</Badge>, l.people, 'var(--series-1)', `${fmt(l.people)} of them: ${l.longName ?? lineName(l)}`))}
        {shift.notTravelling > 0 && row('none', none, shift.notTravelling, 'var(--text)')}
      </ul>
      <p className="muted small">
        Someone who took up two lines is counted on both. Anyone not in a row above: {rest.toLowerCase()}.
      </p>
    </>
  );
}

/** Each station along the line: passengers getting on and off, now against before. */
function Along({ stops, compared }: { stops: LineDetail['stops']; compared: boolean }) {
  if (!stops.length) return <p className="note">Nobody gets on or off.</p>;
  const max = Math.max(1, ...stops.map((s) => Math.max(s.aOn + s.aOff, s.bOn + s.bOff)));
  const size = (s: LineDetail['stops'][number]) => (compared ? Math.abs(s.aOn + s.aOff - s.bOn - s.bOff) : 0) * 1e9 + s.aOn + s.aOff;
  const ordered = [...stops].sort((x, y) => size(y) - size(x)).slice(0, 30);
  return (
    <ul className="results-along">
      {ordered.map((s) => {
        const now = s.aOn + s.aOff;
        const before = s.bOn + s.bOff;
        const d = now - before;
        return (
          <li key={s.id} title={`${s.name}: ${fmt(s.aOn)} on and ${fmt(s.aOff)} off${compared ? ` now, ${fmt(s.bOn)} on and ${fmt(s.bOff)} off before` : ''}`}>
            <span className="results-bar-label ellipsis">{s.name}</span>
            <span className="results-bar-track">
              <i style={{ width: `${(now / max) * 100}%`, background: 'var(--series-1)' }} />
              {compared && <i className="before" style={{ width: `${(before / max) * 100}%` }} />}
            </span>
            <span className="results-bar-n">
              {compared && d !== 0 ? (
                <>
                  <i className="results-dot" style={{ background: divergingColor(d / Math.max(now, before), 0) }} />
                  {signed(d)}
                </>
              ) : (
                fmt(now)
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
