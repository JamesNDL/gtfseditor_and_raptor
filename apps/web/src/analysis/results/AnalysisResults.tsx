// The results screen of the Access pane (FR-14, FR-20; docs/architecture/access-analysis.md §5.2):
// the points of interest to switch between, 'Lines at' to change the breaks, the summary table
// for the point of interest on show, the sample point picked on the map (PointDetail.tsx), the
// legend on the map, 'Compare with…' (CompareView.tsx) and the downloads (FR-18). While comparing,
// the comparison takes the place of the lines, summary and legend. The map's layers draw from the
// same results (map/use-analysis-result-layers.ts, use-analysis-compare-layers.ts).
import type { PoiSummary } from '@gtfs-editor/core';
import { useEffect, useState, type FormEvent } from 'react';
import { useStore } from '../../app/store.ts';
import {
  clearResults,
  loadAnalysis,
  loadPoiResults,
  useAnalysisResults,
} from '../analysis-results.ts';
import { AnalysisLegend } from './AnalysisLegend.tsx';
import { CompareView } from './CompareView.tsx';
import { PointDetail } from './PointDetail.tsx';
import {
  breaksText,
  downloadLinks,
  ratioText,
  readBreaks,
  summaryBreaks,
  summaryRows,
} from './results-text.ts';

/** Changes what the results screen shows; a sample point picked before is let go. */
function show(change: { poiSeq?: number; breaks?: number[] }): void {
  const { analysis, set } = useStore.getState();
  set({ analysis: { ...analysis, ...change, pointSeq: null } });
}

export function AnalysisResults() {
  const openId = useStore((s) => s.analysis.openId);
  const poiSeq = useStore((s) => s.analysis.poiSeq);
  const asked = useStore((s) => s.analysis.breaks);
  const pointSeq = useStore((s) => s.analysis.pointSeq);
  const comparing = useStore((s) => s.analysis.screen === 'compare');
  const { detail, lines, error } = useAnalysisResults();

  useEffect(() => {
    if (openId === null) return;
    void loadAnalysis(openId);
    return clearResults;
  }, [openId]);
  useEffect(() => {
    if (openId !== null) void loadPoiResults(openId, poiSeq, asked);
  }, [openId, poiSeq, asked]);

  if (!detail) {
    return (
      <div className="analysis-body">
        {error ? (
          <p className="error-text small">{error}</p>
        ) : (
          <p className="muted small">Loading the results…</p>
        )}
      </div>
    );
  }
  const breaks = asked ?? detail.settings.breaks;
  const poi = detail.pois.find((p) => p.seq === poiSeq) ?? detail.pois[0];
  // The breaks of the lines on show, which lag the ones asked for until the redraw arrives.
  const drawn = lines ? summaryBreaks(lines.summary) : breaks;

  return (
    <div className="analysis-body">
      <div>
        <h2 className="analysis-title ellipsis" title={detail.name}>
          {detail.name}
        </h2>
        <div className="muted small ellipsis">
          {detail.scenarioName ?? 'Published day'} · {detail.zone.name}
        </div>
      </div>
      {error && <p className="error-text small">{error}</p>}
      {pointSeq !== null && !comparing && <PointDetail analysis={detail} seq={pointSeq} />}

      <section className="analysis-section" aria-label="Point of interest">
        <h3 className="analysis-section-title">Point of interest</h3>
        {detail.pois.map((p) => (
          <label key={p.seq} className="check small">
            <input
              type="radio"
              name="analysis-poi"
              checked={p.seq === poi?.seq}
              onChange={() => show({ poiSeq: p.seq })}
            />
            <span className="ellipsis">{p.name}</span>
          </label>
        ))}
      </section>

      {!comparing && (
        <LinesAt
          key={`${detail.id}|${breaksText(breaks)}`}
          breaks={breaks}
          check={(text) => readBreaks(text, detail.settings)}
        />
      )}

      {lines && !comparing && (
        <section className="analysis-section" aria-label="Summary">
          <h3 className="analysis-section-title">Summary</h3>
          <SummaryTable summary={lines.summary} breaks={drawn} />
        </section>
      )}

      {poi && <CompareView detail={detail} poiSeq={poi.seq} />}

      {poi && (
        <section className="analysis-section" aria-label="Downloads">
          <h3 className="analysis-section-title">Downloads</h3>
          <ul className="analysis-downloads small">
            {downloadLinks(detail.id, poi.seq, drawn).map((link) => (
              <li key={link.label}>
                <a href={link.href} download title={link.title}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {lines && poi && !comparing && (
        <AnalysisLegend detail={detail} poiName={poi.name} breaks={drawn} />
      )}
    </div>
  );
}

/** 'Lines at': the ratios the lines are drawn at, checked as the API checks them. */
function LinesAt({
  breaks,
  check,
}: {
  breaks: readonly number[];
  check: (text: string) => { breaks: number[] } | { problem: string };
}) {
  const [text, setText] = useState(breaksText(breaks));
  const [problem, setProblem] = useState<string | null>(null);
  const redraw = (e: FormEvent) => {
    e.preventDefault();
    const read = check(text);
    if ('problem' in read) setProblem(read.problem);
    else show({ breaks: read.breaks });
  };
  return (
    <form className="analysis-section" aria-label="Lines at" onSubmit={redraw}>
      <h3 className="analysis-section-title">Lines at</h3>
      <div className="analysis-lines-at">
        <input
          className="day-select"
          aria-label="Lines at"
          value={text}
          title="The access ratios to draw lines at: rising, each 0.1 to 20, up to 8, with commas"
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
        />
        <button className="button small-button" type="submit">
          Redraw
        </button>
      </div>
      {problem && <p className="error-text small">{problem}</p>}
    </form>
  );
}

/** The summary for the point of interest on show (FR-20): counts per band, and the median. */
function SummaryTable({ summary, breaks }: { summary: PoiSummary; breaks: readonly number[] }) {
  const { rows, total } = summaryRows(summary, breaks);
  return (
    <table className="analysis-summary small">
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td>
              <i className="analysis-swatch" style={{ background: row.colour }} />
              {row.label}
            </td>
            <td>{row.count.toLocaleString('en-AU')}</td>
          </tr>
        ))}
        <tr className="analysis-summary-total">
          <td>All sample points</td>
          <td>{total.toLocaleString('en-AU')}</td>
        </tr>
        <tr>
          <td>Median access ratio</td>
          <td>{ratioText(summary.median)}</td>
        </tr>
      </tbody>
    </table>
  );
}
