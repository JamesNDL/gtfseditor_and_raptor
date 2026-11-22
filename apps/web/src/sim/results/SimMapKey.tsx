// What the results draw on the map, and the key to it. It stays on screen when the results window
// is folded away, since that is when the map is being read.
import { useStore } from '../../app/store.ts';
import { EMPTY_COLOR } from './loads.ts';
import {
  BLUES,
  FULL_STEPS,
  MIDDLE,
  REDS,
  placeholderNote,
  whoHasSide,
  whoPhrase,
  type SimMapState,
} from './results.ts';

/** Filled in by the map as it draws, so that the key can say what the widths and sizes stand for. */
export const mapScale: {
  flowMax: number;
  placeMax: number;
  people: number | null;
  note: string | null;
} = { flowMax: 0, placeMax: 0, people: null, note: null };

const Swatches = ({ colors }: { colors: string[] }) => (
  <span className="map-key-swatches">
    {colors.map((color) => (
      <i key={color} style={{ background: color }} />
    ))}
  </span>
);

export function SimMapKey() {
  const map = useStore((s) => s.simMap);
  const results = useStore((s) => s.simResults);
  const runId = useStore((s) => s.simRunId);
  const run = useStore((s) => s.simRuns.find((r) => r.id === s.simRunId) ?? null);
  const set = useStore((s) => s.set);
  const tripColours = useStore((s) => s.simTripColours);
  const scenarioId = useStore((s) => s.scenarioId);
  // The map bumps this when it has drawn, so that the scale below is the one on screen.
  useStore((s) => s.simMapDrawn);
  if (runId === null || !run || (!results.open && map.layer === 'none')) return null;
  const update = (partial: Partial<SimMapState>) =>
    set({ simMap: { ...useStore.getState().simMap, ...partial } });
  const alone = run.kind === 'bau' && run.plansRunId === null && results.vs === null;
  const flow = alone && map.flow === 'change' ? 'passengers' : map.flow;
  const placeholders = placeholderNote(
    run.capacities
      ? { trips: run.capacities.trips, placeholder: run.capacities.placeholderOrAssumed }
      : null,
  );

  return (
    <div className="panel map-key" aria-label="Results on the map">
      <div className="map-key-row">
        <b>On the map</b>
        <div className="chips">
          {(['none', 'flow', 'places', 'through', 'vehicles'] as const).map((layer) => (
            <button
              key={layer}
              className={map.layer === layer ? 'on' : ''}
              disabled={layer === 'places' && alone}
              title={
                layer === 'flow'
                  ? 'Passengers on each stretch between stops'
                  : layer === 'places'
                    ? alone
                      ? 'Needs a run to compare with'
                      : 'Where the people who gain or lose time start from, or are going'
                    : layer === 'through'
                      ? 'Click a stretch or a stop: where its passengers come from and go to, and which way the same people go in the other run'
                      : layer === 'vehicles'
                        ? 'Each vehicle coloured by how full it is at the time on the clock'
                        : 'The network as usual'
              }
              onClick={() => update({ layer })}
            >
              {layer === 'none'
                ? 'Nothing'
                : layer === 'flow'
                  ? 'Passenger flow'
                  : layer === 'places'
                    ? 'Who is affected'
                    : layer === 'through'
                      ? 'Through here'
                      : 'How full'}
            </button>
          ))}
        </div>
      </div>

      {map.layer === 'flow' && (
        <>
          <div className="map-key-row">
            <select
              className="day-select"
              value={flow}
              onChange={(e) => update({ flow: e.target.value as SimMapState['flow'] })}
              aria-label="What the colour of a stretch shows"
            >
              {!alone && <option value="change">Coloured by change in passengers</option>}
              <option value="passengers">Passengers only</option>
              <option value="full">Coloured by how full</option>
            </select>
          </div>
          {flow === 'change' && (
            <div className="map-key-row small muted">
              fewer <Swatches colors={[...REDS].reverse()} /> <Swatches colors={[MIDDLE]} />{' '}
              <Swatches colors={BLUES} /> more
            </div>
          )}
          {flow === 'full' && (
            <div className="map-key-row small muted map-key-wrap">
              {FULL_STEPS.map((step) => (
                <span key={step.label}>
                  <Swatches colors={[step.color]} /> {step.label}
                </span>
              ))}
            </div>
          )}
          <div className="small muted">
            Width is passengers
            {mapScale.flowMax
              ? `: the widest is ${Math.round(mapScale.flowMax).toLocaleString('en-AU')} or more`
              : ''}
            {flow === 'full'
              ? '. Colour is passengers aboard as a share of places, over the hours chosen.'
              : flow === 'change'
                ? '. A stretch nobody uses any more is drawn at the width it had.'
                : '.'}{' '}
            Each direction is drawn on its own side.
          </div>
          {flow === 'full' && placeholders && <div className="small warn-text">{placeholders}</div>}
        </>
      )}

      {map.layer === 'places' && (
        <>
          <div className="map-key-row">
            <select
              className="day-select"
              value={map.end}
              onChange={(e) => update({ end: e.target.value as SimMapState['end'] })}
              aria-label="Which end of the journey"
            >
              <option value="origin">Where people start</option>
              <option value="destination">Where people are going</option>
            </select>
            <select
              className="day-select"
              value={map.by}
              onChange={(e) => update({ by: e.target.value as SimMapState['by'] })}
              aria-label="How places are gathered"
            >
              <option value="stop">By stop</option>
              <option value="500">500 m squares</option>
              <option value="1000">1 km squares</option>
              <option value="2000">2 km squares</option>
            </select>
          </div>
          <div className="map-key-row small muted">
            sooner <Swatches colors={[...BLUES].reverse()} /> <Swatches colors={[MIDDLE]} />{' '}
            <Swatches colors={REDS} /> later
          </div>
          <div className="small muted">
            Colour is the average change for the people there: under 5, 15 and 30 minutes, and more.
            The palest also marks a place where only a few of many are 5 minutes or more sooner or
            later.{' '}
            {map.by === 'stop' ? 'Size is how many people.' : 'A stronger square has more people.'}{' '}
            A dark ring marks people who can no longer travel.
          </div>
        </>
      )}
      {map.layer === 'through' && (
        <>
          {results.who ? (
            <>
              <div className="small">
                <b>
                  {mapScale.people !== null
                    ? `${mapScale.people.toLocaleString('en-AU')} people: `
                    : ''}
                </b>
                {whoPhrase(results.who, alone ? 'a' : map.side, !alone)}
              </div>
              <div className="map-key-row">
                {!alone && whoHasSide(results.who) && (
                  <select
                    className="day-select"
                    value={map.side}
                    onChange={(e) => update({ side: e.target.value as SimMapState['side'] })}
                    aria-label="In which run they use it"
                  >
                    <option value="b">who used it before</option>
                    <option value="a">who use it now</option>
                  </select>
                )}
                <button
                  className="link small"
                  onClick={() =>
                    set({
                      simResults: {
                        ...useStore.getState().simResults,
                        open: true,
                        small: false,
                        tab: 'people',
                      },
                    })
                  }
                >
                  List them
                </button>
                <button
                  className="link small"
                  onClick={() =>
                    set({ simResults: { ...useStore.getState().simResults, who: null } })
                  }
                >
                  Pick again
                </button>
              </div>
              {!alone && (
                <div className="map-key-row small muted">
                  they left <Swatches colors={[...REDS].reverse()} /> <Swatches colors={[MIDDLE]} />{' '}
                  <Swatches colors={BLUES} /> they took up
                </div>
              )}
              <div className="map-key-row small muted map-key-wrap">
                <span>
                  <i className="map-key-end from" /> where they start
                </span>
                <span>
                  <i className="map-key-end to" /> where they are going
                </span>
              </div>
              <div className="small muted">
                Width is how many of them ride each stretch
                {mapScale.flowMax
                  ? `: the widest is ${Math.round(mapScale.flowMax).toLocaleString('en-AU')} or more`
                  : ''}
                .{!alone && ' Grey is a stretch they ride in both runs.'}
              </div>
            </>
          ) : (
            <div className="small muted">
              Click a stretch or a stop on the map to see where its passengers come from and go to
              {alone ? '' : ', and which way the same people go in the other run'}. A line's
              passengers can be picked in the Lines tab, and a group of people by clicking a bar of
              the change in arrival time.
            </div>
          )}
        </>
      )}

      {map.layer === 'vehicles' && (
        <>
          <div className="map-key-row small muted map-key-wrap">
            <span>
              <Swatches colors={[EMPTY_COLOR]} /> empty
            </span>
            {FULL_STEPS.map((step) => (
              <span key={step.label}>
                <Swatches colors={[step.color]} /> {step.label}
              </span>
            ))}
          </div>
          <div className="small muted">
            Each vehicle is coloured by the passengers aboard as a share of its places, at the time
            on the clock.
          </div>
          <div className="small warn-text">
            {placeholders ?? 'Capacities are placeholders, so this is illustrative.'}
          </div>
          {(run.kind === 'scenario' ? run.scenarioId : null) !== scenarioId && (
            <div className="small warn-text">
              This run was made on{' '}
              {run.kind === 'bau'
                ? 'the published timetable'
                : `"${run.scenarioName ?? 'a scenario that has been removed'}"`}
              , which is not the timetable open, so its vehicles are not coloured. Open that
              timetable to see them.
            </div>
          )}
          <label
            className="check small"
            title="In the trip diagram, the platform chart and the vehicle chart"
          >
            <input
              type="checkbox"
              checked={tripColours}
              onChange={(e) => set({ simTripColours: e.target.checked })}
            />{' '}
            Colour trips in the timelines the same way
          </label>
        </>
      )}
      {mapScale.note && map.layer !== 'none' && (
        <div className="small warn-text">{mapScale.note}</div>
      )}
    </div>
  );
}
