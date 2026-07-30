/**
 * The feature, driven end to end without a browser: walk onto a real doorstep, press E, be inside a
 * lit floor of that building, climb the stair a storey, ride the lift, come out on the same slab.
 *
 * The bar is set by what went wrong. The previous attempt shipped a black void with the camera
 * outside the room, so this asserts the floor is IN THE SCENE, that it has lights in it, that the
 * player is inside its footprint, and that the plate is wide enough to hold the 9.5 unit boom.
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFeature } from './interiors';
import { buildCore } from './core';
import { doorsNear, nearestDoor, resetDoorCache } from './doors';
import { buildDoorways, buildFloor, markerFade } from './build';
import { solveFloor } from './floor';
import type { FeatureGameApi, FeatureMenuView, FeatureSystem, InteractionCtx } from '../types';

/** Flat ground: the door search still runs against the real generated map, which is the half worth
 *  exercising, and a flat world makes the interior's own heights easy to assert. */
const flat = (): number => 0;

interface Harness {
  api: FeatureGameApi;
  scene: THREE.Scene;
  player: THREE.Vector3;
  earned: number;
  events: { event: string; detail?: string; value?: number }[];
  notes: string[];
  menus: FeatureMenuView[];
  fixtures: number;
}

function harness(): Harness {
  const scene = new THREE.Scene();
  const player = new THREE.Vector3();
  const state: Harness = { scene, player, earned: 0, events: [], notes: [], menus: [], fixtures: 0, api: undefined as never };
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
    showMenu: (view) => { state.menus.push(view); },
    closeMenu: () => undefined,
    persist: () => undefined,
    analytics: (event, props) => { state.events.push({ event, detail: props?.detail, value: props?.value }); },
    // A stand-in ped: the feature pins its y every frame (see placeFixture), so it must have a group.
    spawnFixture: () => { state.fixtures += 1; return { group: new THREE.Group() } as never; },
    removeFixture: () => { state.fixtures -= 1; },
  };
  return state;
}

const ctx = (position: THREE.Vector3): InteractionCtx => ({ context: 'foot', position, vehicle: undefined, hour: 13 });

