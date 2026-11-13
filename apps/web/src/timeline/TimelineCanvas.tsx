// A canvas with a shared, zoomable time axis. Each timeline view supplies what to draw in the rows
// and how to find what is under the pointer; this component owns sizing, zoom, pan, the "now" line,
// hover tooltips and clicks.
import { formatSecs } from '@gtfs-editor/core';
import { useEffect, useRef } from 'react';
import { clock } from '../clock.ts';
import { useStore } from '../store.ts';

export const COLORS = {
  text: '#e8ecf1',
  muted: '#94a0b0',
  grid: '#232830',
  gridStrong: '#343b46',
  surface: '#14171c',
  rowAlt: '#181c22',
  warn: '#fab219',
  critical: '#e5484d',
  /** The outline of whatever is selected, and the fill of a vehicle waiting between trips. */
  highlight: '#ffffff',
  block: '#263243',
};
export const FONT = '11px Inter, "Segoe UI", system-ui, sans-serif';
export const HEADER_H = 24;

export interface Env {
  ctx: CanvasRenderingContext2D;
  /** Full canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Width of the label column on the left. */
  gutter: number;
  /** Top of the rows area (below the time axis). */
  top: number;
  /** Height of the rows area. */
  plotH: number;
  /** Vertical scroll offset of the rows, in pixels. */
  scrollY: number;
  viewStart: number;
  viewEnd: number;
  /** Time to x pixel. */
  x: (secs: number) => number;
  pxPerSec: number;
  hoverTripId: number | null;
  selectedTripId: number | null;
  /** Trip being dragged to a new time, and how far in seconds (snapped). */
  dragTripId: number | null;
  dragDelta: number;
}

export interface Hit {
  tripId?: number;
  vehicleDayId?: number;
  tooltip: string[];
}

interface Props {
  gutter: number;
  /** Total height of the rows; taller than the canvas means the rows scroll vertically. */
  contentHeight: number | 'fit';
  render: (env: Env) => void;
  hitTest: (px: number, py: number, env: Env) => Hit | null;
  onHit: (hit: Hit) => void;
  /** Scroll the rows so this offset is at the top; applied whenever the value changes. */
  scrollTo?: number;
  /** When given, trips can be dragged sideways; called with the trip and the shift in seconds. */
  onDragTrip?: (tripId: number, deltaSecs: number) => void;
}

const TICK_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];
const MIN_WINDOW = 10 * 60;

