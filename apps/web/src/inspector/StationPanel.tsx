import { formatSecs } from '@gtfs-editor/core';
import { useApi } from '../api.ts';
import { clock } from '../clock.ts';
import { useStore } from '../store.ts';
import { Badge, fmt, Loading, Tag, Tile } from './parts.tsx';

interface StationSummary {
  id: number;
  name: string;
  isStation: boolean;
  isNew: boolean;
  calls: number;
  platforms: { id: number; name: string; platformCode: string | null; calls: number }[];
  lines: { routeId: number; shortName: string | null; longName: string | null; color: string; modeName: string; calls: number; first: number; last: number }[];
  hourly: { hour: number; calls: number }[];
}

/** A station or stop: what calls there, at which platforms, and how busy each hour is. */
export function StationPanel({ stopId }: { stopId: number }) {
  const station = useApi<StationSummary>(`/api/stations/${stopId}/summary`);
  const open = useStore((s) => s.open);
  const openTimeline = useStore((s) => s.openTimeline);
  const setView = useStore((s) => s.setView);
  const s = station.data;
  if (!s) return <Loading error={station.error} />;

  const peak = Math.max(1, ...s.hourly.map((h) => h.calls));
  const busiest = s.hourly.reduce((best, h) => (h.calls > best.calls ? h : best), { hour: 0, calls: 0 });
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
          </h2>
          <div className="muted">
            {s.isStation ? `${s.platforms.length} platform${s.platforms.length === 1 ? '' : 's'}` : 'Stop'} · {s.lines.length} line{s.lines.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="tiles">
        <Tile value={fmt(s.calls)} label="calls a day" />
        <Tile value={s.calls ? `${String(busiest.hour % 24).padStart(2, '0')}:00` : 'none'} label="busiest hour" note={s.calls ? `${fmt(busiest.calls)} calls` : undefined} />
      </div>

      <div className="actions">
        <button className="button" onClick={() => chart(s.isStation ? null : s.id)} title="Every call at each platform through the day, with clashes marked">
          Platform chart
        </button>
      </div>

      {s.hourly.length > 0 && (
        <section>
          <h3>Calls per hour</h3>
          <div className="station-hours" role="img" aria-label="Calls in each hour of the day">
            {s.hourly.map((h) => (
              <div key={h.hour} className="station-hour" title={`${String(h.hour % 24).padStart(2, '0')}:00, ${h.calls} calls`}>
                <div className="station-bar" style={{ height: `${Math.max(3, (h.calls / peak) * 100)}%` }} />
                <span className="muted">{h.hour % 3 === 0 ? String(h.hour % 24).padStart(2, '0') : ''}</span>
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
              <li key={p.id}>
                <button className="row" onClick={() => chart(p.id)} title="Show this platform in the platform chart">
                  <div className="grow">{p.platformCode ? `Platform ${p.platformCode}` : p.name.replace(/^.*, /, '')}</div>
                  <div className="row-end">{p.calls ? `${fmt(p.calls)} calls` : 'not used'}</div>
                </button>
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
