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
import { buildCore, hasRoofAccess, hatchFoot } from './core';
import { doorsNear, nearestDoor, resetDoorCache } from './doors';
import { doorLocked } from './lock';
import { buildDoorways, buildFloor, markerFade } from './build';
import { solveFloor } from './floor';
import { FeatureHost, type FeatureHostContext } from '../host';
import { sanitizeInteriorsState } from '../interiors.state';
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

const ctx = (position: THREE.Vector3, hour = 13): InteractionCtx => ({ context: 'foot', position, vehicle: undefined, hour });

/** The offer the on-foot ladder would show right now, through the same resolver E goes through. */
function offer(system: FeatureSystem, position: THREE.Vector3, hour = 13): { prompt: string; act(): void } | undefined {
  for (const rung of [...(system.interactions?.() ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const found = rung.test(ctx(position, hour));
    if (found) return found;
  }
  return undefined;
}

function floorGroups(scene: THREE.Scene): THREE.Object3D[] {
  return scene.children.filter((child) => child.name.startsWith('Floor:'));
}

/** A door the lock line leaves OPEN in daylight, so tests about visit mechanics (fades, chunks,
 *  climbing) are not accidentally about locks. The lock behaviour has its own describe block. */
function openDoorNear(x: number, z: number) {
  return doorsNear(x, z, 2000)
    .filter((door) => !doorLocked(door.facts, 'outside', 13))
    .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
}

/** A door the lock line LOCKS in daylight — somebody's home. */
function lockedDoorNear(x: number, z: number) {
  return doorsNear(x, z, 2000)
    .filter((door) => doorLocked(door.facts, 'outside', 13))
    .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
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
    // An open-class door on a building at least plate-sized, so the position assertion below is
    // about "under your own building", not about the Tardis clamp on a tiny spaza.
    const door = doorsNear(0, 0, 2000)
      .filter((entry) => !doorLocked(entry.facts, 'outside', 13) && entry.facts.width > 15.5 && entry.facts.depth > 21.5)
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!;
    expect(door).toBeDefined();
    test.player.set(door.x, 0, door.z);

    const prompt = offer(system, test.player);
    expect(prompt?.prompt).toBe(`E  Go inside · ${door.name}`);
    expect(system.qa!('enter', {})).toBe('ok');

    const groups = floorGroups(test.scene);
    expect(groups, 'no floor in the scene').toHaveLength(1);
    // Lit: the visit's ambient plus burning lamps from the POOL (floors own no lights — a floor that
    // adds or removes a light recompiles every shader in the scene; see build.ts), or you get the
    // void this feature shipped with.
    const lights: THREE.Light[] = [];
    test.scene.traverse((object) => { if (object instanceof THREE.Light) lights.push(object); });
    expect(lights.filter((light) => light instanceof THREE.AmbientLight).length).toBeGreaterThan(0);
    expect(lights.filter((light) => light instanceof THREE.PointLight && light.intensity > 0).length).toBeGreaterThan(1);

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

  /** Walk the player one qa stride at a time toward a floor-local point, through the real clamp,
   *  until `done(lx, lz)` or the stride budget runs out. Returns the last local position. */
  function walkUntil(system: FeatureSystem, x: number, z: number, done: (lx: number, lz: number) => boolean, budget = 400): { lx: number; lz: number } {
    let lx = 0; let lz = 0;
    for (let i = 0; i < budget; i++) {
      const r = system.qa!('walk', { x, z });
      expect(r.startsWith('ok')).toBe(true);
      const parts = r.split('|');
      lx = Number(parts[1]); lz = Number(parts[2]);
      if (done(lx, lz)) break;
    }
    return { lx, lz };
  }

  /**
   * THE STALL REGRESSION TESTS. The freeze the owner reported was three.js recompiling every shader
   * in the scene whenever the light census changed — which the old code did on every floor raise
   * AND drop, i.e. every time the player crossed the spine sightline. The invariant that kills the
   * whole class: between entering and leaving, the number of lights in the scene NEVER changes.
   */
  it('keeps the scene light census constant across floor raises and drops', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const tall = tallDoor({ x: 0, z: 0 })!;
    test.player.set(tall.door.x, 0, tall.door.z);
    expect(system.qa!('enter', {})).toBe('ok');
    const census = (): string => {
      let point = 0; let ambient = 0;
      test.scene.traverse((object) => {
        if (object instanceof THREE.PointLight) point++;
        else if (object instanceof THREE.AmbientLight) ambient++;
      });
      return `point=${point} ambient=${ambient}`;
    };
    const core = tall.core;
    const offSpine = (lx: number): boolean => Math.abs(lx - core.corridorX) > 3.6; // past holdNeighbour's sightline
    // On the mat (on the spine): the storey above is raised. Census taken now is the visit's census.
    walkUntil(system, core.corridorX, core.depth * 0.05, () => true, 1);
    const reference = census();
    // Into a room and past the release dwell: the neighbour floor DROPS. No light may go with it.
    const plan = solveFloor(tall.door.facts, 0, core);
    const room = plan.rooms[0]!;
    const spot = walkUntil(system, room.rect.x, room.doorZ, (lx) => offSpine(lx));
    expect(offSpine(spot.lx), 'never made it off the spine — pick a different fixture').toBe(true);
    for (let i = 0; i < 70; i++) system.qa!('walk', { x: spot.lx, z: spot.lz }); // 70 strides > 0.8 s dwell
    expect(census()).toBe(reference);
    // Back to the spine: the neighbour RAISES again. Still the same lights.
    walkUntil(system, core.corridorX, room.doorZ, (lx) => Math.abs(lx - core.corridorX) < 0.8);
    expect(census()).toBe(reference);
    // And outside, every pooled light is gone with the visit.
    expect(system.qa!('leave', {})).toBe('ok');
    expect(census()).toBe('point=0 ambient=0');
    system.dispose();
  }, 300000);

  it('re-shows a dropped floor from the cache instead of rebuilding it', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const tall = tallDoor({ x: 0, z: 0 })!;
    test.player.set(tall.door.x, 0, tall.door.z);
    expect(system.qa!('enter', {})).toBe('ok');
    const core = tall.core;
    walkUntil(system, core.corridorX, core.depth * 0.05, () => true, 1); // raises floor 1 from the mat
    const upstairs = test.scene.children.find((child) => child.name === `Floor:${core.id}:1`);
    expect(upstairs, 'the storey above must exist while the player can see up the shaft').toBeDefined();
    expect(upstairs!.visible).toBe(true);
    // Off the sightline and past the dwell: dropped means HIDDEN, not disposed.
    const plan = solveFloor(tall.door.facts, 0, core);
    const room = plan.rooms[0]!;
    const spot = walkUntil(system, room.rect.x, room.doorZ, (lx) => Math.abs(lx - core.corridorX) > 3.6);
    for (let i = 0; i < 70; i++) system.qa!('walk', { x: spot.lx, z: spot.lz });
    expect(upstairs!.visible).toBe(false);
    expect(upstairs!.parent).toBe(test.scene);
    // Back on the spine: the SAME object returns, no rebuild.
    walkUntil(system, core.corridorX, room.doorZ, (lx) => Math.abs(lx - core.corridorX) < 0.8);
    expect(upstairs!.visible).toBe(true);
    expect(test.scene.children.filter((child) => child.name === `Floor:${core.id}:1`)).toHaveLength(1);
    // Leaving disposes the cache: nothing of the building survives outside.
    expect(system.qa!('leave', {})).toBe('ok');
    expect(floorGroups(test.scene)).toHaveLength(0);
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

  /** "There seem to always be stairs, even on single floor buildings" — the owner. A single-storey
   *  building now has no shaft in its core, no stair group in its scene, and rooms on the whole
   *  plate; the visit still works end to end. */
  it('gives a single-storey building no stair at all, and still a walkable visit', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const single = doorsNear(0, 0, 4000)
      .map((door) => ({ door, core: buildCore(door.facts) }))
      .find((entry) => entry.core.storeys === 1);
    expect(single, 'no single-storey building near the origin').toBeDefined();
    expect(single!.core.stair, 'a single-storey core still carries a stair').toBeUndefined();
    expect(single!.core.lift).toBeUndefined();
    test.player.set(single!.door.x, 0, single!.door.z);
    expect(system.qa!('run', {})).toBe('ok');
    system.qa!('enter', {});
    let stairGroups = 0;
    floorGroups(test.scene)[0]!.traverse((object) => { if (object.name === 'Stair') stairGroups++; });
    expect(stairGroups, 'a stairless building drew a stair').toBe(0);
    expect(system.qa!('status', {})).toContain('unreachable=0');
    system.dispose();
  }, 300000);

  /** The interaction ladder guarantees a shown prompt's act() runs — an offer that then answers
   *  'failed:mid-fade' is a stolen keypress, the exact failure class that once made the protest rung
   *  eat "E Enter vehicle". So during a fade every rung must WITHDRAW, not fizzle. */
  it('withdraws every offer during the entry fade instead of stealing the keypress', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = openDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    const prompt = offer(system, test.player);
    expect(prompt?.prompt).toBe(`E  Go inside · ${door.name}`);
    prompt!.act(); // starts the 260 ms entry fade — the visit does not exist yet
    expect(offer(system, test.player), 'an offer shown mid-fade would act and fizzle').toBeUndefined();
    system.dispose(); // clears the pending fade timer
  }, 120000);

  /** Doors derive from map data, not built geometry: without this gate, E on a doorway frame whose
   *  building chunk has not streamed in teleports the player into an invisible building. */
  it('offers nothing while the building chunk is not built, and offers again once it is', () => {
    const test = harness();
    let built = false;
    test.api.chunkBuiltAt = () => built;
    const system = createFeature(test.api, undefined);
    const door = openDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    expect(offer(system, test.player), 'a doorway on an unbuilt chunk must not offer').toBeUndefined();
    built = true;
    expect(offer(system, test.player)?.prompt).toBe(`E  Go inside · ${door.name}`);
    system.dispose();
  }, 120000);

  /** Nothing reserves the doorstep while the player is inside — a car can park on the exact slab
   *  they left from. Stepping out must sidestep the bodywork, not restore into it. */
  it('steps the returning player around a car parked on the doorstep', () => {
    const test = harness();
    let parked: { x: number; z: number } | undefined;
    test.api.vehicleNear = (x, z, radius) => (parked ? Math.hypot(parked.x - x, parked.z - z) < radius : false);
    const system = createFeature(test.api, undefined);
    const door = nearestDoor(0, 0)!;
    test.player.set(door.x, 0, door.z);
    const outside = test.player.clone();
    system.qa!('enter', {});
    parked = { x: outside.x, z: outside.z }; // a taxi pulls onto the slab while they are inside
    system.qa!('leave', {});
    const away = Math.hypot(test.player.x - outside.x, test.player.z - outside.z);
    expect(away, 'the player came out inside the parked car').toBeGreaterThan(1.2);
    expect(away, 'the sidestep must stay by the door, not teleport down the street').toBeLessThan(4);
    // And with the slab clear, the restore is still exact.
    parked = undefined;
    test.player.set(door.x, 0, door.z);
    const clean = test.player.clone();
    system.qa!('enter', {});
    system.qa!('leave', {});
    expect(test.player.distanceTo(clean)).toBeLessThan(0.001);
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
    const built = buildDoorways(doors, () => ({ y: 0, nx: 0, ny: 1, nz: 0 }));
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

/**
 * ROOF ACCESS. Commercial and industrial buildings taller than two storeys open both ways: the top
 * stair head carries a ladder out onto the real roof, and standing on such a roof offers the way
 * down into the top floor. Exit is never gated; entry goes through the same doorLocked() line the
 * street door will use once the locks pass ships the pick.
 */
describe('the roof', () => {
  beforeEach(() => { resetDoorCache(); });

  it('drops into the top floor from the roof, and the street door then puts you out on the doorstep', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const stood = system.qa!('roofstand', {});
    expect(stood.startsWith('ok'), stood).toBe(true);
    const doorId = stood.split('|')[1]!;
    // Standing on the roof: the ladder in, through the same resolver E uses.
    const prompt = offer(system, test.player);
    expect(prompt?.prompt, 'no way in from the roof').toContain('roof hatch');
    const entered = system.qa!('roofenter', {});
    expect(entered.startsWith('ok'), entered).toBe(true);
    const status = system.qa!('status', {});
    const storeys = Number(/storeys=(\d+)/.exec(status)![1]);
    const floor = Number(/floor=(\d+)/.exec(status)![1]);
    expect(storeys).toBeGreaterThan(2);
    expect(floor, 'a roof entry must land on the TOP floor').toBe(storeys - 1);
    expect(status).toContain('unreachable=0');
    // Leaving by the street door must NOT restore the roof position — that would teleport the
    // player back up. It puts them on the doorstep like anyone else. Exit checks nothing, ever.
    expect(system.qa!('leave', {})).toBe('ok');
    const door = doorsNear(test.player.x, test.player.z, 60).find((candidate) => candidate.id === doorId);
    expect(door, 'left somewhere far from the building').toBeDefined();
    expect(Math.hypot(test.player.x - door!.x, test.player.z - door!.z)).toBeLessThan(0.01);
    expect(test.player.y).toBeCloseTo(0, 3);
    system.dispose();
  }, 300000);

  it('exits the top stair head to the real roof, high above the street', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    expect(system.qa!('roofenter', {}).startsWith('ok')).toBe(true);
    const inside = test.player.clone();
    const out = system.qa!('roof', {});
    expect(out.startsWith('ok'), out).toBe(true);
    // Interiors live ~30u underground; the roof is the massing top, well above the flat ground.
    expect(test.player.y, 'the hatch put the player somewhere that is not a roof').toBeGreaterThan(6);
    expect(test.player.y).toBeGreaterThan(inside.y + 20);
    expect(system.indoors?.()).toBe(false);
    // The hatch just used is in grace: the way back down offers immediately.
    const back = offer(system, test.player);
    expect(back?.prompt, 'no way back down through a hatch just exited').toContain('roof hatch');
    system.dispose();
  }, 300000);

  it('offers the hatch rung at the ladder foot on the top floor of a qualifying building', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const roofy = doorsNear(0, 0, 4000)
      .map((door) => ({ door, core: buildCore(door.facts) }))
      .filter((entry) => entry.core.stair && hasRoofAccess(entry.core) && entry.door.roof)
      .sort((a, b) => a.core.storeys - b.core.storeys)[0];
    expect(roofy, 'no roof-qualifying building near the origin').toBeDefined();
    const { door, core } = roofy!;
    test.player.set(door.x, 0, door.z);
    expect(system.qa!('enter', {})).toBe('ok');
    expect(system.qa!('floor', { n: core.storeys - 1 }).startsWith('ok')).toBe(true);
    // Walk to the ladder foot (mapped to world through the visit's own frame).
    const foot = hatchFoot(core.stair!, core.stairDir);
    for (let i = 0; i < 400; i++) {
      const step = system.qa!('walk', { x: foot.x, z: foot.z - 1.4 });
      const parts = step.split('|');
      if (Math.hypot(Number(parts[1]) - foot.x, Number(parts[2]) - (foot.z - 1.4)) < 0.15) break;
    }
    const prompt = offer(system, test.player);
    expect(prompt?.prompt, 'no roof prompt at the ladder foot').toBe('E  Up to the roof');
    system.dispose();
  }, 300000);
});

