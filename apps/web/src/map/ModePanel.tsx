import { useStore } from '../app/store.ts';
import './map.css';

export function ModePanel() {
  const modes = useStore((s) => s.modes);
  const enabled = useStore((s) => s.enabledModes);
  const loaded = useStore((s) => s.loadedModes);
  const toggle = useStore((s) => s.toggleMode);
  const baseline = useStore((s) => s.baselines.find((b) => b.id === s.baselineId));
  if (!baseline) return null;

  return (
    <div className="panel modes">
      {modes
        .filter((m) => baseline.tripsByMode[m.id])
        .map((m) => (
          <button
            key={m.id}
            className={`mode ${enabled[m.id] ? 'on' : 'off'}`}
            onClick={() => toggle(m.id)}
            aria-pressed={!!enabled[m.id]}
            title={enabled[m.id] ? `Hide ${m.name.toLowerCase()}` : `Show ${m.name.toLowerCase()}`}
          >
            <span className="mode-dot" style={{ background: `#${m.color}` }} />
            <span className="mode-name">{m.name}</span>
            <span className="mode-count">
              {loaded[m.id] ? baseline.tripsByMode[m.id].toLocaleString('en-AU') : 'loading'}
            </span>
          </button>
        ))}
    </div>
  );
}
