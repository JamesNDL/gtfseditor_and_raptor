// The Access pane, in the left column: the day's access analyses with where each stands, Open and
// Delete, and "New analysis". The setup and results screens come in later tickets (AA-19, AA-20).
// See docs/architecture/access-analysis.md §5.2.
import type { AnalysisListItem } from '@gtfs-editor/core';
import { useEffect, useState } from 'react';
import { useStore } from '../app/store.ts';
import {
  deleteAnalysis,
  refreshAnalyses,
  useAnalysisList,
  useAnalysisRunning,
} from './analysis-api.ts';
import {
  backToList,
  forgetMissing,
  isAnalysisActive,
  newAnalysis,
  openAnalysis,
  progressShare,
  stateText,
  timetableText,
} from './analysis-state.ts';
import './analysis.css';

/** How often the list is fetched again while an analysis is waiting or running. */
const REFRESH_MS = 2000;

/** Fetches the list, and lets go of an open analysis that is no longer in it. */
async function refresh(): Promise<void> {
  const items = await refreshAnalyses();
  const { analysis, set } = useStore.getState();
  const next = forgetMissing(
    analysis,
    items.map((item) => item.id),
  );
  if (next !== analysis) set({ analysis: next });
}

export function AnalysisPanel() {
  const baselineId = useStore((s) => s.baselineId);
  const screen = useStore((s) => s.analysis.screen);
  const list = useAnalysisList();
  const running = useAnalysisRunning();
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    refresh().then(
      () => setError(null),
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    if (baselineId !== null) void reload();
  }, [baselineId]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [running]);

  if (baselineId === null) return null;
  const items = list.baselineId === baselineId ? list.items : null;

  return (
    <div className="panel analysis-panel">
      {screen === 'list' ? (
        <>
          <div className="analysis-head">
            <h2 className="analysis-title">Access analysis</h2>
            <button
              className="button small-button"
              title="Choose a zone, points of interest and a timetable, and run an analysis"
              onClick={() => {
                const { analysis, scenarioId, set } = useStore.getState();
                set({ analysis: newAnalysis(analysis, scenarioId) });
              }}
            >
              New analysis
            </button>
          </div>
          <div className="analysis-body">
            {error && <p className="error-text small">{error}</p>}
            {items === null ? (
              <p className="muted small">Loading the analyses…</p>
            ) : items.length === 0 ? (
              <p className="muted small">
                No analyses for this day yet. Press "New analysis" to compare public transport with
                driving.
              </p>
            ) : (
              <ul className="analysis-list">
                {items.map((item) => (
                  <AnalysisRow key={item.id} item={item} onChange={reload} onError={setError} />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="analysis-head">
          <button
            className="button small-button"
            title="Back to the day's analyses"
            onClick={() => {
              const { analysis, set } = useStore.getState();
              set({ analysis: backToList(analysis) });
            }}
          >
            Back to the list
          </button>
        </div>
      )}
    </div>
  );
}

/** One analysis in the list: its name, timetable and state, a progress bar, Open and Delete. */
function AnalysisRow({
  item,
  onChange,
  onError,
}: {
  item: AnalysisListItem;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const share = progressShare(item);
  const percent = share === null ? 0 : Math.round(share * 100);

  return (
    <li className="analysis-item">
      <div className="analysis-item-text">
        <div className="ellipsis" title={item.name}>
          {item.name}
        </div>
        <div className="muted small ellipsis">{timetableText(item)}</div>
        <div className={`small ${item.state === 'failed' ? 'error-text' : 'muted'}`}>
          {stateText(item)}
        </div>
        {share !== null && (
          <div
            className="analysis-progress"
            role="progressbar"
            aria-label={`${item.name}: ${percent}% done`}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div className="analysis-item-actions">
        {!deleting ? (
          <>
            {item.state === 'done' && (
              <button
                className="button small-button"
                title="Show this analysis's results on the map"
                onClick={() => {
                  const { analysis, set } = useStore.getState();
                  set({ analysis: openAnalysis(analysis, item.id) });
                }}
              >
                Open
              </button>
            )}
            <button
              className="button small-button"
              title="Delete this analysis and its results"
              onClick={() => setDeleting(true)}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              className="button small-button danger"
              title={
                isAnalysisActive(item)
                  ? 'It is stopped, and nothing of it is kept'
                  : 'Its results are deleted'
              }
              onClick={() =>
                deleteAnalysis(item.id).then(onChange, (e: Error) => {
                  setDeleting(false);
                  onError(e.message);
                })
              }
            >
              Delete for good
            </button>
            <button className="button small-button" onClick={() => setDeleting(false)}>
              Keep
            </button>
          </>
        )}
      </div>
    </li>
  );
}
