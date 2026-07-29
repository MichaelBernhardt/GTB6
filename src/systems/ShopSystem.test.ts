import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { colliderOverlapsXZ, type City } from '../world/City';
import { placedCollider, placedPoint, SHOPS, ShopSystem } from './ShopSystem';

describe('placed shop transforms', () => {
  it('maps local points with the same rotation convention as the shop group', () => {
    expect(placedPoint({ x: 10, z: 20, heading: 0 }, 2, -3)).toEqual({ x: 12, z: 17 });
    const quarter = placedPoint({ x: 10, z: 20, heading: Math.PI / 2 }, 2, -3);
    expect(quarter.x).toBeCloseTo(7); expect(quarter.z).toBeCloseTo(18);
  });

  it('leaves an exact gap between split storefront colliders', () => {
    const site = { x: 0, z: 0, heading: 0 };
    const left = placedCollider(site, -5.9, -1.18, 3.64, 4, 5.2);
    const right = placedCollider(site, 1.18, 5.9, 3.64, 4, 5.2);
    expect(left.maxX).toBeCloseTo(-1.18);
    expect(right.minX).toBeCloseTo(1.18);
    expect(left.maxX).toBeLessThan(0); expect(right.minX).toBeGreaterThan(0);
  });
});

describe('Jozi Arms walk-in contract', () => {
  it('keeps the doorway open and transfers the hint to the indoor shop trigger', () => {
    const snapshot = SHOPS.map((shop) => ({ shop, pad: shop.pad.clone(), radius: shop.radius }));
    const city = {
      colliders: [],
      terrainHeightAt: () => 0,
      surfaceHeightAt: () => 0,
    } as unknown as City;
    try {
      const system = new ShopSystem(new THREE.Scene(), city);
      const interior = system.group.getObjectByName('Jozi Arms Interior')!;
      const site = { x: interior.position.x, z: interior.position.z, heading: interior.rotation.y };
      const outside = placedPoint(site, 0, 4.55);
      const inside = placedPoint(site, 0, -0.75);
      const doorway = placedPoint(site, 0, 3.82);
      const frontage = placedPoint(site, 3.5, 3.82);

      expect(system.walkInNear(new THREE.Vector3(outside.x, 0, outside.z))?.name).toBe('Jozi Arms');
      expect(system.shopNear(new THREE.Vector3(outside.x, 0, outside.z))).toBeUndefined();
      expect(system.shopNear(new THREE.Vector3(inside.x, 0, inside.z))?.name).toBe('Jozi Arms');
      expect(system.walkInNear(new THREE.Vector3(inside.x, 0, inside.z))).toBeUndefined();
      expect(city.colliders.some((box) => colliderOverlapsXZ(box, doorway.x, doorway.z, 0.42))).toBe(false);
      expect(city.colliders.some((box) => colliderOverlapsXZ(box, frontage.x, frontage.z, 0.42))).toBe(true);
    } finally {
      for (const { shop, pad, radius } of snapshot) { shop.pad.copy(pad); shop.radius = radius; }
    }
  });
});
