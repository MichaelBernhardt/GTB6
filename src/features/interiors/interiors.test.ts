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
