// One sample point picked on the results map (FR-15; docs/architecture/access-analysis.md §5.2):
// for the point of interest on show, its public transport journey leg by leg with the lines used,
// both times, the access ratio, and a bar splitting the public transport time into walking,
// waiting and riding. The journey and the car path are drawn on the map from the same answer
// (map/use-analysis-point-layers.ts). Escape, the close button or a click away lets it go.
import type { AnalysisDetail } from '@gtfs-editor/core';
import { useEffect } from 'react';
import { useStore } from '../../app/store.ts';
import { clearPointDetail, isDetailFor, loadPointDetail, usePointDetail } from '../point-detail.ts';
import { modeLook } from '../point-journey.ts';
import { carPathText, carText, journeyText, legRows, splitParts } from './point-detail-text.ts';
import { ratioText } from './results-text.ts';
import './point-detail.css';

/** Lets go of the picked sample point. */
function letGo(): void {
  const { analysis, set } = useStore.getState();
  set({ analysis: { ...analysis, pointSeq: null } });
}

export function PointDetail({ analysis, seq }: { analysis: AnalysisDetail; seq: number }) {
  const poiSeq = useStore((s) => s.analysis.poiSeq);
  const modes = useStore((s) => s.modes);
  const shown = usePointDetail();
  const key = { id: analysis.id, poiSeq, seq };

  useEffect(() => {
    void loadPointDetail({ id: analysis.id, poiSeq, seq });
    return clearPointDetail;
  }, [analysis.id, poiSeq, seq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape in a box ('Lines at') belongs to the box.
      const inBox =
        e.target instanceof HTMLElement && ['INPUT', 'SELECT'].includes(e.target.tagName);
      if (e.key === 'Escape' && !inBox) letGo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const poi = analysis.pois.find((p) => p.seq === poiSeq);
  const detail = isDetailFor(shown, key) ? shown.detail : null;
  const look = (modeId: string) => modeLook(modes, modeId);

  return (
    <section className="analysis-section analysis-point" aria-label="Sample point">
      <div className="analysis-point-head">
        <h3 className="analysis-section-title">
          Sample point {seq}
          {poi && <span className="muted"> to {poi.name}</span>}
        </h3>
        <button className="icon-button" onClick={letGo} aria-label="Close" title="Close (Escape)">
          ✕
        </button>
      </div>
      {shown.error && <p className="error-text small">{shown.error}</p>}
      {!detail && !shown.error && <p className="muted small">Loading the sample point…</p>}
      {detail && (
        <>
          <table className="analysis-summary small">
            <tbody>
              <tr>
                <td>Public transport</td>
                <td>{journeyText(detail, analysis.settings.maxJourneyMins)}</td>
              </tr>
              <tr>
                <td>Car</td>
                <td>{carText(detail)}</td>
              </tr>
              <tr className="analysis-summary-total">
                <td>Access ratio</td>
                <td>{ratioText(detail.ratio)}</td>
              </tr>
            </tbody>
          </table>
          {detail.pt && detail.pt.ptSecs > 0 && <SplitBar parts={splitParts(detail.pt)} />}
          {detail.legs && detail.legs.length > 0 && (
            <ol className="analysis-legs small">
              {legRows(detail.legs, analysis.settings.departSecs, look).map((row, k) => (
                <li key={k} className={`analysis-leg analysis-leg-${row.kind}`}>
                  <i
                    className="analysis-leg-mark"
                    style={row.colour ? { background: row.colour } : undefined}
                  />
                  {row.text}
                </li>
              ))}
            </ol>
          )}
          {carPathText(detail) && <p className="muted small">{carPathText(detail)}</p>}
        </>
      )}
    </section>
  );
}

/** The walk/wait/ride bar, with its parts named under it. */
function SplitBar({ parts }: { parts: ReturnType<typeof splitParts> }) {
  return (
    <div className="analysis-split" aria-label="Walking, waiting and riding">
      <div className="analysis-split-bar">
        {parts.map((p) => (
          <span
            key={p.kind}
            className={`analysis-split-${p.kind}`}
            style={{ width: `${p.share * 100}%` }}
          />
        ))}
      </div>
      <div className="analysis-split-key small">
        {parts.map((p) => (
          <span key={p.kind}>
            <i className={`analysis-swatch analysis-split-${p.kind}`} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}
