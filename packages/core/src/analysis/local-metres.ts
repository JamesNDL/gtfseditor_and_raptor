// Local metres about a centre point (D26). The same flat-earth factors as the road router's
// `roads.ts`: good to well under a metre across a zone a few kilometres wide.

/** A longitude and latitude, in that order (as GeoJSON). */
export type LonLat = readonly [lon: number, lat: number];

/** Metres east (x) and north (y) of a local frame's centre. */
export type Metres = readonly [x: number, y: number];

/** Turns longitude and latitude into metres about one centre point, and back. */
export interface LocalFrame {
  toMetres(point: LonLat): Metres;
  toLonLat(point: Metres): LonLat;
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQUATOR = 111_320;

/** A local frame centred on (centreLon, centreLat), scaled by the cosine of the centre's latitude. */
export function localFrame(centreLon: number, centreLat: number): LocalFrame {
  const mPerDegLon = M_PER_DEG_LON_EQUATOR * Math.cos((centreLat * Math.PI) / 180);
  return {
    toMetres: ([lon, lat]) => [(lon - centreLon) * mPerDegLon, (lat - centreLat) * M_PER_DEG_LAT],
    toLonLat: ([x, y]) => [centreLon + x / mPerDegLon, centreLat + y / M_PER_DEG_LAT],
  };
}
