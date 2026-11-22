import { formatSecs } from '@gtfs-editor/core';
import { useEffect, useState } from 'react';
import { useApi } from '../api.ts';
import { clock } from '../clock.ts';
import { StationPassengers } from '../sim/SimFigures.tsx';
import { useStore } from '../store.ts';
import { DeletedNote, DeletePreviewCard, type Deletion } from './DeleteStop.tsx';
import { Badge, fmt, Loading, Tag, Tile } from './parts.tsx';

interface StationSummary {
  id: number;
  name: string;
  isStation: boolean;
  isNew: boolean;
  /** Trains, trams or ferries call here: its stops are platforms, not the two sides of a road. */
  rail: boolean;
  /** Set when the open scenario has deleted it. */
  deleted: Deletion | null;
  calls: number;
  platforms: {
    id: number;
    name: string;
    platformCode: string | null;
    calls: number;
    deleted: Deletion | null;
  }[];
  lines: {
    routeId: number;
    shortName: string | null;
    longName: string | null;
    color: string;
    modeName: string;
    calls: number;
    first: number;
    last: number;
  }[];
  hourly: { hour: number; calls: number }[];
}

/** A station or stop: what calls there, at which platforms, and how busy each hour is. */
export function StationPanel({ stopId }: { stopId: number }) {
  const station = useApi<StationSummary>(`/api/stations/${stopId}/summary`);
  const open = useStore((s) => s.open);
  const openTimeline = useStore((s) => s.openTimeline);
  const setView = useStore((s) => s.setView);
  const editing = useStore((s) => s.baselineId !== null);
  // What is about to be deleted, while its preview is open: the station itself, or one platform.
  const [deleting, setDeleting] = useState<number[] | null>(null);
  useEffect(() => setDeleting(null), [stopId]);
  const s = station.data;
  if (!s) return <Loading error={station.error} />;

  const live = s.platforms.filter((p) => !p.deleted);
  const platformName = (p: StationSummary['platforms'][number]) =>
    p.platformCode ? `Platform ${p.platformCode}` : p.name.replace(/^.*, /, '');
  // A bus stop's 'station' is only the feed's grouping, so it is called a stop.
  const whole = s.rail || live.length > 1 ? 'station' : 'stop';

  const peak = Math.max(1, ...s.hourly.map((h) => h.calls));
  const busiest = s.hourly.reduce((best, h) => (h.calls > best.calls ? h : best), {
    hour: 0,
    calls: 0,
  });
  const chart = (focusStopId: number | null) => {
    openTimeline({ tab: 'platforms', stationId: s.id, focusStopId });
    setView(Math.max(0, clock.secs - 1800), clock.secs + 5400);
  };

  return (
    <>
      <div className="title-row">
        <div>
          <h2>
            {s.name}
            {s.isNew && <Tag kind="info">added in this scenario</Tag>}
            {s.deleted && <Tag kind="warn">deleted in this scenario</Tag>}
          </h2>
          <div className="muted">
            {s.isStation ? `${live.length} platform${live.length === 1 ? '' : 's'}` : 'Stop'} ·{' '}
            {s.lines.length} line{s.lines.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="tiles">
        <Tile value={fmt(s.calls)} label="calls a day" />
        <Tile
          value={s.calls ? `${String(busiest.hour % 24).padStart(2, '0')}:00` : 'none'}
          label="busiest hour"
          note={s.calls ? `${fmt(busiest.calls)} calls` : undefined}
        />
      </div>

      <div className="actions">
        <button
          className="button"
          onClick={() => chart(s.isStation ? null : s.id)}
          title="Every call at each platform through the day, with clashes marked"
        >
          Platform chart
        </button>
        {editing && !s.deleted && !deleting && (
          <button
            className="button"
            title={`Take this ${whole} out of the scenario. You see what it does to the trips before anything changes.`}
            onClick={() => setDeleting([s.id])}
          >
            Delete this {whole}
          </button>
        )}
      </div>

      {s.deleted && <DeletedNote what={s.name} deletion={s.deleted} />}
      {deleting && <DeletePreviewCard stopIds={deleting} onClose={() => setDeleting(null)} />}

      <StationPassengers stopId={s.id} />

      {s.hourly.length > 0 && (
        <section>
          <h3>Calls per hour</h3>
          <div className="station-hours" role="img" aria-label="Calls in each hour of the day">
            {s.hourly.map((h) => (
              <div
                key={h.hour}
                className="station-hour"
                title={`${String(h.hour % 24).padStart(2, '0')}:00, ${h.calls} calls`}
              >
                <div
                  className="station-bar"
                  style={{ height: `${Math.max(3, (h.calls / peak) * 100)}%` }}
                />
                <span className="muted">
                  {h.hour % 3 === 0 ? String(h.hour % 24).padStart(2, '0') : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {s.isStation && s.platforms.length > 0 && (
        <section>
          <h3>Platforms</h3>
          <ul className="rows clickable">
            {s.platforms.map((p) => (
              <li key={p.id} className="platform-row">
                <button
                  className="row"
                  onClick={() => chart(p.id)}
                  disabled={!!p.deleted}
                  title={p.deleted ? p.deleted.summary : 'Show this platform in the platform chart'}
                >
                  <div className={`grow${p.deleted ? ' struck' : ''}`}>{platformName(p)}</div>
                  <div className="row-end">
                    {p.deleted ? 'deleted' : p.calls ? `${fmt(p.calls)} calls` : 'not used'}
                  </div>
                </button>
                {editing && !p.deleted && !s.deleted && live.length > 1 && (
                  <button
                    className="button small-button"
                    title={
                      s.rail
                        ? 'Take this platform away. Its calls move to another platform of this station; you see how many, and any clashes, before anything changes.'
                        : 'Take this stop away. You see what it does to the trips before anything changes.'
                    }
                    aria-label={`Delete ${platformName(p)}`}
                    onClick={() => setDeleting([p.id])}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Lines that call here</h3>
        {s.lines.length === 0 && <p className="note">Nothing calls here on this day.</p>}
        <ul className="rows clickable">
          {s.lines.map((l) => (
            <li key={l.routeId}>
              <button className="row" onClick={() => open({ kind: 'route', id: l.routeId })}>
                <Badge color={l.color}>{l.shortName ?? '?'}</Badge>
                <div className="grow">
                  <div className="ellipsis">{l.longName ?? l.modeName}</div>
                  <div className="muted">
                    {formatSecs(l.first)} to {formatSecs(l.last)}
                  </div>
                </div>
                <div className="row-end">{fmt(l.calls)} calls</div>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
