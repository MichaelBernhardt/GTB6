import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { colliderOverlapsXZ, type City } from '../world/City';
import { placedPoint } from './ShopSystem';
import { canEnterSafehouse, SAFEHOUSE_IDS, SAFEHOUSES, SafehouseSystem, safehouseSpawn, SIGHTING_GRACE, SLEEP_HOURS, sleepHour } from './SafehouseSystem';

describe('sleep clock math', () => {
  it('advances six game hours by default', () => {
    expect(SLEEP_HOURS).toBe(6);
    expect(sleepHour(10)).toBe(16);
    expect(sleepHour(0)).toBe(6);
  });

  it('wraps across midnight into [0, 24)', () => {
    expect(sleepHour(22)).toBe(4);
    expect(sleepHour(23.5)).toBeCloseTo(5.5);
    expect(sleepHour(18)).toBe(0);
  });

  it('normalizes out-of-range hours and custom durations', () => {
    expect(sleepHour(-3)).toBe(3);
    expect(sleepHour(47)).toBe(5);
    expect(sleepHour(20, 12)).toBe(8);
    for (const hour of [0, 3.7, 12, 23.99]) { const slept = sleepHour(hour); expect(slept).toBeGreaterThanOrEqual(0); expect(slept).toBeLessThan(24); }
  });
});

describe('entry gating', () => {
  it('always admits an unwanted player, even mid-sighting decay', () => {
    expect(canEnterSafehouse(false, null)).toBe(true);
    expect(canEnterSafehouse(false, 0)).toBe(true);
  });

  it('never blocks on pending reports alone: no sighting means the door is open', () => {
    expect(canEnterSafehouse(true, null)).toBe(true);
  });

  it('locks the door while a police sighting is fresh', () => {
    expect(canEnterSafehouse(true, 0)).toBe(false);
    expect(canEnterSafehouse(true, SIGHTING_GRACE - 0.1)).toBe(false);
  });

  it('unlocks once the sighting goes stale', () => {
    expect(canEnterSafehouse(true, SIGHTING_GRACE)).toBe(true);
    expect(canEnterSafehouse(true, 120)).toBe(true);
    expect(canEnterSafehouse(true, 1, 1)).toBe(true);
  });
});

describe('safehouse spawn', () => {
  it('produces a fresh tuple matching the place definition', () => {
    const place = SAFEHOUSES[0]!;
    const spawn = safehouseSpawn(place);
    expect(spawn).toEqual(place.spawn);
    expect(spawn).not.toBe(place.spawn);
    spawn[0] += 99;
    expect(place.spawn[0]).not.toBe(spawn[0]);
  });

  it('keeps every spawn on its entry pad so respawn lands at the door', () => {
    for (const place of SAFEHOUSES) expect(Math.hypot(place.spawn[0] - place.pad.x, place.spawn[2] - place.pad.z)).toBeLessThan(place.radius);
  });

  it('registers exactly the ids known to the save schema', () => {
    expect(SAFEHOUSES.map((place) => place.id)).toEqual([...SAFEHOUSE_IDS]);
  });
});

describe('Main Main Mansions walk-in contract', () => {
  it('keeps both gate and door open, then hands the exterior hint to the indoor save trigger', () => {
    const place = SAFEHOUSES[0]!;
    const snapshot = { pad: place.pad.clone(), radius: place.radius, spawn: [...place.spawn] as [number, number, number] };
    const city = {
      colliders: [],
      terrainHeightAt: () => 0,
      surfaceHeightAt: () => 0,
    } as unknown as City;
    try {
      const system = new SafehouseSystem(new THREE.Scene(), city);
      const interior = system.group.getObjectByName('Main Main Mansions Interior')!;
      const site = { x: interior.position.x, z: interior.position.z, heading: interior.rotation.y };
      const outside = placedPoint(site, 0, 4.55);
      const inside = placedPoint(site, 0, 0.25);
      const doorway = placedPoint(site, 0, 3.35);
      const frontage = placedPoint(site, 3, 3.35);

      expect(system.walkInNear(new THREE.Vector3(outside.x, 0, outside.z))?.name).toBe('Main Main Mansions');
      expect(system.near(new THREE.Vector3(outside.x, 0, outside.z))).toBeUndefined();
      expect(system.near(new THREE.Vector3(inside.x, 0, inside.z))?.name).toBe('Main Main Mansions');
      expect(system.walkInNear(new THREE.Vector3(inside.x, 0, inside.z))).toBeUndefined();
      expect(city.colliders.some((box) => colliderOverlapsXZ(box, doorway.x, doorway.z, 0.42))).toBe(false);
      expect(city.colliders.some((box) => colliderOverlapsXZ(box, frontage.x, frontage.z, 0.42))).toBe(true);
    } finally {
      place.pad.copy(snapshot.pad); place.radius = snapshot.radius; place.spawn = snapshot.spawn;
    }
  });
});
