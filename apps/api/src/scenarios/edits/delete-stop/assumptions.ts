// Figures and mode lists that deleting a stop works from.

// A line is warned about when its nearest remaining stop is further than this from the deleted one:
// about ten minutes on foot.
export const AREA_M = 800;
// Metres a second that an estimated run time may never imply: 90 km/h on the road, 160 on rails,
// 55 on the water. Assumptions, there to stop a guess producing a vehicle no one has seen.
export const TOP_SPEED: Record<string, number> = { road: 25, rail: 45, ferry: 15 };
export const RAIL_MODES = ['train', 'metro', 'light_rail', 'ferry'];
