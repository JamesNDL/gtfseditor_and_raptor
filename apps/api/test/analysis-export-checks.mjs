// Checks the three exports of one finished analysis (AA-22: FR-18, AC-FR-18.1; §5.3) against the
// stored pairs: results.csv has the header and one row per sample point and point of interest,
// points.geojson one point feature per pair, and lines.geojson the lines of equal ratio as the map
// gets them; each is a download named access-<id>-.... Used by analysis-compare.e2e.mjs. Not a
// test itself.
import assert from 'node:assert/strict';
import { API, get, send, step } from './analysis-e2e-client.mjs';

const HEADER =
  'point,lat,lon,poi,poi_name,status,pt_mins,walk_mins,wait_mins,ride_mins,rides,' +
  'drive_mins_free_flow,drive_km,traffic_factor,parking_mins,car_mins,ratio';

/** Fetches an export; fails unless it is a 200 download whose file name matches `name`. */
async function download(path, type, name) {
  const res = await fetch(API + path);
  const text = await res.text();
  assert.equal(res.status, 200, `${path}: ${text}`);
  assert.match(res.headers.get('content-type'), type, `${path}: content type`);
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="access-\d+-[a-z0-9-]+\.[a-z]+"$/, disposition);
  assert.match(disposition, name, `${path}: file name`);
  return text;
}

/** Rounded to `places` places; null stays null. */
const round = (value, places) =>
  value === null ? null : Math.round(value * 10 ** places) / 10 ** places;
/** Rounded and written with exactly `places` places, or an empty cell for null. */
const fixed = (value, places) => (value === null ? '' : round(value, places).toFixed(places));
const mins = (secs) => (secs === null ? null : round(secs / 60, 1));

/** A CSV cell for a name: quoted, with quotes doubled, when it holds a comma or a quote. */
const nameCell = (name) => (/[",]/.test(name) ? `"${name.replaceAll('"', '""')}"` : name);

/** Every pair of the analysis with its sample point and point of interest, as the CSV orders it. */
const pairsOf = (db, id) => db`
  select p.seq, p.lon, p.lat, r.poi_seq, o.name, r.status, r.pt_secs, r.walk_secs, r.wait_secs,
         r.ride_secs, r.rides, r.drive_secs, r.drive_metres, r.car_secs, r.ratio
  from analysis_points p
  join analysis_results r on r.analysis_id = p.analysis_id and r.point_seq = p.seq
  join analysis_pois o on o.analysis_id = p.analysis_id and o.seq = r.poi_seq
  where p.analysis_id = ${id}
  order by p.seq, r.poi_seq`;

/** The CSV line one stored pair should give (traffic factor 1.4 at 08:00, parking 5 minutes). */
const csvLine = (r) =>
  [
    r.seq,
    r.lat,
    r.lon,
    r.poi_seq,
    nameCell(r.name),
    r.status,
    fixed(mins(r.pt_secs), 1),
    fixed(mins(r.walk_secs), 1),
    fixed(mins(r.wait_secs), 1),
    fixed(mins(r.ride_secs), 1),
    r.rides ?? '',
    fixed(mins(r.drive_secs), 1),
    fixed(r.drive_metres === null ? null : r.drive_metres / 1000, 2),
    '1.4',
    '5.0',
    fixed(mins(r.car_secs), 1),
    fixed(r.ratio, 2),
  ].join(',');

/** Fails unless the exports of `detail` (a finished analysis run with the default settings) fit. */
export async function checkExports(db, detail) {
  const { id } = detail;
  const rows = await pairsOf(db, id);
  assert.equal(rows.length, detail.sampleCount * detail.pois.length);
  assert.ok(
    rows.some((r) => /[",]/.test(r.name)),
    'a point of interest name needs quoting',
  );

  const csv = await download(
    `/api/analyses/${id}/export/results.csv`,
    /^text\/csv/,
    new RegExp(`"access-${id}-results\\.csv"`),
  );
  const lines = csv.split('\r\n');
  assert.equal(lines[0], HEADER);
  assert.equal(lines.at(-1), '', 'the file ends with a line break');
  assert.equal(lines.length, rows.length + 2, 'one line per sample point and point of interest');
  rows.forEach((r, k) => assert.equal(lines[k + 1], csvLine(r), `CSV line ${k + 1}`));
  step('AC-FR-18.1 results.csv: the header, then one row per sample point and point of interest');

  const points = JSON.parse(
    await download(
      `/api/analyses/${id}/export/points.geojson`,
      /^application\/geo\+json/,
      new RegExp(`"access-${id}-points\\.geojson"`),
    ),
  );
  assert.equal(points.type, 'FeatureCollection');
  assert.equal(points.features.length, rows.length, 'one feature per pair');
  points.features.forEach((feature, k) => {
    const r = rows[k];
    assert.equal(feature.type, 'Feature');
    assert.deepEqual(feature.geometry, { type: 'Point', coordinates: [r.lon, r.lat] });
    const p = feature.properties;
    assert.deepEqual(
      [p.point, p.poi, p.poi_name, p.status, p.pt_mins, p.car_mins],
      [r.seq, r.poi_seq, r.name, r.status, mins(r.pt_secs), mins(r.car_secs)],
      `feature ${k}`,
    );
    assert.equal(p.ratio, round(r.ratio, 2));
  });
  step('AC-FR-18.1 points.geojson: one point feature per pair, with the CSV columns');

  for (const [poiSeq, breaks] of [
    [0, null],
    [1, [1.2, 1.3]],
  ]) {
    const query = breaks ? `?poi=${poiSeq}&breaks=${breaks.join(',')}` : `?poi=${poiSeq}`;
    const geojson = JSON.parse(
      await download(
        `/api/analyses/${id}/export/lines.geojson${query}`,
        /^application\/geo\+json/,
        new RegExp(`"access-${id}-lines-${poiSeq}\\.geojson"`),
      ),
    );
    assert.equal(geojson.type, 'FeatureCollection');
    const used = breaks ?? detail.settings.breaks;
    assert.deepEqual(
      geojson.features.map((f) => [f.geometry.type, f.properties.ratio]),
      used.map((ratio) => ['MultiLineString', ratio]),
    );
    const map = await get(`/api/analyses/${id}/lines${query}`);
    assert.deepEqual(geojson, map.lines, 'the same lines as the map draws');
  }
  for (const [path, status] of [
    ['lines.geojson', 400],
    ['lines.geojson?poi=9', 404],
    ['lines.geojson?poi=0&breaks=2,1', 400],
  ]) {
    assert.equal((await send('GET', `/api/analyses/${id}/export/${path}`)).status, status, path);
  }
  step('AC-FR-18.1 lines.geojson: a FeatureCollection of MultiLineStrings with their ratio');

  for (const file of ['results.csv', 'points.geojson', 'lines.geojson?poi=0']) {
    assert.equal((await send('GET', `/api/analyses/999999/export/${file}`)).status, 404, file);
  }
}
