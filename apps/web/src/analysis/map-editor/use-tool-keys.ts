// The map editor's keys, while the Access pane's setup is showing: Z picks Draw zone and P picks
// Place point of interest; while drawing, Backspace takes off the last corner and Enter finishes;
// Escape puts the tool down. Keys typed into a box (the name box, the settings) are left alone.
import { useEffect } from 'react';
import { useStore } from '../../app/store.ts';
import type { AnalysisView } from '../analysis-state.ts';
import { NO_MAP_WORK, closeDrawing, pickTool, undoCorner, type MapWork } from '../map-work.ts';

const change = (step: (work: MapWork) => MapWork): void => {
  const { analysis, set } = useStore.getState();
  const work = step(analysis.work);
  if (work !== analysis.work) set({ analysis: { ...analysis, work } satisfies AnalysisView });
};

/** Whether the key was typed into a box, where it belongs to the box. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function useToolKeys(shown: boolean): void {
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const { work } = useStore.getState().analysis;
      const key = e.key.toLowerCase();
      if (key === 'escape') change(() => NO_MAP_WORK);
      else if (key === 'z') change((w) => pickTool(w, 'zone'));
      else if (key === 'p') change((w) => pickTool(w, 'poi'));
      else if (work.tool === 'zone' && key === 'backspace') {
        e.preventDefault();
        change(undoCorner);
      } else if (work.tool === 'zone' && key === 'enter') change(closeDrawing);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown]);
}
