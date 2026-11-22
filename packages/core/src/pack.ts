// Animation pack: a compact binary file holding every trip of one mode for one service day, so the
// browser can place every vehicle at any time of day without asking the server.
//
// Layout: [u32 header length][header JSON, padded to 8 bytes][typed arrays, each aligned to 8 bytes]

export type PackArrayType = 'i32' | 'u32' | 'f32';

const CTORS = { i32: Int32Array, u32: Uint32Array, f32: Float32Array } as const;

export interface PackMeta {
  version: 1;
  modeId: string;
  tripCount: number;
  stopTimeCount: number;
  shapeCount: number;
  pointCount: number;
}

interface PackHeader {
  meta: PackMeta;
  arrays: { name: string; type: PackArrayType; offset: number; length: number }[];
}

/** Coordinates are stored as integers of 1e-6 degrees (about 0.1 m). */
export const COORD_SCALE = 1e6;

export interface PackArrays {
  /** Database trip id, sorted by start time. */
  tripId: Int32Array;
  tripRoute: Int32Array;
  tripStart: Int32Array;
  tripEnd: Int32Array;
  /** Index into the shape arrays. */
  tripShape: Int32Array;
  /** tripCount + 1 offsets into the stop-time arrays. */
  tripStOffset: Uint32Array;
  stArr: Int32Array;
  stDep: Int32Array;
  /** Metres along the trip's shape. */
  stDist: Float32Array;
  /** shapeCount + 1 offsets into the point arrays. */
  shapePtOffset: Uint32Array;
  ptLon: Int32Array;
  ptLat: Int32Array;
  ptDist: Float32Array;
}

const ARRAY_TYPES: Record<keyof PackArrays, PackArrayType> = {
  tripId: 'i32',
  tripRoute: 'i32',
  tripStart: 'i32',
  tripEnd: 'i32',
  tripShape: 'i32',
  tripStOffset: 'u32',
  stArr: 'i32',
  stDep: 'i32',
  stDist: 'f32',
  shapePtOffset: 'u32',
  ptLon: 'i32',
  ptLat: 'i32',
  ptDist: 'f32',
};

const align8 = (n: number) => (n + 7) & ~7;

export function encodePack(meta: PackMeta, arrays: PackArrays): Uint8Array {
  const names = Object.keys(ARRAY_TYPES) as (keyof PackArrays)[];
  // Offsets depend on the header length, which depends on the offsets; reserve fixed-width numbers.
  const build = (offsets: number[]): PackHeader => ({
    meta,
    arrays: names.map((name, i) => ({
      name,
      type: ARRAY_TYPES[name],
      offset: offsets[i],
      length: arrays[name].length,
    })),
  });
  const encoder = new TextEncoder();
  const headerRoom = align8(
    encoder.encode(JSON.stringify(build(names.map(() => 4_000_000_000)))).length + 4,
  );
  const offsets: number[] = [];
  let cursor = headerRoom;
  for (const name of names) {
    offsets.push(cursor);
    cursor = align8(cursor + arrays[name].byteLength);
  }
  const out = new Uint8Array(cursor);
  const headerBytes = encoder.encode(JSON.stringify(build(offsets)));
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  names.forEach((name, i) => {
    const a = arrays[name];
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offsets[i]);
  });
  return out;
}

export interface Pack extends PackArrays {
  meta: PackMeta;
}

export function decodePack(buffer: ArrayBuffer): Pack {
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)),
  ) as PackHeader;
  if (header.meta.version !== 1) throw new Error(`Unsupported pack version ${header.meta.version}`);
  const pack: Record<string, unknown> = { meta: header.meta };
  for (const a of header.arrays) pack[a.name] = new CTORS[a.type](buffer, a.offset, a.length);
  return pack as unknown as Pack;
}

/**
 * Where trip `i` is at `secs`, written as [lon, lat] degrees into `out` at `outIndex`.
 * Returns false if the trip is not running at that time.
 */
export function tripPosition(
  pack: Pack,
  i: number,
  secs: number,
  out: Float64Array | Float32Array,
  outIndex: number,
): boolean {
  if (secs < pack.tripStart[i] || secs > pack.tripEnd[i]) return false;
  const s0 = pack.tripStOffset[i];
  const s1 = pack.tripStOffset[i + 1];

  // Last stop whose arrival is at or before `secs`.
  let lo = s0;
  let hi = s1 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (pack.stArr[mid] <= secs) lo = mid;
    else hi = mid - 1;
  }
  let dist: number;
  if (secs <= pack.stDep[lo] || lo === s1 - 1) {
    dist = pack.stDist[lo]; // dwelling at a stop
  } else {
    const span = pack.stArr[lo + 1] - pack.stDep[lo];
    const f = span > 0 ? (secs - pack.stDep[lo]) / span : 1;
    dist = pack.stDist[lo] + f * (pack.stDist[lo + 1] - pack.stDist[lo]);
  }

  const shape = pack.tripShape[i];
  const p0 = pack.shapePtOffset[shape];
  const p1 = pack.shapePtOffset[shape + 1];
  // Last shape point at or before `dist`.
  let a = p0;
  let b = p1 - 1;
  while (a < b) {
    const mid = (a + b + 1) >>> 1;
    if (pack.ptDist[mid] <= dist) a = mid;
    else b = mid - 1;
  }
  if (a === p1 - 1) {
    out[outIndex] = pack.ptLon[a] / COORD_SCALE;
    out[outIndex + 1] = pack.ptLat[a] / COORD_SCALE;
    return true;
  }
  const seg = pack.ptDist[a + 1] - pack.ptDist[a];
  const f = seg > 0 ? Math.min(1, Math.max(0, (dist - pack.ptDist[a]) / seg)) : 0;
  out[outIndex] = (pack.ptLon[a] + f * (pack.ptLon[a + 1] - pack.ptLon[a])) / COORD_SCALE;
  out[outIndex + 1] = (pack.ptLat[a] + f * (pack.ptLat[a + 1] - pack.ptLat[a])) / COORD_SCALE;
  return true;
}
