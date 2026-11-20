import { formatClock } from '@gtfs-editor/core';
import { useEffect, useRef } from 'react';
import { clock } from './clock.ts';
import { liveStats } from './liveStats.ts';
import { SPEEDS, useStore } from './store.ts';
import { activityHistogram, vehicleData } from './vehicles.ts';

const BIN_SECS = 300;

export function TimeBar() {
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const loadedModes = useStore((s) => s.loadedModes);
  const enabledModes = useStore((s) => s.enabledModes);
  const baselineId = useStore((s) => s.baselineId);
  const set = useStore((s) => s.set);

  const timeRef = useRef<HTMLSpanElement>(null);
  const dayRef = useRef<HTMLSpanElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const waitingRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Clock readout and playhead, updated without re-rendering.
  useEffect(() => {
    const update = (secs: number) => {
      const { time, nextDay } = formatClock(secs);
      if (timeRef.current) timeRef.current.textContent = time;
      if (dayRef.current) dayRef.current.style.visibility = nextDay ? 'visible' : 'hidden';
      if (headRef.current) headRef.current.style.left = `${(secs / clock.maxSecs) * 100}%`;
    };
    update(clock.secs);
    return clock.subscribe(update);
  }, [baselineId]);

  useEffect(() => {
    const update = (n: number, waiting: number) => {
      if (countRef.current) countRef.current.textContent = n.toLocaleString('en-AU');
      if (waitingRef.current) waitingRef.current.textContent = `${waiting.toLocaleString('en-AU')} waiting`;
    };
    update(liveStats.vehicles, liveStats.waiting);
    return liveStats.subscribe(update);
  }, []);

  // Backdrop: how many vehicles are running through the day.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, width, height);
      const active = [...vehicleData.values()].filter((mv) => enabledModes[mv.modeId]);
      if (!active.length) return;
      const bins = activityHistogram(active, clock.maxSecs, BIN_SECS);
      const max = Math.max(1, ...bins);
      ctx.beginPath();
      ctx.moveTo(0, height);
      bins.forEach((v, i) => ctx.lineTo((i / (bins.length - 1)) * width, height - (v / max) * (height - 2)));
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = 'rgba(76, 194, 255, 0.22)';
      ctx.fill();
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [loadedModes, enabledModes]);

  const seek = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    clock.set(((clientX - rect.left) / rect.width) * clock.maxSecs);
  };

  const hours: number[] = [];
  for (let h = 0; h * 3600 <= clock.maxSecs; h += 3) hours.push(h);

  return (
    <footer className="panel timebar">
      <button className="play" onClick={() => set({ playing: !playing })} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? (
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <rect x="5" y="4" width="5" height="16" rx="1.5" fill="currentColor" />
            <rect x="14" y="4" width="5" height="16" rx="1.5" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M8 4.5v15l12-7.5z" fill="currentColor" />
          </svg>
        )}
      </button>

      <div className="clock">
        <span ref={timeRef} className="clock-time">
          --:--
        </span>
        <span ref={dayRef} className="clock-day">
          next day
        </span>
      </div>

      <div className="timeline">
        <div
          ref={trackRef}
          className="track"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) seek(e.clientX);
          }}
          role="slider"
          aria-label="Time of day"
          aria-valuemin={0}
          aria-valuemax={clock.maxSecs}
          aria-valuenow={Math.round(clock.secs)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') clock.set(clock.secs + 300);
            if (e.key === 'ArrowLeft') clock.set(clock.secs - 300);
          }}
        >
          <canvas ref={canvasRef} className="track-canvas" />
          <div ref={headRef} className="playhead" />
        </div>
        <div className="ticks">
          {hours.map((h) => (
            <span key={h} style={{ left: `${((h * 3600) / clock.maxSecs) * 100}%` }}>
              {String(h % 24).padStart(2, '0')}
            </span>
          ))}
        </div>
      </div>

      <div className="speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} className={s === speed ? 'on' : ''} onClick={() => set({ speed: s, playing: true })}>
            {s}×
          </button>
        ))}
      </div>

      {/* The count is every vehicle drawn. Those standing between two trips are part of it, and are also given on their own. */}
      <div
        className="moving"
        title="Vehicles on the map: those running a trip, and those waiting at the end of one for their next trip. A vehicle that waits more than an hour is not shown or counted until it leaves again."
      >
        <span ref={countRef} className="moving-count">
          0
        </span>
        <span className="moving-label">vehicles out</span>
        <span ref={waitingRef} className="moving-label moving-waiting">
          0 waiting
        </span>
      </div>
    </footer>
  );
}
