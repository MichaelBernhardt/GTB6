import { describe, expect, it } from 'vitest';
import { CBD_CENTER, MAP_WORLD_SIZE } from '../mapData';
import { SPAWN_POINT } from '../placements';
import { inBuildZone, TEST_BUILDING_BUDGET, TEST_BUILDING_ZONES } from './cityBuild';

const HALF = MAP_WORLD_SIZE / 2;
// Zone radii scale with the footprint (P in cityBuild.ts); these sanity bounds track it too.
const SCALE = MAP_WORLD_SIZE / 6000;

describe('CBD test-building zones (data-driven massing scope)', () => {
  it('anchors every zone inside the world and around the CBD', () => {
    expect(TEST_BUILDING_ZONES.length).toBeGreaterThan(0);
    for (const zone of TEST_BUILDING_ZONES) {
      expect(Math.abs(zone.x) + zone.radius, `${zone.name} within +/-X`).toBeLessThan(HALF);
      expect(Math.abs(zone.z) + zone.radius, `${zone.name} within +/-Z`).toBeLessThan(HALF);
      expect(zone.radius, `${zone.name} radius sane`).toBeGreaterThan(80 * SCALE);
      expect(zone.radius, `${zone.name} radius sane`).toBeLessThan(700 * SCALE);
      // Every zone sits in/near the CBD district so this build populates the inner city, not the veld.
      expect(Math.hypot(zone.x - CBD_CENTER.x, zone.z - CBD_CENTER.z), `${zone.name} near CBD`).toBeLessThan(CBD_CENTER.radius + 200 * SCALE);
    }
  });

  it('covers the player spawn so there are blocks to drive around', () => {
    expect(inBuildZone(SPAWN_POINT.x, SPAWN_POINT.z)).toBe(true);
  });

  it('leaves the far corners of the 36000u map as bare roads', () => {
    for (const [x, z] of [[HALF - 50, HALF - 50], [-(HALF - 50), -(HALF - 50)], [HALF - 50, -(HALF - 50)], [0, -(HALF - 50)]] as const) {
      expect(inBuildZone(x, z), `(${x},${z}) unpopulated`).toBe(false);
    }
  });

  it('keeps the round massing budget bounded for predictable draw calls near spawn', () => {
    expect(TEST_BUILDING_BUDGET).toBeGreaterThan(40); // enough for a real sense of scale
    expect(TEST_BUILDING_BUDGET).toBeLessThanOrEqual(500); // but not a whole-map flood
  });

  it('is a pure, deterministic predicate (same inputs → same answer)', () => {
    const probe: Array<[number, number]> = [
      [SPAWN_POINT.x, SPAWN_POINT.z],
      [CBD_CENTER.x, CBD_CENTER.z],
      [SPAWN_POINT.x + 5000, SPAWN_POINT.z],
    ];
    for (const [x, z] of probe) expect(inBuildZone(x, z)).toBe(inBuildZone(x, z));
  });
});
