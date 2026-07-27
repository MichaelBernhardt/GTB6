/**
 * The door is a fact, not a guess — so the plan and the build must be the same building.
 *
 * `plan()` exists so anything that needs a building's shape (the interior feature asks every parcel
 * on a block where its front door is) can have it without allocating the meshes. That is only safe
 * while the two paths agree EXACTLY, which is what this suite holds: identical tiers, identical
 * gables, identical entrance, across every structural family and every variant of each.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_VARIANTS,
  BuildingArchitecture,
  frontFacadeZAt,
  planEntrance,
  type BuildingStyle,
} from './BuildingArchitecture';

const STYLES = Object.keys(ARCHITECTURE_VARIANTS) as BuildingStyle[];

function specFor(style: BuildingStyle, variant: number): Parameters<BuildingArchitecture['build']>[0] {
  // Sizes stay inside the ranges CityGen's ZONE_SHAPE actually produces for each style.
  const size: Record<BuildingStyle, [number, number, number]> = {
    downtown: [34, 30, 68],
    'mixed-use': [18, 18, 16],
    'dense-residential': [21, 12, 22],
    suburban: [19, 11, 8],
    industrial: [36, 30, 12],
    estate: [70, 40, 10],
    rural: [55, 11, 6],
  };
  const [width, depth, height] = size[style];
  return {
    x: 0, z: 0, width, depth, height, style, variant,
    facade: new THREE.MeshBasicMaterial(), roof: new THREE.MeshBasicMaterial(),
  };
}

describe('BuildingArchitecture.plan', () => {
  it('reproduces build() tiers, gables and entrance for every family and variant', () => {
    const drawn = new BuildingArchitecture(new THREE.Group());
    const planner = new BuildingArchitecture(new THREE.Group());
    for (const style of STYLES) {
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style] * 2; variant++) {
        const built = drawn.build(specFor(style, variant));
        const planned = planner.plan(specFor(style, variant));
        expect(planned.tiers, `${style}#${variant} tiers`).toEqual(built.tiers);
        expect(planned.gables, `${style}#${variant} gables`).toEqual(built.gables);
        expect(planned.roofY, `${style}#${variant} roofY`).toBe(built.roofY);
        expect(planned.entrance, `${style}#${variant} entrance`).toEqual(built.entrance);
      }
    }
  });

  it('adds nothing to the scene while planning', () => {
    const parent = new THREE.Group();
    const planner = new BuildingArchitecture(parent);
    for (const style of STYLES) planner.plan(specFor(style, 0));
    expect(parent.children).toHaveLength(0);
  });

  it('puts every tagged door on a real front wall at door height, never on the parcel edge', () => {
    const planner = new BuildingArchitecture(new THREE.Group());
    let tagged = 0;
    for (const style of STYLES) {
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style]; variant++) {
        const spec = specFor(style, variant);
        const profile = planner.plan(spec);
        if (!profile.entrance) continue;
        tagged++;
        const door = profile.entrance;
        // The wall the leaf hangs on has to exist at exactly the plane the tag names.
        expect(frontFacadeZAt(profile.tiers, door.x, 1.72, door.width / 2)).toBe(door.z);
        // ...and it must be a wall of THIS building, never beyond the parcel it stands on.
        expect(door.z).toBeLessThanOrEqual(spec.depth / 2 + 1.7);
        expect(door.width).toBeGreaterThan(1);
      }
    }
    expect(tagged).toBeGreaterThan(20);
  });

  it('agrees with the facade rule: an undetailed building draws no leaf, so it offers no door', () => {
    const planner = new BuildingArchitecture(new THREE.Group());
    // suburban #1 is odd-numbered and not one of the always-detailed families.
    expect(planner.plan(specFor('suburban', 1)).entrance).toBeUndefined();
    expect(planEntrance(19, 'suburban', 1, planner.plan(specFor('suburban', 1)).tiers)).toBeUndefined();
    // downtown is always detailed, whatever the variant's parity.
    expect(planner.plan(specFor('downtown', 1)).entrance).toBeDefined();
  });

  it('finds the real front plane where the massing is set back from the parcel edge', () => {
    const planner = new BuildingArchitecture(new THREE.Group());
    // dense-residential #0 puts its slab at z − 0.29·d with only 0.42·d of depth: the front wall is
    // well BEHIND the parcel edge, which is the case a depth/2 guess gets wrong by metres.
    const spec = specFor('dense-residential', 0);
    const door = planner.plan(spec).entrance;
    expect(door).toBeDefined();
    expect(spec.depth / 2 - door!.z).toBeGreaterThan(1);
  });
});
