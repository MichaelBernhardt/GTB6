import { describe, expect, it } from 'vitest';
import { ROAD_NETWORK } from './City';

describe('San Cordova road topology', () => {
  it('contains distinct arterials, loops, diagonals, and district roads', () => {
    expect(ROAD_NETWORK.length).toBeGreaterThanOrEqual(10);
    expect(new Set(ROAD_NETWORK.map((road) => road.name)).size).toBe(ROAD_NETWORK.length);
    expect(ROAD_NETWORK.some((road) => road.closed)).toBe(true);
    expect(ROAD_NETWORK.some((road) => road.points.some((point, index) => {
      const next = road.points[index + 1];
      return next && Math.abs(next.x - point.x) > 20 && Math.abs(next.z - point.z) > 20;
    }))).toBe(true);
    expect(ROAD_NETWORK.some((road) => road.name.includes('Harbor'))).toBe(true);
    expect(ROAD_NETWORK.some((road) => road.name.includes('Industrial') || road.name.includes('Foundry') || road.name.includes('Mercado'))).toBe(true);
  });
});
