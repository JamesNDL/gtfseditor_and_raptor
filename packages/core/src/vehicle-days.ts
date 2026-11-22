// Builds vehicle days: which physical vehicle runs which trips, in order.
//
// The TfNSW feed does not publish this. Suburban trains carry a run number in the trip ID, which is
// used directly. Everything else is inferred by chaining a trip that ends somewhere onto the next
// trip that starts nearby after a plausible layover. Inferred chains are a guess, not the operator's
// roster.

export type RuleSet = 'rail' | 'ferry' | 'road';

export interface ChainRules {
  /** Shortest turnaround between two trips on the same vehicle, seconds. */
  minLayoverSecs: number;
  /** Longest wait before we assume the vehicle went back to a depot, seconds. */
  maxLayoverSecs: number;
  /** How far apart an arrival and the next departure can be and still count as the same place, metres. */
  radiusM: number;
}

/** Assumptions, not sourced values. Tune per operator once real rosters are available. */
export const DEFAULT_CHAIN_RULES: Record<RuleSet, ChainRules> = {
  rail: { minLayoverSecs: 120, maxLayoverSecs: 2 * 3600, radiusM: 400 },
  ferry: { minLayoverSecs: 120, maxLayoverSecs: 2 * 3600, radiusM: 300 },
  road: { minLayoverSecs: 60, maxLayoverSecs: 3600, radiusM: 500 },
};

export interface ChainTrip {
  id: number;
  startSecs: number;
  endSecs: number;
  firstLon: number;
  firstLat: number;
  lastLon: number;
  lastLat: number;
  ruleSet: RuleSet;
  /** Trips are only chained within a partition (for example mode + operator + vehicle type). */
  partition: string;
  /** Train run number; trips sharing one are a known vehicle day. */
  runKey?: string | null;
  /** Feed block_id: passengers stay aboard, so consecutive trips must share a vehicle. */
  blockId?: string | null;
}

export interface VehicleDay {
  source: 'run_number' | 'inferred';
  partition: string;
  runKey: string | null;
  tripIds: number[];
  startSecs: number;
  endSecs: number;
  /** Consecutive trips that do not start where the previous one ended. */
  gapCount: number;
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQUATOR = 111_320;

export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  const dx =
    (lon2 - lon1) * M_PER_DEG_LON_EQUATOR * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
}

interface Vehicle {
  trips: ChainTrip[];
  cell: string;
}

function byStart(a: ChainTrip, b: ChainTrip): number {
  return a.startSecs - b.startSecs || a.endSecs - b.endSecs || a.id - b.id;
}

function toVehicleDay(
  source: VehicleDay['source'],
  trips: ChainTrip[],
  rules: Record<RuleSet, ChainRules>,
): VehicleDay {
  let gapCount = 0;
  for (let i = 1; i < trips.length; i++) {
    const prev = trips[i - 1];
    const next = trips[i];
    const radius = rules[next.ruleSet].radiusM;
    if (distanceM(prev.lastLon, prev.lastLat, next.firstLon, next.firstLat) > radius) gapCount++;
  }
  return {
    source,
    partition: trips[0].partition,
    runKey: trips[0].runKey ?? null,
    tripIds: trips.map((t) => t.id),
    startSecs: trips[0].startSecs,
    endSecs: Math.max(...trips.map((t) => t.endSecs)),
    gapCount,
  };
}

function chainPartition(trips: ChainTrip[], rules: Record<RuleSet, ChainRules>): Vehicle[] {
  const sorted = [...trips].sort(byStart);
  const vehicles: Vehicle[] = [];
  const idle = new Map<string, Vehicle[]>();
  const blockTail = new Map<string, Vehicle>();

  const cellOf = (lon: number, lat: number, r: ChainRules): [number, number] => [
    Math.floor((lon * M_PER_DEG_LON_EQUATOR * 0.83) / r.radiusM),
    Math.floor((lat * M_PER_DEG_LAT) / r.radiusM),
  ];
  const removeIdle = (v: Vehicle) => {
    const list = idle.get(v.cell);
    if (!list) return;
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
  };

  for (const trip of sorted) {
    const r = rules[trip.ruleSet];
    let chosen: Vehicle | undefined;

    // A block link wins: the feed says passengers stay on this vehicle.
    if (trip.blockId) {
      const tail = blockTail.get(trip.blockId);
      if (tail && tail.trips[tail.trips.length - 1].endSecs <= trip.startSecs) chosen = tail;
    }

    if (!chosen) {
      const [cx, cy] = cellOf(trip.firstLon, trip.firstLat, r);
      let bestFree = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = idle.get(`${cx + dx}:${cy + dy}`);
          if (!list) continue;
          for (let i = list.length - 1; i >= 0; i--) {
            const v = list[i];
            const last = v.trips[v.trips.length - 1];
            if (trip.startSecs - last.endSecs > r.maxLayoverSecs) {
              list.splice(i, 1); // waited too long: assume it left for the depot
              continue;
            }
            if (last.endSecs + r.minLayoverSecs > trip.startSecs) continue;
            if (distanceM(last.lastLon, last.lastLat, trip.firstLon, trip.firstLat) > r.radiusM)
              continue;
            // First in, first out: take the vehicle that has been waiting longest.
            if (last.endSecs < bestFree) {
              bestFree = last.endSecs;
              chosen = v;
            }
          }
        }
      }
    }

    if (chosen) {
      removeIdle(chosen);
    } else {
      chosen = { trips: [], cell: '' };
      vehicles.push(chosen);
    }
    chosen.trips.push(trip);
    const [ex, ey] = cellOf(trip.lastLon, trip.lastLat, r);
    chosen.cell = `${ex}:${ey}`;
    let list = idle.get(chosen.cell);
    if (!list) idle.set(chosen.cell, (list = []));
    list.push(chosen);
    if (trip.blockId) blockTail.set(trip.blockId, chosen);
  }
  return vehicles;
}

export function buildVehicleDays(
  trips: ChainTrip[],
  rules: Record<RuleSet, ChainRules> = DEFAULT_CHAIN_RULES,
): VehicleDay[] {
  const result: VehicleDay[] = [];

  const runs = new Map<string, ChainTrip[]>();
  const partitions = new Map<string, ChainTrip[]>();
  for (const trip of trips) {
    const target = trip.runKey ? runs : partitions;
    const key = trip.runKey ? `${trip.partition}|${trip.runKey}` : trip.partition;
    let list = target.get(key);
    if (!list) target.set(key, (list = []));
    list.push(trip);
  }

  for (const list of runs.values())
    result.push(toVehicleDay('run_number', list.sort(byStart), rules));
  for (const list of partitions.values()) {
    for (const vehicle of chainPartition(list, rules))
      result.push(toVehicleDay('inferred', vehicle.trips, rules));
  }
  return result.sort((a, b) => a.startSecs - b.startSecs);
}
