// The left edge of the screen: a narrow rail of buttons, and beside it the one panel that is open.
// The two tools that change the network are always on the rail; the timetable, the simulation and
// the layers each fold out when their button is pressed and away when it is pressed again, so that
// the map is not buried under panels nobody is using.
import type React from 'react';
import { useEffect } from 'react';
import { startClosing } from '../builder.ts';
import { ModePanel } from '../ModePanel.tsx';
import { ScenarioPanel } from '../ScenarioPanel.tsx';
import { SimPanel } from '../sim/SimPanel.tsx';
import { isActive } from '../sim/simApi.ts';
import { useStore, type LeftPane } from './store.ts';

const icon = (path: React.ReactNode) => (
  <svg
    viewBox="0 0 20 20"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

const PANES: { id: LeftPane; label: string; title: string; icon: React.ReactNode }[] = [
  {
    id: 'scenario',
    label: 'Timetable',
    title: 'The timetable open: scenarios, what has changed, clashes, undo and export',
    icon: icon(<path d="M4 5h12M4 10h12M4 15h8" />),
  },
  {
    id: 'sim',
    label: 'Simulate',
    title: 'Send journeys through the timetable and see where the passengers go',
    icon: icon(
      <>
        <circle cx="7" cy="6.5" r="2.5" />
        <path d="M2.5 16c0-2.8 2-4.5 4.5-4.5s4.5 1.7 4.5 4.5M13 4.5a2.5 2.5 0 0 1 0 5M14.5 11.8c1.8.5 3 2 3 4.2" />
      </>,
    ),
  },
  {
    id: 'modes',
    label: 'Layers',
    title: 'Show or hide trains, buses and the other modes',
    icon: icon(<path d="M10 3l7 4-7 4-7-4 7-4zM3 11l7 4 7-4M3 14.5l7 4 7-4" />),
  },
];

export function LeftRail() {
  const baselineId = useStore((s) => s.baselineId);
  const pane = useStore((s) => s.leftPane);
  const drawing = useStore((s) => s.builder !== null && !s.builder.reshape);
  const closing = useStore((s) => s.closing);
  const info = useStore((s) => s.scenarioInfo);
  const editError = useStore((s) => s.editError);
  const simGoing = useStore((s) => s.simRuns.some(isActive));
  const set = useStore((s) => s.set);

  const show = (next: LeftPane | null) => {
    set({ leftPane: next });
    try {
      localStorage.setItem('leftPane', next ?? '');
    } catch {
      // Remembering it is a convenience only.
    }
  };
  // An edit that failed says why in the timetable panel, so that panel must be in sight.
  useEffect(() => {
    if (editError) set({ leftPane: 'scenario' });
  }, [editError]);

  if (baselineId === null) return null;
  const clashes = info?.conflicts.length ?? 0;
  const changes = info ? info.edits.filter((e) => e.applied).length : 0;

  return (
    <>
      <nav className="panel rail" aria-label="Tools">
        <div className="map-tools" role="toolbar" aria-label="Change the network">
          <button
            className={`rail-button draw-button${drawing ? ' on' : ''}`}
            aria-pressed={drawing}
            title="Draw a new line: create one by clicking stops on the map"
            onClick={() =>
              drawing
                ? set({ builder: null, builderPath: null, placing: null })
                : set({
                    builder: {
                      name: '',
                      modeId: 'bus',
                      color: 'FF4FA3',
                      headwayMin: 15,
                      followRoads: true,
                      loop: false,
                      stops: [],
                    },
                    builderPath: null,
                    closing: null,
                    closingPreview: null,
                  })
            }
          >
            <span className="rail-icon">{icon(<path d="M10 4v12M4 10h12" />)}</span>
            Draw a line
          </button>
          <button
            className={`rail-button close-button${closing ? ' on' : ''}`}
            aria-pressed={closing !== null}
            title="Close a road or a line: draw a line on the map and every service that crosses it is cut there. Buses go round; trains, trams and ferries stop either side."
            onClick={() =>
              closing ? set({ closing: null, closingPreview: null }) : startClosing()
            }
          >
            <span className="rail-icon" aria-hidden="true">
              ✂
            </span>
            Close a road
          </button>
        </div>
        <div className="rail-rule" />
        {PANES.map((p) => (
          <button
            key={p.id}
            className={`rail-button${pane === p.id ? ' on' : ''}`}
            aria-expanded={pane === p.id}
            title={`${p.title}${pane === p.id ? ' (click to fold away)' : ''}`}
            onClick={() => show(pane === p.id ? null : p.id)}
          >
            <span className="rail-icon">{p.icon}</span>
            {p.label}
            {p.id === 'scenario' && clashes > 0 && (
              <span
                className="rail-badge warn"
                title={`${clashes} clash${clashes === 1 ? '' : 'es'} to fix`}
              >
                {clashes > 99 ? '99+' : clashes}
              </span>
            )}
            {p.id === 'scenario' && clashes === 0 && changes > 0 && (
              <span
                className="rail-badge"
                title={`${changes} change${changes === 1 ? '' : 's'} in this scenario`}
              >
                {changes > 99 ? '99+' : changes}
              </span>
            )}
            {p.id === 'sim' && simGoing && (
              <span className="rail-badge going" title="A simulation is running" />
            )}
          </button>
        ))}
        {pane !== null && (
          <button
            className="rail-button rail-fold"
            title="Fold the panel away"
            aria-label="Fold the panel away"
            onClick={() => show(null)}
          >
            <span className="rail-icon">{icon(<path d="M12 5l-5 5 5 5" />)}</span>
          </button>
        )}
      </nav>

      {closing && (
        <span className="map-tools-hint rail-hint">
          {closing.line.length === 0
            ? 'Click the map on one side of what is closed, then on the other.'
            : closing.line.length === 1
              ? 'Now click on the other side.'
              : 'Everything the red line crosses is cut. Click again to carry the line on.'}
        </span>
      )}

      {/* Each panel stays mounted while folded away, so that it keeps what it was doing. */}
      <div className="left-column">
        <div className="left-pane" hidden={pane !== 'scenario'}>
          <ScenarioPanel />
        </div>
        <div className="left-pane" hidden={pane !== 'sim'}>
          <SimPanel />
        </div>
        <div className="left-pane" hidden={pane !== 'modes'}>
          <ModePanel />
        </div>
      </div>
    </>
  );
}
