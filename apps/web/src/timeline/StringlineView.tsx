// Time-distance diagram: stations down the side, time across, one line per trip.
import { formatSecs } from '@gtfs-editor/core';
import { useMemo } from 'react';
import { useApi } from '../shared/api-client.ts';
import { applyEdit } from '../scenarios/scenario-client.ts';
import { peakText, stepAt, stepColor, useTripColours } from '../sim/loads.ts';
import { useStore } from '../app/store.ts';
import { COLORS, fitText, TimelineCanvas, type Env, type Hit } from './TimelineCanvas.tsx';

interface StringlineData {
  patternId: number;
  routeId: number;
  stations: { id: number; name: string; dist: number }[];
  routes: { id: number; shortName: string | null; color: string }[];
  /** calls is flat: [stationIndex, arr, dep, passing] per call. */
  trips: { id: number; routeId: number; edited: boolean; calls: number[] }[];
  /** Published trips the open scenario replaced or removed. */
  ghosts: { id: number; routeId: number; calls: number[] }[];
}

const GUTTER = 150;
const PAD = 12;

export function StringlineView({ patternId, others }: { patternId: number; others: boolean }) {
  const { data, error } = useApi<StringlineData>(
    `/api/patterns/${patternId}/stringline?others=${others ? 1 : 0}`,
  );
  const open = useStore((s) => s.open);
  const editing = useStore((s) => s.baselineId !== null);
  // Trips coloured by how full they are in the chosen simulation run, when that is switched on.
  const loaded = useTripColours() !== null;

  const model = useMemo(() => {
    if (!data) return null;
    const color = new Map(data.routes.map((r) => [r.id, `#${r.color}`]));
    const name = new Map(data.routes.map((r) => [r.id, r.shortName ?? '?']));
    const d0 = data.stations[0]?.dist ?? 0;
    const span = Math.max(1, (data.stations[data.stations.length - 1]?.dist ?? 1) - d0);
    const frac = data.stations.map((s) => (s.dist - d0) / span);
    const trips = data.trips.map((t) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < t.calls.length; i += 4) {
        min = Math.min(min, t.calls[i + 1]);
        max = Math.max(max, t.calls[i + 2]);
      }
      return { ...t, min, max, own: t.routeId === data.routeId };
    });
    // The line's own trips are drawn last, on top of the others.
    trips.sort((a, b) => Number(a.own) - Number(b.own));
    return { color, name, frac, trips };
  }, [data]);

  if (!data || !model)
    return (
      <div className="muted pad timeline-message">
        {error ? `Could not load: ${error}` : 'Loading ...'}
      </div>
    );

  const yOf = (env: Env, stationIndex: number) =>
    env.top + PAD + model.frac[stationIndex] * (env.plotH - 2 * PAD);

  const tracePath = (env: Env, calls: number[], shift = 0) => {
    const { ctx } = env;
    ctx.beginPath();
    for (let i = 0; i < calls.length; i += 4) {
      const y = yOf(env, calls[i]);
      const xa = env.x(calls[i + 1] + shift);
      if (i === 0) ctx.moveTo(xa, y);
      else ctx.lineTo(xa, y);
      if (calls[i + 2] !== calls[i + 1]) ctx.lineTo(env.x(calls[i + 2] + shift), y);
    }
  };

  /** Strokes a trip stretch by stretch, each in the colour of how full the vehicle is as it leaves. */
  const strokeLoaded = (env: Env, tripId: number, calls: number[]) => {
    const { ctx } = env;
    let step = stepAt(tripId, calls[2]);
    ctx.beginPath();
    ctx.moveTo(env.x(calls[1]), yOf(env, calls[0]));
    ctx.lineTo(env.x(calls[2]), yOf(env, calls[0]));
    for (let i = 4; i < calls.length; i += 4) {
      const y = yOf(env, calls[i]);
      const xa = env.x(calls[i + 1]);
      ctx.lineTo(xa, y);
      const next = stepAt(tripId, calls[i + 2]);
      if (next !== step) {
        ctx.strokeStyle = stepColor(step);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(xa, y);
        step = next;
      }
      if (calls[i + 2] !== calls[i + 1]) ctx.lineTo(env.x(calls[i + 2]), y);
    }
    ctx.strokeStyle = stepColor(step);
    ctx.stroke();
  };

  const render = (env: Env) => {
    const { ctx } = env;
    // Station lines and labels.
    let lastLabelY = -Infinity;
    ctx.lineWidth = 1;
    data.stations.forEach((s, i) => {
      const y = Math.round(yOf(env, i)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(env.gutter, y);
      ctx.lineTo(env.width, y);
      ctx.stroke();
      if (y - lastLabelY >= 13) {
        ctx.fillStyle = COLORS.muted;
        ctx.textAlign = 'right';
        ctx.fillText(
          fitText(ctx, s.name.replace(/ Station$/, ''), env.gutter - 14),
          env.gutter - 8,
          y,
        );
        lastLabelY = y;
      }
    });
    ctx.textAlign = 'left';

    ctx.save();
    ctx.beginPath();
    ctx.rect(env.gutter, env.top, env.width - env.gutter, env.plotH);
    ctx.clip();
    ctx.lineJoin = 'round';
    // Where trips were before the scenario changed them: dashed grey, underneath everything.
    if (data.ghosts.length) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = COLORS.muted;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.75;
      for (const g of data.ghosts) {
        tracePath(env, g.calls);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    const showDots = env.pxPerSec * 60 >= 5;
    let focus: (typeof model.trips)[number] | null = null;
    for (const t of model.trips) {
      if (t.max < env.viewStart || t.min > env.viewEnd) continue;
      if (t.id === env.selectedTripId || t.id === env.hoverTripId) {
        if (!focus || t.id === env.selectedTripId) focus = t;
        if (t.id === env.selectedTripId) continue;
      }
      ctx.globalAlpha = t.own ? 0.95 : 0.5;
      ctx.strokeStyle = model.color.get(t.routeId) ?? COLORS.muted;
      ctx.lineWidth = t.id === env.hoverTripId ? 2.5 : t.own ? 1.4 : 1;
      if (t.edited) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 3.4;
        tracePath(env, t.calls);
        ctx.stroke();
        ctx.strokeStyle = COLORS.highlight;
        ctx.lineWidth = 1;
      }
      if (loaded) {
        ctx.globalAlpha = t.own ? 1 : 0.6;
        ctx.lineWidth = t.id === env.hoverTripId ? 3 : t.own ? 2 : 1.3;
        strokeLoaded(env, t.id, t.calls);
        continue;
      }
      tracePath(env, t.calls);
      ctx.stroke();
      if (showDots && t.own) {
        ctx.fillStyle = model.color.get(t.routeId) ?? COLORS.muted;
        for (let i = 0; i < t.calls.length; i += 4) {
          if (t.calls[i + 3]) continue;
          ctx.beginPath();
          ctx.arc(env.x(t.calls[i + 2]), yOf(env, t.calls[i]), 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    // The selected trip: a white casing under its own colour so it reads on any background.
    const selected = model.trips.find((t) => t.id === env.selectedTripId);
    if (selected) {
      ctx.strokeStyle = COLORS.highlight;
      ctx.lineWidth = 5;
      tracePath(env, selected.calls);
      ctx.stroke();
      ctx.lineWidth = 2.5;
      if (loaded) {
        strokeLoaded(env, selected.id, selected.calls);
      } else {
        ctx.strokeStyle = model.color.get(selected.routeId) ?? COLORS.muted;
        tracePath(env, selected.calls);
        ctx.stroke();
      }
    }
    // A trip being dragged: a dashed white ghost at the time it would move to.
    const dragged =
      env.dragTripId !== null ? model.trips.find((t) => t.id === env.dragTripId) : undefined;
    if (dragged) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = COLORS.highlight;
      ctx.lineWidth = 2.5;
      tracePath(env, dragged.calls, env.dragDelta);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  };

  const hitTest = (px: number, py: number, env: Env): Hit | null => {
    if (px < env.gutter) return null;
    let best: { d: number; trip: (typeof model.trips)[number]; call: number } | null = null;
    for (const t of model.trips) {
      if (t.max < env.viewStart || t.min > env.viewEnd) continue;
      const c = t.calls;
      let x0 = env.x(c[1]);
      let y0 = yOf(env, c[0]);
      for (let i = 0; i < c.length; i += 4) {
        const y = yOf(env, c[i]);
        // Two segments per call: travel to it, then the dwell.
        for (const x of [env.x(c[i + 1]), env.x(c[i + 2])]) {
          const dx = x - x0;
          const dy = y - y0;
          const len2 = dx * dx + dy * dy;
          const f =
            len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
          const d = Math.hypot(px - (x0 + f * dx), py - (y0 + f * dy));
          // Prefer the line's own trips when two are equally close.
          const score = d - (t.own ? 0.5 : 0);
          if (d <= 5 && (!best || score < best.d)) best = { d: score, trip: t, call: i };
          x0 = x;
          y0 = y;
        }
      }
    }
    if (!best) return null;
    const c = best.trip.calls;
    const station = data.stations[c[best.call]].name.replace(/ Station$/, '');
    return {
      tripId: best.trip.id,
      tooltip: [
        `${model.name.get(best.trip.routeId) ?? '?'} · ${formatSecs(best.trip.min)} to ${formatSecs(best.trip.max)}`,
        `${c[best.call + 3] ? 'Passes' : 'At'} ${station} ${formatSecs(c[best.call + 2])}`,
        ...(loaded ? [peakText(best.trip.id) ?? 'Carries nobody'] : []),
      ],
    };
  };

  return (
    <TimelineCanvas
      gutter={GUTTER}
      contentHeight="fit"
      render={render}
      hitTest={hitTest}
      onHit={(hit) =>
        hit.tripId !== undefined && open({ kind: 'trip', id: hit.tripId }, { replace: true })
      }
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
    />
  );
}
