import * as THREE from 'three';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFeature } from './interiors';
import { findStagePlot, PLOT_FLATNESS, PLOT_RADIUS } from './stage';
import { interiorDoors } from '../interiors.state';
import type { FeatureGameApi, FeatureSystem, InteractionCtx } from '../types';
import { distanceToRoadEdge, ROAD_EDGE_CAP } from '../../world/mapData';

/** Flat ground everywhere: the plot search's road/building/water tests still run against the real
 *  generated map, which is the half worth exercising. */
const flat = (): number => 0;

interface Harness {
  api: FeatureGameApi;
  scene: THREE.Scene;
  player: THREE.Vector3;
  earned: number;
  events: Array<{ event: string; detail?: string }>;
  notes: string[];
  persists: number;
}

function harness(): Harness {
  const scene = new THREE.Scene();
  const player = new THREE.Vector3();
  const state: Harness = { scene, player, earned: 0, events: [], notes: [], persists: 0, api: undefined as never };
  state.api = {
    scene,
    surfaceHeightAt: flat,
    districtAt: () => 'Joburg CBD',
    isPark: () => false,
    nearestRoadPose: () => ({ position: new THREE.Vector3(), heading: 0 }),
    playerPosition: () => player,
    playerHeading: () => 0,
    drivenVehicle: () => undefined,
    hour: () => 13,
    blackout: () => 0,
    balance: () => 500,
    earn: (amount) => { state.earned += amount; },
    spend: () => true,
    notify: (title) => { state.notes.push(title); },
    showMenu: () => undefined,
    closeMenu: () => undefined,
    persist: () => { state.persists += 1; },
    analytics: (event, props) => { state.events.push({ event, detail: props?.detail }); },
    spawnFixture: () => undefined,
    removeFixture: () => undefined,
  };
  return state;
}

const ctx = (position: THREE.Vector3): InteractionCtx => ({ context: 'foot', position, vehicle: undefined, hour: 13 });

