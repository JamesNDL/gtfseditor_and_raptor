// The picked sample point's detail (FR-15; docs/architecture/access-analysis.md §5.1): its times,
// split, stored legs and car path, from GET /api/analyses/:id/points/:seq. Kept in a store of its
// own so that the detail in the pane (results/PointDetail.tsx) and the journey on the map
// (map/use-analysis-point-layers.ts) read the same answer.
import type { PointDetail } from '@gtfs-editor/core';
import { create } from 'zustand';
import { getJson } from '../shared/api-client.ts';

/** Which pair is asked for: the analysis, its point of interest, and the sample point. */
export interface PointKey {
  id: number;
  poiSeq: number;
  seq: number;
}

interface PointDetailState {
  /** The pair last asked for, or null when none is picked. */
  key: PointKey | null;
  /** Its detail, or null while it loads. */
  detail: PointDetail | null;
  /** Why the fetch failed, or null. */
  error: string | null;
}

const NONE: PointDetailState = { key: null, detail: null, error: null };

/** The picked sample point's detail, as last fetched. */
export const usePointDetail = create<PointDetailState>(() => NONE);

/** Counts the fetches, so that an answer overtaken by a later pick is dropped. */
let latest = 0;

/** True when the detail shown is the one for this pair. */
export const isDetailFor = (shown: PointDetailState, key: PointKey | null): boolean =>
  key !== null &&
  shown.detail !== null &&
  shown.key !== null &&
  shown.key.id === key.id &&
  shown.key.poiSeq === key.poiSeq &&
  shown.key.seq === key.seq;

/** Fetches one pair's detail, forgetting the one shown before. */
export async function loadPointDetail(key: PointKey): Promise<void> {
  const ticket = ++latest;
  usePointDetail.setState({ key, detail: null, error: null });
  try {
    const detail = await getJson<PointDetail>(
      `/api/analyses/${key.id}/points/${key.seq}?poi=${key.poiSeq}`,
    );
    if (ticket === latest) usePointDetail.setState({ detail });
  } catch (e) {
    if (ticket === latest) {
      usePointDetail.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Forgets the detail, as when the sample point is let go. */
export function clearPointDetail(): void {
  latest++;
  usePointDetail.setState(NONE);
}
