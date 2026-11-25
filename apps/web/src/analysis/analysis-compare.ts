// Comparing the open analysis with another (FR-17, D31; docs/architecture/access-analysis.md
// §5.3): the analyses 'Compare with…' offers, starting and stopping the comparison, and the
// comparison itself for the point of interest on show. The open analysis is the first (a) and the
// other the second (b), so a change is the other's ratio less the open one's. Kept here, beside
// the results, so that the compare screen and the map's layers
// (map/use-analysis-compare-layers.ts) read the same answer.
import type { AnalysisDetail, AnalysisListEntry, CompareResult } from '@gtfs-editor/core';
import { create } from 'zustand';
import type { AnalysisView } from './analysis-state.ts';

/**
 * The listed analyses the open one can be compared with (D31: both finished, the same zone
 * outline and spacing, a point of interest in common), in the list's order.
 */
export function comparableAnalyses(
  items: readonly AnalysisListEntry[],
  openId: number,
): AnalysisListEntry[] {
  const open = items.find((item) => item.id === openId);
  if (!open) return [];
  return items.filter((item) => item.id !== openId && open.comparableWith.includes(item.id));
}

/** Compares the open analysis with another; the sample point picked is let go. */
export const startComparing = (view: AnalysisView, otherId: number): AnalysisView => ({
  ...view,
  screen: 'compare',
  compareWith: otherId,
  pointSeq: null,
});

/** Goes back to the open analysis's own results. */
export const stopComparing = (view: AnalysisView): AnalysisView => ({
  ...view,
  screen: 'results',
  compareWith: null,
});

/**
 * The saved point of interest an analysis's point of interest came from, which the comparison is
 * asked for; null when it has been deleted since, or the analysis has no such point of interest.
 */
export const savedPoiId = (detail: Pick<AnalysisDetail, 'pois'>, poiSeq: number): number | null =>
  detail.pois.find((poi) => poi.seq === poiSeq)?.poiId ?? null;

/** The compare request: b's ratios less a's, for the saved point of interest (§5.3). */
export const compareUrl = (a: number, b: number, poiId: number): string =>
  `/api/analyses/compare?a=${a}&b=${b}&poi=${poiId}`;

interface Comparison {
  /** The request the result answers, or null before one arrives. */
  url: string | null;
  result: CompareResult | null;
  /** Why the comparison could not be made (the API's reason), or null. */
  error: string | null;
}

const EMPTY: Comparison = { url: null, result: null, error: null };

/** The comparison on show, as last fetched. */
export const useComparison = create<Comparison>(() => EMPTY);

/** Counts the fetches, so that an answer overtaken by a later choice is dropped. */
let latest = 0;

/** Forgets the comparison, as when comparing stops. */
export function clearComparison(): void {
  latest++;
  useComparison.setState(EMPTY);
}

/** Fetches the comparison of b with a for a saved point of interest; what was shown stays until then. */
export async function loadComparison(a: number, b: number, poiId: number): Promise<void> {
  const ticket = ++latest;
  const url = compareUrl(a, b, poiId);
  try {
    const res = await fetch(url);
    const reply = (await res.json().catch(() => ({}))) as CompareResult & { message?: string };
    // A 409 says why the two cannot be compared (D31); show its words.
    if (!res.ok) throw new Error(reply.message ?? `The comparison failed (${res.status})`);
    const result: CompareResult = { points: reply.points, counts: reply.counts };
    if (ticket === latest) useComparison.setState({ url, result, error: null });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (ticket === latest) useComparison.setState({ url, result: null, error });
  }
}
