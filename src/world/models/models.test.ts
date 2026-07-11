/**
 * Headless catalog verification: every model must build for several seeds and all its variants,
 * produce real geometry with valid materials, stay inside its declared footprint bounds, keep its
 * collider tiers inside the footprint, and rebuild identically from the same seed.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MODEL_CATALOG, MODEL_INDEX, buildModel } from './catalog';

const SEEDS = [1, 7, 42, 1337];
const MAX_MESHES = 130;

function meshStats(group: THREE.Group): { count: number; signature: string } {
  let count = 0; const parts: string[] = [];
  group.updateWorldMatrix(true, true);
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    count++;
    expect(object.material).toBeTruthy();
    const position = object.geometry.getAttribute('position');
    expect(position.count).toBeGreaterThan(0);
    const p = object.getWorldPosition(new THREE.Vector3());
    parts.push(`${position.count}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`);
  });
  return { count, signature: parts.sort().join('|') };
}

describe('structure model catalog', () => {
  it('has unique names, sane metadata, and covers every required category', () => {
    expect(new Set(MODEL_CATALOG.map((def) => def.name)).size).toBe(MODEL_CATALOG.length);
    for (const category of ['rural', 'commercial', 'industrial', 'coastal', 'residential', 'civic'] as const) {
      expect(MODEL_CATALOG.filter((def) => def.category === category).length).toBeGreaterThanOrEqual(5);
    }
    for (const def of MODEL_CATALOG) {
      expect(def.variants).toBeGreaterThanOrEqual(2);
      expect(def.zones.length).toBeGreaterThan(0);
      expect(def.spacing).toBeGreaterThan(0);
      expect(def.maxFootprint.w).toBeGreaterThan(0); expect(def.maxFootprint.d).toBeGreaterThan(0);
    }
    expect(MODEL_INDEX.get('windpomp')).toBeDefined();
    expect(() => buildModel('nope', 1)).toThrow();
  });

  for (const def of MODEL_CATALOG) {
    describe(def.name, () => {
      for (const seed of SEEDS) {
        it(`builds sane geometry for seed ${seed} across all ${def.variants} variants`, () => {
          for (let variant = 0; variant < def.variants; variant++) {
            const built = def.build(seed, { variant });
            const { count } = meshStats(built.group);
            expect(count).toBeGreaterThanOrEqual(3);
            expect(count).toBeLessThanOrEqual(MAX_MESHES);

            const bounds = new THREE.Box3().setFromObject(built.group);
            for (const tier of built.tiers) { // the footprint is the union of meshes and collider tiers
              bounds.min.x = Math.min(bounds.min.x, tier.minX); bounds.max.x = Math.max(bounds.max.x, tier.maxX);
              bounds.min.z = Math.min(bounds.min.z, tier.minZ); bounds.max.z = Math.max(bounds.max.z, tier.maxZ);
            }
            const size = bounds.getSize(new THREE.Vector3());
            expect(size.x).toBeGreaterThan(1); expect(size.y).toBeGreaterThan(1); expect(size.z).toBeGreaterThan(0.8);
            // Recentred on the origin, inside the returned footprint, inside the declared catalog bound.
            expect(Math.abs(bounds.min.x + bounds.max.x)).toBeLessThan(0.01);
            expect(Math.abs(bounds.min.z + bounds.max.z)).toBeLessThan(0.01);
            expect(size.x).toBeLessThanOrEqual(built.footprint.w + 1e-3);
            expect(size.z).toBeLessThanOrEqual(built.footprint.d + 1e-3);
            expect(built.footprint.w).toBeLessThanOrEqual(def.maxFootprint.w);
            expect(built.footprint.d).toBeLessThanOrEqual(def.maxFootprint.d);
            // Grounded at y≈0 with real height above it.
            expect(bounds.min.y).toBeGreaterThanOrEqual(-0.8);
            expect(bounds.min.y).toBeLessThanOrEqual(0.4);
            expect(bounds.max.y).toBeGreaterThan(1);

            expect(built.tiers.length).toBeGreaterThan(0);
            for (const tier of built.tiers) {
              expect(tier.maxX).toBeGreaterThan(tier.minX);
              expect(tier.maxZ).toBeGreaterThan(tier.minZ);
              expect(tier.y1).toBeGreaterThan(tier.y0);
              expect(tier.y0).toBeGreaterThanOrEqual(-0.5);
              expect(tier.minX).toBeGreaterThanOrEqual(-built.footprint.w / 2 - 0.05);
              expect(tier.maxX).toBeLessThanOrEqual(built.footprint.w / 2 + 0.05);
              expect(tier.minZ).toBeGreaterThanOrEqual(-built.footprint.d / 2 - 0.05);
              expect(tier.maxZ).toBeLessThanOrEqual(built.footprint.d / 2 + 0.05);
            }
            // Standable models must offer a platform tier the player could actually occupy.
            if (def.standable) {
              expect(built.tiers.some((tier) => tier.y1 >= 0.4 && (tier.maxX - tier.minX) * (tier.maxZ - tier.minZ) >= 1)).toBe(true);
            }
          }
        });
      }

      it('rebuilds identically from the same seed', () => {
        const first = def.build(7, {});
        const second = def.build(7, {});
        expect(meshStats(second.group).signature).toBe(meshStats(first.group).signature);
        expect(second.footprint).toEqual(first.footprint);
        expect(second.tiers).toEqual(first.tiers);
      });
    });
  }
});
