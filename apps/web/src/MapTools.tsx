import { startClosing } from './builder.ts';
import { useStore } from './store.ts';

/** The two tools that change the network, always in sight on the map: draw a new line, and close a road or a line. */
export function MapTools() {
  const baselineId = useStore((s) => s.baselineId);
  const drawing = useStore((s) => s.builder !== null && !s.builder.reshape);
  const closing = useStore((s) => s.closing);
  const set = useStore((s) => s.set);
  if (baselineId === null) return null;

  return (
    <div className="map-tools" role="toolbar" aria-label="Change the network">
      <button
        className={`map-tool draw-button${drawing ? ' on' : ''}`}
        aria-pressed={drawing}
        title="Create a new line by clicking stops on the map"
        onClick={() =>
          drawing
            ? set({ builder: null, builderPath: null, placing: null })
            : set({ builder: { name: '', modeId: 'bus', color: 'FF4FA3', headwayMin: 15, followRoads: true, loop: false, stops: [] }, builderPath: null, closing: null, closingPreview: null })
        }
      >
        <span className="map-tool-icon" aria-hidden="true">
          ＋
        </span>
        Draw a new line
      </button>
      <button
        className={`map-tool close-button${closing ? ' on' : ''}`}
        aria-pressed={closing !== null}
        title="Draw a line on the map: every service that crosses it is cut there, whatever it is. Buses go round; trains, trams and ferries stop either side."
        onClick={() => (closing ? set({ closing: null, closingPreview: null }) : startClosing())}
      >
        <span className="map-tool-icon" aria-hidden="true">
          ✂
        </span>
        Close a road or a line
      </button>
      {closing && (
        <span className="map-tools-hint">
          {closing.line.length === 0
            ? 'Click the map on one side of what is closed, then on the other.'
            : closing.line.length === 1
              ? 'Now click on the other side.'
              : 'Everything the red line crosses is cut. Click again to carry the line on.'}
        </span>
      )}
    </div>
  );
}
