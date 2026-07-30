/**
 * WHICH FOLIAGE IS WOOD.
 *
 * The owner could walk through large tree trunks: every scattered foliage model was skipped by the
 * collision pass, canopy and trunk alike. These tests pin the rule that replaced that blanket skip —
 * an authored trunk at or over SOLID_TRUNK_MIN_DIAMETER is a solid 'tree' prop, everything else
 * (canopies, hedges, aloes, bougainvillea, grass) stays passable — and pin the two behaviours the
 * rule has to produce: a walker is stopped, and a car is stopped hard rather than felling it.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import {
  buildTreeAsset, buildTreeInstance, installTreeLibrary, resetTreeLibraryForTests,
  SOLID_TRUNK_MIN_DIAMETER, TREE_SPECIES, trunkIsSolid,
} from './FoliageAssets';
import { trunkProp } from './City';
import { buildModel } from './models/catalog';
import { KNOCKOVER_MIN_SPEED, PropRegistry, PROP_TIERS, STANDABLE_PROPS } from '../systems/PropSystem';

let library: GLTF;

beforeAll(async () => {
  const file = await readFile(resolve('public/models/foliage/joburg-trees.glb'));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  library = await new GLTFLoader().parseAsync(buffer, '/models/foliage/');
});

afterEach(() => resetTreeLibraryForTests());

describe('the solid-trunk rule', () => {
  it('is a threshold on the authored trunk, so every instance of a species agrees', () => {
    // Deliberately read off the AUTHORED metadata rather than the ±16% per-tree scale jitter: two
    // visually identical gums must not disagree about whether they are a wall.
    expect(trunkIsSolid(SOLID_TRUNK_MIN_DIAMETER, SOLID_TRUNK_MIN_DIAMETER)).toBe(true);
    expect(trunkIsSolid(SOLID_TRUNK_MIN_DIAMETER - 0.01, SOLID_TRUNK_MIN_DIAMETER - 0.01)).toBe(false);
    expect(trunkIsSolid(0.2, SOLID_TRUNK_MIN_DIAMETER + 0.2)).toBe(true); // the wider axis decides
  });

  it('makes every species in the required library solid wood, with one trunk tier each', () => {
    installTreeLibrary(library);
    for (const species of TREE_SPECIES) for (const variant of [0, 1]) {
      const built = buildTreeAsset(species, 11 + variant, { variant });
      expect(built.tiers.length, `${species} v${variant}`).toBe(1);
      const trunk = built.tiers[0]!;
      const diameter = Math.max(trunk.maxX - trunk.minX, trunk.maxZ - trunk.minZ);
      // The tier is the trunk, not the canopy: a canopy-sized collider would wall off half a park.
      expect(diameter, `${species} v${variant} trunk`).toBeLessThan(2);
      expect(diameter).toBeLessThan(built.footprint.w / 2);
      expect(trunk.y0).toBe(0);
      expect(trunk.y1).toBeGreaterThan(2); // tall enough to stop a body, not a kerb you step over
      expect(buildTreeInstance(species, 11 + variant, { variant }).trunkSolid).toBe(true);
    }
  });

  it('leaves a slimmer authored trunk passable — no tier, no prop, walk on through', () => {
    // A sapling variant is a plausible future asset; the gate has to be the only decision, so prove
    // it by re-authoring one species' trunk metadata under the threshold.
    const sapling = library.scene.getObjectByName('JohannesburgTreeLibrary')!.children.find((child) => child.name === 'gum__0')!;
    const metadata = sapling.userData.treeAsset as { trunkCollider: number[] };
    const authored = metadata.trunkCollider;
    metadata.trunkCollider = [0.3, 0.3, authored[2]!];
    try {
      installTreeLibrary(library);
      const built = buildTreeAsset('gum', 3, { variant: 0 });
      expect(built.tiers).toEqual([]);
      expect(buildTreeInstance('gum', 3, { variant: 0 }).trunkSolid).toBe(false);
      expect(trunkProp(built, 10, 20)).toBeUndefined();
    } finally {
      metadata.trunkCollider = authored;
    }
  });
});

describe('trunkProp (the one place a tree becomes collision)', () => {
  it('turns an authored tree into a circular trunk at the placement, sized off the trunk tier', () => {
    installTreeLibrary(library);
    const built = buildTreeAsset('jacaranda', 42);
    const trunk = trunkProp(built, -120.5, 88.25)!;
    expect(trunk).toBeDefined();
    expect(trunk.x).toBe(-120.5); expect(trunk.z).toBe(88.25);
    const tier = built.tiers[0]!;
    expect(trunk.radius).toBeCloseTo(Math.max(tier.maxX - tier.minX, tier.maxZ - tier.minZ) / 2, 6);
    expect(trunk.height).toBeCloseTo(tier.y1 - tier.y0, 6);
    // A jacaranda is a metre of wood under a ten-metre canopy: the collider is the wood.
    expect(trunk.radius).toBeLessThan(0.5);
    expect(trunk.radius).toBeGreaterThan(0.25);
  });

  it('never makes procedural undergrowth solid, however big its own tiers are', () => {
    // hedge-unit and bougainvillea both declare collide tiers for their bodies, and a hedge is up to
    // 4.4 u across. You brush through a hedge; that is the whole point of the species check.
    for (const name of ['hedge-unit', 'bougainvillea', 'aloe', 'agave', 'veld-grass']) {
      const built = buildModel(name, 7);
      expect(trunkProp(built, 0, 0), name).toBeUndefined();
    }
  });
});

describe('what a solid trunk does', () => {
  const registry = (): { props: PropRegistry; radius: number } => {
    installTreeLibrary(library);
    const props = new PropRegistry();
    const trunk = trunkProp(buildTreeAsset('shade-tree', 5), 40, -60)!;
    props.register('tree', trunk.x, trunk.z, trunk.radius, trunk.height);
    return { props, radius: trunk.radius };
  };

  it('stops a walker at the bark and nowhere else', () => {
    const { props, radius } = registry();
    const body = 0.65; // PLAYER.radius
    expect(props.blocked(40, -60, body)).toBe(true);
    expect(props.blocked(40 + radius + body - 0.05, -60, body)).toBe(true);
    // One step further out and the pavement beside the tree is free — a trunk is not a wall.
    expect(props.blocked(40 + radius + body + 0.05, -60, body)).toBe(false);
    expect(props.blocked(40, -60 + radius + body + 0.05, body)).toBe(false);
  });

  it('stops a car dead instead of being felled like a bin, and is never something to stand on', () => {
    const { props } = registry();
    expect(PROP_TIERS.tree).toBe('solid');
    expect(STANDABLE_PROPS.has('tree')).toBe(false);
    expect(props.solidBlocked(40, -60, 1.4)).toBe(true);
    // A bakkie at speed: knock-over props tip and it ploughs on; a trunk fells nothing, so the
    // vehicle's normal blocked-move response (reverse impulse + solid-impact damage) is what runs.
    expect(props.tryKnockdown(40, -60, 1.4, KNOCKOVER_MIN_SPEED * 2, 1, 0)).toBe(0);
    expect(props.consumeKnockdowns()).toEqual([]);
    expect(props.blocked(40, -60, 1.4)).toBe(true);
  });
});
