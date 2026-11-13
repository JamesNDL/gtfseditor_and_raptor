import { useMemo, useState } from 'react';
import { useStore } from './store.ts';

const fmt = (n: number) => n.toLocaleString('en-AU');

export function TopBar() {
  const baselines = useStore((s) => s.baselines);
  const baselineId = useStore((s) => s.baselineId);
  const routes = useStore((s) => s.routes);
  const modes = useStore((s) => s.modes);
  const set = useStore((s) => s.set);
  const info = useStore((s) => s.scenarioInfo);
  const theme = useStore((s) => s.theme);
  const open = useStore((s) => s.open);
  const timelineOpen = useStore((s) => s.timeline.open);
  const openTimeline = useStore((s) => s.openTimeline);
  const closeTimeline = useStore((s) => s.closeTimeline);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const baseline = baselines.find((b) => b.id === baselineId);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const modeRank = new Map(modes.map((m, i) => [m.id, i]));
    const scored: { score: number; id: number }[] = [];
    for (const r of routes.values()) {
      const short = (r.shortName ?? '').toLowerCase();
      const long = (r.longName ?? '').toLowerCase();
      let score = -1;
      if (short === q) score = 0;
      else if (short.startsWith(q)) score = 1;
      else if (long.includes(q)) score = 2;
      if (score >= 0) scored.push({ score: score * 10 + (modeRank.get(r.modeId) ?? 9), id: r.id });
    }
    return scored
      .sort((a, b) => a.score - b.score || routes.get(b.id)!.tripCount - routes.get(a.id)!.tripCount)
      .slice(0, 8)
      .map((s) => routes.get(s.id)!);
  }, [query, routes, modes]);

  return (
    <header className="topbar">
      <div className="panel brand">
        <div className="brand-name">GTFS Editor</div>
        <select
          className="day-select"
          value={baselineId ?? ''}
          onChange={(e) => set({ baselineId: Number(e.target.value) })}
          aria-label="Service day"
        >
          {baselines.length === 0 && <option value="">No days imported</option>}
          {baselines.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
        <button
          className={`button small-button${timelineOpen ? ' on' : ''}`}
          onClick={() => (timelineOpen ? closeTimeline() : openTimeline())}
          aria-pressed={timelineOpen}
          title="Stringline, platform and vehicle timelines"
        >
          Timelines
        </button>
        <button className="button small-button" onClick={() => set({ fleetOpen: true })} title="Vehicle types, capacities and fleet sizes">
          Fleet
        </button>
        <button
          className="button small-button"
          title={theme === 'dark' ? 'Switch to the light version' : 'Switch to the dark version'}
          aria-label={theme === 'dark' ? 'Switch to the light version' : 'Switch to the dark version'}
          onClick={() => {
            const next = theme === 'dark' ? 'light' : 'dark';
            set({ theme: next });
          }}
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>

      <div className="search">
        <input
          className="panel search-input"
          placeholder="Find a line: T1, 333, F1 ..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          aria-label="Find a line"
        />
        {focused && matches.length > 0 && (
          <ul className="panel search-results">
            {matches.map((r) => (
              <li key={r.id}>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    open({ kind: 'route', id: r.id }, { replace: true });
                    setQuery('');
                    setFocused(false);
                  }}
                >
                  <span className="badge" style={{ background: `#${r.color}` }}>
                    {r.shortName ?? '?'}
                  </span>
                  <span className="search-name">{r.longName ?? r.agency}</span>
                  <span className="muted">{fmt(r.tripCount)} trips</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {baseline && (
        <div className="panel stats">
          <Stat
            value={fmt(info ? info.stats.trips : baseline.stats.trips)}
            label={info ? 'trips in this scenario' : 'trips'}
            title={info ? `${fmt(baseline.stats.trips)} as published` : undefined}
          />
          <Stat value={fmt(baseline.stats.routesRunning)} label="lines running" />
          <Stat
            value={fmt(info ? info.stats.vehicles : baseline.stats.vehicleDays)}
            label="vehicles (est.)"
            title={`${fmt(baseline.stats.vehicleDaysInferred)} of these are inferred by chaining trips, not taken from operator rosters`}
          />
          <Stat
            value={fmt(baseline.stats.baselineConflicts)}
            label="clashes as published"
            title="Pairs of trips at the same platform or wharf at the same time in the feed as published"
          />
        </div>
      )}
    </header>
  );
}

function Stat({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
