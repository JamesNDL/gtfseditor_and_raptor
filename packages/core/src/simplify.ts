// Douglas-Peucker line simplification that returns the indices of the points to keep, so callers can
// carry extra per-point values (such as distance along the shape) through unchanged.

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQUATOR = 111_320;

export function simplifyIndices(lon: ArrayLike<number>, lat: ArrayLike<number>, toleranceM: number): number[] {
  const n = lon.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);

  const cos = Math.cos(lat[0] * (Math.PI / 180));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = lon[i] * M_PER_DEG_LON_EQUATOR * cos;
    y[i] = lat[i] * M_PER_DEG_LAT;
  }

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    const dx = x[last] - x[first];
    const dy = y[last] - y[first];
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = first + 1; i < last; i++) {
      let px = x[i] - x[first];
      let py = y[i] - y[first];
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        px -= t * dx;
        py -= t * dy;
      }
      const d2 = px * px + py * py;
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
