/**
 * Building interiors — the lazy body. Nothing in this directory is imported statically anywhere;
 * registry.ts's `load()` is the only reference, so it ships as its own async chunk and boot never
 * fetches it. See src/features/README.md.
 *
 * ONE VISIT, END TO END:
 *   a lit doorway on a real building down the street -> the gold pad on its step -> E -> fade -> the
 *   GROUND FLOOR of that building is solved and built (never before now) -> you land on the mat
 *   inside, facing down the spine -> rooms off the corridor, a stair and, if it is tall enough, a
 *   lift at the far end -> up the switchback, or ride -> E on the mat under the EXIT sign -> fade ->
 *   back on the exact paving slab you left, in the same street with the same people in it.
 *
 * WHERE THE ROOM LIVES, and this is the decision the whole feature turns on.
 * The interior stands DIRECTLY UNDER ITS OWN BUILDING — same x, same z, well below the terrain, one
 * storey per floor with the top storey nearest the surface. It cannot be built inside the massing:
 * City pushes a collider per massing tier and City.clampMoveAt would freeze the player solid.
 *
 * SAME X, SAME Z is what makes the far-teleport trap go away rather than be worked around. The
 * player's position never changes by a single unit horizontally, so updateBuildingChunks streams
 * nothing, the LifecycleSystem census sees nobody leave, REFRESH_RADIUS recycles nothing, mission
 * distances do not move and city.updateVisibility keeps exactly the chunks it had. Stepping out puts
 * you back in the street you left because you never left it. Nothing had to be frozen behind a modal
 * flag, so nothing can be left frozen.
 *
 * BELOW rather than above, and this one is physics, not taste. Player.update asks
 * City.supportHeight for the standable surface underfoot and hands it to stepVertical, which snaps
 * the player DOWN onto anything within a step and starts a FALL off anything further. Above a roof
 * the interior floor is thirteen units clear of the highest collider, so the player is permanently
 * airborne: a falling animation, and a velocityY that grows every frame against our y-pin until the
 * stutter is a metre a frame. Below the terrain, supportHeight returns the ground far ABOVE the
 * player, `motion.y - support <= stepUp` is trivially true, and stepVertical snaps and zeroes the
 * velocity — grounded, still, and silent. Player.update runs before features.update, so the last
 * word on the player's height each frame is this feature's, and the camera never sees the snap.
 * A feature-owned standable surface would be the honest fix; that seam does not exist. See report.
 *
 * THE CAMERA, which is why the first attempt rendered a black void. Game.updateCamera special-cases
 * plane, train and airborne for the view ladder and the boom, and a feature cannot add a case: the
 * boom is a hard 9.5 units. So the geometry is built for it — the shell is inside-out (a cutaway
 * rather than a wall in front of the lens), the floor plate is never narrower than a corridor plus
 * two rooms, and every interior partition standing between the player and where the camera is gets
 * hidden for that frame using the real render-camera position supplied by FeatureGameApi. Hosts
 * without that optional seam retain the older heading/boom estimate.
 *
 * This feature pushes ZERO colliders. Containment is its own clamp, so dispose() genuinely removes
 * every trace — the append-only collider list never learns this building had an inside.
 */
import * as THREE from 'three';
import type { FeatureGameApi, FeatureHudEntry, FeatureSystem, InteractionDescriptor } from '../types';
import { PLAYER } from '../../config';
import { FIND_CAP, type InteriorDoor, type InteriorsSave } from '../interiors.state';
import {
  BOOM, buildDoorways, buildFloor, EXIT_MAT_IN, INTERIOR_LAMP_INTENSITY, markerFade, toLocal, toWorld,
  type BuiltDoorways, type BuiltFloor,
} from './build';
import {
  buildCore, CORRIDOR, rectMaxX, rectMaxZ, rectMinX, rectMinZ, STOREY_HEIGHT,
  type BuildingCore, type Rect,
} from './core';
import { stablePositionRandom } from '../../world/StableRandom';
import { doorDistrict, doorNear, doorsNear, landmarkDoor, nearestDoor, tallestDoorNear } from './doors';
import { solveFloor, type FloorPlan } from './floor';

/** How long the screen sits black over a swap. Matches UIManager.screenFade's 620 ms feel. */
const FADE_MS = 260;
/** Standing this close to the exit mat offers the way out. Generous: leaving is never a hunt. */
const EXIT_RADIUS = 2.4;
/** How far under the terrain the TOP storey sits. Big enough that the black shroud around a floor
 *  (which reaches ~22 units over its own slab) never pokes out of a hillside, and that the camera,
 *  4.7 units above the player, stays well under the ground it is standing beneath. */
const BASEMENT_DROP = 30;
/** If anything else (death, a checkpoint reload, a cheat teleport) moves the player further than
 *  this from the building, the interior lets go rather than yanking them back. */
const ABANDON_DISTANCE = 90;
/** How far down the street a doorway is built. Far enough to be a landmark you walk toward. */
const STREAM_RANGE = 190;
const STREAM_SLACK = 45;
const STREAM_CAP = 22;
/** Hold a floor this long after the player leaves its sightline, so pacing up and down a few steps
 *  cannot thrash generation. */
const RELEASE_DWELL = 0.8;
/** A prop shorter than this is stepped over, not walked around. The solver's grid uses the same sill. */
const STEP_OVER = 0.55;

/**
 * THE LAMP POOL — the other half of the stall fix (see the header of build.ts).
 *
 * Three.js compiles a fresh program variant for every rendered material each time the scene's light
 * CENSUS changes, and destroys nothing it might need again cheaply — so the old per-floor
 * add-a-light/drop-a-light pattern recompiled the whole scene's shaders on every floor raise and
 * drop: a measured 4.4 s entry freeze and 5.1 s on the first release, then a hitch for every
 * first-visited floor. This pool is created ONCE per visit, holds a constant number of PointLights
 * for the whole stay (unused slots idle at intensity 0, which is a uniform, not a recompile), and is
 * reassigned to the visible floors' lamp positions every frame — 14 uniform writes, nothing else.
 *
 * SIZE: a floor plans at most 2 spine lamps + 8 room lamps + 1 fill (see floor.ts lampsFor), and at
 * most two floors are ever visible (both ends of the flight you are on). 14 covers the current floor
 * completely plus the neighbour's spine, stair-mouth and fill — the parts you actually see up a
 * stairwell. The current floor is assigned first, so any shortfall only ever dims the floor you are
 * NOT standing on.
 */
