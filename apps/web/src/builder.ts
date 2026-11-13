// Picking stops on the map, for a new line being drawn or an existing one being reshaped.
import { distanceM } from '@gtfs-editor/core';
import { getJson } from './api.ts';
import { useStore, type BuilderStop } from './store.ts';

export interface MapStop {
  id: number;
  name: string;
  isStation: boolean;
  lon: number;
  lat: number;
}

const ROAD_MODES = ['bus', 'coach', 'school_bus'];
export const isRoadMode = (modeId: string) => ROAD_MODES.includes(modeId);

/** Where on the line a stop already is: by its own id, or by its station when a station was clicked. */
const positionOf = (stops: BuilderStop[], stop: MapStop) => stops.findIndex((s) => s.id === stop.id || (stop.isStation && s.parentId === stop.id));

/** The place in the list where a stop adds the least extra distance. */
function bestFit(stops: BuilderStop[], stop: MapStop): number {
  if (stops.length === 0) return 0;
  const d = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => distanceM(a.lon, a.lat, b.lon, b.lat);
  let best = stops.length;
  let cost = d(stops[stops.length - 1], stop);
  const atStart = d(stop, stops[0]);
  if (atStart < cost) {
    best = 0;
    cost = atStart;
  }
  for (let i = 1; i < stops.length; i++) {
    const detour = d(stops[i - 1], stop) + d(stop, stops[i]) - d(stops[i - 1], stops[i]);
    if (detour < cost) {
      best = i;
      cost = detour;
    }
  }
  return best;
}

/** What clicking a stop will do, for the map's tooltip. */
export function describePick(stop: MapStop): string {
  const { builder } = useStore.getState();
  if (!builder?.reshape) return 'click to add to the new line';
  return positionOf(builder.stops, stop) >= 0 ? 'click to take it off the line' : 'click to add to the line';
}

/** A stop was clicked on the map while drawing. */
export function pickStop(stop: MapStop) {
  const { builder, set } = useStore.getState();
  if (!builder) return;
  const picked: BuilderStop = { id: stop.id, name: stop.name, lon: stop.lon, lat: stop.lat, parentId: null };
  if (!builder.reshape) {
    if (builder.stops[builder.stops.length - 1]?.id !== stop.id) set({ builder: { ...builder, stops: [...builder.stops, picked] } });
    return;
  }
  // Reshaping: a stop already on the line comes off; any other stop goes on.
  const at = positionOf(builder.stops, stop);
  if (at >= 0) {
    if (builder.stops.length > 2) set({ builder: { ...builder, stops: builder.stops.filter((_, i) => i !== at) } });
    return;
  }
  const where = builder.reshape.insertAt === 'end' ? builder.stops.length : builder.reshape.insertAt === 'start' ? 0 : bestFit(builder.stops, stop);
  // A stop taken off earlier and clicked again goes back as itself (its own platform), not as a new stop.
  const original = builder.reshape.original.find((s) => s.id === stop.id || (stop.isStation && s.parentId === stop.id));
  set({ builder: { ...builder, stops: [...builder.stops.slice(0, where), original ?? picked, ...builder.stops.slice(where)] } });
}

interface PatternStops {
  id: number;
  routeId: number;
  stops: BuilderStop[];
}

/** Starts changing the stops of one of a line's stop patterns. */
export async function startReshape(route: { id: number; name: string; modeId: string; color: string }, patternId: number) {
  const pattern = await getJson<PatternStops>(`/api/patterns/${patternId}/stops`);
  const previous = useStore.getState().builder?.reshape;
  useStore.getState().set({
    builderPath: null,
    builder: {
      name: route.name,
      modeId: route.modeId,
      color: route.color,
      headwayMin: 15,
      followRoads: true,
      stops: pattern.stops,
      reshape: {
        routeId: route.id,
        patternId,
        original: pattern.stops,
        insertAt: previous?.insertAt ?? 'best',
        direct: previous?.direct ?? false,
        bothWays: previous?.bothWays ?? true,
      },
    },
  });
}
