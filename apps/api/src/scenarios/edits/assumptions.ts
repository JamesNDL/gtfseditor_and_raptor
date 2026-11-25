// Figures the edit kinds assume where the timetable has nothing to learn from.

// Seconds saved by not stopping, on top of the dwell itself, when the timetable has no non-stop
// example to learn from. Assumptions, not sourced values.
export const SKIP_PENALTY: Record<string, number> = { rail: 45, ferry: 120, road: 20 };

// Typical end-to-end speeds including time lost stopping, and time spent at each stop.
// Assumptions for brand-new lines, where there is no timetable to learn from.
export const NEW_LINE: Record<string, { speed: number; dwell: number; routeType: number }> = {
  train: { speed: 15, dwell: 45, routeType: 2 },
  metro: { speed: 16, dwell: 30, routeType: 401 },
  light_rail: { speed: 7, dwell: 30, routeType: 900 },
  ferry: { speed: 6, dwell: 120, routeType: 4 },
  bus: { speed: 6.5, dwell: 20, routeType: 700 },
  coach: { speed: 14, dwell: 60, routeType: 204 },
  school_bus: { speed: 6.5, dwell: 20, routeType: 712 },
};