const LAMP_POOL = 14;
/** Floors kept BUILT (hidden, not disposed) per visit. Raising a cached floor is a visibility flip,
 *  so pacing across the spine sightline costs nothing; the cap bounds memory in a tower. */
const RESIDENT_CACHE = 4;
/** The per-floor fill light: dim, wide, so the corners are never pure black even with the grid down. */
const FILL = { color: 0x9fb0c8, intensity: 5, distance: 44, decay: 1.1 } as const;

interface Resident { plan: FloorPlan; built: BuiltFloor }

interface LampPool {
  readonly lights: readonly THREE.PointLight[];
  readonly ambient: THREE.AmbientLight;
}

interface Visit {
  door: InteriorDoor;
  core: BuildingCore;
  /** World anchor: the building's own centre, and the y its ground floor sits at. */
  x: number; z: number; baseY: number;
  /** Room heading: the door's INWARD yaw, so local +z is "further into the building". */
  heading: number;
  /** Exactly where the player stood outside, restored on the way out. */
  origin: THREE.Vector3;
  /** The storey the player is standing on. */
  floor: number;
  /** Built floors, in LRU order (a raise re-inserts). At most two VISIBLE — see holdNeighbour();
   *  up to RESIDENT_CACHE kept built-but-hidden so re-raising them is a visibility flip. */
  resident: Map<number, Resident>;
  /** The constant-size light pool for this visit. See LAMP_POOL. */
  pool: LampPool;
  /** The floor index at the BOTTOM of the flight the player is on, while they are in the shaft. */
  shaftBase?: number;
  /** Seconds the second floor has been out of sight; it goes when this passes RELEASE_DWELL. */
  idleFor: number;
  fixture?: { ped: NonNullable<ReturnType<FeatureGameApi['spawnFixture']>>; y: number };
  /** Previous local position, for the axis-separated clamp. */
  last: { x: number; z: number };
  /** Peak floors VISIBLE at once this visit — reported by the QA driver, not guessed at. */
  peakResident: number;
}

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem {
  const saved = state as InteriorsSave | undefined;
  const visited = new Set<string>(saved?.visited ?? []);
  let finds = saved?.finds ?? 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let visit: Visit | undefined;
  let phase = 0;
  let swapping = false;
  let disposed = false;
  let overlay: HTMLDivElement | undefined;

  // ---- the fade. The feature API has no screenFade(), so the feature owns one element and takes it
  // away again in dispose(). #fade is z-index 90; this sits just under it and over the HUD.
  const showFade = (on: boolean): void => {
    if (typeof document === 'undefined') return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'interior-fade';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:89;background:#05070a;opacity:0;pointer-events:none;transition:opacity .22s';
      document.body.append(overlay);
    }
    overlay.style.opacity = on ? '1' : '0';
  };
  const after = (ms: number, run: () => void): void => {
    const handle = setTimeout(() => { timers.delete(handle); if (!disposed) run(); }, ms);
    timers.add(handle);
  };

  // ---- the doorways in the street ---------------------------------------------------------------
  let doorways: BuiltDoorways | undefined;
  let builtAt: { x: number; z: number } | undefined;

  const streamDoorways = (x: number, z: number): void => {
    const near = doorsNear(x, z, STREAM_RANGE)
      .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))
      .slice(0, STREAM_CAP);
    const wanted = near.map((door) => door.id).join('|');
    if (doorways && wanted === doorways.ids.join('|')) { builtAt = { x, z }; return; }
    doorways?.dispose();
    doorways = buildDoorways(near, (px, pz) => api.surfaceHeightAt(px, pz));
    api.scene.add(doorways.group);
    builtAt = { x, z };
  };

  // ---- floors, on demand -------------------------------------------------------------------------

  const floorY = (current: Visit, index: number): number => current.baseY + index * STOREY_HEIGHT;

  const visibleCount = (current: Visit): number =>
    [...current.resident.values()].filter((resident) => resident.built.group.visible).length;

  /** Solve and build ONE storey — or, for a floor still in the cache, just show it again. Either
   *  way this is the only place a floor comes to be on screen. */
  const raise = (current: Visit, index: number): Resident | undefined => {
    if (index < 0 || index >= current.core.storeys) return undefined;
    const existing = current.resident.get(index);
    if (existing) {
      existing.built.group.visible = true;
      // LRU touch: re-insert so the longest-unseen floor is the one the cap evicts.
      current.resident.delete(index); current.resident.set(index, existing);
      current.peakResident = Math.max(current.peakResident, visibleCount(current));
      return existing;
    }
    const plan = solveFloor(current.door.facts, index, current.core);
    const built = buildFloor(plan, { ground: index === 0, top: index === current.core.storeys - 1 });
    built.group.position.set(current.x, floorY(current, index), current.z);
    built.group.rotation.y = current.heading;
    api.scene.add(built.group);
    current.resident.set(index, { plan, built });
    // The cap only ever evicts a HIDDEN floor, so the flight the player stands on is untouchable.
    if (current.resident.size > RESIDENT_CACHE) {
      for (const [old, resident] of current.resident) {
        if (resident.built.group.visible) continue;
        resident.built.dispose(); current.resident.delete(old);
        break;
      }
    }
    current.peakResident = Math.max(current.peakResident, visibleCount(current));
    return current.resident.get(index);
  };

  /** A dropped floor HIDES rather than disposes: pacing on and off the spine used to rebuild (and
   *  worse, relight — see LAMP_POOL) the same storey every few seconds. Disposal happens on
   *  close(), or under the cache cap in raise(). */
  const drop = (current: Visit, index: number): void => {
    const resident = current.resident.get(index);
    if (!resident) return;
    resident.built.group.visible = false;
  };

  /** The plan for the storey the player is on. Always resident by construction. */
  const here = (current: Visit): FloorPlan => current.resident.get(current.floor)!.plan;

  // ---- residency: two floors on the stairs, one on a lift ----------------------------------------

  /**
   * THE TRIGGER IS VISIBILITY, NOT ARRIVAL. From anywhere on the spine corridor the stairwell
   * opening is in front of you and you can see the flight and the underside of the storey above, so
   * the storey above has to EXIST before you get there — generating on the top step means the player
   * watches it pop in, which is worse than a load screen because it happens in front of them.
   *
   * So the sightline is the spine plus the shaft, and the neighbour it holds is the one that flight
   * leads to. Off the spine, in a room with the door behind you, the neighbour is released — after a
   * dwell, so pacing back and forth across a doorway cannot thrash generation.
   */
  const holdNeighbour = (current: Visit, local: { x: number; z: number }, dt: number): void => {
    const core = current.core;
    const onSpine = Math.abs(local.x - core.corridorX) < CORRIDOR / 2 + 1.6;
    const inShaft = withinRect(core.stair, local.x, local.z, 0.6);
    const wanted = current.shaftBase !== undefined ? current.shaftBase + 1
      : onSpine || inShaft ? current.floor + 1
        : undefined;
    const live = wanted !== undefined && wanted < core.storeys ? wanted : undefined;
    const keep = new Set([current.floor, current.shaftBase, live].filter((index): index is number => index !== undefined));
    if (live !== undefined) current.idleFor = 0; else current.idleFor += dt;
    // PRUNE BEFORE BUILDING, so the peak really is two and not two-plus-a-frame. Never release
    // either end of a flight the player is standing on.
    if (current.shaftBase === undefined && (live !== undefined || current.idleFor >= RELEASE_DWELL)) {
      for (const index of [...current.resident.keys()]) if (!keep.has(index)) drop(current, index);
    }
    if (live === undefined) return;
    for (const index of keep) raise(current, index);
  };

  // ---- the stair ----------------------------------------------------------------------------------

  /**
   * How high up the flight you are, 0 at the bottom landing and 1 one whole storey above it.
   *
   * The shaft holds a switchback: up the +x half from the front to the mid landing at the back, then
   * up the −x half back to the front, arriving one storey higher directly over where you set off.
   * build.ts draws exactly this; here it is walked. Because the top of one flight is the bottom of
   * the next IN THE SAME SHAFT, there is no special case at either end of the building, and there is
   * no moment where the player is teleported up a storey — they walk it.
   */
  const stairProgress = (shaft: Rect, x: number, z: number): number | undefined => {
    if (!withinRect(shaft, x, z, 0)) return undefined;
    const along = (z - rectMinZ(shaft)) / shaft.d;
    const clamped = Math.max(0, Math.min(1, along));
    return x >= shaft.x ? clamped * 0.5 : 0.5 + (1 - clamped) * 0.5;
  };

  // ---- the light pool ------------------------------------------------------------------------------

  /**
   * Point the constant pool at the visible floors' lamp positions. Current floor first, in full;
   * whatever is left goes to the neighbour, whose lampsFor() order (spine, stair mouth, rooms) means
   * the slots it does get are the ones you see up the shaft. Load shedding scales every assignment —
   * the bulbs sink with the grid; the pool ambient (never scaled) keeps the way out findable.
   * Fourteen uniform writes per frame; the light CENSUS never moves, which is the whole point.
   */
  const assignLamps = (current: Visit): void => {
    const power = 1 - api.blackout();
    const floors = [...current.resident.entries()]
      .filter(([, resident]) => resident.built.group.visible)
      .sort(([a], [b]) => (a === current.floor ? 0 : 1) - (b === current.floor ? 0 : 1));
    let slot = 0;
    const lights = current.pool.lights;
    const place = (index: number, lx: number, lz: number, y: number, color: number, intensity: number, distance: number, decay: number): void => {
      if (slot >= lights.length) return;
      const light = lights[slot]!;
      const world = toWorld(current, current.heading, lx, lz);
      light.position.set(world.x, floorY(current, index) + y, world.z);
      light.color.setHex(color);
      light.intensity = intensity * power;
      light.distance = distance; light.decay = decay;
      slot += 1;
    };
    for (const [index, resident] of floors) {
      for (const lamp of resident.plan.lamps) place(index, lamp.x, lamp.z, lamp.y, lamp.color, INTERIOR_LAMP_INTENSITY, 22, 1.5);
      place(index, 0, -resident.plan.depth * 0.2, resident.plan.height * 0.82, FILL.color, FILL.intensity, FILL.distance, FILL.decay);
    }
    for (; slot < lights.length; slot++) lights[slot]!.intensity = 0;
  };

  // ---- entering / leaving --------------------------------------------------------------------------

  const install = (door: InteriorDoor): void => {
    const core = buildCore(door.facts);
    const heading = door.heading + Math.PI; // local +z runs away from the street, into the building
    // Floor 0 is the DEEPEST, so climbing a storey raises you and the top floor is the one just
    // under the pavement — the building, the right way up, buried.
    const baseY = api.surfaceHeightAt(door.facts.x, door.facts.z) - BASEMENT_DROP - (core.storeys - 1) * STOREY_HEIGHT;
    const origin = api.playerPosition().clone();
    // The visit's whole light budget, made once, under the entry fade: the scene's light census then
    // holds perfectly still until the exit fade, which is the invariant the stall fix rests on.
    const pool: LampPool = {
      lights: Array.from({ length: LAMP_POOL }, () => new THREE.PointLight(0xffffff, 0, 22, 1.5)),
      ambient: new THREE.AmbientLight(0xffe9cc, 0.24),
    };
    for (const light of pool.lights) api.scene.add(light);
    api.scene.add(pool.ambient);
    visit = {
      door, core, x: door.facts.x, z: door.facts.z, baseY, heading, origin,
      floor: 0, resident: new Map(), idleFor: 0, last: { x: core.entryX, z: -core.depth / 2 + EXIT_MAT_IN },
      peakResident: 0, pool,
    };
    const ground = raise(visit, 0)!;
    assignLamps(visit);
    // Land ON THE MAT, facing down the spine at the stair — the shape of the room reads from here.
    const stand = toWorld(visit, heading, core.entryX, -core.depth / 2 + EXIT_MAT_IN);
    api.playerPosition().set(stand.x, baseY, stand.z);
    placeFixture(visit, ground.plan);
    api.analytics('entered', { detail: core.entrance });
    const first = !visited.has(door.id);
    if (first) visited.add(door.id);
    if (first && finds < FIND_CAP) {
      finds += 1;
      const find = 30 + Math.floor(stableFind(core.seed) * 5) * 10;
      api.earn(find);
      api.notify(door.name, `${ground.plan.findLine} +R${find}`, true);
      api.analytics('first_visit', { detail: core.entrance, value: find });
    } else {
      api.notify(door.name, ground.plan.blurb, true);
    }
    api.persist();
  };

  const placeFixture = (current: Visit, plan: FloorPlan): void => {
    if (current.fixture) { api.removeFixture(current.fixture.ped); current.fixture = undefined; }
    if (!plan.fixture) return;
    const spot = toWorld(current, current.heading, plan.fixture.x, plan.fixture.z);
    const ped = api.spawnFixture(spot.x, spot.z, plan.fixture.name);
    // spawnFixture grounds the ped on the terrain, which for an interior is a hundred metres below
    // the floor it should be standing on. The API has no way to place one at a height, so its y is
    // pinned here every frame instead. Noted as a gap rather than papered over.
    if (ped) { ped.group.position.y = floorY(current, current.floor); current.fixture = { ped, y: floorY(current, current.floor) }; }
  };

  const enter = (door: InteriorDoor, instant = false): string => {
    if (visit) return 'failed:already-inside';
    if (swapping) return 'failed:mid-fade';
    if (instant) { install(door); return 'ok'; }
    swapping = true;
    showFade(true);
    after(FADE_MS, () => { install(door); swapping = false; after(90, () => showFade(false)); });
    return 'ok';
  };

  /** Tear the building down. `restore` is false when the world already moved the player elsewhere. */
  const close = (restore: boolean): void => {
    if (!visit) return;
    const current = visit;
    visit = undefined;
    if (current.fixture) api.removeFixture(current.fixture.ped);
    for (const resident of current.resident.values()) resident.built.dispose();
    current.resident.clear();
    // The pool goes with the visit, under the exit fade. The census outside is the same one we left,
    // so its program variants are still warm in every material — no recompile on the way out.
    for (const light of current.pool.lights) { light.removeFromParent(); light.dispose(); }
    current.pool.ambient.removeFromParent(); current.pool.ambient.dispose();
    if (restore) api.playerPosition().copy(current.origin);
    api.analytics('left', { detail: current.core.entrance });
  };

  const leave = (instant = false): string => {
    if (!visit) return 'failed:not-inside';
    if (instant) { swapping = false; close(true); api.persist(); return 'ok'; }
    if (swapping) return 'failed:mid-fade';
    swapping = true;
    showFade(true);
    after(FADE_MS, () => { close(true); swapping = false; api.persist(); after(90, () => showFade(false)); });
    return 'ok';
  };

  // ---- the lift -------------------------------------------------------------------------------------

  /** A lift is the cheap path as well as the fast one, which is the right incentive in a tower: the
   *  player is enclosed for the whole journey, so the floor they left is released as the doors close
   *  and only the destination is ever built. ONE floor resident, against two on a stair. */
  const rideTo = (current: Visit, index: number): string => {
    if (index < 0 || index >= current.core.storeys) return 'failed:no-such-floor';
    swapping = true;
    showFade(true);
    after(FADE_MS + 220, () => {
      for (const resident of [...current.resident.keys()]) drop(current, resident);
      current.floor = index;
      current.shaftBase = undefined;
      const arrived = raise(current, index)!;
      const spot = toWorld(current, current.heading, arrived.plan.landing.x, arrived.plan.landing.z);
      api.playerPosition().set(spot.x, floorY(current, index), spot.z);
      current.last = { ...arrived.plan.landing };
      assignLamps(current);
      placeFixture(current, arrived.plan);
      api.analytics('lift', { value: index });
      swapping = false;
      after(90, () => showFade(false));
    });
    return 'ok';
  };

  const openLiftMenu = (current: Visit): void => {
    const rows: { id: string; label: string; detail?: string; disabled?: boolean }[] = [];
    for (let index = 0; index < current.core.storeys; index++) {
      rows.push({
        id: `floor:${index}`,
        label: index === 0 ? 'Ground floor' : `Floor ${index}`,
        detail: index === current.floor ? 'you are here' : undefined,
        disabled: index === current.floor,
      });
    }
    api.showMenu({
      featureId: 'interiors', eyebrow: current.door.name.toUpperCase(), title: 'Lift',
      blurb: `${current.core.storeys} floors. The buttons for half of them have been pressed flat.`,
      rows,
    });
  };

  // ---- containment -----------------------------------------------------------------------------------

  /** Everything solid on a floor, as room-local boxes: the partitions with their doorways cut out,
   *  the lift shaft, the stair's spine wall, the caps on the flights that lead nowhere, and every
   *  piece of furniture the solver proved does not seal a doorway. */
  const obstacles = (current: Visit, plan: FloorPlan): Rect[] => {
    const out: Rect[] = [];
    const core = current.core;
    for (const wall of plan.walls) {
      const push = (from: number, to: number): void => {
        if (to - from < 0.02) return;
        out.push(wall.axis === 'x'
          ? { x: wall.at, z: (from + to) / 2, w: 0.2, d: to - from }
          : { x: (from + to) / 2, z: wall.at, w: to - from, d: 0.2 });
      };
      if (wall.gapWidth === undefined) push(wall.from, wall.to);
      else { push(wall.from, wall.gapCentre! - wall.gapWidth / 2); push(wall.gapCentre! + wall.gapWidth / 2, wall.to); }
    }
    if (core.lift) out.push(core.lift);
    out.push({ x: core.stair.x, z: core.stair.z - core.stair.d * 0.19, w: 0.16, d: core.stair.d * 0.62 });
    // The shuttered half flight is NOT in this list. The clamp is two-dimensional, and the shutter at
    // the foot of the ground floor's down flight sits directly under the TOP of its up flight — as a
    // flat obstacle it walls off the last step of a climb the player is three metres above. The
    // flight that leads nowhere is refused by altitude instead: see the guard in clamp().
    for (const prop of plan.props) {
      if (prop.solid && prop.h >= STEP_OVER) out.push({ x: prop.x, z: prop.z, w: prop.w, d: prop.d });
    }
    return out;
  };

  /** How far up the flight the player was last frame, so stepping off the end resolves to the
   *  storey they actually stepped onto rather than the one they set out from. */
  let lastProgress = 0;

  /**
   * Axis-separated clamp in floor-local space — exactly the shape City.clampMove uses, so it feels
   * identical to the street. Also pins the player to this storey's floor plane, or, in the shaft, to
   * the flight they are standing on.
   */
  const clamp = (current: Visit, dt: number): void => {
    const plan = here(current);
    const player = api.playerPosition();
    const local = toLocal(current, current.heading, player.x, player.z);
    const halfW = plan.width / 2 - PLAYER.radius;
    const halfD = plan.depth / 2 - PLAYER.radius;
    let x = Math.max(-halfW, Math.min(halfW, local.x));
    let z = Math.max(-halfD, Math.min(halfD, local.z));
    const boxes = obstacles(current, plan);
    const blocked = (px: number, pz: number): boolean => boxes.some((box) =>
      Math.abs(px - box.x) < box.w / 2 + PLAYER.radius && Math.abs(pz - box.z) < box.d / 2 + PLAYER.radius);
    const wasAt = current.last;
    if (blocked(x, current.last.z)) x = current.last.x;
    if (blocked(x, z)) z = current.last.z;
    current.last = { x, z };

    // Height: the floor plane, unless the player is on the flight, in which case the flight.
    const progress = stairProgress(current.core.stair, x, z);
    if (progress === undefined) {
      if (current.shaftBase !== undefined) {
        // Stepped off the flight onto a storey. Which one is decided by which end they left from.
        current.floor = current.shaftBase + (lastProgress > 0.5 ? 1 : 0);
        current.shaftBase = undefined;
        raise(current, current.floor);
        placeFixture(current, here(current));
      }
      const world = toWorld(current, current.heading, x, z);
      player.set(world.x, floorY(current, current.floor), world.z);
    } else {
      if (current.shaftBase === undefined) {
        // Which flight this is: the +x half climbs FROM this storey, the −x half arrives ON it.
        const base = progress < 0.5 ? current.floor : current.floor - 1;
        if (base < 0 || base + 1 >= current.core.storeys) {
          // No storey at the far end — the roof hatch is locked, and there is no basement. Refuse the
          // step rather than walk the player up a flight to nowhere. build.ts draws the same shutter.
          current.last = wasAt;
          const stay = toWorld(current, current.heading, wasAt.x, wasAt.z);
          player.set(stay.x, floorY(current, current.floor), stay.z);
          holdNeighbour(current, wasAt, dt);
          return;
        }
        current.shaftBase = base;
        // Both ends of a flight must exist before a foot lands on it.
        raise(current, current.shaftBase);
        raise(current, current.shaftBase + 1);
      }
      lastProgress = progress;
      const world = toWorld(current, current.heading, x, z);
      player.set(world.x, floorY(current, current.shaftBase) + progress * STOREY_HEIGHT, world.z);
    }
    holdNeighbour(current, { x, z }, dt);
  };

  /**
   * Hide the partitions standing between the player and the actual camera. The boom is 9.5 units,
   * so in a room narrower than that the lens can be in the next room along — and a wall directly in
   * front of it is exactly the black screen this feature shipped with. The fallback keeps custom
   * hosts source-compatible, but Game supplies the render camera and therefore also handles orbiting,
   * cover lean, first-person transitions and collision-shortened booms correctly.
   */
  const cullPartitions = (current: Visit): void => {
    const resident = current.resident.get(current.floor);
    if (!resident) return;
    const player = api.playerPosition();
    const yaw = api.playerHeading();
    const eye = toLocal(current, current.heading, player.x, player.z);
    const camera = api.cameraPosition?.();
    const back = camera
      ? toLocal(current, current.heading, camera.x, camera.z)
      : toLocal(current, current.heading, player.x - Math.sin(yaw) * BOOM, player.z - Math.cos(yaw) * BOOM);
    const onTheStair = withinRect(current.core.stair, eye.x, eye.z, 0.8);
    for (const partition of resident.built.partitions) {
      if (partition.core && onTheStair) { partition.mesh.visible = true; continue; }
      partition.mesh.visible = !segmentCrossesBox(eye, back, partition);
    }
    // The floors either side of this one are only ever seen up the shaft; nothing of theirs should
    // ever be between the camera and the player, so they keep every wall. (Cached-hidden floors are
    // skipped — their whole group is invisible, and touching them would fight the cache.)
    for (const [index, other] of current.resident) {
      if (index === current.floor || !other.built.group.visible) continue;
      for (const partition of other.built.partitions) partition.mesh.visible = true;
    }
  };

  // ---- interaction rungs ---------------------------------------------------------------------------

  const rungs: InteractionDescriptor[] = [
    {
      id: 'interiors:leave', order: 44, context: 'foot',
      test: (ctx) => {
        if (!visit || visit.floor !== 0) return undefined;
        const local = toLocal(visit, visit.heading, ctx.position.x, ctx.position.z);
        const plan = here(visit);
        if (Math.hypot(local.x - visit.core.entryX, local.z + plan.depth / 2 - EXIT_MAT_IN) > EXIT_RADIUS) return undefined;
        return { prompt: 'E  Step outside', act: () => { leave(); } };
      },
    },
    {
      id: 'interiors:lift', order: 45, context: 'foot',
      test: (ctx) => {
        if (!visit || !visit.core.lift) return undefined;
        const local = toLocal(visit, visit.heading, ctx.position.x, ctx.position.z);
        const lift = visit.core.lift;
        if (Math.abs(local.x - lift.x) > lift.w / 2 + 1.4 || Math.abs(local.z - rectMinZ(lift)) > 2.0) return undefined;
        const current = visit;
        return { prompt: `E  Call the lift · ${current.core.storeys} floors`, act: () => openLiftMenu(current) };
      },
    },
    {
      // BELOW THE PEOPLE, ON PURPOSE. There are thousands of front doors and they are everywhere, so
      // this is the one rung in the game that can turn up next to any other feature's rung — and a
      // tie in `order` is broken alphabetically by id, which is not a design decision anybody made.
      // At the 50 this used to sit on it beat `street:deal` (50) and `street:worker` (51) purely
      // because "interiors" sorts before "street", and a dealer standing in a doorway would have
      // become unreachable — the exact failure the street branch shipped a proximity ring to fix.
      // 52 puts the door under both of them and still over the ambient prompts (golf:desk 54,
      // protest 54-62). A person you can talk to always outranks a door you can always come back to.
      id: 'interiors:door', order: 52, context: 'foot',
      test: (ctx) => {
        if (visit) return undefined;
        const door = doorNear(ctx.position.x, ctx.position.z);
        if (!door) return undefined;
        return { prompt: `E  Go inside · ${door.name}`, act: () => { enter(door); } };
      },
    },
  ];

  // ---- the system ------------------------------------------------------------------------------------

  return {
    update: (dt) => {
      const player = api.playerPosition();
      const current = visit;
      if (!current && (!builtAt || Math.hypot(player.x - builtAt.x, player.z - builtAt.z) > STREAM_SLACK)) {
        streamDoorways(player.x, player.z);
      }
      phase += dt;
      // THE MARKERS FADE UP AS YOU REACH THEM. A shop pad pulses at full strength from across the
      // street because there are six of them; there are thousands of front doors, so a door only
      // lights when you are nearly on its step and a street of houses reads as a street of houses.
      // See markerFade / the note over it in build.ts.
      const pulse = 0.24 + Math.sin(phase * 2.6) * 0.09;
      if (doorways) {
        for (const marker of doorways.markers) {
          const fade = markerFade(Math.hypot(marker.x - player.x, marker.z - player.z));
          const lit = fade > 0.001;
          marker.disc.visible = lit; marker.ring.visible = lit; marker.bay.visible = lit;
          if (!lit) continue;
          marker.discMaterial.opacity = pulse * fade;
          marker.ringMaterial.opacity = 0.7 * fade;
          marker.disc.rotation.y += dt * 0.9;
        }
      }
      if (!current) return;
      if (swapping) return;
      // Death, a checkpoint reload or a console teleport all move the player without telling us.
      if (Math.hypot(player.x - current.x, player.z - current.z) > ABANDON_DISTANCE) { close(false); showFade(false); return; }
      clamp(current, dt);
      cullPartitions(current);
      if (current.fixture) current.fixture.ped.group.position.y = floorY(current, current.floor);
      // Load shedding reaches inside: the pool lamps sink with the grid, the pool ambient does not,
      // so the way out is always findable. assignLamps also tracks raise/drop from this frame.
      assignLamps(current);
      const power = 1 - api.blackout();
      for (const resident of current.resident.values()) {
        for (const entry of resident.built.powered) entry.material.emissiveIntensity = entry.base * power;
      }
    },

    hud: (): FeatureHudEntry[] | undefined => {
      if (!visit) return undefined;
      const plan = here(visit);
      return [
        { id: 'interiors:where', label: plan.eyebrow, value: visit.door.name },
        { id: 'interiors:floor', label: 'FLOOR', value: `${visit.floor}/${visit.core.storeys - 1}` },
      ];
    },

    /** Under a roof, with the lamps above (dimmed by the grid, never out) and the exit mat behind. */
    indoors: () => Boolean(visit),

    interactions: () => rungs,

    serialize: () => ({ visited: [...visited].slice(-32), finds }),

    restore: (next) => {
      const incoming = next as InteriorsSave | undefined;
      visited.clear();
      for (const id of incoming?.visited ?? []) visited.add(id);
      finds = incoming?.finds ?? 0;
      close(false);
    },

    menu: (actionId) => {
      const current = visit;
      if (!current || !actionId.startsWith('floor:')) return;
      const index = Number.parseInt(actionId.slice(6), 10);
      if (!Number.isFinite(index)) return;
      api.closeMenu();
      rideTo(current, index);
    },

    command: (args) => {
      const [verb, target] = args;
      const player = api.playerPosition();
      if (!verb || verb === 'doors') {
        const near = doorsNear(player.x, player.z, STREAM_RANGE * 2);
        if (near.length === 0) return ['No doors within 380u. Try a street.'];
        return near
          .sort((a, b) => Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z))
          .slice(0, 12)
          .map((door) => `${door.name} — ${Math.hypot(door.x - player.x, door.z - player.z).toFixed(0)}u away, ${buildCore(door.facts).storeys} floors @ ${door.x.toFixed(0)},${door.z.toFixed(0)}${visited.has(door.id) ? ' (visited)' : ''}`);
      }
      if (verb === 'where') {
        if (!visit) return ['Outside.'];
        const plan = here(visit);
        const shown = [...visit.resident.entries()].filter(([, r]) => r.built.group.visible).map(([index]) => index).sort((a, b) => a - b);
        return [
          `${visit.door.name}: floor ${visit.floor} of ${visit.core.storeys}, ${plan.rooms.length} rooms, ${plan.walkable} walkable tiles, ${plan.unreachable} unreachable.`,
          `Visible floors: ${shown.join(', ')} (peak ${visit.peakResident}); cached ${visit.resident.size}/${RESIDENT_CACHE}.`,
        ];
      }
      if (verb === 'leave') return [leave() === 'ok' ? 'Stepping out.' : 'Not inside anything.'];
      if (verb === 'lift') {
        if (!visit) return ['Not inside anything.'];
        const index = Number.parseInt(target ?? '', 10);
        if (!Number.isFinite(index)) return [`feature interiors lift <0..${visit.core.storeys - 1}>`];
        return [rideTo(visit, index) === 'ok' ? `Riding to floor ${index}.` : 'That floor does not exist.'];
      }
      if (verb === 'go' || verb === 'enter') {
        const door = target === 'ponte' ? landmarkDoor()
          : target === 'tall' ? tallestDoorNear(player.x, player.z, STREAM_RANGE * 3)
            : nearestDoor(player.x, player.z);
        if (!door) return ['No door found from here.'];
        player.set(door.x, api.surfaceHeightAt(door.x, door.z), door.z);
        streamDoorways(door.x, door.z);
        if (verb === 'go') return [`On the step at ${door.name} (${doorDistrict(door)}), ${buildCore(door.facts).storeys} floors. Press E.`];
        return [enter(door) === 'ok' ? `Entering ${door.name}.` : `Could not enter ${door.name}.`];
      }
      return ['feature interiors [doors|go [ponte|tall]|enter [ponte|tall]|lift <n>|leave|where]'];
    },

    /**
     * The machine playthrough. `run` walks the whole loop for one door without a human: stand on the
     * step, go in, prove the room contains you, climb a storey on the stair, ride the lift if there
     * is one, come back down, and prove you are returned to the same paving slab.
     */
    qa: (action, args) => {
      const player = api.playerPosition();
      const wanted = typeof args.door === 'string' ? args.door : undefined;
      const pick = (): InteriorDoor | undefined => (wanted === 'ponte' ? landmarkDoor()
        : wanted === 'tall' ? tallestDoorNear(player.x, player.z, STREAM_RANGE * 3)
          : nearestDoor(player.x, player.z));

      if (action === 'doors') {
        const near = doorsNear(player.x, player.z, STREAM_RANGE);
        return near.length === 0 ? 'none' : near.map((door) => `${door.id}@${door.x.toFixed(0)},${door.z.toFixed(0)}`).join(',');
      }
      if (action === 'status') {
        if (!visit) return 'outside';
        const plan = here(visit);
        return `inside|${visit.door.id}|floor=${visit.floor}|storeys=${visit.core.storeys}|rooms=${plan.rooms.length}|unreachable=${plan.unreachable}|resident=${visibleCount(visit)}|cached=${visit.resident.size}|peak=${visit.peakResident}|lift=${visit.core.lift ? 'yes' : 'no'}`;
      }
      if (action === 'leave') return leave(true);
      if (action === 'stand') {
        const door = pick();
        if (!door) return 'stuck:no-doors';
        const back = typeof args.back === 'number' ? args.back : 0;
        const x = door.x + Math.sin(door.heading) * back;
        const z = door.z + Math.cos(door.heading) * back;
        player.set(x, api.surfaceHeightAt(x, z), z);
        streamDoorways(x, z);
        // Pipe-separated: door ids contain a colon, and the harness vocabulary already owns ':'.
        return `ok|${door.id}|${door.name}|${door.heading.toFixed(4)}|${door.x.toFixed(2)}|${door.z.toFixed(2)}|${buildCore(door.facts).storeys}`;
      }
      // ONE STRIDE toward a floor-local point, through the same clamp a player meets. A stride, not
      // a teleport: a driver that jumps to its destination proves nothing about whether you could
      // have walked there, and the doorway it skipped over is exactly the thing under test.
      if (action === 'walk') {
        if (!visit) return 'failed:not-inside';
        const x = typeof args.x === 'number' ? args.x : 0;
        const z = typeof args.z === 'number' ? args.z : 0;
        const from = visit.last;
        const dx = x - from.x; const dz = z - from.z;
        const distance = Math.hypot(dx, dz);
        const stride = Math.min(0.16, distance);
        const step = distance < 1e-4 ? from : { x: from.x + dx / distance * stride, z: from.z + dz / distance * stride };
        const spot = toWorld(visit, visit.heading, step.x, step.z);
        player.set(spot.x, player.y, spot.z);
        clamp(visit, 1 / 60);
        const local = toLocal(visit, visit.heading, player.x, player.z);
        return `ok|${local.x.toFixed(2)}|${local.z.toFixed(2)}|y=${player.y.toFixed(2)}|floor=${visit.floor}|to=${distance.toFixed(2)}`;
      }
      if (action === 'enter' || action === 'run') {
        const door = pick();
        if (!door) return 'stuck:no-doors';
        if (visit) leave(true);
        player.set(door.x, api.surfaceHeightAt(door.x, door.z), door.z);
        const outside = player.clone();
        if (!doorNear(player.x, player.z)) return 'failed:doorstep-out-of-ring';
        const entered = enter(door, true);
        if (entered !== 'ok') return entered;
        if (action === 'enter') return 'ok';
        const current = visit as Visit | undefined;
        if (!current) return 'failed:no-visit';
        const ground = current.resident.get(0);
        if (!ground?.built.group.parent) return 'failed:floor-not-in-scene';
        if (ground.plan.unreachable !== 0) return `failed:unreachable-${ground.plan.unreachable}`;
        // Shove the player at each wall a metre past it and confirm the clamp holds them in.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const push = toWorld(current, current.heading, dx * (ground.plan.width / 2 + 1), dz * (ground.plan.depth / 2 + 1));
          player.set(push.x, player.y, push.z);
          clamp(current, 1 / 60);
          const local = toLocal(current, current.heading, player.x, player.z);
          if (Math.abs(local.x) > ground.plan.width / 2 + 0.01 || Math.abs(local.z) > ground.plan.depth / 2 + 0.01) return `failed:escaped-${dx}-${dz}`;
        }
        // The shove test left the driver against a wall in whichever room it was thrown into. Put
        // it back on the mat before the climb, the way a player who had wandered would walk back.
        const home = toWorld(current, current.heading, current.core.entryX, -ground.plan.depth / 2 + EXIT_MAT_IN);
        player.set(home.x, player.y, home.z);
        current.last = { x: current.core.entryX, z: -ground.plan.depth / 2 + EXIT_MAT_IN };
        clamp(current, 1 / 60);
        // Climb one storey on the stair, a step at a time, exactly as a player would.
        if (current.core.storeys > 1) {
          const climbed = climb(current, 1);
          if (climbed !== 'ok') return climbed;
          if (current.peakResident > 2) return `failed:peak-residency-${current.peakResident}`;
          const back = climb(current, -1);
          if (back !== 'ok') return back;
        }
        if (current.floor !== 0) return `failed:not-back-on-the-ground-${current.floor}`;
        // Back to the mat, and out the way we came.
        const plan = here(current);
        const mat = toWorld(current, current.heading, current.core.entryX, -plan.depth / 2 + EXIT_MAT_IN);
        player.set(mat.x, player.y, mat.z);
        const offer = rungs[0]!.test({ context: 'foot', position: player, vehicle: undefined, hour: api.hour() });
        if (!offer) return 'failed:no-exit-prompt';
        offer.act();
        leave(true);
        if (visit) return 'failed:still-inside';
        if (player.distanceTo(outside) > 0.01) return `failed:returned-${player.distanceTo(outside).toFixed(2)}u-away`;
        return 'ok';
      }
      return `stuck:unknown-action:${action}`;
    },

    dispose: () => {
      disposed = true; swapping = false;
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
      close(false);
      doorways?.dispose();
      doorways = undefined;
      builtAt = undefined;
      overlay?.remove();
      overlay = undefined;
    },
  };

  /** Walk the switchback one whole storey, in player-sized steps through the same clamp the player
   *  uses. Returns 'ok' only if the storey actually changed. */
  function climb(current: Visit, direction: 1 | -1): string {
    const from = current.floor;
    const shaft = current.core.stair;
    const player = api.playerPosition();
    // Waypoints: front of the up half, back of it, back of the down half, front of the down half.
    const lane = shaft.w / 4;
    // Onto the spine first — the corridor is the one route every room opens onto, so this is the
    // walk a player makes, not a shortcut through a wall.
    const spine: [number, number][] = [[current.core.corridorX, current.last.z], [current.core.corridorX, rectMinZ(shaft) - 1.6]];
    const path: [number, number][] = direction > 0
      ? [[shaft.x + lane, rectMinZ(shaft) + 0.3], [shaft.x + lane, rectMaxZ(shaft) - 0.3], [shaft.x - lane, rectMaxZ(shaft) - 0.3], [shaft.x - lane, rectMinZ(shaft) + 0.3]]
      : [[shaft.x - lane, rectMinZ(shaft) + 0.3], [shaft.x - lane, rectMaxZ(shaft) - 0.3], [shaft.x + lane, rectMaxZ(shaft) - 0.3], [shaft.x + lane, rectMinZ(shaft) + 0.3]];
    let at = { x: current.last.x, z: current.last.z };
    for (const [tx, tz] of [...spine, ...path, [current.core.corridorX, rectMinZ(shaft) - 1.6]] as [number, number][]) {
      for (let step = 0; step < 200; step++) {
        const dx = tx - at.x; const dz = tz - at.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.12) break;
        const stride = Math.min(0.16, distance);
        at = { x: at.x + dx / distance * stride, z: at.z + dz / distance * stride };
        const spot = toWorld(current, current.heading, at.x, at.z);
        player.set(spot.x, player.y, spot.z);
        clamp(current, 1 / 60);
        const local = toLocal(current, current.heading, player.x, player.z);
        at = { x: local.x, z: local.z };
      }
    }
    if (current.floor === from + direction) return 'ok';
    // Say exactly where it stopped: a climb that fails silently is a bug you debug twice.
    return `failed:climb-${direction}-stayed-on-${current.floor}-from-${from}`
      + `-at-${current.last.x.toFixed(2)},${current.last.z.toFixed(2)}`
      + `-shaft-${shaft.x.toFixed(2)},${rectMinZ(shaft).toFixed(2)}..${rectMaxZ(shaft).toFixed(2)}`
      + `-base-${current.shaftBase ?? 'none'}-p-${lastProgress.toFixed(2)}`;
  }
}

