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
        // The wall the leaf hangs on has to exist at exactly the plane the tag names — and it is a
        // wall of the BUILDING, so the search that found it never saw the garden wall in front of it.
        const mass = profile.tiers.filter((tier) => tier.kind !== 'wall');
        expect(frontFacadeZAt(mass, door.x, 1.72, door.width / 2), `${style}#${variant}`).toBe(door.z);
        // ...and it must be a wall of THIS building, never beyond the parcel it stands on.
        expect(door.z, `${style}#${variant}`).toBeLessThanOrEqual(spec.depth / 2 + 1.7);
        expect(door.width).toBeGreaterThan(1);
        expect(door.height).toBeGreaterThan(2);
      }
    }
    expect(tagged).toBeGreaterThan(20);
  });

  /**
   * The rule this replaced was `variant % 2 === 0 || an always-detailed family` — the facade pass's
   * own ornament test, borrowed on the argument that a building with no drawn leaf must not offer a
   * door. It shut 757 of the city's 3,722 parcels, nearly all of them houses. The tag is what City
   * draws the leaf FROM, so the argument ran backwards: tagging the building makes the model draw a
   * door. Every family, every variant, both parities.
   */
  it('gives every structural family and every variant a way in, whatever the ornament rule says', () => {
    const planner = new BuildingArchitecture(new THREE.Group());
    for (const style of STYLES) {
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style] * 2; variant++) {
        expect(planner.plan(specFor(style, variant)).entrance, `${style}#${variant} has no way in`).toBeDefined();
      }
    }
    // The odd-variant house that used to be the worked example of a shut building.
    expect(planner.plan(specFor('suburban', 1)).entrance).toBeDefined();
    expect(planEntrance(19, 'suburban', planner.plan(specFor('suburban', 1)).tiers)).toBeDefined();
  });

  it('hangs an estate front door on the villa, never on the garden wall standing in front of it', () => {
    const planner = new BuildingArchitecture(new THREE.Group());
    let walled = 0;
    for (let variant = 0; variant < ARCHITECTURE_VARIANTS.estate; variant++) {
      const profile = planner.plan(specFor('estate', variant));
      const door = profile.entrance!;
      expect(door, `estate#${variant} has no way in`).toBeDefined();
      // Most estate massings put a gated perimeter wall well in FRONT of the villa. That wall is
      // the frontmost street-facing surface on the parcel, so a search that could see it would hang
      // the leaf on it — which is the doorstep-in-the-front-yard bug the tag exists to prevent.
      const walls = profile.tiers.filter((tier) => tier.kind === 'wall');
      if (walls.length === 0) continue;
      walled++;
      expect(door.z, `estate#${variant} door is on the boundary wall`).toBeLessThan(Math.max(...walls.map((tier) => tier.maxZ)));
    }
    expect(walled, 'no estate massing draws a perimeter wall any more').toBeGreaterThan(3);
  });

  it('finds the wall on a massing with nothing across its centre line', () => {
    const planner = new BuildingArchitecture(new THREE.Group());
    // suburban #4 is two detached gabled wings either side of the centre: there is no wall at x = 0
    // at all, so the old centre-only search left it blank-faced and shut.
    const profile = planner.plan(specFor('suburban', 4));
    const door = profile.entrance!;
    expect(door).toBeDefined();
    expect(Math.abs(door.x), 'the door stayed on the empty centre line').toBeGreaterThan(1);
    expect(frontFacadeZAt(profile.tiers, door.x, 1.72, door.width / 2)).toBe(door.z);
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
