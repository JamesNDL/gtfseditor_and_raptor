// What a vehicle can physically do, used wherever an edit makes or retimes a stretch, and by the
// clash rules that check a scenario afterwards. Assumptions, not sourced values: they are set a
// little above what each mode does in service, so that only the impossible is caught.

/** The fastest a vehicle of each mode runs between two stops, in km/h, measured in a straight line. */
export const MODE_MAX_KMH: Record<string, number> = {
  train: 165,
  metro: 110,
  light_rail: 80,
  ferry: 60,
  bus: 100,
  coach: 115,
  school_bus: 100,
};

/** How fast an empty vehicle gets from where one trip ends to where the next starts, in km/h in a straight line. */
export const DEAD_RUN_KMH: Record<string, number> = { rail: 70, ferry: 30, road: 50 };

/** How far apart a trip's end and the next trip's start can be and still count as the same place, in metres. */
export const SAME_PLACE_M: Record<string, number> = { rail: 800, ferry: 400, road: 600 };

export const maxSpeedMs = (modeId: string): number => (MODE_MAX_KMH[modeId] ?? 100) / 3.6;

/** The least time a vehicle of this mode needs to cover a distance, in whole seconds. */
export const minRunSecs = (modeId: string, metres: number): number => (metres > 0 ? Math.ceil(metres / maxSpeedMs(modeId)) : 0);
