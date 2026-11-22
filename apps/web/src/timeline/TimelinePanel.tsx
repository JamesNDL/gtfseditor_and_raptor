import { useEffect, useState } from 'react';
import { useApi, type RouteDetail } from '../api.ts';
import { clock } from '../clock.ts';
import { Badge, shortStop } from '../inspector/parts.tsx';
import { FULL_STEPS, placeholderNote } from '../sim/results.ts';
import { EMPTY_COLOR } from '../sim/loads.ts';
import { useShownRun } from '../sim/SimFigures.tsx';
import { useStore, type TimelineTab } from '../store.ts';
import { PlatformView } from './PlatformView.tsx';
import { StringlineView } from './StringlineView.tsx';
import { VehicleView } from './VehicleView.tsx';

const TABS: { id: TimelineTab; label: string }[] = [
  { id: 'stringline', label: 'Trip diagram' },
  { id: 'platforms', label: 'Platforms' },
  { id: 'vehicles', label: 'Vehicles' },
];

const RAIL_MODES = new Set(['train', 'metro', 'light_rail']);

export function TimelinePanel() {
  const timeline = useStore((s) => s.timeline);
  const openTimeline = useStore((s) => s.openTimeline);
  const closeTimeline = useStore((s) => s.closeTimeline);
  const setView = useStore((s) => s.setView);
  const editing = useStore((s) => s.scenarioId !== null);
  // A simulation run made on the timetable open: its trips can be coloured by how full they are.
  const simRun = useShownRun();
  const tripColours = useStore((s) => s.simTripColours);
  const set = useStore((s) => s.set);

  const needsRoute = timeline.tab !== 'platforms';
  const route = useApi<RouteDetail>(
    timeline.open && needsRoute && timeline.routeId ? `/api/routes/${timeline.routeId}` : null,
  );
  // Reported by the platform view once its data arrives, so the station is fetched only once.
  const [stationName, setStationName] = useState('');

  // Escape closes the panel.
  useEffect(() => {
    if (!timeline.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTimeline();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [timeline.open, closeTimeline]);

  if (!timeline.open) return null;

  const r = route.data;
  // Longest stopping pattern first: it makes the most complete station axis.
  const patterns = r
    ? [...r.patterns].sort((a, b) => b.stopCount - a.stopCount || b.tripCount - a.tripCount)
    : [];
  // A remembered pattern may be gone: reshaping a line replaces its stop patterns.
  const patternId =
    (patterns.some((p) => p.id === timeline.patternId) ? timeline.patternId : null) ??
    patterns[0]?.id ??
    null;
  const others = timeline.showOthers ?? (r ? RAIL_MODES.has(r.modeId) : false);

  const aroundNow = (hours: number) => {
    const start = Math.max(0, clock.secs - (hours * 3600) / 4);
    setView(start, start + hours * 3600);
  };

  // What can be dragged comes first: it is the part that cannot be guessed.
  const hint = [
    timeline.tab === 'stringline' && 'Drag a trip sideways to retime it',
    timeline.tab === 'vehicles' &&
      'Drag a trip sideways to retime it, up or down to change its vehicle',
    timeline.tab === 'platforms' &&
      'Drag a call sideways to retime its trip, up or down to change its platform',
    'scroll to zoom time · drag elsewhere to pan · click a trip to inspect it · click empty space to move the clock',
    editing && timeline.tab === 'stringline' && 'white core = changed · dashed grey = where it was',
    editing &&
      timeline.tab === 'vehicles' &&
      'blue name = vehicle added · white edge = changed trip',
    timeline.tab === 'vehicles' &&
      'bright link = passengers stay aboard · dashed amber = empty run needed',
    timeline.tab === 'platforms' &&
      'faint band = vehicle waiting between trips · red box = overlap already in the feed',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section className="panel tl-panel" aria-label="Timeline">
      <header className="timeline-header">
        <div className="tabs timeline-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={timeline.tab === t.id ? 'on' : ''}
              onClick={() => openTimeline({ tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="timeline-context">
          {needsRoute && r && (
            <>
              <Badge color={r.color}>{r.shortName ?? '?'}</Badge>
              <span className="ellipsis">{r.longName}</span>
            </>
          )}
          {timeline.tab === 'platforms' && timeline.stationId !== null && (
            <strong className="ellipsis">{stationName}</strong>
          )}
        </div>

        {timeline.tab === 'stringline' && r && patterns.length > 0 && (
          <>
            <select
              className="day-select timeline-select"
              value={patternId ?? ''}
              onChange={(e) => openTimeline({ patternId: Number(e.target.value) })}
              aria-label="Corridor"
              title="Which stopping pattern to use as the station axis"
            >
              {patterns.map((p) => (
                <option key={p.id} value={p.id}>
                  {shortStop(p.firstStop)} → {shortStop(p.lastStop)} · {p.stopCount} stops ·{' '}
                  {p.tripCount} trips
                </option>
              ))}
            </select>
            <label
              className="timeline-check"
              title="Show trips of other lines that call at three or more of these stations"
            >
              <input
                type="checkbox"
                checked={others}
                onChange={(e) => openTimeline({ showOthers: e.target.checked })}
              />
              Other lines
            </label>
          </>
        )}

        {simRun && (
          <label
            className="timeline-check"
            title={`Colour each trip by how full it is in "${simRun.name}": passengers aboard as a share of its places`}
          >
            <input
              type="checkbox"
              checked={tripColours}
              onChange={(e) => set({ simTripColours: e.target.checked })}
            />
            How full
            {tripColours && (
              <span
                className="map-key-swatches"
                title={`Grey is empty, then ${FULL_STEPS.map((step) => step.label).join(', ')}`}
              >
                {[EMPTY_COLOR, ...FULL_STEPS.map((step) => step.color)].map((color) => (
                  <i key={color} style={{ background: color }} />
                ))}
              </span>
            )}
            {tripColours &&
              simRun.capacities &&
              placeholderNote({
                trips: simRun.capacities.trips,
                placeholder: simRun.capacities.placeholderOrAssumed,
              }) && (
                <span
                  className="tag tag-warn"
                  title={placeholderNote({
                    trips: simRun.capacities.trips,
                    placeholder: simRun.capacities.placeholderOrAssumed,
                  })!}
                >
                  placeholder capacities
                </span>
              )}
          </label>
        )}

        <div className="timeline-window">
          <button
            className="button small-button"
            onClick={() => aroundNow(2)}
            title="Show two hours around the clock"
          >
            2 h
          </button>
          <button
            className="button small-button"
            onClick={() => aroundNow(6)}
            title="Show six hours around the clock"
          >
            6 h
          </button>
          <button
            className="button small-button"
            onClick={() => setView(3 * 3600, Math.min(clock.maxSecs, 27 * 3600))}
            title="Show the whole day"
          >
            Day
          </button>
          <button className="icon-button" onClick={closeTimeline} aria-label="Close timeline">
            ✕
          </button>
        </div>
      </header>

      <div className="timeline-body">
        {timeline.tab === 'stringline' &&
          (patternId !== null ? (
            <StringlineView key={`${patternId}-${others}`} patternId={patternId} others={others} />
          ) : (
            <Empty
              text={
                timeline.routeId
                  ? 'Loading ...'
                  : 'Open a line first: click one on the map or use the search box.'
              }
            />
          ))}
        {timeline.tab === 'platforms' &&
          (timeline.stationId !== null ? (
            <PlatformView
              key={timeline.stationId}
              stationId={timeline.stationId}
              onStationName={setStationName}
            />
          ) : (
            <Empty text="Click a station on the map, or a stop in a trip's stop list, to see its platforms." />
          ))}
        {timeline.tab === 'vehicles' &&
          (timeline.routeId !== null ? (
            <VehicleView key={timeline.routeId} routeId={timeline.routeId} />
          ) : (
            <Empty text="Open a line first: click one on the map or use the search box." />
          ))}
      </div>

      {/* One line, cut short where the panel is narrow; the whole of it shows on hover. */}
      <footer className="timeline-hint muted small" title={hint}>
        {hint}
      </footer>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="muted pad timeline-message">{text}</div>;
}
