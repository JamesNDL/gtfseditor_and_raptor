// Flat-earth geometry for the test feed: good enough over a few kilometres of Sydney.

/** Metres in one degree of latitude. */
export const M_LAT = 110_540;
/** Metres in one degree of longitude at a given latitude. */
export const mLon = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);
const metres = (a, b) => Math.hypot((b[0] - a[0]) * mLon(a[1]), (b[1] - a[1]) * M_LAT);
/** Rounds a coordinate to six decimal places. */
export const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Points every `step` metres or less along the waypoints, with the distance of each from the start. */
export function densify(waypoints, step) {
  const pts = [waypoints[0]];
  const dist = [0];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const len = metres(a, b);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      dist.push(dist[dist.length - 1] + len / n);
    }
  }
  return { pts: pts.map((p) => [round6(p[0]), round6(p[1])]), dist };
}

/** The point at a distance along a path, moved `left` metres to the left of the way it runs. */
export function pointAt(path, along, left = 0) {
  const { pts, dist } = path;
  let i = 1;
  while (i < pts.length - 1 && dist[i] < along) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const f = Math.max(0, Math.min(1, (along - dist[i - 1]) / (dist[i] - dist[i - 1] || 1)));
  const x = a[0] + (b[0] - a[0]) * f;
  const y = a[1] + (b[1] - a[1]) * f;
  const dx = (b[0] - a[0]) * mLon(y);
  const dy = (b[1] - a[1]) * M_LAT;
  const len = Math.hypot(dx, dy) || 1;
  // Left of the direction of travel.
  const east = (-dy / len) * left;
  const north = (dx / len) * left;
  return [round6(x + east / mLon(y)), round6(y + north / M_LAT)];
}

/** Where a point sits along a path, and how far it is from it. */
export function locate(path, p) {
  const { pts, dist } = path;
  let best = { along: 0, off: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const k = mLon(p[1]);
    const ax = (a[0] - p[0]) * k;
    const ay = (a[1] - p[1]) * M_LAT;
    const dx = (b[0] - a[0]) * k;
    const dy = (b[1] - a[1]) * M_LAT;
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + f * dx, ay + f * dy);
    if (off < best.off) best = { along: dist[i - 1] + f * (dist[i] - dist[i - 1]), off };
  }
  return best;
}
