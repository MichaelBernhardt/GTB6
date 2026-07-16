/**
 * Headless catalog verification: every model must build for several seeds and all its variants,
 * produce real geometry with valid materials, stay inside its declared footprint bounds, keep its
 * collider tiers inside the footprint, and rebuild identically from the same seed.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { installTreeLibrary, resetTreeLibraryForTests } from '../FoliageAssets';
import { MODEL_CATALOG, MODEL_INDEX, buildModel } from './catalog';

const SEEDS = [1, 7, 42, 1337];
const MAX_MESHES = 130;

beforeAll(async () => {
  const file = await readFile(resolve('public/models/foliage/joburg-trees.glb'));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  installTreeLibrary(await new GLTFLoader().parseAsync(buffer, '/models/foliage/'));
});
afterAll(() => resetTreeLibraryForTests());

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
    for (const category of ['rural', 'commercial', 'industrial', 'coastal', 'residential', 'civic', 'foliage'] as const) {
      expect(MODEL_CATALOG.filter((def) => def.category === category).length).toBeGreaterThanOrEqual(5);
    }
    for (const def of MODEL_CATALOG) {
      expect(def.variants).toBeGreaterThanOrEqual(2);
      expect(def.zones.length).toBeGreaterThan(0);
      expect(def.spacing).toBeGreaterThan(0);
      expect(def.maxFootprint.w).toBeGreaterThan(0); expect(def.maxFootprint.d).toBeGreaterThan(0);
    }
    expect(MODEL_INDEX.get('windpomp')).toBeDefined();
    for (const name of [
      'mixed-use-corner', 'parking-garage', 'semi-detached-house', 'walk-up-flats',
      'rdp-row', 'workshop-row', 'logistics-depot', 'farm-worker-cottages',
    ]) expect(MODEL_INDEX.get(name), name).toBeDefined();
    expect(() => buildModel('nope', 1)).toThrow();
  });

  for (const def of MODEL_CATALOG) {
    describe(def.name, () => {
      for (const seed of SEEDS) {
        it(`builds sane geometry for seed ${seed} across all ${def.variants} variants`, () => {
          for (let variant = 0; variant < def.variants; variant++) {
            const built = def.build(seed, { variant });
            const { count } = meshStats(built.group);
            expect(count).toBeGreaterThanOrEqual(built.group.userData.assetSource === 'blender' ? 1 : 3);
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

            // Foliage dressing (grass tufts) may legitimately have no collider at all.
            if (def.category !== 'foliage') expect(built.tiers.length).toBeGreaterThan(0);
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

// ---- Foliage set ------------------------------------------------------------------------------

const FOLIAGE = ['jacaranda', 'shade-tree', 'gum', 'pine', 'acacia', 'palm', 'aloe', 'agave', 'bougainvillea', 'veld-grass', 'hedge-unit', 'landmark-tree'];
/** Everything except grass dressing is solid somewhere — a trunk, core, or clipped body. */
const TRUNK_COLLIDERS = FOLIAGE.filter((name) => name !== 'veld-grass');
/** Trees whose colliders must stay trunk-slim so the player walks under the canopy, not into it. */
const SLIM_TRUNKS = ['jacaranda', 'shade-tree', 'gum', 'pine', 'acacia', 'palm', 'landmark-tree'];
/** Instancing budget: worst-case triangles per build (foliage scatters in the thousands). */
const TRI_BUDGET: Record<string, number> = {
  'jacaranda': 300, 'shade-tree': 340, 'gum': 300, 'pine': 240, 'acacia': 300, 'palm': 260,
  'aloe': 420, 'agave': 240, 'bougainvillea': 200, 'veld-grass': 130, 'hedge-unit': 200, 'landmark-tree': 500,
};

function triangleCount(group: THREE.Group): number {
  let triangles = 0;
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    triangles += (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
  });
  return triangles;
}

describe('foliage set', () => {
  it('registers every foliage model as non-standable scatter', () => {
    for (const name of FOLIAGE) {
      const def = MODEL_INDEX.get(name);
      expect(def, name).toBeDefined();
      expect(def!.category).toBe('foliage');
      expect(def!.standable).toBe(false);
    }
  });

  for (const name of TRUNK_COLLIDERS) {
    it(`${name} exposes a solid collider tier for every seed and variant`, () => {
      const def = MODEL_INDEX.get(name)!;
      for (const seed of SEEDS) {
        for (let variant = 0; variant < def.variants; variant++) {
          const built = def.build(seed, { variant });
          expect(built.tiers.length).toBeGreaterThan(0);
          expect(built.tiers.some((tier) => tier.y1 - tier.y0 >= 0.5)).toBe(true);
          if (SLIM_TRUNKS.includes(name)) { // canopy must not collide — every tier stays trunk-sized
            for (const tier of built.tiers) {
              expect(tier.maxX - tier.minX).toBeLessThanOrEqual(3);
              expect(tier.maxZ - tier.minZ).toBeLessThanOrEqual(3);
            }
          }
        }
      }
    });
  }

  it('veld-grass is pure dressing with no collider', () => {
    for (const seed of SEEDS) expect(buildModel('veld-grass', seed).tiers).toEqual([]);
  });

  it('stays inside its per-model instancing triangle budget', () => {
    for (const name of FOLIAGE) {
      const def = MODEL_INDEX.get(name)!;
      for (const seed of SEEDS) {
        for (let variant = 0; variant < def.variants; variant++) {
          expect(triangleCount(def.build(seed, { variant }).group), `${name} v${variant} seed ${seed}`).toBeLessThanOrEqual(TRI_BUDGET[name]!);
        }
      }
    }
  });

  it('builds every tree exclusively from disposable Blender asset geometry', () => {
    for (const name of SLIM_TRUNKS) {
      const first = buildModel(name, 11, { variant: 0 }); const second = buildModel(name, 11, { variant: 0 });
      expect(first.group.userData.assetSource, name).toBe('blender');
      const firstGeometry: THREE.BufferGeometry[] = []; const secondGeometry: THREE.BufferGeometry[] = [];
      first.group.traverse((object) => { if (object instanceof THREE.Mesh) firstGeometry.push(object.geometry); });
      second.group.traverse((object) => { if (object instanceof THREE.Mesh) secondGeometry.push(object.geometry); });
      expect(firstGeometry.length).toBeGreaterThan(0);
      expect(secondGeometry).toHaveLength(firstGeometry.length);
      for (let index = 0; index < firstGeometry.length; index++) expect(secondGeometry[index]).not.toBe(firstGeometry[index]);
    }
  });

  it('keeps Blender-authored palm fronds and jacaranda bloom materials variant-specific', () => {
    const materialNames = (name: string, variant: number): Set<string> => {
      const names = new Set<string>();
      buildModel(name, 11, { variant }).group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) names.add(material.name);
      });
      return names;
    };
    expect(materialNames('palm', 0)).toContain('PalmFrond');
    expect(materialNames('palm', 1)).toContain('PalmDry');
    expect(materialNames('jacaranda', 1)).toContain('JacarandaBloom');
    expect(materialNames('jacaranda', 0)).not.toContain('JacarandaBloom');
    expect(materialNames('landmark-tree', 1)).toContain('CoralBloom');
    expect(materialNames('landmark-tree', 0)).not.toContain('CoralBloom');
  });
});