/** The offer the on-foot ladder would show right now, from the same resolver E goes through. */
function offer(system: FeatureSystem, position: THREE.Vector3): { prompt: string; act(): void } | undefined {
  for (const rung of [...(system.interactions?.() ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const found = rung.test(ctx(position));
    if (found) return found;
  }
  return undefined;
}

describe('interior stage plots', () => {
  // The first call warms CityGen's parcel pass and ModelScatter's scatter pass, which the running
  // game has already paid for at boot. Everything after it runs against warm caches.
  beforeAll(() => { findStagePlot(interiorDoors()[0]!, flat); }, 120000);

  it('finds a buildable plot for every derived doorstep, close enough that nothing re-streams', () => {
    for (const door of interiorDoors()) {
      const plot = findStagePlot(door, flat);
      expect(plot, `no plot for ${door.id}`).toBeDefined();
      const distance = Math.hypot(plot!.x - door.x, plot!.z - door.z);
      // ChunkVisibility.CHUNK_VISIBLE_RANGE is 2500 world units: stay well inside it and not one
      // building chunk, ambient pedestrian or mission distance changes while the player is indoors.
      expect(distance, `${door.id} plot is ${distance.toFixed(0)}u away`).toBeLessThan(1200);
    }
  });

  it('puts plots clear of every road surface, so nothing drives or walks through the lounge', () => {
    for (const door of interiorDoors()) {
      const plot = findStagePlot(door, flat)!;
      expect(distanceToRoadEdge(plot.x, plot.z)).toBeGreaterThanOrEqual(ROAD_EDGE_CAP - 0.1);
    }
  });

  it('is deterministic — the same door resolves to the same plot every time', () => {
    for (const door of interiorDoors()) {
      expect(findStagePlot(door, flat)).toEqual(findStagePlot(door, flat));
    }
  });

  it('costs a fraction of a frame once the world is built, so entering never hitches', () => {
    const door = interiorDoors()[0]!;
    const started = performance.now();
    for (let i = 0; i < 5; i++) findStagePlot({ x: door.x + i * 3, z: door.z + i * 3 }, flat);
    const each = (performance.now() - started) / 5;
    expect(each, `${each.toFixed(1)}ms per search`).toBeLessThan(16);
  });

  it('rejects sloping ground', () => {
    const door = interiorDoors()[0]!;
    const slope = (x: number, z: number): number => (x + z) * 0.5; // way past PLOT_FLATNESS over PLOT_RADIUS
    expect(PLOT_FLATNESS).toBeLessThan(0.55); // under PLAYER.stepUp, or the player falls off the floor
    expect(PLOT_RADIUS).toBeGreaterThan(12);
    expect(findStagePlot(door, slope)).toBeUndefined();
  });
});

describe('interiors feature', () => {
  let world: Harness;
  let system: FeatureSystem;

  beforeEach(() => {
    world = harness();
    system = createFeature(world.api, { visited: [] }) as FeatureSystem;
  });

  it('offers nothing until you are standing on a doorstep', () => {
    world.player.set(0, 0, 0);
    expect(offer(system, world.player)).toBeUndefined();
    expect(system.hud?.()).toBeUndefined();
  });

  it('offers the way in from the doorstep, in the prompt grammar the mobile pill parses', () => {
    const door = interiorDoors()[0]!;
    world.player.set(door.x, 0, door.z);
    const found = offer(system, world.player);
    expect(found?.prompt.startsWith('E  ')).toBe(true);
    expect(found?.prompt).toContain(door.name);
  });

  it('walks the whole loop and lands you back on the exact slab you left', () => {
    expect(system.qa?.('run', {})).toBe('ok');
  });

  it('runs the loop for every door on the map', () => {
    for (const door of interiorDoors()) {
      expect(system.qa?.('run', { door: door.id }), `${door.id} playthrough`).toBe('ok');
    }
  });

  it('builds the room only when you go in, and takes all of it away again', () => {
    const before = world.scene.children.length;
    expect(before).toBe(0); // nothing at all until someone opens a door
    expect(system.qa?.('enter', {})).toBe('ok');
    expect(world.scene.children.length).toBe(before + 1);
    expect(system.qa?.('leave', {})).toBe('ok');
    expect(world.scene.children.length).toBe(before);
  });

  it('leaks nothing across ten trips through the same door', () => {
    for (let i = 0; i < 10; i++) {
      expect(system.qa?.('enter', {})).toBe('ok');
      expect(system.qa?.('leave', {})).toBe('ok');
    }
    expect(world.scene.children.length).toBe(0);
  });

  it('shows a HUD chip while you are inside and nothing when you are not', () => {
    expect(system.hud?.()).toBeUndefined();
    system.qa?.('enter', {});
    const chips = system.hud?.();
    expect(chips).toHaveLength(1);
    expect(chips?.[0]?.label).toBe('SPAZA');
    system.qa?.('leave', {});
    expect(system.hud?.()).toBeUndefined();
  });

  it('keeps you in the room however hard you push at the walls', () => {
    system.qa?.('enter', {});
    const inside = world.player.clone();
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      world.player.x += Math.cos(angle) * 40;
      world.player.z += Math.sin(angle) * 40;
      system.update?.(1 / 60);
      expect(world.player.distanceTo(inside)).toBeLessThan(12);
    }
  });

  it('pays the first-visit find once, remembers it, and hands it back through the save slice', () => {
    system.qa?.('run', {});
    const first = world.earned;
    expect(first).toBeGreaterThan(0);
    const slice = system.serialize?.() as { visited: string[] };
    expect(slice.visited).toContain(interiorDoors()[0]!.id);
    system.qa?.('run', {});
    expect(world.earned).toBe(first);

    // A reload with that slice must not pay again.
    const second = createFeature(world.api, slice) as FeatureSystem;
    world.earned = 0;
    second.qa?.('run', {});
    expect(world.earned).toBe(0);
    second.dispose();
  });

  it('lets go rather than dragging you back when the world teleports you out', () => {
    system.qa?.('enter', {});
    expect(system.qa?.('status', {})).toMatch(/^inside:/);
    world.player.set(9000, 0, -9000); // a respawn, a checkpoint reload, a console teleport
    system.update?.(1 / 60);
    expect(system.qa?.('status', {})).toBe('outside');
    expect(world.player.x).toBe(9000);
    expect(world.scene.children.length).toBe(0);
  });

  it('has an idempotent dispose that empties the scene', () => {
    system.qa?.('enter', {});
    system.dispose();
    system.dispose();
    expect(world.scene.children.length).toBe(0);
    expect(system.hud?.()).toBeUndefined();
  });

  it('answers the console', () => {
    expect(system.command?.(['doors'])).toHaveLength(interiorDoors().length);
    expect(system.command?.(['where'])).toEqual(['Outside.']);
    system.qa?.('enter', {});
    expect(system.command?.(['where'])[0]).toContain('Inside');
  });
});