/** The offer the on-foot ladder would show right now, through the same resolver E goes through. */
function offer(system: FeatureSystem, position: THREE.Vector3): { prompt: string; act(): void } | undefined {
  for (const rung of [...(system.interactions?.() ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const found = rung.test(ctx(position));
    if (found) return found;
  }
  return undefined;
}

function floorGroups(scene: THREE.Scene): THREE.Object3D[] {
  return scene.children.filter((child) => child.name.startsWith('Floor:'));
}

/** A door on a building with more than one storey, so the stair has somewhere to go. */
function tallDoor(from: { x: number; z: number }) {
  return doorsNear(from.x, from.z, 2000)
    .map((door) => ({ door, core: buildCore(door.facts) }))
    .filter((entry) => entry.core.storeys >= 2)
    .sort((a, b) => b.core.storeys - a.core.storeys)[0];
}

describe('a visit', () => {
  beforeEach(() => { resetDoorCache(); });

  it('opens on a real doorstep and builds the ground floor of that building, lit', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    expect(door).toBeDefined();
    test.player.set(door.x, 0, door.z);

    const prompt = offer(system, test.player);
    expect(prompt?.prompt).toBe(`E  Go inside · ${door.name}`);
    expect(system.qa!('enter', {})).toBe('ok');

    const groups = floorGroups(test.scene);
    expect(groups, 'no floor in the scene').toHaveLength(1);
    // Lit: an ambient plus at least one lamp, or you get the void this feature shipped with.
    const lights: THREE.Light[] = [];
    groups[0]!.traverse((object) => { if (object instanceof THREE.Light) lights.push(object); });
    expect(lights.filter((light) => light instanceof THREE.AmbientLight).length).toBeGreaterThan(0);
    expect(lights.filter((light) => light instanceof THREE.PointLight).length).toBeGreaterThan(1);

    // The player is under their own building, at the same x and z they walked in on — and BELOW the
    // ground, which is the only band where City.supportHeight leaves them grounded rather than
    // permanently falling. See the header of interiors.ts.
    const status = system.qa!('status', {});
    expect(status).toMatch(/^inside\|/);
    expect(status).toContain('unreachable=0');
    expect(Math.hypot(test.player.x - door.facts.x, test.player.z - door.facts.z))
      .toBeLessThan(Math.hypot(door.facts.width, door.facts.depth));
    expect(test.player.y, 'the interior must sit under the terrain').toBeLessThan(-20);
    system.dispose();
  }, 120000);

  it('never moves the player in x or z beyond their own building, so the city never restreams', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    test.player.set(door.x, 0, door.z);
    system.qa!('enter', {});
    // The whole footprint plus the plate clamp: nothing like the hundreds of units a far plot moved.
    expect(Math.hypot(test.player.x - door.x, test.player.z - door.z)).toBeLessThan(40);
    system.dispose();
  }, 120000);

  it('walks the whole loop — in, contained, up the stair, back down, out on the same slab', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const tall = tallDoor({ x: 0, z: 0 });
    expect(tall, 'no multi-storey building anywhere near the origin').toBeDefined();
    test.player.set(tall!.door.x, 0, tall!.door.z);
    expect(system.qa!('run', {})).toBe('ok');
    expect(floorGroups(test.scene), 'floors left behind after leaving').toHaveLength(0);
    system.dispose();
  }, 300000);

  it('holds at most two floors at once, and only while the flight needs both', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const tall = tallDoor({ x: 0, z: 0 })!;
    test.player.set(tall.door.x, 0, tall.door.z);
    expect(system.qa!('run', {})).toBe('ok');
    // `run` climbs a storey and comes back; the driver fails itself above two, and the status line
    // reports the peak it actually measured.
    system.qa!('enter', {});
    const peak = /peak=(\d+)/.exec(system.qa!('status', {}))![1]!;
    expect(Number(peak)).toBeLessThanOrEqual(2);
    system.dispose();
  }, 300000);

  it('gives a tall building a lift, and the lift is a menu of every floor', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const lifted = doorsNear(0, 0, 4000)
      .map((door) => ({ door, core: buildCore(door.facts) }))
      .find((entry) => entry.core.lift);
    if (!lifted) return; // no tower near the origin on this map; floor.test.ts covers the rule
    test.player.set(lifted.door.x, 0, lifted.door.z);
    system.qa!('enter', {});
    const top = lifted.core.storeys - 1;
    expect(system.command!(['lift', String(top)])[0]).toContain(`floor ${top}`);
    system.dispose();
  }, 300000);

  it('rebuilds the identical floor on a second visit', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    test.player.set(door.x, 0, door.z);
    system.qa!('enter', {});
    const first = system.command!(['where']).join('\n');
    const shape = floorGroups(test.scene)[0]!.children.length;
    system.qa!('leave', {});
    test.player.set(door.x, 0, door.z);
    system.qa!('enter', {});
    expect(system.command!(['where']).join('\n')).toBe(first);
    expect(floorGroups(test.scene)[0]!.children.length).toBe(shape);
    system.dispose();
  }, 120000);

  it('pays the first visit once, and never past the cap', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    test.player.set(door.x, 0, door.z);
    system.qa!('enter', {});
    const paid = test.earned;
    expect(paid).toBeGreaterThan(0);
    system.qa!('leave', {});
    test.player.set(door.x, 0, door.z);
    system.qa!('enter', {});
    expect(test.earned).toBe(paid);
    system.dispose();
  }, 120000);

  it('leaves nothing in the scene, and no fixture, after dispose', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    test.player.set(door.x, 0, door.z);
    system.update?.(0.016);          // streams the street doorways
    system.qa!('enter', {});
    expect(test.scene.children.length).toBeGreaterThan(0);
    system.dispose();
    system.dispose();                 // idempotent
    expect(test.scene.children).toHaveLength(0);
    expect(test.fixtures).toBe(0);
  }, 120000);

  it('offers the way out from the mat and puts the player back where they were standing', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    test.player.set(door.x, 0, door.z);
    const outside = test.player.clone();
    system.qa!('enter', {});
    const inside = offer(system, test.player);
    expect(inside?.prompt, 'landing on the mat must offer the way out').toBe('E  Step outside');
    system.qa!('leave', {});
    expect(test.player.distanceTo(outside)).toBeLessThan(0.001);
    system.dispose();
  }, 120000);

  // The torch hint asks the host "is the player under a roof?" and must stay silent in here: the
  // lamps dim with the grid but the room keeps its own ambient, so the way out is always findable.
  it('reports itself as indoors only between stepping in and stepping out', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    test.player.set(door.x, 0, door.z);
    expect(system.indoors?.()).toBe(false);
    system.qa!('enter', {});
    expect(system.indoors?.()).toBe(true);
    system.qa!('leave', {});
    expect(system.indoors?.()).toBe(false);
    system.dispose();
  }, 120000);
});

