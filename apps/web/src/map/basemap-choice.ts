// The basemap the user chose, remembered in the browser, and the map colours that go with the
// basemap on show. Kept out of the app store: only the map, its layers and the shell read it.
import { create } from 'zustand';
import { useStore } from '../app/store.ts';
import { MAP_PALETTE, type MapPalette } from '../app/theme.ts';
import { basemapTone, parseBasemap, shownBasemap, type Basemap } from './basemaps.ts';

const KEY = 'basemap';

function remembered(): Basemap | null {
  try {
    return parseBasemap(localStorage.getItem(KEY));
  } catch {
    // Private windows may refuse; the map then follows the theme.
    return null;
  }
}

/** The basemap chosen, or null to follow the theme. */
export const useBasemapChoice = create<{ choice: Basemap | null }>(() => ({
  choice: remembered(),
}));

/** Chooses a basemap and remembers it. */
export function chooseBasemap(choice: Basemap): void {
  useBasemapChoice.setState({ choice });
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Not remembered; the choice lasts until the page is closed.
  }
}

/** The basemap on show. */
export function useShownBasemap(): Basemap {
  const choice = useBasemapChoice((s) => s.choice);
  const theme = useStore((s) => s.theme);
  return shownBasemap(choice, theme);
}

/** The colours to draw with over the basemap on show. */
export const useMapPalette = (): MapPalette => MAP_PALETTE[basemapTone(useShownBasemap())];
