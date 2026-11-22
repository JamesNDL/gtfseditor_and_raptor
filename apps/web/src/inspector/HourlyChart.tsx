import { useState } from 'react';
import type { HourlyRow } from '../api.ts';
import { fmt } from './parts.tsx';

interface Props {
  title: string;
  rows: HourlyRow[];
  /** The published timetable for the same direction, drawn as an outline for comparison. */
  before?: HourlyRow[];
  /** Shared across the small multiples so they can be compared. */
  hours: [number, number];
  yMax: number;
  capacityIsPlaceholder: boolean;
  /** What the bars measure: departures, or seated plus standing places. */
  metric?: 'trips' | 'places';
}

const W = 392;
const H = 96;
const LEFT = 22;
const BOTTOM = 16;
const TOP = 6;

/** Departures per hour for one direction. One series, so the title names it and there is no legend. */
export function HourlyChart({
  title,
  rows,
  before,
  hours,
  yMax,
  capacityIsPlaceholder,
  metric = 'trips',
}: Props) {
  const value = (r: HourlyRow | undefined) =>
    !r ? 0 : metric === 'trips' ? r.trips : r.seated + r.standing;
  const [hover, setHover] = useState<number | null>(null);
  const [h0, h1] = hours;
  const n = h1 - h0 + 1;
  const slot = (W - LEFT) / n;
  const barW = Math.max(2, slot - 2);
  const plotH = H - BOTTOM - TOP;
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  const beforeByHour = before ? new Map(before.map((r) => [r.hour, r])) : null;
  const y = (v: number) => TOP + plotH - (v / yMax) * plotH;
  const hovered = hover !== null ? byHour.get(hover) : undefined;

  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <div className="chart-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`${title}: ${metric === 'trips' ? 'departures' : 'places'} per hour`}
        >
          <line x1={LEFT} x2={W} y1={y(yMax)} y2={y(yMax)} className="chart-grid" />
          <line x1={LEFT} x2={W} y1={y(0)} y2={y(0)} className="chart-axis" />
          <text x={LEFT - 4} y={y(yMax) + 3} textAnchor="end" className="chart-label">
            {yMax >= 10000 ? `${Math.round(yMax / 1000)}k` : yMax}
          </text>
          <text x={LEFT - 4} y={y(0) + 3} textAnchor="end" className="chart-label">
            0
          </text>
          {Array.from({ length: n }, (_, i) => {
            const hour = h0 + i;
            const row = byHour.get(hour);
            const x = LEFT + i * slot + (slot - barW) / 2;
            const top = row ? y(value(row)) : y(0);
            const height = y(0) - top;
            const r = Math.min(3, barW / 2, height);
            return (
              <g key={hour} onMouseEnter={() => setHover(hour)} onMouseLeave={() => setHover(null)}>
                {/* Full-height hit target, larger than the bar itself. */}
                <rect x={LEFT + i * slot} y={TOP} width={slot} height={plotH} fill="transparent" />
                {row && height > 0 && (
                  <path
                    d={`M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${y(0)} Z`}
                    className={hover === hour ? 'chart-bar hover' : 'chart-bar'}
                  />
                )}
                {/* Published level: an outline, shown only where the scenario differs from it. */}
                {beforeByHour && value(beforeByHour.get(hour)) !== value(row) && (
                  <rect
                    x={x - 0.5}
                    y={y(value(beforeByHour.get(hour)))}
                    width={barW + 1}
                    height={Math.max(1.5, y(0) - y(value(beforeByHour.get(hour))))}
                    className="chart-before"
                  />
                )}
                {hour % 3 === 0 && (
                  <text
                    x={LEFT + i * slot + slot / 2}
                    y={H - 4}
                    textAnchor="middle"
                    className="chart-label"
                  >
                    {String(hour % 24).padStart(2, '0')}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div
            className="chart-tooltip"
            style={{ left: `${((LEFT + (hover - h0 + 0.5) * slot) / W) * 100}%` }}
          >
            <strong>
              {String(hover % 24).padStart(2, '0')}:00 to{' '}
              {String((hover + 1) % 24).padStart(2, '0')}:00
            </strong>
            <span>
              {hovered ? `${hovered.trips} departures` : 'No departures'}
              {beforeByHour &&
                (beforeByHour.get(hover)?.trips ?? 0) !== (hovered?.trips ?? 0) &&
                ` (published: ${beforeByHour.get(hover)?.trips ?? 0})`}
            </span>
            {hovered && (
              <span>
                {fmt(hovered.seated + hovered.standing)} places
                {capacityIsPlaceholder ? ' (placeholder)' : ''}
                {beforeByHour &&
                  metric === 'places' &&
                  value(beforeByHour.get(hover)) !== value(hovered) &&
                  ` (published: ${fmt(value(beforeByHour.get(hover)))})`}
              </span>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}
