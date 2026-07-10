import { describe, expect, it } from 'vitest';
import { PARK_AREAS, ROAD_NETWORK } from './City';
import { CITY_JUNCTIONS } from './UrbanInfrastructure';

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

  it('reserves varied public spaces across multiple districts', () => {
    expect(PARK_AREAS).toHaveLength(3);
    expect(new Set(PARK_AREAS.map((park) => park.kind)).size).toBe(3);
    expect(PARK_AREAS.every((park) => park.width >= 50 && park.depth >= 38)).toBe(true);
  });

  it('defines named, independently phased signalized intersections', () => {
    expect(CITY_JUNCTIONS.length).toBeGreaterThanOrEqual(7);
    expect(CITY_JUNCTIONS.every((junction) => junction.roadA.length > 0 && junction.roadB.length > 0)).toBe(true);
    expect(new Set(CITY_JUNCTIONS.map((junction) => junction.phase)).size).toBe(CITY_JUNCTIONS.length);
  });
});
