// The dark and light versions of the interface. The stylesheet follows `data-theme` on the page;
// the map and the timeline charts draw their own colours, so they read the palettes here.
import { COLORS } from '../timeline/TimelineCanvas.tsx';

export type Theme = 'dark' | 'light';

const CHART: Record<Theme, typeof COLORS> = {
  dark: { ...COLORS },
  light: {
    text: '#1b2330',
    muted: '#5b6676',
    grid: '#e3e7ed',
    gridStrong: '#c9d0da',
    surface: '#ffffff',
    rowAlt: '#f5f7fa',
    warn: '#b87900',
    critical: '#c62828',
    highlight: '#111827',
    block: '#d5dce6',
  },
};

type Rgba = [number, number, number, number];

/** The colours the map draws with, chosen by the basemap's tone (map/basemaps.ts). */
export interface MapPalette {
  /** Fill behind small markers and the halo round labels. */
  ink: string;
  soft: string;
  /** Marker outlines and label text. */
  paper: string;
  panel: string;
  label: string;
  /** Network lines while something else is being edited. */
  faded: string;
  /** The edge drawn under a selected line. */
  casing: string;
  outline: Rgba;
  bright: Rgba;
}

export const MAP_PALETTE: Record<Theme, MapPalette> = {
  dark: {
    ink: '#0e1116',
    soft: '#b6c0cc',
    paper: '#f4f6f8',
    panel: '#1c2027',
    label: '#dfe5ec',
    faded: '#5b6675',
    casing: '#ffffff',
    outline: [8, 10, 14, 255],
    bright: [255, 255, 255, 255],
  },
  light: {
    ink: '#ffffff',
    soft: '#5b6676',
    paper: '#1b2330',
    panel: '#eef1f5',
    label: '#1b2330',
    faded: '#9aa3ae',
    casing: '#111827',
    outline: [255, 255, 255, 255],
    bright: [17, 24, 39, 255],
  },
};

/** Switches the stylesheet and the chart colours. The map and charts are rebuilt by the caller. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  Object.assign(COLORS, CHART[theme]);
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Private windows may refuse; the choice then lasts until the page is closed.
  }
}