describe('third-person interior visibility', () => {
  it('registers both doorway jambs as occluders along with every full-height wall span', () => {
    resetDoorCache();
    const door = nearestDoor(0, 0)!;
    const core = buildCore(door.facts);
    const plan = solveFloor(door.facts, 0, core);
    const built = buildFloor(plan, { ground: true, top: core.storeys === 1, hatch: false });
    let expected = core.stair ? 1 : 0; // the stair core, when the building has one
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

/**
 * THE LOCKS, live. One direction only: entering from the street or the roof asks the lock line;
 * leaving never asks anything. A pickless player at a locked door gets NO offer at all —
 * FeatureHost.act() returns true the instant any rung offers, so even an "honest" explainer
 * offer claims the E press from the `E  Enter vehicle` rung directly below (the protest-rung
 * failure class, PR #120). The passive LOCKED chip explains instead; with a pick, the dial
 * offers and ACTS.
 */
describe('locked doors', () => {
  beforeEach(() => { resetDoorCache(); });

  it('claims no key from a pickless player, so E falls through to the vehicle rung below', async () => {
    const test = harness();
    // The real host, called exactly the way Game's on-foot E handler calls it: the line after
    // `if (this.features.act('foot')) return;` is vehicle entry, so act() must answer false here.
    const context: FeatureHostContext = { api: test.api, suspended: () => false, emit: () => undefined, reportError: () => undefined };
    const host = new FeatureHost(context, [{
      id: 'interiors', saveKey: 'interiors', label: 'Building interiors',
      load: () => Promise.resolve({ createFeature }),
    }]);
    await host.open('interiors');
    const door = lockedDoorNear(0, 0)!;
    expect(door).toBeDefined();
    test.player.set(door.x, 0, door.z);
    expect(host.offer('foot'), 'a locked door with no pick must not offer').toBeUndefined();
    expect(host.act('foot'), 'act() must decline so Game reaches beginEnter(vehicle)').toBe(false);
    // The explanation moved to the passive chip, which claims no key at all.
    expect(host.hud()?.some((chip) => chip.id === 'interiors:locked' && chip.label === 'LOCKED')).toBe(true);
    host.dispose();
  }, 120000);

  it('with a pick, runs the dial through the real rung and opens on the bite', () => {
    const test = harness();
    test.api.inventoryCount = () => 1;
    const system = createFeature(test.api, undefined);
    const door = lockedDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    expect(offer(system, test.player)?.prompt).toBe(`E  Pick the lock · ${door.name}`);
    const picked = system.qa!('pick', {});
    expect(picked.startsWith('ok'), picked).toBe(true);
    expect(picked).toContain('picks=1');
    expect(system.qa!('status', {})).toMatch(/^inside\|/);
    // EXIT IS NEVER GATED: straight back out, no pick, no check, restored to the slab.
    expect(system.qa!('leave', {})).toBe('ok');
    expect(Math.hypot(test.player.x - door.x, test.player.z - door.z)).toBeLessThan(0.01);
    system.dispose();
  }, 120000);

  it('holds the door you just left open for the grace window — no second dial to undo a step outside', () => {
    const test = harness();
    test.api.inventoryCount = () => 1;
    const system = createFeature(test.api, undefined);
    const door = lockedDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    expect(system.qa!('pick', {}).startsWith('ok')).toBe(true);
    expect(system.qa!('leave', {})).toBe('ok');
    // Within the grace window the same door opens without the dial.
    expect(offer(system, test.player)?.prompt).toBe(`E  Go inside · ${door.name}`);
    system.dispose();
  }, 120000);

  it('carries the street-door grace through the save, so a reload on the doorstep keeps it', () => {
    const test = harness();
    test.api.inventoryCount = () => 1;
    const system = createFeature(test.api, undefined);
    const door = lockedDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    expect(system.qa!('pick', {}).startsWith('ok')).toBe(true);
    expect(system.qa!('leave', {})).toBe('ok');
    // The save written on the doorstep carries the graced door through the sanitizer...
    const slice = sanitizeInteriorsState(system.serialize!());
    expect(slice.graceId, 'the graced street door must survive into the save').toBe(door.id);
    system.dispose();
    // ...and a PICKLESS fresh session restored on the same doorstep still walks straight in.
    const revived = createFeature({ ...test.api, inventoryCount: () => 0 }, slice);
    expect(offer(revived, test.player)?.prompt, 'reload re-locked the door just stepped out of')
      .toBe(`E  Go inside · ${door.name}`);
    revived.dispose();
  }, 120000);

  it('opensesame opens everything without a pick', () => {
    const test = harness();
    test.api.doorsUnlocked = () => true;
    const system = createFeature(test.api, undefined);
    const door = lockedDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    expect(offer(system, test.player)?.prompt).toBe(`E  Go inside · ${door.name}`);
    system.dispose();
  }, 120000);

  it('owns the hands while the dial runs, so cover can neither mask the prompt nor yank the bite', () => {
    const test = harness();
    test.api.inventoryCount = () => 1;
    const system = createFeature(test.api, undefined);
    expect(system.handsBusy?.(), 'idle hands').toBe(false);
    const door = lockedDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    offer(system, test.player)!.act();   // the dial starts
    expect(system.handsBusy?.(), 'the dial owns the hands').toBe(true);
    test.player.set(door.x + 8, 0, door.z); // walk off: dial cancels
    system.update!(1 / 60);
    expect(system.handsBusy?.(), 'hands free after the dial ends').toBe(false);
    system.dispose();
  }, 120000);

  it('cancels the dial when the player walks away, costing nothing', () => {
    const test = harness();
    test.api.inventoryCount = () => 1;
    const system = createFeature(test.api, undefined);
    const door = lockedDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    const start = offer(system, test.player);
    expect(start?.prompt).toBe(`E  Pick the lock · ${door.name}`);
    start!.act(); // dial running
    expect(system.hud!()?.some((chip) => chip.id === 'interiors:pick')).toBe(true);
    test.player.set(door.x + 8, 0, door.z); // walk off the step
    system.update!(1 / 60);
    expect(system.hud!()?.some((chip) => chip.id === 'interiors:pick') ?? false).toBe(false);
    system.dispose();
  }, 120000);
});

/**
 * THE MACHINE CLIMBS EVERY CLASS. The stair can stand at the back, mid-plate, against a wall or
 * beside the door now, and the QA driver's climb is the same walk a player makes — spine, across
 * the band, into the up flight, around the switchback, out — through the same clamp. One 'run' per
 * class per source (parcel and scatter where present) is the difference between "the histogram
 * moved" and "you can actually walk these buildings".
 */
describe('every stair class is climbable', () => {
  beforeEach(() => { resetDoorCache(); });

  it('walks the full loop in a back, mid, side and front stair building', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const seen = new Map<string, { x: number; z: number }>();
    for (const door of doorsNear(0, 0, 2600)) {
      const core = buildCore(door.facts);
      if (!core.stair || core.stairClass === undefined) continue;
      if (doorLocked(door.facts, 'outside', 13)) continue; // visit mechanics, not locks
      if (!seen.has(core.stairClass)) seen.set(core.stairClass, { x: door.x, z: door.z });
      if (seen.size === 4) break;
    }
    expect([...seen.keys()].sort(), 'could not find all four classes near the origin')
      .toEqual(['back', 'front', 'mid', 'side']);
    for (const [stairClass, spot] of seen) {
      test.player.set(spot.x, 0, spot.z);
      const result = system.qa!('run', {});
      expect(result, `class ${stairClass} at ${spot.x.toFixed(0)},${spot.z.toFixed(0)}: ${result}`).toBe('ok');
    }
    system.dispose();
  }, 300000);
});

/**
 * A SAVE WRITTEN INDOORS RELOADS INDOORS. The owner: "when saving with the player inside, they
 * respawn in the outside world." The save now carries the visit (building, storey, floor-local
 * spot) while the WORLD position it stores is the doorstep — so a loader without the feature lands
 * the player at the front door instead of underground, and the feature walks them back inside
 * through the real entry path on the first update.
 */
describe('saving indoors', () => {
  beforeEach(() => { resetDoorCache(); });

  it('reloads inside the same building, on the same storey, on the identical floor plan', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const entry = tallDoor({ x: 0, z: 0 })!;
    expect(entry.core.storeys).toBeGreaterThan(2);
    const { door } = entry;
    test.player.set(door.x, 0, door.z);
    expect(system.qa!('enter', {})).toBe('ok');
    expect(system.qa!('floor', { n: 2 }).startsWith('ok')).toBe(true);
    const before = system.qa!('where', {});
    // The save, through the real sanitizer.
    const slice = sanitizeInteriorsState(system.serialize!());
    expect(slice.visit, 'a save written indoors must carry the visit').toBeDefined();
    expect(slice.visit!.id).toBe(door.id);
    expect(slice.visit!.floor).toBe(2);
    // The world position the save should carry is the DOORSTEP, not the buried player.
    const anchor = (system as { outdoorAnchor?(): { x: number; z: number } | undefined }).outdoorAnchor?.();
    expect(anchor, 'no outdoor anchor while indoors').toBeDefined();
    expect(Math.hypot(anchor!.x - door.x, anchor!.z - door.z)).toBeLessThan(0.01);
    system.dispose();

    // A fresh session boots with the slice, the player standing where the save put them: the step.
    const revived = createFeature(test.api, slice);
    test.player.set(door.x, 0, door.z);
    revived.update!(0.02);
    const status = revived.qa!('status', {});
    expect(status, 'the reload must land INSIDE').toMatch(/^inside\|/);
    expect(status).toContain(door.id);
    expect(status).toContain('floor=2');
    expect(test.player.y, 'restored under the terrain, on the storey').toBeLessThan(-20);
    // The rebuilt floor is the floor they left — same rooms, same walkable tile count.
    expect(revived.qa!('where', {})).toBe(before);
    revived.dispose();
  }, 120000);

  it('drops the anchor and the visit the moment the player steps back outside', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    const door = openDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    expect(system.qa!('enter', {})).toBe('ok');
    expect(sanitizeInteriorsState(system.serialize!()).visit).toBeDefined();
    expect(system.qa!('leave', {})).toBe('ok');
    expect(sanitizeInteriorsState(system.serialize!()).visit, 'an outdoor save must not carry a visit').toBeUndefined();
    expect((system as { outdoorAnchor?(): unknown }).outdoorAnchor?.()).toBeUndefined();
    system.dispose();
  }, 120000);

  it('sanitizes a hostile visit slice instead of trusting it', () => {
    const garbage = sanitizeInteriorsState({ visited: [], finds: 0, picks: 0, visit: { id: 'x'.repeat(80), floor: 1e9, x: Number.NaN, z: 5 } });
    expect(garbage.visit).toBeUndefined();
    const fine = sanitizeInteriorsState({ visited: [], finds: 0, picks: 0, visit: { id: '12:34', floor: 3.7, x: -2.25, z: 61 } });
    expect(fine.visit).toEqual({ id: '12:34', floor: 3, x: -2.25, z: 61 });
  }, 120000);
});

/**
 * THE CIRCLE NEVER LIES. The owner pressed E at circle after circle and "nothing happens" — some
 * of it was the chunk-bake window with no explanation, some of it was locked doors whose gold
 * circle promised an interaction the ladder deliberately withholds from a pickless player. Now the
 * circle, the chip and the rung all read the same predicates: a grey circle means the ladder will
 * stay silent (locked, no pick), gold means walking up offers (enter or the dial), and a door in a
 * still-baking chunk explains itself with the STREAMING chip instead of dead air.
 */
describe('the circle, the chip and the rung agree', () => {
  beforeEach(() => { resetDoorCache(); });

  /** The disc mesh nearest a doorstep, fished out of the built doorway group. */
  function discFor(scene: THREE.Scene, door: { x: number; z: number }): THREE.Mesh | undefined {
    let found: THREE.Mesh | undefined;
    scene.getObjectByName('InteriorDoors')?.traverse((object) => {
      if (found || !(object instanceof THREE.Mesh)) return;
      if (object.geometry.type !== 'CylinderGeometry') return;
      if (Math.hypot(object.position.x - door.x, object.position.z - door.z) < 1.5) found = object;
    });
    return found;
  }

  it('tints locked-silent doors grey, pickable and open doors gold — same predicate as the rung', () => {
    const test = harness();
    let picks = 0;
    test.api.inventoryCount = () => picks;
    const system = createFeature(test.api, undefined);
    const locked = lockedDoorNear(0, 0)!;
    test.player.set(locked.x, 0, locked.z);
    system.update!(0.02); system.update!(0.02);
    // Pickless at a locked door: grey circle, no offer, LOCKED chip — three signals, one truth.
    const grey = discFor(test.scene, locked)!;
    expect(grey, 'no disc built for the locked door').toBeDefined();
    expect((grey.material as THREE.MeshBasicMaterial).color.getHex(), 'a silent door must not glow gold').toBe(0xc3ccd4);
    expect(offer(system, test.player)).toBeUndefined();
    expect(system.hud!()?.some((chip) => chip.id === 'interiors:locked')).toBe(true);
    // Buy a pick: the same circle turns gold, because the ladder now offers the dial.
    picks = 1;
    system.update!(0.02);
    expect((grey.material as THREE.MeshBasicMaterial).color.getHex(), 'a pickable door earns the gold back').toBe(0xe8b64c);
    expect(offer(system, test.player)?.prompt).toContain('Pick the lock');
    // An open door was always gold, and always offers.
    picks = 0;
    const open = openDoorNear(0, 0)!;
    test.player.set(open.x, 0, open.z);
    system.update!(0.02); system.update!(0.02);
    const gold = discFor(test.scene, open)!;
    expect(gold, 'no disc built for the open door').toBeDefined();
    expect((gold.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xe8b64c);
    expect(offer(system, test.player)?.prompt).toContain('Go inside');
    system.dispose();
  }, 120000);

  it('names the cheat at the doorstep while opensesame is armed', () => {
    // Locks census, current build: every residential door (suburban/estate/rural/dense-res,
    // parcel and scattered) answers LOCKED pickless at every hour, and none is roof-enterable —
    // so "I walked into a residential building" pickless means the session cheat is on, and the
    // game must say so rather than let the lock line take the blame.
    const test = harness();
    test.api.doorsUnlocked = () => true;
    const system = createFeature(test.api, undefined);
    const door = lockedDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    system.update!(0.02);
    expect(offer(system, test.player)?.prompt).toBe(`E  Go inside · ${door.name}`);
    expect(system.hud!()?.some((chip) => chip.id === 'interiors:sesame'),
      'an armed opensesame must be named at the door').toBe(true);
    system.dispose();
  }, 120000);

  it('explains a still-baking chunk with the STREAMING chip instead of dead air', () => {
    const test = harness();
    test.api.chunkBuiltAt = () => false;   // the whole city mid-bake, as after a teleport
    const system = createFeature(test.api, undefined);
    const door = openDoorNear(0, 0)!;
    test.player.set(door.x, 0, door.z);
    system.update!(0.02);
    // The rung must stay silent (E may not enter an unbuilt building) — but never unexplained.
    expect(offer(system, test.player)).toBeUndefined();
    expect(system.hud!()?.some((chip) => chip.id === 'interiors:streaming'),
      'silence with no explanation is the bug the owner reported').toBe(true);
    // The chunk lands: chip yields to the offer.
    test.api.chunkBuiltAt = () => true;
    system.update!(0.02);
    expect(offer(system, test.player)?.prompt).toContain('Go inside');
    expect(system.hud!()?.some((chip) => chip.id === 'interiors:streaming') ?? false).toBe(false);
    system.dispose();
  }, 120000);
});

/**
 * THE RAILS ARE REAL. The owner's follow-up, verbatim: "it's a little tricky to climb the stairs
 * because you just fall off the sides as you go up and around the flights if you're not super
 * careful." The side edges of the shaft are sealed by the clamp now (and railed by build.ts), so
 * this walks the exact failure: up the switchback PRESSING OUTWARD the whole way — every stride
 * aimed two metres past the open edge — and asserts the player stays on the flight, arrives on
 * floor 1, and can still walk the ground floor past the stair afterwards.
 */
describe('the stair rails hold', () => {
  beforeEach(() => { resetDoorCache(); });

  it('climbs the switchback hugging the outside of the turn without falling off', () => {
    const test = harness();
    const system = createFeature(test.api, undefined);
    // A mid-class island in the open, so falling off the side would be a real half-storey drop
    // AND the ground floor genuinely walks past the shaft (both halves of the fix in one room).
    const entry = doorsNear(0, 0, 2600)
      .map((door) => ({ door, core: buildCore(door.facts) }))
      .filter(({ door, core }) => core.stairClass === 'mid' && !doorLocked(door.facts, 'outside', 13))
      .sort((a, b) => Math.hypot(a.door.x, a.door.z) - Math.hypot(b.door.x, b.door.z))[0];
    expect(entry, 'no open mid-class building near the origin').toBeDefined();
    const { door, core } = entry!;
    const s = core.stair!;
    const lane = s.w / 4;
    const up = core.stairDir;
    const minZ = s.z - s.d / 2, maxZ = s.z + s.d / 2;
    const outside = s.x + up * (s.w / 2 + 2);       // two metres past the open edge of the up flight
    test.player.set(door.x, 0, door.z);
    expect(system.qa!('enter', {})).toBe('ok');

    const walk = (x: number, z: number, max = 400): string => {
      let last = '';
      for (let i = 0; i < max; i++) {
        last = system.qa!('walk', { x, z });
        const [, lx, lz] = last.split('|');
        if (Math.hypot(parseFloat(lx!) - x, parseFloat(lz!) - z) < 0.18) break;
      }
      return last;
    };
    // Onto the spine and square in front of the up lane, then IN.
    walk(core.corridorX, minZ - 1.6);
    walk(s.x + up * lane, minZ - 1.2);
    walk(s.x + up * lane, minZ + 0.3);
    // Up the flight aiming OUTWARD at every step — the owner's hug. The rail must hold the x while
    // the z (and therefore the altitude) climbs.
    const baseY = parseFloat(walk(outside, minZ + 0.3).split('|')[3]!.slice(2));
    let highest = baseY;
    for (const z of [minZ + s.d * 0.35, minZ + s.d * 0.7, maxZ - 0.7]) {
      const state = walk(outside, z);
      const [, lx, , y] = state.split('|');
      expect(Math.abs(parseFloat(lx!) - s.x) < s.w / 2 - 0.3,
        `pressed past the rail at z=${z.toFixed(1)}: ${state}`).toBe(true);
      highest = Math.max(highest, parseFloat(y!.slice(2)));
    }
    expect(highest - baseY, 'the hug never gained height — not on the flight at all').toBeGreaterThan(1.2);
    // Around the turn (still pressing outward on the OTHER side) and out one storey up.
    walk(s.x - up * lane, maxZ - 0.7);
    walk(s.x - up * (s.w / 2 + 2), minZ + 0.5, 500);
    walk(s.x - up * lane, minZ + 0.3);
    walk(s.x, minZ - 1.6);
    const upStatus = system.qa!('status', {});
    expect(upStatus, 'hugging the rails the whole way must still deliver floor 1').toContain('floor=1');
    // Back down clean, then the other half of the promise: the ground floor still walks PAST the
    // shaft — the side caps are the shaft's edge, not a fence around the room.
    expect(system.qa!('floor', { n: 0 }).startsWith('ok')).toBe(true);
    walk(core.corridorX, minZ - 1.6);
    const behind = walk(core.corridorX, maxZ + 1.6, 600);
    expect(behind.startsWith('ok'), `ground floor no longer passes the stair: ${behind}`).toBe(true);
    const [, , lz] = behind.split('|');
    expect(parseFloat(lz!), 'never reached the band behind the island').toBeGreaterThan(maxZ + 1.0);
    system.dispose();
  }, 300000);
});

/**
 * EVERY HATCH OPENS FROM THE ROOF SIDE, ALWAYS. Round 2 kept the hatch behind the lock line plus a
 * re-arming grace window, and shipped a residual trap anyway (#128): jump from your graced roof A
 * to neighbouring roof B and B's hatch wanted a pick you might not carry. The owner's call closed
 * it by deleting the roof-side lock outright — "people lock the street door, not the roof" — with
 * the stated trade that reaching a roof by parkour now yields free entry to that top floor. These
 * tests pin the new, simpler invariant: ANY hatch opens from ANY roof — no pick, no grace, no
 * history, no hour. The street door's own lock, grace and persistence are untouched (see the
 * locked-doors block above).
 */
describe('any hatch opens from any roof', () => {
  beforeEach(() => { resetDoorCache(); });

  /** A roof-access building that is open in hours and locked at night — the strictest subject: at
   *  23:00 its STREET door refuses outsiders, so an opening hatch proves the roof side asks no
   *  lock question at all. Searched outward so a sparse origin still answers. */
  function nightLockedRoofDoor() {
    for (const radius of [1500, 3000, 6000]) {
      const found = doorsNear(0, 0, radius)
        .map((door) => ({ door, core: buildCore(door.facts) }))
        .filter((entry) => entry.door.roof && entry.core.stair && hasRoofAccess(entry.core)
          && !doorLocked(entry.door.facts, 'outside', 13)
          && doorLocked(entry.door.facts, 'outside', 23))
        .sort((a, b) => Math.hypot(a.door.x, a.door.z) - Math.hypot(b.door.x, b.door.z))[0];
      if (found) return found;
    }
    return undefined;
  }

  it('opens the hatch on a roof reached cold — pickless, at night, never having been inside', () => {
    const test = harness();
    const hour = 23;
    test.api.hour = () => hour;
    const system = createFeature(test.api, undefined);   // fresh session: no visits, no grace, no pick
    const roofy = nightLockedRoofDoor();
    expect(roofy, 'no night-locking roof-access building on the map').toBeDefined();
    const { door, core } = roofy!;
    expect(doorLocked(door.facts, 'outside', hour), 'the building must night-lock or this test bites nothing').toBe(true);
    // Stand on the roof the way a parkour arrival would: on the top tier, via the same resolver.
    test.player.set(door.x, 0, door.z);
    const stood = system.qa!('roofstand', {});
    expect(stood.startsWith('ok'), stood).toBe(true);
    expect(stood).toContain(door.id);
    // The way in is simply open: no pick carried, street door locked, roof never graced.
    const back = offer(system, test.player, hour);
    expect(back?.prompt, 'a hatch refused a player on its own roof').toContain('In through the roof hatch');
    const entered = system.qa!('roofenter', {});
    expect(entered.startsWith('ok'), entered).toBe(true);
    const status = system.qa!('status', {});
    expect(status).toMatch(/^inside\|/);
    expect(status).toContain(`floor=${core.storeys - 1}`);  // in at the top, exactly where the hatch leads
    system.dispose();
  }, 300000);

  it('lingering on a roof you exited costs nothing: the way down never expires', () => {
    const test = harness();
    let hour = 13;
    test.api.hour = () => hour;
    const system = createFeature(test.api, undefined);
    const roofy = nightLockedRoofDoor();
    expect(roofy).toBeDefined();
    const { door, core } = roofy!;
    test.player.set(door.x, 0, door.z);
    expect(system.qa!('enter', {})).toBe('ok');                       // in through the open works door, in hours
    expect(system.qa!('floor', { n: core.storeys - 1 }).startsWith('ok')).toBe(true);
    expect(system.qa!('roof', {}).startsWith('ok')).toBe(true);       // out the hatch — free, as every exit is
    // Night falls and they photograph the skyline for three whole minutes — far past any window
    // the old grace machinery ever kept. There is no window now; there is no lock.
    hour = 23;
    for (let i = 0; i < 180; i++) system.update!(1);
    const back = offer(system, test.player, hour);
    expect(back?.prompt, 'pickless player marooned on a night-locked roof').toContain('In through the roof hatch');
    system.dispose();
  }, 300000);

  it('survives a reload cold: a fresh session on the same roof still gets in, no saved grace needed', () => {
    const test = harness();
    const hour = 23;
    test.api.hour = () => hour;
    const roofy = nightLockedRoofDoor();
    expect(roofy).toBeDefined();
    const { door } = roofy!;
    test.player.set(door.x, 0, door.z);
    const scout = createFeature(test.api, undefined);
    expect(scout.qa!('roofstand', {}).startsWith('ok')).toBe(true);
    scout.dispose();
    // A save with NOTHING in it — the old test needed graceId to survive the sanitizer for the
    // roof to stay answerable; the invariant no longer depends on any state at all.
    const revived = createFeature(test.api, sanitizeInteriorsState(undefined));
    for (let i = 0; i < 60; i++) revived.update!(1);
    expect(offer(revived, test.player, hour)?.prompt, 'a reload re-latched the way down').toContain('In through the roof hatch');
    revived.dispose();
  }, 300000);
});

