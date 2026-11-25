// AA-11 (FR-4, FR-5, FR-16, FR-18; §4.2, D9): the access analysis types the API and the web app
// share. These are checked by the type checker (npm run typecheck); the runtime checks only make
// sure that typed values of each shape can be built. Imported from the package's entry, as the
// API and the web app import them (AC 4).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AnalysisCreateBody,
  AnalysisDetail,
  AnalysisListItem,
  AnalysisSettings,
  AnalysisState,
  CompareResult,
  PairStatus,
  PointDetail,
  PointLeg,
  PointOfInterest,
  PoiBody,
  PoiSummary,
  StoredLeg,
  Zone,
  ZoneBody,
} from '../index.ts';
import { DEFAULT_ANALYSIS_SETTINGS } from '../index.ts';

const square: [number, number][] = [
  [151.72, -32.88],
  [151.75, -32.88],
  [151.75, -32.91],
  [151.72, -32.91],
];

describe('access analysis shared types', () => {
  it('describes saved zones and points of interest, and their bodies', () => {
    const zone: Zone = { id: 1, name: 'Mayfield', ring: square, createdAt: '2026-11-25T08:00Z' };
    const zoneBody: ZoneBody = { name: zone.name, ring: zone.ring };
    const poi: PointOfInterest = {
      id: 2,
      name: 'Newcastle city centre',
      kind: 'place',
      source: 'drawn',
      lon: 151.772,
      lat: -32.927,
    };
    const poiBody: PoiBody = { name: poi.name, lon: poi.lon, lat: poi.lat };
    expect(zoneBody.ring).toHaveLength(4);
    expect(poiBody.kind).toBeUndefined();
  });

  it('reuses the analysis settings and pair status of packages/core/src/analysis', () => {
    expectTypeOf<AnalysisCreateBody['settings']>().toEqualTypeOf<AnalysisSettings>();
    expectTypeOf<AnalysisDetail['settings']>().toEqualTypeOf<AnalysisSettings>();
    expectTypeOf<PointDetail['status']>().toEqualTypeOf<PairStatus>();
    expectTypeOf<AnalysisState>().toEqualTypeOf<
      'queued' | 'preparing' | 'running' | 'done' | 'failed' | 'cancelled'
    >();
  });

  it('describes the body that makes an analysis', () => {
    const body: AnalysisCreateBody = {
      baselineId: 1,
      scenarioId: null,
      zoneId: 1,
      poiIds: [2, 3],
      settings: DEFAULT_ANALYSIS_SETTINGS,
    };
    expectTypeOf(body.name).toEqualTypeOf<string | undefined>();
    expectTypeOf(body.scenarioId).toEqualTypeOf<number | null>();
    expect(body.poiIds).toEqual([2, 3]);
  });

  it('describes an analysis in the list and in full, with each point of interest by seq', () => {
    expectTypeOf<AnalysisListItem['state']>().toEqualTypeOf<AnalysisState>();
    expectTypeOf<AnalysisDetail['pois'][number]['seq']>().toEqualTypeOf<number>();
    expectTypeOf<AnalysisDetail['pois'][number]['summary']>().toEqualTypeOf<PoiSummary | null>();
    // The open band ends go over the wire as null (JSON has no infinity).
    expectTypeOf<PoiSummary['bands'][number]['from']>().toEqualTypeOf<number | null>();
    expectTypeOf<PoiSummary['bands'][number]['to']>().toEqualTypeOf<number | null>();
    expectTypeOf<AnalysisDetail['zone']['ring']>().toEqualTypeOf<[number, number][]>();
    expectTypeOf<NonNullable<AnalysisDetail['progress']>['stage']>().toEqualTypeOf<
      'timetable' | 'drives' | 'journeys'
    >();
    expectTypeOf<NonNullable<AnalysisDetail['progress']>['done']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<AnalysisDetail['error']>().toEqualTypeOf<string | null>();
  });

  it('describes stored legs: walks, rides with where they board and alight, and transfers', () => {
    const legs: StoredLeg[] = [
      { type: 'walk', secs: 300, metres: 400 },
      {
        type: 'ride',
        route: '100',
        mode: 'bus',
        board: { name: 'Mayfield', lat: -32.89, lon: 151.73, time: 28_900 },
        alight: { name: 'Civic', lat: -32.927, lon: 151.772, time: 29_800 },
        secs: 900,
        metres: 5200,
      },
      { type: 'transfer', secs: 60, metres: 80 },
    ];
    const rides = legs.filter((leg) => leg.type === 'ride');
    expect(rides.map((leg) => leg.board.name)).toEqual(['Mayfield']);
    // The picked point gives each ride its path on the map as well (D39).
    expectTypeOf<PointDetail['legs']>().toEqualTypeOf<PointLeg[] | null>();
  });

  it('describes a comparison as points with their change and kind, and counts per kind', () => {
    const result: CompareResult = {
      points: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [151.73, -32.89] },
            properties: { i: 0, j: 0, kind: 'better', change: -0.4 },
          },
        ],
      },
      counts: { better: 1, worse: 0, same: 0, gainedService: 0, lostService: 0, bothNone: 0 },
    };
    expect(result.points.features[0]?.properties.kind).toBe('better');
  });
});