export function TimelineCanvas({ gutter, contentHeight, render, hitTest, onHit, scrollTo, onDragTrip }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Mutable drawing state, read by the animation frame without re-rendering React.
  const state = useRef({
    width: 0,
    height: 0,
    scrollY: 0,
    hoverTripId: null as number | null,
    dragTripId: null as number | null,
    dragDelta: 0,
    staticDirty: true,
    staticCanvas: null as HTMLCanvasElement | null,
    lastNow: -1,
  });
  const propsRef = useRef({ gutter, contentHeight, render, hitTest, onHit, onDragTrip });
  propsRef.current = { gutter, contentHeight, render, hitTest, onHit, onDragTrip };

  const view = useStore((s) => s.view);
  const selectedTripId = useStore((s) => s.highlightTripId);

  useEffect(() => {
    if (scrollTo !== undefined) {
      state.current.scrollY = Math.max(0, scrollTo);
      state.current.staticDirty = true;
    }
  }, [scrollTo]);

  // Anything React knows changed means the static layer must be redrawn.
  state.current.staticDirty = true;

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const s = state.current;
    const ratio = () => window.devicePixelRatio || 1;

    const buildEnv = (ctx: CanvasRenderingContext2D): Env => {
      const [viewStart, viewEnd] = useStore.getState().view;
      const p = propsRef.current;
      const plotW = Math.max(1, s.width - p.gutter);
      const pxPerSec = plotW / (viewEnd - viewStart);
      return {
        ctx,
        width: s.width,
        height: s.height,
        gutter: p.gutter,
        top: HEADER_H,
        plotH: Math.max(0, s.height - HEADER_H),
        scrollY: s.scrollY,
        viewStart,
        viewEnd,
        x: (secs) => p.gutter + (secs - viewStart) * pxPerSec,
        pxPerSec,
        hoverTripId: s.hoverTripId,
        selectedTripId: useStore.getState().highlightTripId,
        dragTripId: s.dragTripId,
        dragDelta: s.dragDelta,
      };
    };

    const maxScroll = () => {
      const c = propsRef.current.contentHeight;
      return c === 'fit' ? 0 : Math.max(0, c - (s.height - HEADER_H));
    };

    const drawStatic = () => {
      if (!s.staticCanvas) s.staticCanvas = document.createElement('canvas');
      const off = s.staticCanvas;
      const r = ratio();
      off.width = Math.max(1, Math.round(s.width * r));
      off.height = Math.max(1, Math.round(s.height * r));
      const ctx = off.getContext('2d')!;
      ctx.setTransform(r, 0, 0, r, 0, 0);
      ctx.clearRect(0, 0, s.width, s.height);
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      s.scrollY = Math.min(s.scrollY, maxScroll());
      const env = buildEnv(ctx);

      // Vertical time gridlines.
      const step = TICK_STEPS.find((t) => t * env.pxPerSec >= 64) ?? 21600;
      const first = Math.ceil(env.viewStart / step) * step;
      ctx.lineWidth = 1;
      for (let t = first; t <= env.viewEnd; t += step) {
        const x = Math.round(env.x(t)) + 0.5;
        ctx.strokeStyle = t % 3600 === 0 ? COLORS.gridStrong : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(x, HEADER_H);
        ctx.lineTo(x, s.height);
        ctx.stroke();
      }

      // Rows, clipped so they cannot draw over the header.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, HEADER_H, s.width, s.height - HEADER_H);
      ctx.clip();
      propsRef.current.render(env);
      ctx.restore();

      // Time axis header, on top.
      ctx.fillStyle = COLORS.surface;
      ctx.fillRect(0, 0, s.width, HEADER_H);
      ctx.strokeStyle = COLORS.gridStrong;
      ctx.beginPath();
      ctx.moveTo(0, HEADER_H + 0.5);
      ctx.lineTo(s.width, HEADER_H + 0.5);
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = 'center';
      for (let t = first; t <= env.viewEnd; t += step) {
        const x = env.x(t);
        if (x < env.gutter + 16 || x > s.width - 16) continue;
        ctx.fillText(formatSecs(((t % 86400) + 86400) % 86400), x, HEADER_H / 2);
      }
      ctx.textAlign = 'left';
      s.staticDirty = false;
    };

    let frame = 0;
    const paint = () => {
      frame = requestAnimationFrame(paint);
      const now = clock.secs;
      if (!s.staticDirty && now === s.lastNow) return;
      if (s.width === 0 || s.height === 0) return;
      const redrawn = s.staticDirty;
      if (s.staticDirty) drawStatic();
      // Test hook: with ?exportCanvas in the address, log each redraw as an image. Headless screenshot
      // tools do not capture this canvas, so automated checks read it from the console instead.
      if (redrawn && import.meta.env.DEV && location.search.includes('exportCanvas')) {
        const flat = document.createElement('canvas');
        flat.width = s.staticCanvas!.width;
        flat.height = s.staticCanvas!.height;
        const fctx = flat.getContext('2d')!;
        fctx.fillStyle = COLORS.surface;
        fctx.fillRect(0, 0, flat.width, flat.height);
        fctx.drawImage(s.staticCanvas!, 0, 0);
        console.log('TLDATA ' + flat.toDataURL('image/png'));
      }
      s.lastNow = now;
      const r = ratio();
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(s.staticCanvas!, 0, 0);
      ctx.setTransform(r, 0, 0, r, 0, 0);
      const env = buildEnv(ctx);
      const x = env.x(now);
      if (x >= env.gutter && x <= s.width) {
        ctx.strokeStyle = COLORS.highlight;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = 'rgba(255,255,255,0.7)';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(x, 4);
        ctx.lineTo(x, s.height);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    };

    const resize = () => {
      s.width = wrap.clientWidth;
      s.height = wrap.clientHeight;
      const r = ratio();
      canvas.width = Math.max(1, Math.round(s.width * r));
      canvas.height = Math.max(1, Math.round(s.height * r));
      s.staticDirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();

    const local = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    };
    const timeAt = (px: number) => {
      const [a, b] = useStore.getState().view;
      return a + ((px - propsRef.current.gutter) / Math.max(1, s.width - propsRef.current.gutter)) * (b - a);
    };
    const clampView = (a: number, b: number): [number, number] => {
      const lo = -3600;
      const hi = clock.maxSecs + 3600;
      let span = Math.min(Math.max(b - a, MIN_WINDOW), hi - lo);
      if (a < lo) a = lo;
      if (a + span > hi) a = hi - span;
      return [a, a + span];
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { px } = local(e);
      const [a, b] = useStore.getState().view;
      const anchor = timeAt(Math.max(px, propsRef.current.gutter));
      const factor = Math.exp(e.deltaY * 0.0015);
      const [na, nb] = clampView(anchor - (anchor - a) * factor, anchor + (b - anchor) * factor);
      useStore.getState().setView(na, nb);
    };

    let drag: { px: number; py: number; view: [number, number]; scrollY: number; moved: boolean; tripId: number | null } | null = null;
    const SNAP = 30;
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const { px, py } = local(e);
      // Pressing on a trip drags that trip (when editing); pressing anywhere else pans the view.
      let tripId: number | null = null;
      if (propsRef.current.onDragTrip && py > HEADER_H) {
        tripId = propsRef.current.hitTest(px, py, buildEnv(canvas.getContext('2d')!))?.tripId ?? null;
      }
      drag = { px, py, view: useStore.getState().view, scrollY: s.scrollY, moved: false, tripId };
    };
    const hideTooltip = () => (tooltipRef.current!.style.display = 'none');
    const onMove = (e: PointerEvent) => {
      const { px, py } = local(e);
      if (drag) {
        const dx = px - drag.px;
        const dy = py - drag.py;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        if (drag.tripId !== null) {
          const span = drag.view[1] - drag.view[0];
          const secs = (dx / Math.max(1, s.width - propsRef.current.gutter)) * span;
          s.dragTripId = drag.tripId;
          s.dragDelta = Math.round(secs / SNAP) * SNAP;
          s.staticDirty = true;
          const tooltip = tooltipRef.current!;
          const mins = Math.abs(s.dragDelta) / 60;
          tooltip.textContent = s.dragDelta === 0 ? 'No change' : `${mins} min ${s.dragDelta > 0 ? 'later' : 'earlier'}`;
          tooltip.style.display = 'flex';
          tooltip.style.left = `${px + 14}px`;
          tooltip.style.right = '';
          tooltip.style.top = `${Math.max(HEADER_H, py - 28)}px`;
          canvas.style.cursor = 'ew-resize';
          return;
        }
        hideTooltip();
        const span = drag.view[1] - drag.view[0];
        const dt = (dx / Math.max(1, s.width - propsRef.current.gutter)) * span;
        const [na, nb] = clampView(drag.view[0] - dt, drag.view[1] - dt);
        s.scrollY = Math.max(0, Math.min(maxScroll(), drag.scrollY - dy));
        s.staticDirty = true;
        useStore.getState().setView(na, nb);
        return;
      }
      const ctx = canvas.getContext('2d')!;
      const hit = py > HEADER_H ? propsRef.current.hitTest(px, py, buildEnv(ctx)) : null;
      const hoverId = hit?.tripId ?? null;
      if (hoverId !== s.hoverTripId) {
        s.hoverTripId = hoverId;
        s.staticDirty = true;
      }
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      const tooltip = tooltipRef.current!;
      if (hit) {
        tooltip.replaceChildren(
          ...hit.tooltip.map((line, i) => {
            const el = document.createElement(i === 0 ? 'strong' : 'span');
            el.textContent = line;
            return el;
          }),
        );
        tooltip.style.display = 'flex';
        const flip = px > s.width - 240;
        tooltip.style.left = flip ? '' : `${px + 14}px`;
        tooltip.style.right = flip ? `${s.width - px + 14}px` : '';
        tooltip.style.top = `${Math.max(HEADER_H, py - 10)}px`;
      } else {
        hideTooltip();
      }
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = drag?.moved;
      const draggedTrip = drag?.tripId ?? null;
      drag = null;
      if (wasDrag && draggedTrip !== null) {
        const delta = s.dragDelta;
        s.dragTripId = null;
        s.dragDelta = 0;
        s.staticDirty = true;
        hideTooltip();
        if (delta !== 0) propsRef.current.onDragTrip?.(draggedTrip, delta);
        return;
      }
      if (wasDrag) return;
      const { px, py } = local(e);
      const ctx = canvas.getContext('2d')!;
      const hit = py > HEADER_H ? propsRef.current.hitTest(px, py, buildEnv(ctx)) : null;
      if (hit) propsRef.current.onHit(hit);
      else if (px > propsRef.current.gutter) clock.set(timeAt(px)); // click empty space to move the clock there
    };
    const onLeave = () => {
      hideTooltip();
      if (s.hoverTripId !== null) {
        s.hoverTripId = null;
        s.staticDirty = true;
      }
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  // `view` and `selectedTripId` are read here only so that changing them re-renders and marks the layer dirty.
  void view;
  void selectedTripId;

  return (
    <div ref={wrapRef} className="timeline-canvas-wrap">
      <canvas ref={canvasRef} className="timeline-canvas" />
      <div ref={tooltipRef} className="chart-tooltip timeline-tooltip" />
    </div>
  );
}

/** Draws text clipped to a maximum width with an ellipsis. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
