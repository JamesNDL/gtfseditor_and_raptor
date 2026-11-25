// The Access pane's calls to the editor's API (docs/architecture/access-analysis.md §4.4, §5.2),
// and the list of the day's analyses, kept here rather than in the app store so that the store
// gains only its one `analysis` field (D29). The rail reads it for its "running" badge.
import type { AnalysisListItem } from '@gtfs-editor/core';
import { create } from 'zustand';
import { useStore } from '../app/store.ts';
import { getJson } from '../shared/api-client.ts';
import { isAnalysisActive } from './analysis-state.ts';

interface AnalysisList {
  /** The day the list is for, or null before it is first fetched. */
  baselineId: number | null;
  items: AnalysisListItem[];
}

/** The day's analyses, newest first, as last fetched. */
export const useAnalysisList = create<AnalysisList>(() => ({ baselineId: null, items: [] }));

/** True while any of the day's analyses is waiting or running. */
export const useAnalysisRunning = (): boolean =>
  useAnalysisList((list) => list.items.some(isAnalysisActive));

/** Fetches the chosen day's analyses into the list, and answers them. */
export async function refreshAnalyses(): Promise<AnalysisListItem[]> {
  const { baselineId } = useStore.getState();
  if (baselineId === null) return [];
  const items = await getJson<AnalysisListItem[]>(`/api/analyses?baseline=${baselineId}`);
  // A day chosen while this was on its way has its own list coming.
  if (useStore.getState().baselineId === baselineId)
    useAnalysisList.setState({ baselineId, items });
  return items;
}

/** Deletes an analysis and its results; one still running is cancelled first by the API. */
export async function deleteAnalysis(id: number): Promise<void> {
  const res = await fetch(`/api/analyses/${id}`, { method: 'DELETE' });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message ?? `The analysis could not be deleted (${res.status})`);
}