/**
 * "The entrance visuals are a bit strong given it should be for most buildings. Perhaps just a
 * circle on the ground, no column of light." — the owner, after the first playtest. So: no beam
 * anywhere, and the circle only says anything when you are nearly standing on it.
 */
describe('the marker on the step', () => {
  it('is off down the street, full on the step, and never a beam', () => {
    expect(markerFade(0)).toBe(1);
    expect(markerFade(11)).toBe(1);
    expect(markerFade(26)).toBe(0);
    expect(markerFade(400)).toBe(0);
    expect(markerFade(18)).toBeGreaterThan(0);
    expect(markerFade(18)).toBeLessThan(1);
    // Monotone, so a marker never brightens as you walk away from it.
    for (let d = 0; d < 40; d += 0.5) expect(markerFade(d + 0.5)).toBeLessThanOrEqual(markerFade(d));
  });

  it('draws a disc and a ring on every door and a column of light on none of them', () => {
    resetDoorCache();
    const doors = doorsNear(0, 0, 260).slice(0, 8);
    expect(doors.length).toBeGreaterThan(3);
    const built = buildDoorways(doors, flat);
    expect(built.markers).toHaveLength(doors.length);
    let cylinders = 0; let tallest = 0;
    built.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const geometry = object.geometry as THREE.BufferGeometry & { parameters?: { height?: number } };
      if (geometry.type === 'CylinderGeometry') {
        cylinders++;
        tallest = Math.max(tallest, (geometry.parameters?.height ?? 0) * object.scale.y);
      }
    });
    // The only cylinder left in a doorway is the 5 cm disc on the paving. The beam was 9 m.
    expect(cylinders).toBe(doors.length);
    expect(tallest).toBeLessThan(0.2);
    // The frame is scaled to the opening the model tagged, never a fixed 3.4 m hole in a cottage.
    for (const [index, marker] of built.markers.entries()) {
      const door = doors[index]!;
      expect(Math.hypot(marker.x - door.x, marker.z - door.z)).toBeLessThan(1e-6);
      expect(marker.discMaterial.opacity).toBeLessThanOrEqual(0.31);
    }
    built.dispose();
  }, 120000);
});

describe('third-person interior visibility', () => {
  it('registers both doorway jambs as occluders along with every full-height wall span', () => {
    resetDoorCache();
    const door = nearestDoor(0, 0)!;
    const core = buildCore(door.facts);
    const plan = solveFloor(door.facts, 0, core);
    const built = buildFloor(plan, { ground: true, top: core.storeys === 1 });
    let expected = 1; // the stair core
    for (const wall of plan.walls) {
      if (wall.gapWidth === undefined) {
        if (wall.to - wall.from >= 0.02) expected += 1;
        continue;
      }
      const gapMin = wall.gapCentre! - wall.gapWidth / 2;
      const gapMax = wall.gapCentre! + wall.gapWidth / 2;
      if (gapMin - wall.from >= 0.02) expected += 1;
      if (wall.to - gapMax >= 0.02) expected += 1;
      expected += 2; // the two dark posts must disappear with the partition in front of the lens
    }
    expect(built.partitions).toHaveLength(expected);
    built.dispose();
  }, 120000);
});