// ---- geometry helpers ------------------------------------------------------------------------------

function withinRect(rect: Rect, x: number, z: number, grow: number): boolean {
  return x >= rectMinX(rect) - grow && x <= rectMaxX(rect) + grow
    && z >= rectMinZ(rect) - grow && z <= rectMaxZ(rect) + grow;
}

function segmentCrossesBox(
  a: { x: number; z: number }, b: { x: number; z: number },
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  // Slab test in 2D. Grown a little so a wall the camera is grazing goes too.
  const pad = 0.35;
  const minX = box.minX - pad; const maxX = box.maxX + pad;
  const minZ = box.minZ - pad; const maxZ = box.maxZ + pad;
  let t0 = 0; let t1 = 1;
  for (const [origin, delta, low, high] of [[a.x, b.x - a.x, minX, maxX], [a.z, b.z - a.z, minZ, maxZ]] as const) {
    if (Math.abs(delta) < 1e-6) { if (origin < low || origin > high) return false; continue; }
    const near = (low - origin) / delta; const far = (high - origin) / delta;
    t0 = Math.max(t0, Math.min(near, far));
    t1 = Math.min(t1, Math.max(near, far));
    if (t0 > t1) return false;
  }
  return true;
}

/** One stable draw for the first-visit find, off the building's own seed. Math.sin-based hashes are
 *  not deterministic across engines — see StableRandom — so this goes through the house helper. */
function stableFind(seed: number): number {
  return stablePositionRandom(seed, 0, 0xf1d5);
}
