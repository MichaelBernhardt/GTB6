/**
 * Headless verification of the procedural building families: every (style, massing) variant must
 * build real meshes with collision tiers that mirror the massing, reach its spec height, and be
 * structurally distinct from its siblings (no two variants collapsing into the same massing).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, type BuildingProfile, type BuildingStyle } from './BuildingArchitecture';

const facade = new THREE.MeshStandardMaterial();
const roof = new THREE.MeshStandardMaterial();
/** Representative parcel sizes per style (mid-range of the CityGen ZONE_SHAPE bands). */
const SIZES: Record<BuildingStyle, { w: number; d: number; h: number }> = {
  downtown: { w: 26, d: 24, h: 60 },
  residential: { w: 16, d: 11, h: 8 },
  industrial: { w: 30, d: 26, h: 12 },
  estate: { w: 40, d: 28, h: 9 },
};

const build = (style: BuildingStyle, variant: number): { parent: THREE.Group; profile: BuildingProfile } => {
  const parent = new THREE.Group();
  const { w, d, h } = SIZES[style];
  const profile = new BuildingArchitecture(parent).build({ x: 0, z: 0, width: w, depth: d, height: h, style, variant, facade, roof });
  return { parent, profile };
};

describe('procedural building families', () => {
  for (const style of Object.keys(ARCHITECTURE_VARIANTS) as BuildingStyle[]) {
    it(`builds every ${style} massing with real meshes and mirrored collision tiers`, () => {
      const { w, d, h } = SIZES[style];
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style]; variant++) {
        const { parent, profile } = build(style, variant);
        expect(profile.massing).toBe(variant);
        expect(profile.tiers.length).toBeGreaterThan(0);
        expect(profile.roofY).toBeGreaterThan(Math.min(h * 0.7, h - 1)); // every family reaches its parcel height
        // The collision registry mirrors the massing: no tier floats above the reported roof and every
        // tier stays near the parcel (garden walls may sit just outside the w×d mass, never further).
        for (const tier of profile.tiers) {
          expect(tier.y1).toBeGreaterThan(tier.y0);
          expect(tier.y1).toBeLessThanOrEqual(profile.roofY + 1e-6);
          expect(Math.max(Math.abs(tier.minX), Math.abs(tier.maxX))).toBeLessThanOrEqual(w / 2 + 1.6);
          expect(Math.max(Math.abs(tier.minZ), Math.abs(tier.maxZ))).toBeLessThanOrEqual(d / 2 + 1.6);
        }
        let meshes = 0;
        parent.traverse((object) => { if (object instanceof THREE.Mesh) meshes++; });
        expect(meshes).toBeGreaterThanOrEqual(3);
      }
    });

    it(`gives every ${style} variant a distinct massing (families don't collapse into one another)`, () => {
      const signatures = new Set<string>();
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style]; variant++) {
        const { profile } = build(style, variant);
        signatures.add(profile.tiers.map((t) => [t.minX, t.maxX, t.minZ, t.maxZ, t.y0, t.y1].map((v) => v.toFixed(2)).join(',')).sort().join('|'));
      }
      expect(signatures.size).toBe(ARCHITECTURE_VARIANTS[style]);
    });

    it(`rebuilds a ${style} variant deterministically`, () => {
      const first = build(style, 1).profile;
      const second = build(style, 1).profile;
      expect(second.tiers).toEqual(first.tiers);
      expect(second.roofY).toBe(first.roofY);
    });
  }
});
