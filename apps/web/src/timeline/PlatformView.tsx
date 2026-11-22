// Platform occupancy: one row per platform, a bar for each train's stay.
import { formatSecs } from '@gtfs-editor/core';
import { useEffect, useMemo } from 'react';
import { useApi } from '../api.ts';
import { applyEdit } from '../scenario.ts';
import { stepAt, stepColor, useTripColours } from '../sim/loads.ts';
import { useStore } from '../store.ts';
import {
  COLORS,
  fitText,
  roundRect,
  TimelineCanvas,
  type Env,
  type Hit,
} from './TimelineCanvas.tsx';

export interface PlatformData {
  station: { id: number; name: string };
  platforms: { id: number; name: string; platformCode: string | null }[];
  routes: { id: number; shortName: string | null; color: string }[];
  calls: {
    tripId: number;
    /** Which of the trip's calls this is. */
    seq: number;
    stopId: number;
    arr: number;
    dep: number;
    passing: boolean;
    routeId: number;
    headsign: string | null;
    starts: boolean;
    ends: boolean;
  }[];
  layovers: {
    stopId: number;
    from: number;
    to: number;
    tripId: number;
    nextTripId: number;
    inferred: boolean;
    color: string;
  }[];
  conflicts: { stopId: number; tripA: number; tripB: number; from: number; to: number }[];
}

const GUTTER = 150;
const MIN_BAR = 3;

const minutes = (secs: number) => `${Math.max(1, Math.round(secs / 60))} min`;

