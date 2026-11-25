// One sample point's journey as the map draws it (FR-15, D30; docs/architecture/access-analysis.md
// §5.2): the stored legs keep no path, so walks and rides are straight lines from end to end. A
// ride runs from where it boards to where it alights; walks join the sample point, the stops and
// the point of interest. The car path is the road router's, as the API gives it.
import type { GeoJsonPosition, PointDetail } from '@gtfs-editor/core';
import type { Mode } from '../shared/api-client.ts';

/** How a mode is named and coloured ('#rrggbb') in the detail and on the map. */
export interface ModeLook {
  name: string;
  colour: string;
}

/** Finds a mode's name and colour; one not known is shown by its id in grey. */
export function modeLook(modes: readonly Mode[], modeId: string): ModeLook {
  const mode = modes.find((m) => m.id === modeId);
  return mode ? { name: mode.name, colour: `#${mode.color}` } : { name: modeId, colour: '#888888' };
}

/** One line of the journey or the drive on the map. */
export interface JourneyPiece {
  kind: 'walk' | 'ride' | 'car';
  /** The ride's mode colour; null for walks and the drive, which have their own. */
  colour: string | null;
  /** The ride's line; null for walks and the drive. */
  label: string | null;
  line: GeoJsonPosition[];
}

const samePlace = (a: GeoJsonPosition, b: GeoJsonPosition): boolean =>
  a[0] === b[0] && a[1] === b[1];

const walk = (from: GeoJsonPosition, to: GeoJsonPosition): JourneyPiece => ({
  kind: 'walk',
  colour: null,
  label: null,
  line: [from, to],
});

/**
 * The pieces to draw for a picked sample point: its journey (none when it has no stored legs)
 * and its car path (none when it could not be fetched).
 */
export function journeyPieces(
  detail: PointDetail,
  poi: { lon: number; lat: number },
  look: (modeId: string) => ModeLook,
): JourneyPiece[] {
  const pieces: JourneyPiece[] = [];
  if (detail.legs !== null) {
    // Walks are drawn as what joins one ride's end to the next ride's start, as their own legs
    // carry no places; a change at the same stop draws nothing.
    let at: GeoJsonPosition = [detail.lon, detail.lat];
    for (const leg of detail.legs) {
      if (leg.type !== 'ride') continue;
      const board: GeoJsonPosition = [leg.board.lon, leg.board.lat];
      const alight: GeoJsonPosition = [leg.alight.lon, leg.alight.lat];
      if (!samePlace(at, board)) pieces.push(walk(at, board));
      pieces.push({
        kind: 'ride',
        colour: look(leg.mode).colour,
        label: leg.route,
        line: [board, alight],
      });
      at = alight;
    }
    const end: GeoJsonPosition = [poi.lon, poi.lat];
    if (!samePlace(at, end)) pieces.push(walk(at, end));
  }
  if (detail.carPath !== null && detail.carPath.length > 1) {
    pieces.push({ kind: 'car', colour: null, label: null, line: detail.carPath });
  }
  return pieces;
}
