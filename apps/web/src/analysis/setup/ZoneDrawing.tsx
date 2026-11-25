// Drawing a zone (FR-4, AC-FR-4.1, AC-FR-4.2): what to do next, Undo corner, Finish and Cancel
// while the corners are clicked; then, once the outline is closed, a box for its name. An outline
// that crosses itself is refused on closing, with the reason, and keeps its corners.
import { useStore } from '../../app/store.ts';
import { saveZone } from '../analysis-api.ts';
import {
  cancelMapWork,
  closeDrawing,
  pickZone,
  undoCorner,
  type AnalysisView,
} from '../analysis-state.ts';
import { NameForm } from './NameForm.tsx';

const change = (step: (view: AnalysisView) => AnalysisView): void => {
  const { analysis, set } = useStore.getState();
  set({ analysis: step(analysis) });
};

/** Saves the closed outline under its name, and picks the new zone for the analysis. */
async function save(name: string): Promise<void> {
  const ring = useStore.getState().analysis.drawing ?? [];
  const zone = await saveZone({ name, ring });
  change((view) => pickZone(cancelMapWork(view), zone.id));
}

export function ZoneDrawing() {
  const corners = useStore((s) => s.analysis.drawing) ?? [];
  const closed = useStore((s) => s.analysis.drawingClosed);
  const problem = useStore((s) => s.analysis.drawingProblem);

  if (closed) {
    return (
      <div className="analysis-drawing">
        <p className="small">The outline is closed with {corners.length} corners. Name the zone.</p>
        <NameForm label="Name of the zone" onSave={save} onCancel={() => change(cancelMapWork)} />
        <button
          className="button small-button"
          title="Open the outline again to change its corners"
          onClick={() => change(undoCorner)}
        >
          Keep drawing
        </button>
      </div>
    );
  }

  const count = corners.length;
  return (
    <div className="analysis-drawing">
      <p className="small">
        {count === 0
          ? 'Click the map to place the first corner of the zone.'
          : count < 3
            ? `${count} ${count === 1 ? 'corner' : 'corners'}. Click the map to add the next one.`
            : `${count} corners. Click the first corner, or press Finish, to close the outline.`}
      </p>
      {problem && <p className="error-text small">{problem}</p>}
      <div className="analysis-actions">
        <button
          className="button small-button"
          disabled={count === 0}
          title="Take off the last corner"
          onClick={() => change(undoCorner)}
        >
          Undo corner
        </button>
        <button
          className="button small-button"
          disabled={count < 3}
          title="Close the outline from the last corner back to the first"
          onClick={() => change(closeDrawing)}
        >
          Finish
        </button>
        <button
          className="button small-button"
          title="Stop drawing and forget the corners (Escape)"
          onClick={() => change(cancelMapWork)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