export function PlatformView({
  stationId,
  onStationName,
}: {
  stationId: number;
  onStationName: (name: string) => void;
}) {
  const { data, error } = useApi<PlatformData>(`/api/stations/${stationId}/platforms`);
  const open = useStore((s) => s.open);
  const focusStopId = useStore((s) => s.timeline.focusStopId);
  const editing = useStore((s) => s.baselineId !== null);
  // Calls coloured by how full the vehicle is in the chosen simulation run, when that is switched on.
  const loaded = useTripColours() !== null;
  const stationName = data?.station.name;
  useEffect(() => {
    if (stationName) onStationName(stationName);
  }, [stationName, onStationName]);

  const model = useMemo(() => {
    if (!data) return null;
    const natural = new Intl.Collator('en', { numeric: true });
    // Numbered platforms first, in number order; then stands, wharves and stops by name.
    const platforms = [...data.platforms].sort(
      (a, b) =>
        Number(a.platformCode === null) - Number(b.platformCode === null) ||
        natural.compare(a.platformCode ?? a.name, b.platformCode ?? b.name) ||
        natural.compare(a.name, b.name),
    );
    const row = new Map(platforms.map((p, i) => [p.id, i]));
    const color = new Map(data.routes.map((r) => [r.id, `#${r.color}`]));
    const name = new Map(data.routes.map((r) => [r.id, r.shortName ?? '?']));
    const trimmed = (name: string) =>
      name.replace(data.station.name, '').replace(/^[ ,]+/, '') || name;
    const numbered = platforms.map((p) =>
      p.platformCode ? `Platform ${p.platformCode}` : trimmed(p.name),
    );
    // Interchanges can have two "Platform 1"s (say train and light rail); fall back to the stop's own name.
    const labels = numbered.map((label, i) =>
      numbered.indexOf(label) !== numbered.lastIndexOf(label) ? trimmed(platforms[i].name) : label,
    );
    return { platforms, row, color, name, labels };
  }, [data]);

  if (!data || !model)
    return (
      <div className="muted pad timeline-message">
        {error ? `Could not load: ${error}` : 'Loading ...'}
      </div>
    );
  if (model.platforms.length === 0)
    return <div className="muted pad timeline-message">No services call here on this day.</div>;

  const rowH = model.platforms.length <= 8 ? 34 : model.platforms.length <= 16 ? 26 : 22;
  const focusRow = model.platforms.findIndex((p) => p.id === focusStopId);
  const rowTop = (env: Env, r: number) => env.top + r * rowH - env.scrollY;
  const barX = (env: Env, from: number, to: number): [number, number] => {
    const x = env.x(from);
    return [x, Math.max(MIN_BAR, env.x(to) - x)];
  };

  const render = (env: Env) => {
    const { ctx } = env;
    model.platforms.forEach((_, r) => {
      const y = rowTop(env, r);
      if (y + rowH < env.top || y > env.height) return;
      const focused = model.platforms[r].id === focusStopId;
      if (focused) {
        ctx.fillStyle = COLORS.block;
        ctx.fillRect(0, y, env.width, rowH);
      } else if (r % 2 === 1) {
        ctx.fillStyle = COLORS.rowAlt;
        ctx.fillRect(0, y, env.width, rowH);
      }
      ctx.fillStyle = focused ? COLORS.text : COLORS.muted;
      ctx.fillText(fitText(ctx, model.labels[r], env.gutter - 16), 10, y + rowH / 2);
    });

    ctx.save();
    ctx.beginPath();
    ctx.rect(env.gutter, env.top, env.width - env.gutter, env.plotH);
    ctx.clip();
    const inset = rowH >= 26 ? 5 : 4;

    // Vehicles waiting between trips: a faint band joining arrival to next departure.
    for (const l of data.layovers) {
      if (l.to < env.viewStart || l.from > env.viewEnd) continue;
      const r = model.row.get(l.stopId);
      if (r === undefined) continue;
      const [x, w] = barX(env, l.from, l.to);
      const y = rowTop(env, r) + inset + 3;
      // Neutral, not the route colour: a red line's band would read as an alarm.
      ctx.fillStyle = 'rgba(148, 160, 176, 0.22)';
      ctx.fillRect(x, y, w, rowH - 2 * inset - 6);
    }

    for (const c of data.calls) {
      if (c.dep < env.viewStart || c.arr > env.viewEnd) continue;
      const r = model.row.get(c.stopId);
      if (r === undefined) continue;
      const y = rowTop(env, r) + inset;
      const h = rowH - 2 * inset;
      const [x, w] = barX(env, c.arr, c.dep);
      // The fuller of how it arrives and how it leaves: a train that empties here arrived full.
      const fill = loaded
        ? stepColor(Math.max(stepAt(c.tripId, c.arr - 1), stepAt(c.tripId, c.dep)))
        : (model.color.get(c.routeId) ?? COLORS.muted);
      if (c.passing) {
        // Runs through without stopping: a thin tick rather than a bar.
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = fill;
        ctx.fillRect(x, y + h / 2 - 1, Math.max(w, 2), 2);
        ctx.globalAlpha = 1;
        continue;
      }
      roundRect(ctx, x, y, w, h, 3);
      ctx.fillStyle = fill;
      ctx.fill();
      if (c.tripId === env.selectedTripId || c.tripId === env.hoverTripId) {
        ctx.strokeStyle = COLORS.highlight;
        ctx.lineWidth = c.tripId === env.selectedTripId ? 2.5 : 1.5;
        roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 4);
        ctx.stroke();
      }
      if (w >= 30) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 2;
        ctx.fillText(fitText(ctx, model.name.get(c.routeId) ?? '', w - 8), x + 4, y + h / 2 + 0.5);
        ctx.shadowBlur = 0;
      }
    }

    // A call being dragged: a dashed white outline on the platform, or at the time, it would move to.
    const held = env.dragHit;
    const dragged = held
      ? data.calls.find((c) => c.tripId === held.tripId && c.seq === held.seq)
      : undefined;
    const draggedRow = dragged ? (env.dragRow ?? model.row.get(dragged.stopId)) : undefined;
    if (dragged && draggedRow !== undefined) {
      const [x, w] = barX(env, dragged.arr + env.dragDelta, dragged.dep + env.dragDelta);
      if (env.dragRow !== null) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.fillRect(env.gutter, rowTop(env, draggedRow), env.width - env.gutter, rowH);
      }
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = COLORS.highlight;
      ctx.lineWidth = 2;
      roundRect(
        ctx,
        x - 1,
        rowTop(env, draggedRow) + inset - 1,
        Math.max(w, 6) + 2,
        rowH - 2 * inset + 2,
        4,
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Two trips on the platform at once in the feed as published.
    ctx.strokeStyle = COLORS.critical;
    ctx.lineWidth = 2;
    for (const k of data.conflicts) {
      if (k.to < env.viewStart || k.from > env.viewEnd) continue;
      const r = model.row.get(k.stopId);
      if (r === undefined) continue;
      const [x, w] = barX(env, k.from, k.to);
      ctx.strokeRect(x - 3, rowTop(env, r) + 1.5, Math.max(w, 6) + 6, rowH - 3);
    }
    ctx.restore();
  };

  const hitTest = (px: number, py: number, env: Env): Hit | null => {
    if (px < env.gutter) return null;
    const r = Math.floor((py - env.top + env.scrollY) / rowH);
    const platform = model.platforms[r];
    if (!platform) return null;
    const overlap = data.conflicts.some(
      (k) =>
        k.stopId === platform.id &&
        px >= env.x(k.from) - 4 &&
        px <= Math.max(env.x(k.to), env.x(k.from) + 6) + 4,
    );
    // Bars are often only a few pixels wide, so accept a near miss and take the closest.
    let best: PlatformData['calls'][number] | null = null;
    let bestD = Infinity;
    for (const c of data.calls) {
      if (c.stopId !== platform.id) continue;
      const [x, w] = barX(env, c.arr, c.dep);
      if (px < x - 6 || px > x + w + 6) continue;
      const d = Math.abs(px - (x + w / 2));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) {
      const what = best.passing
        ? 'Passes through'
        : best.starts
          ? 'Starts here'
          : best.ends
            ? 'Terminates here'
            : `Stops ${minutes(best.dep - best.arr)}`;
      return {
        tripId: best.tripId,
        row: r,
        seq: best.seq,
        tooltip: [
          `${model.name.get(best.routeId) ?? '?'}${best.headsign ? ` to ${best.headsign}` : ''}`,
          best.arr === best.dep
            ? formatSecs(best.arr)
            : `${formatSecs(best.arr)} to ${formatSecs(best.dep)}`,
          what,
          ...(overlap ? ['Overlaps another trip on this platform'] : []),
        ],
      };
    }
    for (const l of data.layovers) {
      if (l.stopId !== platform.id) continue;
      if (px >= env.x(l.from) && px <= env.x(l.to)) {
        return {
          tripId: l.nextTripId,
          noDrag: true,
          tooltip: [
            `Vehicle waits here ${minutes(l.to - l.from)}`,
            `${formatSecs(l.from)} to ${formatSecs(l.to)}`,
            ...(l.inferred
              ? ['Inferred: the feed does not say which vehicle runs the next trip']
              : []),
          ],
        };
      }
    }
    return null;
  };

  return (
    <TimelineCanvas
      gutter={GUTTER}
      contentHeight={model.platforms.length * rowH}
      scrollTo={focusRow >= 0 ? (focusRow - 2) * rowH : undefined}
      render={render}
      hitTest={hitTest}
      onHit={(hit) =>
        hit.tripId !== undefined && open({ kind: 'trip', id: hit.tripId }, { replace: true })
      }
      rowAt={(py, env) => {
        const r = Math.floor((py - env.top + env.scrollY) / rowH);
        return r >= 0 && r < model.platforms.length ? r : null;
      }}
      dropLabel={(_, row) => `Move to ${model.labels[row]}`}
      // Sideways moves the whole trip in time; up or down moves this call to another platform.
      onDragTrip={
        editing
          ? (tripId, delta) => {
              open({ kind: 'trip', id: tripId }, { replace: true });
              void applyEdit({
                kind: 'shift',
                tripIds: [tripId],
                delta,
                ripple: useStore.getState().ripple,
              });
            }
          : undefined
      }
      onDropRow={
        editing
          ? (hit, row) => {
              if (hit.tripId === undefined || hit.seq === undefined) return;
              open({ kind: 'trip', id: hit.tripId }, { replace: true });
              void applyEdit({
                kind: 'setPlatform',
                tripId: hit.tripId,
                stopSeq: hit.seq,
                stopId: model.platforms[row].id,
              });
            }
          : undefined
      }
    />
  );
}
