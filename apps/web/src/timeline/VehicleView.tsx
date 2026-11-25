// Vehicle chart: one row per vehicle, its trips as bars across the day.
import { formatSecs } from '@gtfs-editor/core';
import { useMemo } from 'react';
import { useApi } from '../shared/api-client.ts';
import { applyEdit } from '../scenarios/scenario-client.ts';
import { EMPTY_COLOR, peakText, stepColor, tripLoads, useTripColours } from '../sim/loads.ts';
import { currentSelection, useStore } from '../app/store.ts';
import {
  COLORS,
  fitText,
  roundRect,
  TimelineCanvas,
  type Env,
  type Hit,
} from './TimelineCanvas.tsx';

interface VehicleTrip {
  id: number;
  startSecs: number;
  endSecs: number;
  routeId: number;
  shortName: string | null;
  color: string;
  headsign: string | null;
  edited: boolean;
  firstStationId: number;
  lastStationId: number;
}

interface VehiclesData {
  vehicleDays: {
    id: number;
    label: string;
    source: 'run_number' | 'inferred';
    startSecs: number;
    endSecs: number;
    gapCount: number;
    isNew: boolean;
    trips: VehicleTrip[];
  }[];
  stayAboard: [number, number][];
}

const GUTTER = 150;
const ROW_H = 22;
const MIN_BAR = 3;

