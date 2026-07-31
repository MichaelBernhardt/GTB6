/**
 * The Tardis transform: interiors are clamped BIGGER than most of the buildings that hold them
 * (58.6% of the city exceeds its own massing on an axis), so any point that crosses from inside
 * to outside must map proportionally — by where it sits on the plate — never by raw units. These
 * tests pin the contract the roof exit uses today and the deferred windows work inherits.
 */
import { describe, expect, it } from 'vitest';
import { buildCore, CEILING, type BuildingFacts } from './core';
import {
  buildingLocalToInterior, clampInsideRect, FACADE_BAND, facadeHeight,
  interiorToBuildingLocal, tardisScale,
} from './tardis';

const facts = (over: Partial<BuildingFacts>): BuildingFacts => ({
  id: 'b', x: 1200, z: -800, heading: 0.7, width: 12, depth: 14, height: 11,
  style: 'downtown', entrance: 'lobby', doorX: 0, ...over,
});

describe('the horizontal Tardis mapping', () => {
  it('maps the plate edge exactly onto the footprint edge, however mismatched the two are', () => {
    // The measured worst case citywide: a 5.9 x 5.0 shed wearing a 15.1 x 21 interior (2.6x, 4.2x).
    const f = facts({ style: 'mixed-use', entrance: 'shopfront', width: 5.9, depth: 5.0, height: 3.9 });
    const core = buildCore(f);
    expect(core.width).toBeGreaterThan(f.width); // the premise: this IS a Tardis
    const edge = interiorToBuildingLocal(core, f, core.width / 2, core.depth / 2);
    expect(edge.x).toBeCloseTo(-f.width / 2, 6);
    expect(edge.z).toBeCloseTo(-f.depth / 2, 6);
    // A raw-unit mapping would have put the same point 7.55 u out — in the street, off the roof.
    expect(Math.abs(edge.x)).toBeLessThanOrEqual(f.width / 2 + 1e-6);
    expect(Math.abs(edge.z)).toBeLessThanOrEqual(f.depth / 2 + 1e-6);
  });

  it('flips sign: the interior frame is the building frame rotated a half turn', () => {
    const f = facts({});
    const core = buildCore(f);
    const p = interiorToBuildingLocal(core, f, 3, 4);
    expect(p.x).toBeLessThan(0);
    expect(p.z).toBeLessThan(0);
  });

  it('round-trips through its inverse', () => {
    const f = facts({ style: 'industrial', entrance: 'dock', width: 40, depth: 44, height: 12 });
    const core = buildCore(f);
    for (const [lx, lz] of [[0, 0], [2.5, -7], [-core.width / 2, core.depth / 3], [1e-3, 9]]) {
      const out = interiorToBuildingLocal(core, f, lx!, lz!);
      const back = buildingLocalToInterior(core, f, out.x, out.z);
      expect(back.x).toBeCloseTo(lx!, 9);
      expect(back.z).toBeCloseTo(lz!, 9);
    }
  });

  it('is anisotropic on real buildings — which is why directions must never pass through it', () => {
    const f = facts({ style: 'suburban', entrance: 'porch', width: 16, depth: 9, height: 3.6 });
    const k = tardisScale(buildCore(f), f);
    expect(k.kx).not.toBeCloseTo(k.kz, 2);
  });
});

describe('the facade height mapping', () => {
  it('keeps every interior eye inside the real building, floor for floor', () => {
    const f = facts({ height: 10.9 }); // 3 facade storeys
    const core = buildCore(f);
    expect(core.storeys).toBe(3);
    const storey = f.height / core.storeys;
    for (let floor = 0; floor < core.storeys; floor++) {
      const base = facadeHeight(core, f, floor, 0);
      const eye = facadeHeight(core, f, floor, 1.6);
      const top = facadeHeight(core, f, floor, CEILING);
      expect(base).toBeCloseTo(floor * storey, 6);
      expect(eye).toBeGreaterThan(base);
      expect(top).toBeGreaterThan(eye);
      // The ceiling of floor N stays under the base of floor N+1 (FACADE_BAND < 1: never in the slab).
      expect(top).toBeLessThan((floor + 1) * storey);
    }
    // And the top floor's ceiling stays under the building's own roof.
    expect(facadeHeight(core, f, core.storeys - 1, CEILING)).toBeLessThan(f.height);
    expect(FACADE_BAND).toBeLessThan(1);
  });

  it('never maps interior height one-to-one: a 3rd-storey eye on a short building stays on it', () => {
    const f = facts({ height: 10.9 });
    const core = buildCore(f);
    // Interior stacking puts floor 2's eye at 2·5.7 + 1.6 = 13 u — above this building's whole roof.
    expect(facadeHeight(core, f, 2, 1.6)).toBeLessThan(f.height);
  });
});

describe('clampInsideRect', () => {
  const rect = { minX: -4, maxX: 4, minZ: -6, maxZ: 2 };

  it('leaves interior points alone and pulls exterior points to the inset border', () => {
    expect(clampInsideRect(rect, 0, -1, 1)).toEqual({ x: 0, z: -1 });
    expect(clampInsideRect(rect, 9, -9, 1)).toEqual({ x: 3, z: -5 });
    expect(clampInsideRect(rect, -9, 9, 1)).toEqual({ x: -3, z: 1 });
  });

  it('collapses a rect too small for the inset to its centre instead of inverting', () => {
    const sliver = { minX: -0.5, maxX: 0.5, minZ: -6, maxZ: 2 };
    expect(clampInsideRect(sliver, 3, 3, 1)).toEqual({ x: 0, z: 1 });
  });
});
