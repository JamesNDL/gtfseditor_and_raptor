import type { ReactNode } from 'react';

export const fmt = (n: number) => n.toLocaleString('en-AU');

export function duration(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
}

export function Badge({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="badge" style={{ background: `#${color.replace('#', '')}` }}>
      {children}
    </span>
  );
}

export function Tag({
  kind,
  title,
  children,
}: {
  kind: 'warn' | 'info';
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`tag tag-${kind}`} title={title}>
      {children}
    </span>
  );
}

export function Tile({ value, label, note }: { value: string; label: string; note?: string }) {
  return (
    <div className="tile" title={note}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

export function Loading({ error }: { error: string | null }) {
  return <div className="muted pad">{error ? `Could not load: ${error}` : 'Loading ...'}</div>;
}

/** Station names in the feed end in ", Platform N" or " Station"; trim for compact lists. */
export const shortStop = (name: string) =>
  name.replace(/ Station(?=,|$)/, '').replace(/, Platform /, ' P');
