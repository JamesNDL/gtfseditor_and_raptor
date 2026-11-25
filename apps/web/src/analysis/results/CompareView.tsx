// 'Compare with…' on the results screen, and the comparison itself (FR-17, AC-FR-17.1, D31;
// docs/architecture/access-analysis.md §5.2, §5.3): pick another analysis of the same zone and
// spacing, then see how many sample points got better or worse for the point of interest on show,
// with the key on the map. The map draws the compared points (map/use-analysis-compare-layers.ts).
import type { AnalysisDetail } from '@gtfs-editor/core';
import { useEffect } from 'react';
import { useStore } from '../../app/store.ts';
import { useAnalysisList } from '../analysis-api.ts';
import {
  clearComparison,
  comparableAnalyses,
  loadComparison,
  savedPoiId,
  startComparing,
  stopComparing,
  useComparison,
} from '../analysis-compare.ts';
import { timetableTimeText } from '../analysis-state.ts';
import { compareRows, compareTotal, timeModeNote, type CompareRow } from './compare-text.ts';
import './compare-export.css';

/** Compares with the analysis picked, or stops comparing when none is. */
function pick(value: string): void {
  const { analysis, set } = useStore.getState();
  set({
    analysis: value === '' ? stopComparing(analysis) : startComparing(analysis, Number(value)),
  });
}

export function CompareView({ detail, poiSeq }: { detail: AnalysisDetail; poiSeq: number }) {
  const compareWith = useStore((s) => s.analysis.compareWith);
  const items = useAnalysisList((list) => list.items);
  const { result, error } = useComparison();
  const others = comparableAnalyses(items, detail.id);
  const poiId = savedPoiId(detail, poiSeq);
  const other = items.find((item) => item.id === compareWith);
  // AC-FR-21.3: an arrive-by and a depart-at analysis may be compared, but not as if alike.
  const own = items.find((item) => item.id === detail.id);
  const note = own && other ? timeModeNote(own, other) : null;

  useEffect(() => {
    if (compareWith === null) return;
    if (poiId !== null) void loadComparison(detail.id, compareWith, poiId);
    return clearComparison;
  }, [detail.id, compareWith, poiId]);

  return (
    <section className="analysis-section" aria-label="Compare with">
      <h3 className="analysis-section-title">Compare with…</h3>
      {others.length === 0 ? (
        <p className="muted small">No other analysis of this zone and spacing yet</p>
      ) : (
        <div className="analysis-compare-pick">
          <select
            className="day-select"
            aria-label="Compare with"
            title="Another analysis of the same zone and spacing, such as the published day or a scenario"
            value={compareWith ?? ''}
            onChange={(e) => pick(e.target.value)}
          >
            <option value="">Choose an analysis…</option>
            {others.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {timetableTimeText(item)}
              </option>
            ))}
          </select>
          {compareWith !== null && (
            <button
              className="button small-button"
              title="Back to this analysis's own results"
              onClick={() => pick('')}
            >
              Stop comparing
            </button>
          )}
        </div>
      )}
      {compareWith !== null &&
        (poiId === null ? (
          <p className="muted small">
            This point of interest has been deleted since the analysis was made, so it cannot be
            compared.
          </p>
        ) : error ? (
          <p className="error-text small">{error}</p>
        ) : result ? (
          <>
            <p className="muted small">
              How {other?.name ?? 'the other analysis'} differs from {detail.name}. A lower access
              ratio is better.
            </p>
            {note && <p className="analysis-compare-note small">{note}</p>}
            <CompareCounts rows={compareRows(result.counts)} total={compareTotal(result.counts)} />
          </>
        ) : (
          <p className="muted small">Comparing…</p>
        ))}
    </section>
  );
}

/** A row's swatch: a fill (or gradient), or a ring with no fill, as on the map. */
function Swatch({ row }: { row: CompareRow }) {
  return row.background === null || row.ring !== null ? (
    <i
      className="analysis-dot"
      style={{ background: row.background ?? 'transparent', borderColor: row.ring ?? undefined }}
    />
  ) : (
    <i className="analysis-swatch" style={{ background: row.background }} />
  );
}

/** The counts of each kind of change, which are also the key to the map's colours. */
function CompareCounts({ rows, total }: { rows: CompareRow[]; total: number }) {
  return (
    <table className="analysis-summary small" aria-label="Compared sample points">
      <tbody>
        {rows.map((row) => (
          <tr key={row.kind} title={row.title}>
            <td>
              <Swatch row={row} />
              {row.label}
            </td>
            <td>{row.count.toLocaleString('en-AU')}</td>
          </tr>
        ))}
        <tr className="analysis-summary-total">
          <td>All sample points</td>
          <td>{total.toLocaleString('en-AU')}</td>
        </tr>
      </tbody>
    </table>
  );
}
