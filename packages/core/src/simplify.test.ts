import { describe, expect, it } from 'vitest';
import { simplifyIndices } from './simplify.ts';

describe('simplifyIndices', () => {
  it('drops points on a straight line and keeps corners', () => {
    const lon = [151.0, 151.001, 151.002, 151.002, 151.002];
    const lat = [-33.8, -33.8, -33.8, -33.801, -33.802];
    expect(simplifyIndices(lon, lat, 5)).toEqual([0, 2, 4]);
  });
});
