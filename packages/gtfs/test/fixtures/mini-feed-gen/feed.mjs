// The feed's tables, filled in by the train, bus and ferry modules, and the time helpers they share.

/** The one service id: weekdays. */
export const SERVICE = 'WKDY';

// --- Times ----------------------------------------------------------------------------------

/** Seconds since the start of the service day as HH:MM:SS (hours can pass 24). */
export const hms = (secs) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}`;
};
/** Seconds since the start of the service day for a clock time. */
export const at = (h, m = 0) => h * 3600 + m * 60;
/** Whether a time falls in the morning or evening peak. */
export const inPeak = (secs) =>
  (secs >= at(6, 30) && secs < at(9, 30)) || (secs >= at(15) && secs < at(19));

// --- Feed tables ----------------------------------------------------------------------------

/** Rows of stops.txt, in the order they are added. */
export const stops = [];
/** Stops by stop_id. */
export const stopById = new Map();
/** Rows of routes.txt. */
export const routes = [];
/** Rows of trips.txt. */
export const trips = [];
/** Rows of stop_times.txt. */
export const stopTimes = [];
/** Lines of shapes.txt, already joined with commas. */
export const shapes = [];

/** Adds a stop, filling in the columns it leaves out, and returns the full row. */
export function addStop(row) {
  const full = {
    stop_code: '',
    location_type: '',
    parent_station: '',
    wheelchair_boarding: '1',
    level_id: '',
    platform_code: '',
    ...row,
  };
  stops.push(full);
  stopById.set(full.stop_id, full);
  return full;
}

/** Adds the points of a densified path as a shape. */
export function addShape(id, path) {
  path.pts.forEach((p, i) =>
    shapes.push([id, p[1], p[0], i + 1, path.dist[i].toFixed(2)].join(',')),
  );
}
