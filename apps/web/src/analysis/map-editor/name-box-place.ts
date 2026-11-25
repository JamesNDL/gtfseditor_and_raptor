// Where the name box sits on the map, in pixels from the map's top-left corner: centred just above
// the place it names, kept inside the map's edges, and below the place when there is no room.

/** Pixels between the place and the box's nearest edge (room for the pin). */
export const NAME_BOX_GAP = 18;
/** Pixels kept clear between the box and the map's edges. */
export const NAME_BOX_MARGIN = 8;

interface Size {
  width: number;
  height: number;
}

/** The box's top-left corner for a place at `point` on a map of `view`, and whether it is below. */
export function nameBoxPlace(
  point: { x: number; y: number },
  box: Size,
  view: Size,
): { left: number; top: number; below: boolean } {
  const clamp = (value: number, low: number, high: number): number =>
    Math.max(low, Math.min(high, value));
  const left = clamp(
    point.x - box.width / 2,
    NAME_BOX_MARGIN,
    view.width - box.width - NAME_BOX_MARGIN,
  );
  const above = point.y - NAME_BOX_GAP - box.height;
  const below = above < NAME_BOX_MARGIN;
  const top = clamp(
    below ? point.y + NAME_BOX_GAP : above,
    NAME_BOX_MARGIN,
    view.height - box.height - NAME_BOX_MARGIN,
  );
  return { left, top, below };
}
