// The map editor's tool bar, floating on the map beside the side panel (D36): Draw zone (Z) and
// Place point of interest (P), the tool in use lit up, and beside it what to do next, with Undo
// corner and Finish while drawing, and Cancel (Escape). With no tool it says what can be dragged.
import type { ReactNode } from 'react';
import { useStore } from '../../app/store.ts';
import { usePlaces } from '../analysis-api.ts';
import {
  NO_MAP_WORK,
  closeDrawing,
  pickTool,
  toolHint,
  undoCorner,
  type MapTool,
  type MapWork,
} from '../map-work.ts';

const change = (step: (work: MapWork) => MapWork): void => {
  const { analysis, set } = useStore.getState();
  set({ analysis: { ...analysis, work: step(analysis.work) } });
};

const svg = (body: ReactNode) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    {body}
  </svg>
);

/** An outline with a dot at each corner. */
const POLYGON_ICON = svg(
  <>
    <path
      d="M5 8.5 11 4l8 4.5-2 9.5H7.5L5 8.5Z"
      fill="currentColor"
      fillOpacity="0.15"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    {[
      [5, 8.5],
      [11, 4],
      [19, 8.5],
      [17, 18],
      [7.5, 18],
    ].map(([x, y]) => (
      <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="currentColor" />
    ))}
  </>,
);

/** A map pin. */
const PIN_ICON = svg(
  <>
    <path
      d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21Z"
      fill="currentColor"
      fillOpacity="0.15"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="9.8" r="2.4" fill="currentColor" />
  </>,
);

const TOOLS: { tool: MapTool; name: string; key: string; tip: string; icon: ReactNode }[] = [
  {
    tool: 'zone',
    name: 'Draw zone',
    key: 'Z',
    tip: 'Click the map at each corner of the area to analyse',
    icon: POLYGON_ICON,
  },
  {
    tool: 'poi',
    name: 'Place point of interest',
    key: 'P',
    tip: 'Click the map where people travel to, such as a hospital',
    icon: PIN_ICON,
  },
];

/** What the hint says with no tool in use: what can be dragged, if anything is on the map. */
function idleHint(hasZone: boolean, hasPins: boolean): string | null {
  if (hasZone && hasPins)
    return "Drag the zone's corners or a pin to move them. Click a pin to rename it.";
  if (hasZone)
    return "Drag the zone's corners to reshape it, or the middle of a side to add a corner.";
  if (hasPins) return 'Drag a pin to move it. Click a pin to rename it.';
  return null;
}

export function AnalysisToolbar() {
  const work = useStore((s) => s.analysis.work);
  const hasZone = useStore((s) => s.analysis.setup.zoneId !== null);
  const hasPins = usePlaces((s) => (s.pois?.length ?? 0) > 0);
  const error = usePlaces((s) => s.zoneError ?? s.poiError);
  const hint = toolHint(work) ?? error ?? idleHint(hasZone, hasPins);
  const drawing = work.tool === 'zone' && !work.closed;

  return (
    <div className="aa-tools">
      <div
        className="aa-toolbar panel"
        role="toolbar"
        aria-label="Map editor"
        aria-orientation="vertical"
      >
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            className={`aa-tool${work.tool === t.tool ? ' on' : ''}`}
            aria-pressed={work.tool === t.tool}
            aria-label={`${t.name} (${t.key})`}
            title={`${t.name} (${t.key}): ${t.tip}`}
            onClick={() => change((w) => pickTool(w, t.tool))}
          >
            {t.icon}
          </button>
        ))}
      </div>
      {hint && (
        <div className={`aa-hint${!work.tool && error ? ' error' : ''}`} role="status">
          <span>{hint}</span>
          {work.tool && (
            <span className="aa-hint-actions">
              {drawing && (
                <>
                  <button
                    className="button small-button"
                    disabled={work.corners.length === 0}
                    title="Take off the last corner (Backspace)"
                    onClick={() => change(undoCorner)}
                  >
                    Undo corner
                  </button>
                  <button
                    className="button small-button"
                    disabled={work.corners.length < 3}
                    title="Close the outline from the last corner back to the first (Enter)"
                    onClick={() => change(closeDrawing)}
                  >
                    Finish
                  </button>
                </>
              )}
              <button
                className="button small-button"
                title="Put the tool down (Escape)"
                onClick={() => change(() => NO_MAP_WORK)}
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
