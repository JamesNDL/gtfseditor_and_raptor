// Checks one answer of GET /api/analyses/:id/lines (AA-16, FR-14) against the stored pairs, without
// working the contours out again: the bands and lines have the shape §5.1 gives, every corner lies
// in the zone's box, each sample point with a ratio is a corner of the band its ratio falls in (so
// the grid was laid where the sample points are), and a line is drawn exactly where some grid
// square has ratios on both sides of it. Used by analysis-results.e2e.mjs. Not a test itself.
import assert from 'node:assert/strict';

/** Degrees: the API rounds to 6 decimals (about 0.1 m) and the grid is rebuilt from metres. */
const SLACK = 2e-6;

/** Every position in a geometry's coordinates, however deeply nested. */
function positions(coordinates) {
  return typeof coordinates[0] === 'number' ? [coordinates] : coordinates.flatMap(positions);
}

/** The four corners of every grid square whose corners all have a ratio, as lists of ratios. */
function fullSquares(rows) {
  const ratioAt = new Map(rows.filter((r) => r.status === 'ok').map((r) => [`${r.i},${r.j}`, r]));
  const squares = [];
  for (const row of ratioAt.values()) {
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([di, dj]) => ratioAt.get(`${row.i + di},${row.j + dj}`));
    if (corners.every(Boolean)) squares.push(corners);
  }
  return squares;
}

/**
 * Fails unless `answer` ({bands, lines, summary}) fits the stored `rows` of one point of interest
 * for these `breaks`. Gives how many breaks have a line drawn.
 */
export function checkLines(answer, rows, breaks, ring) {
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  const inBox = ([lon, lat]) =>
    lon >= Math.min(...lons) - SLACK &&
    lon <= Math.max(...lons) + SLACK &&
    lat >= Math.min(...lats) - SLACK &&
    lat <= Math.max(...lats) + SLACK;

  const { bands, lines } = answer;
  assert.equal(bands.type, 'FeatureCollection');
  assert.equal(lines.type, 'FeatureCollection');
  assert.equal(bands.features.length, breaks.length + 1, 'one band more than the breaks');
  assert.equal(lines.features.length, breaks.length, 'one line per break');
  bands.features.forEach((band, k) => {
    assert.equal(band.type, 'Feature');
    assert.equal(band.geometry.type, 'MultiPolygon');
    assert.deepEqual(band.properties, {
      from: k === 0 ? null : breaks[k - 1],
      to: k === breaks.length ? null : breaks[k],
    });
    for (const polygon of band.geometry.coordinates) {
      assert.equal(polygon.length, 1, 'each band piece is one ring');
      const [piece] = polygon;
      assert.ok(piece.length >= 4, 'a ring has at least three corners and is closed');
      assert.deepEqual(piece[0], piece[piece.length - 1], 'the ring is closed');
      assert.ok(piece.every(inBox), 'band corners lie in the zone');
    }
  });

  // Each sample point with a ratio that is a corner of a full square is a corner of its band.
  const squares = fullSquares(rows);
  const corners = new Set(squares.flat());
  for (const row of corners) {
    if (breaks.some((b) => Math.abs(row.ratio - b) < 1e-9)) continue;
    const k = breaks.filter((b) => row.ratio >= b).length;
    const near = positions(bands.features[k].geometry.coordinates).some(
      ([lon, lat]) => Math.abs(lon - row.lon) <= SLACK && Math.abs(lat - row.lat) <= SLACK,
    );
    assert.ok(near, `sample point ${row.seq} (ratio ${row.ratio}) is a corner of band ${k}`);
  }

  let drawn = 0;
  lines.features.forEach((line, k) => {
    assert.equal(line.type, 'Feature');
    assert.equal(line.geometry.type, 'MultiLineString');
    assert.deepEqual(line.properties, { ratio: breaks[k] });
    for (const part of line.geometry.coordinates) {
      assert.ok(part.length >= 2, 'a line has at least two points');
      assert.ok(part.every(inBox), 'line points lie in the zone');
    }
    const crossed = squares.some(
      (square) =>
        square.some((r) => r.ratio < breaks[k]) && square.some((r) => r.ratio >= breaks[k]),
    );
    const has = line.geometry.coordinates.length > 0;
    assert.equal(has, crossed, `the line at ${breaks[k]} is drawn where the ratios cross it`);
    if (has) drawn++;
  });
  return drawn;
}
