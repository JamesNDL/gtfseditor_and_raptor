// Local metres about a centre point (D26): the flat-earth factors shared with the road router.
import { describe, expect, it } from 'vitest';
import { localFrame } from './local-metres.ts';

describe('localFrame', () => {
  const frame = localFrame(151.0, -33.8);

  it('puts the centre at the origin', () => {
    const [x, y] = frame.toMetres([151.0, -33.8]);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
  });

  it('uses 110,540 m per degree of latitude', () => {
    const [x, y] = frame.toMetres([151.0, -32.8]);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(110_540, 6);
  });

  it('uses 111,320 x cos(centre latitude) per degree of longitude', () => {
    const [x, y] = frame.toMetres([152.0, -33.8]);
    expect(x).toBeCloseTo(111_320 * Math.cos((-33.8 * Math.PI) / 180), 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('turns metres back into the same longitude and latitude', () => {
    const [lon, lat] = frame.toLonLat(frame.toMetres([151.0123, -33.8456]));
    expect(lon).toBeCloseTo(151.0123, 12);
    expect(lat).toBeCloseTo(-33.8456, 12);
  });

  it('turns 1 km east and 1 km north into the right offsets', () => {
    const [lon, lat] = frame.toLonLat([1000, 1000]);
    expect(lon - 151.0).toBeCloseTo(1000 / (111_320 * Math.cos((-33.8 * Math.PI) / 180)), 12);
    expect(lat + 33.8).toBeCloseTo(1000 / 110_540, 12);
  });
});
