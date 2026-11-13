import { useEffect, useRef, useState } from 'react';
import { useStore } from './store.ts';

export interface Baseline {
  id: number;
  label: string;
  dayType: string;
  serviceDate: string;
  feedId: string;
  stats: {
    trips: number;
    stopTimes: number;
    vehicleDays: number;
    vehicleDaysInferred: number;
    baselineConflicts: number;
    tripsWithAssumedVehicle: number;
    firstDeparture: number;
    lastArrival: number;
    routesRunning: number;
  };
  tripsByMode: Record<string, number>;
}

export interface Mode {
  id: string;
  name: string;
  ruleSet: 'rail' | 'ferry' | 'road';
  color: string;
}

export interface RouteListItem {
  id: number;
  shortName: string | null;
  longName: string | null;
  modeId: string;
  color: string;
  tripCount: number;
  agency: string | null;
  /** Created by the open scenario. */
  isNew?: boolean;
}

export interface VehicleTypeUse {
  id: number;
  name: string;
  cars: number | null;
  seated: number;
  standing: number;
  capacityIsPlaceholder: boolean;
  assumed: boolean;
  trips: number;
}

export interface HourlyRow {
  direction: number;
  hour: number;
  trips: number;
  seated: number;
  standing: number;
}

export interface RouteDetail {
  id: number;
  shortName: string | null;
  longName: string | null;
  description: string | null;
  modeId: string;
  modeName: string;
  color: string;
  agency: string | null;
  tripCount: number;
  west: number | null;
  south: number | null;
  east: number | null;
  north: number | null;
  firstDeparture: number;
  lastArrival: number;
  vehicleDays: number;
  avgRunSecs: number;
  hourly: HourlyRow[];
  /** Departure times of the most-used stopping pattern in each direction. */
  mainDepartures: { direction: number; starts: number[] }[];
  /** The published timetable's numbers, sent only while a scenario is open. */
  before: { tripCount: number; vehicleDays: number; hourly: HourlyRow[] } | null;
  directions: { direction: number; headsign: string | null; trips: number }[];
  vehicleTypes: VehicleTypeUse[];
  patterns: {
    id: number;
    direction: number;
    headsign: string | null;
    tripCount: number;
    stopCount: number;
    firstStop: string;
    lastStop: string;
  }[];
}

export interface RouteTrip {
  id: number;
  gtfsId: string;
  direction: number;
  headsign: string | null;
  startSecs: number;
  endSecs: number;
  patternId: number | null;
  vehicleDayId: number | null;
  vehicleDayLabel: string | null;
  vehicleDaySource: 'run_number' | 'inferred' | null;
  vehicleType: string;
  vehicleAssumed: boolean;
  firstStop: string;
  lastStop: string;
  stopCount: number;
  edited: boolean;
  pinned: boolean;
}

export interface TripSummary {
  id: number;
  gtfsId: string;
  headsign: string | null;
  startSecs: number;
  endSecs: number;
  vehicleDaySeq: number | null;
  routeId: number;
  routeShortName: string | null;
  color: string;
  modeId: string;
  firstStop: string;
  lastStop: string;
  firstStationId: number;
  lastStationId: number;
}

export interface TripDetail {
  id: number;
  gtfsId: string;
  headsign: string | null;
  startSecs: number;
  endSecs: number;
  direction: number;
  tripName: string | null;
  routeId: number;
  routeShortName: string | null;
  routeLongName: string | null;
  color: string;
  modeId: string;
  modeName: string;
  vehicleDayId: number | null;
  vehicleDayLabel: string | null;
  vehicleDaySource: 'run_number' | 'inferred' | null;
  vehicleType: string;
  vehicleTypeId: number;
  seated: number;
  standing: number;
  capacityIsPlaceholder: boolean;
  vehicleAssumed: boolean;
  patternId: number | null;
  edited: boolean;
  pinned: boolean;
  ruleSet: 'rail' | 'ferry' | 'road';
  stopTimes: {
    seq: number;
    arr: number;
    dep: number;
    dist: number | null;
    pickupType: number;
    dropOffType: number;
    stopId: number;
    name: string;
    platformCode: string | null;
    lon: number;
    lat: number;
  }[];
  stayAboardFrom: TripSummary | null;
  stayAboardTo: TripSummary | null;
}

export interface VehicleDayDetail {
  id: number;
  label: string;
  source: 'run_number' | 'inferred';
  modeId: string;
  modeName: string;
  tripCount: number;
  startSecs: number;
  endSecs: number;
  gapCount: number;
  vehicleType: string | null;
  seated: number | null;
  standing: number | null;
  capacityIsPlaceholder: boolean | null;
  /** Added by the open scenario for its new trips. */
  isNew: boolean;
  trips: TripSummary[];
  stayAboard: { fromTripId: number; toTripId: number }[];
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return (await res.json()) as T;
}

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Fetches JSON whenever the URL changes. Pass null to fetch nothing.
 * Requests are made for the scenario being edited, and repeated after every edit; the previous
 * result stays on screen while the fresh one loads, so views do not flicker.
 */
export function useApi<T>(url: string | null): ApiState<T> {
  const scenarioId = useStore((s) => s.scenarioId);
  const version = useStore((s) => s.dataVersion);
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: !!url });
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!url) {
      shown.current = null;
      setState({ data: null, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    const key = `${url}|${scenarioId}`;
    const sameThing = shown.current === key;
    shown.current = key;
    setState((prev) => ({ data: sameThing ? prev.data : null, error: null, loading: true }));
    const full = scenarioId === null ? url : `${url}${url.includes('?') ? '&' : '?'}s=${scenarioId}`;
    getJson<T>(full, controller.signal).then(
      (data) => setState({ data, error: null, loading: false }),
      (err) => {
        if (!controller.signal.aborted) setState({ data: null, error: String(err.message ?? err), loading: false });
      },
    );
    return () => controller.abort();
  }, [url, scenarioId, version]);
  return state;
}
