import { describe, expect, it } from 'vitest';
import { boundsOf, makeFitTransform, makeProjector, METRES_PER_DEG_LAT, polylineLength } from './projection';

describe('makeProjector', () => {
  const origin = { lat: -26.205, lon: 28.043 };
  const project = makeProjector(origin);

  it('maps the origin to (0, 0)', () => {
    expect(project(origin.lat, origin.lon)).toEqual({ x: 0, z: 0 });
  });

  it('projects one degree of latitude to ~111 km, with south positive', () => {
    const south = project(origin.lat - 1, origin.lon);
    expect(south.z).toBeCloseTo(METRES_PER_DEG_LAT, 3);
    expect(south.x).toBe(0);
    const north = project(origin.lat + 0.1, origin.lon);
    expect(north.z).toBeLessThan(0);
  });

  it('shrinks longitude by cos(latitude), with east positive', () => {
    const east = project(origin.lat, origin.lon + 1);
    expect(east.x).toBeCloseTo(METRES_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180), 3);
    expect(east.x).toBeGreaterThan(99_000);
    expect(east.x).toBeLessThan(100_500);
  });
});

describe('makeFitTransform', () => {
  it('fits the longer axis exactly to targetSize and preserves aspect', () => {
    const bounds = { minX: 0, maxX: 2000, minZ: 0, maxZ: 1000 };
    const fit = makeFitTransform(bounds, 3000);
    const a = fit.apply({ x: 0, z: 0 });
    const b = fit.apply({ x: 2000, z: 1000 });
    expect(b.x - a.x).toBeCloseTo(3000, 6);
    expect(b.z - a.z).toBeCloseTo(1500, 6); // aspect preserved
    expect(a.x).toBeCloseTo(-1500, 6); // centred on origin
    expect(b.x).toBeCloseTo(1500, 6);
    expect(fit.metresPerUnit).toBeCloseTo(2000 / 3000, 9);
  });

  it('is centred: the bbox centre maps to (0, 0)', () => {
    const fit = makeFitTransform({ minX: -100, maxX: 300, minZ: 50, maxZ: 250 }, 1000);
    expect(fit.apply({ x: 100, z: 150 })).toEqual({ x: 0, z: 0 });
  });
});

describe('helpers', () => {
  it('boundsOf finds the extremes', () => {
    expect(boundsOf([{ x: 1, z: -5 }, { x: -3, z: 9 }, { x: 2, z: 0 }])).toEqual({ minX: -3, maxX: 2, minZ: -5, maxZ: 9 });
  });

  it('polylineLength sums segment lengths', () => {
    expect(polylineLength([{ x: 0, z: 0 }, { x: 3, z: 4 }, { x: 3, z: 14 }])).toBeCloseTo(15, 9);
  });
});