export function VehicleView({ routeId }: { routeId: number }) {
  const { data, error } = useApi<VehiclesData>(`/api/routes/${routeId}/vehicles`);
  const open = useStore((s) => s.open);
  const selection = useStore(currentSelection);
  const selectedDayId = selection?.kind === 'vehicleDay' ? selection.id : null;
  const editing = useStore((s) => s.baselineId !== null);
  // Trips coloured by how full they are in the chosen simulation run, when that is switched on.
  const loaded = useTripColours() !== null;

  const stay = useMemo(
    () => new Set((data?.stayAboard ?? []).map(([a, b]) => `${a}>${b}`)),
    [data],
  );

  if (!data)
    return (
      <div className="muted pad timeline-message">
        {error ? `Could not load: ${error}` : 'Loading ...'}
      </div>
    );
  if (data.vehicleDays.length === 0)
    return <div className="muted pad timeline-message">No vehicles run this line on this day.</div>;

  const rowTop = (env: Env, r: number) => env.top + r * ROW_H - env.scrollY;

  const render = (env: Env) => {
    const { ctx } = env;
    data.vehicleDays.forEach((day, r) => {
      const y = rowTop(env, r);
      if (y + ROW_H < env.top || y > env.height) return;
      if (day.id === selectedDayId) {
        ctx.fillStyle = COLORS.block;
        ctx.fillRect(0, y, env.width, ROW_H);
      } else if (r % 2 === 1) {
        ctx.fillStyle = COLORS.rowAlt;
        ctx.fillRect(0, y, env.width, ROW_H);
      }
      // Vehicles the scenario added are named in the accent colour with a plus sign.
      ctx.fillStyle = day.isNew ? '#4cc2ff' : day.id === selectedDayId ? COLORS.text : COLORS.muted;
      ctx.fillText(
        fitText(ctx, day.isNew ? `+ ${day.label}` : day.label, env.gutter - 16),
        10,
        y + ROW_H / 2,
      );

      ctx.save();
      ctx.beginPath();
      ctx.rect(env.gutter, Math.max(y, env.top), env.width - env.gutter, ROW_H);
      ctx.clip();
      const mid = Math.round(y + ROW_H / 2) + 0.5;

      // What happens between trips: waiting, passengers staying aboard, or an empty run.
      for (let i = 1; i < day.trips.length; i++) {
        const prev = day.trips[i - 1];
        const next = day.trips[i];
        if (next.startSecs < env.viewStart || prev.endSecs > env.viewEnd) continue;
        const x0 = env.x(prev.endSecs);
        const x1 = env.x(next.startSecs);
        ctx.beginPath();
        ctx.moveTo(x0, mid);
        ctx.lineTo(x1, mid);
        if (stay.has(`${prev.id}>${next.id}`)) {
          ctx.strokeStyle = COLORS.text;
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
        } else if (prev.lastStationId !== next.firstStationId) {
          ctx.strokeStyle = COLORS.warn;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
        } else {
          ctx.strokeStyle = COLORS.gridStrong;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const t of day.trips) {
        if (t.endSecs < env.viewStart || t.startSecs > env.viewEnd) continue;
        const x = env.x(t.startSecs);
        // A 1px surface gap keeps back-to-back trips reading as separate bars.
        const w = Math.max(MIN_BAR, env.x(t.endSecs) - x - 1);
        roundRect(ctx, x, y + 4, w, ROW_H - 8, 3);
        ctx.fillStyle = loaded ? EMPTY_COLOR : `#${t.color}`;
        ctx.fill();
        const load = loaded ? tripLoads.byTrip.get(t.id) : undefined;
        if (load) {
          // Along the bar, each part of the trip in the colour of how full the vehicle is then.
          ctx.save();
          roundRect(ctx, x, y + 4, w, ROW_H - 8, 3);
          ctx.clip();
          for (let k = 0; k < load.times.length; k++) {
            if (load.steps[k] <= 0) continue;
            const from = env.x(Math.max(load.times[k], t.startSecs));
            const to = env.x(Math.min(load.times[k + 1] ?? t.endSecs, t.endSecs));
            ctx.fillStyle = stepColor(load.steps[k]);
            ctx.fillRect(from, y + 4, Math.max(1, to - from), ROW_H - 8);
          }
          ctx.restore();
        }
        if (t.id === env.selectedTripId || t.id === env.hoverTripId) {
          ctx.strokeStyle = COLORS.highlight;
          ctx.lineWidth = t.id === env.selectedTripId ? 2.5 : 1.5;
          roundRect(ctx, x - 1, y + 3, w + 2, ROW_H - 6, 4);
          ctx.stroke();
        } else if (t.edited) {
          // Changed by the scenario: a thin white edge.
          ctx.strokeStyle = COLORS.highlight;
          ctx.lineWidth = 1;
          roundRect(ctx, x + 0.5, y + 4.5, w - 1, ROW_H - 9, 3);
          ctx.stroke();
        }
        if (w >= 30) {
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = 'rgba(0,0,0,0.6)';
          ctx.shadowBlur = 2;
          ctx.fillText(fitText(ctx, t.shortName ?? '', w - 8), x + 4, y + ROW_H / 2 + 0.5);
          ctx.shadowBlur = 0;
        }
      }
      ctx.restore();
    });

    // A trip being dragged: a dashed white outline on the vehicle, or at the time, it would move to.
    if (env.dragTripId !== null) {
      const from = data.vehicleDays.findIndex((d) => d.trips.some((t) => t.id === env.dragTripId));
      const t = data.vehicleDays[from]?.trips.find((t) => t.id === env.dragTripId);
      if (t) {
        const y = rowTop(env, env.dragRow ?? from);
        ctx.save();
        ctx.beginPath();
        ctx.rect(env.gutter, env.top, env.width - env.gutter, env.plotH);
        ctx.clip();
        if (env.dragRow !== null) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
          ctx.fillRect(env.gutter, y, env.width - env.gutter, ROW_H);
        }
        const x = env.x(t.startSecs + env.dragDelta);
        const w = Math.max(MIN_BAR, env.x(t.endSecs + env.dragDelta) - x - 1);
        ctx.setLineDash([5, 3]);
        ctx.strokeStyle = COLORS.highlight;
        ctx.lineWidth = 2;
        roundRect(ctx, x - 1, y + 3, w + 2, ROW_H - 6, 4);
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  const hitTest = (px: number, py: number, env: Env): Hit | null => {
    const r = Math.floor((py - env.top + env.scrollY) / ROW_H);
    const day = data.vehicleDays[r];
    if (!day) return null;
    if (px < env.gutter) {
      return {
        vehicleDayId: day.id,
        tooltip: [
          day.label,
          `${day.trips.length} trips · ${formatSecs(day.startSecs)} to ${formatSecs(day.endSecs)}`,
          day.isNew
            ? 'Added by this scenario for its new trips'
            : day.source === 'inferred'
              ? "Inferred, not the operator's roster"
              : 'From the run number in the feed',
        ],
      };
    }
    for (let i = 0; i < day.trips.length; i++) {
      const t = day.trips[i];
      const x = env.x(t.startSecs);
      const w = Math.max(MIN_BAR, env.x(t.endSecs) - x);
      if (px >= x - 4 && px <= x + w + 4) {
        return {
          tripId: t.id,
          row: r,
          tooltip: [
            `${t.shortName ?? '?'}${t.headsign ? ` to ${t.headsign}` : ''}`,
            `${formatSecs(t.startSecs)} to ${formatSecs(t.endSecs)}`,
            day.label,
            ...(loaded ? [peakText(t.id) ?? 'Carries nobody'] : []),
          ],
        };
      }
      const next = day.trips[i + 1];
      if (next && px > x + w && px < env.x(next.startSecs)) {
        const gap = Math.max(1, Math.round((next.startSecs - t.endSecs) / 60));
        const kind = stay.has(`${t.id}>${next.id}`)
          ? 'Passengers stay aboard'
          : t.lastStationId !== next.firstStationId
            ? 'Empty run needed to reach the next trip'
            : 'Waits';
        return { vehicleDayId: day.id, tooltip: [day.label, `${kind} · ${gap} min`] };
      }
    }
    return null;
  };

  return (
    <TimelineCanvas
      gutter={GUTTER}
      contentHeight={data.vehicleDays.length * ROW_H}
      render={render}
      hitTest={hitTest}
      onHit={(hit) => {
        if (hit.tripId !== undefined) open({ kind: 'trip', id: hit.tripId }, { replace: true });
        else if (hit.vehicleDayId !== undefined)
          open({ kind: 'vehicleDay', id: hit.vehicleDayId }, { replace: true });
      }}
      rowAt={(py, env) => {
        const r = Math.floor((py - env.top + env.scrollY) / ROW_H);
        return r >= 0 && r < data.vehicleDays.length ? r : null;
      }}
      dropLabel={(_, row) => `Move to ${data.vehicleDays[row].label}`}
      // Sideways moves the trip in time; up or down gives it to another vehicle.
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
              if (hit.tripId === undefined) return;
              open({ kind: 'trip', id: hit.tripId }, { replace: true });
              void applyEdit({
                kind: 'moveToVehicle',
                tripId: hit.tripId,
                vehicleDayId: data.vehicleDays[row].id,
              });
            }
          : undefined
      }
    />
  );
}
