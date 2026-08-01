/**
 * A solved floor, in three.js. Built on first use, disposed on the way out — nothing here is
 * reachable from City.buildStages or prepareAssets, so an interior costs boot exactly nothing.
 *
 * THE SHELL IS INSIDE-OUT ON PURPOSE. The camera boom only shortens against City's own colliders
 * (CameraController probes city.collidesAt) and a feature cannot register one, so if the player hugs
 * an outer wall the boom WILL swing through it. A front-faced shell would put an opaque wall between
 * the camera and the player; a BackSide shell disappears from outside instead, so the worst case
 * degrades to a cutaway rather than the black screen this feature shipped with the first time.
 *
 * PARTITIONS ARE A DIFFERENT PROBLEM and get a different answer. An interior wall stands BETWEEN two
 * rooms, so inside-out does not help: whichever room the camera is in, it sees a face. So every
 * partition is handed back with its footprint (see `partitions`) and the feature hides the ones that
 * stand between the player and where the camera is. That is the standard third-person interior
 * treatment and it is the only one available while the boom is not ours to shorten.
 */
import * as THREE from 'three';
import { createSignMesh } from '../../world/ProceduralMaterials';
import { hatchFoot, rectMaxX, rectMaxZ, rectMinX, rectMinZ, STOREY_HEIGHT, type Rect } from './core';
import type { FloorPlan, Prop, Wall } from './floor';
import type { InteriorDoor } from '../interiors.state';

/** The camera boom this room has to stand inside. FOOT_VIEW_DISTANCES tops out here. */
export const BOOM = 9.5;
/** Interior bulbs are deliberately below streetlight intensity. The floors sit below the terrain,
 *  but Three's global sun has no roof geometry to shadow them; brighter bulbs plus that daylight
 *  clipped pale rooms to white at noon. */
export const INTERIOR_LAMP_INTENSITY = 12;
const WALL_T = 0.16;
/** Doorway head height. Partitions carry a lintel over the gap so a doorway reads as a doorway. */
const DOOR_H = 2.25;

/** A partition, with the footprint the occlusion cull tests against. */
export interface Partition {
  readonly mesh: THREE.Object3D;
  readonly minX: number; readonly maxX: number;
  readonly minZ: number; readonly maxZ: number;
  /** The stair core, as one occluder. It hides like any other wall when it stands between the player
   *  and the lens — which it does every time you step off a flight, because the boom then swings
   *  straight back into the shaft — but NOT while the player is on it. You cannot walk up a flight
   *  you cannot see. */
  readonly core?: boolean;
}

export interface BuiltFloor {
  readonly group: THREE.Group;
  readonly powered: readonly { material: THREE.MeshStandardMaterial; base: number }[];
  readonly partitions: readonly Partition[];
  dispose(): void;
}

/**
 * NO LIGHTS IN A FLOOR, AND THIS IS THE STALL FIX. Three.js compiles a program variant per
 * (material, light-census) pair for EVERY material it renders, so a floor that brings its own
 * PointLights changes NUM_POINT_LIGHTS for the whole scene on every raise and drop — measured at
 * 4.4 s for the entry storm and 5.1 s for the first drop under SwiftShader, and a visible freeze on
 * hardware. Floors therefore emit only lamp POSITIONS (plan.lamps, drawn here as bulb meshes); the
 * feature owns one constant-size pool of PointLights per visit (see interiors.ts LAMP_POOL) and
 * repositions them, so the light census never changes between the entry fade and the exit fade.
 *
 * MATERIALS ARE SHARED FOR THE SAME REASON, second order: a fresh MeshStandardMaterial per floor
 * meant every first visit to a floor compiled a handful of new program variants mid-walk (measured
 * 196-333 ms apiece). Everything here draws from a module-level cache keyed on colour/roughness/side,
 * so after the first floor of a session there is nothing left to compile. Cached materials are NEVER
 * disposed by a floor — the cache is bounded by the palette tables in floor.ts.
 */
const MATERIALS = new Map<string, THREE.MeshStandardMaterial>();
function shared(color: number, roughness: number, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${side}`;
  let material = MATERIALS.get(key);
  if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness, side }); MATERIALS.set(key, material); }
  return material;
}
/** Emissive materials, one per role. `powered` entries reference these shared instances; the blackout
 *  ramp writes the same product into each, so sharing cannot desynchronise them. */
const GLOW = new Map<string, THREE.MeshStandardMaterial>();
function sharedGlow(color: number, emissive: number, intensity: number, roughness: number): THREE.MeshStandardMaterial {
  const key = `${color}|${emissive}|${intensity}|${roughness}`;
  let material = GLOW.get(key);
  if (!material) { material = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity, roughness }); GLOW.set(key, material); }
  return material;
}
/** Fixed-colour basics (the void, door mouths, the exit-mat glow). */
const VOID_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x05070a, side: THREE.BackSide, fog: false });
const MOUTH_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x0a0d10, fog: false });
const MAT_GLOW_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xe8b64c, transparent: true, opacity: 0.34, fog: false });
/** One unit box, scaled per mesh — floors were allocating (and disposing) hundreds of BoxGeometries
 *  each; every box in an interior is axis-aligned and untextured, so scale carries the whole shape. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const BULB_GEOMETRY = new THREE.SphereGeometry(0.13, 10, 8);

/** Local room point -> world. group.rotation.y = h maps local (lx, lz) to
 *  world (lx·cos h + lz·sin h, −lx·sin h + lz·cos h). */
export function toWorld(at: { x: number; z: number }, heading: number, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(heading); const s = Math.sin(heading);
  return { x: at.x + lx * c + lz * s, z: at.z - lx * s + lz * c };
}

/** World point -> local floor space. Exact inverse of toWorld. */
export function toLocal(at: { x: number; z: number }, heading: number, x: number, z: number): { x: number; z: number } {
  const c = Math.cos(heading); const s = Math.sin(heading);
  const dx = x - at.x; const dz = z - at.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** What is special about the ends of the building: the ground floor gets the street exit and the
 *  under-stair storage, the top floor gets a stair head instead of a flight to nowhere, and a top
 *  floor with `hatch` gets the ladder to the roof. */
export interface FloorEnds { ground: boolean; top: boolean; hatch: boolean }

export function buildFloor(plan: FloorPlan, ends: FloorEnds): BuiltFloor {
  const group = new THREE.Group();
  group.name = `Floor:${plan.core.id}:${plan.index}`;

  const geometries: THREE.BufferGeometry[] = [];
  const powered: { material: THREE.MeshStandardMaterial; base: number }[] = [];
  const partitions: Partition[] = [];
  const keep = <T extends THREE.BufferGeometry>(geometry: T): T => { geometries.push(geometry); return geometry; };
  // `mat` hands back the SHARED instance untouched: kept as a seam so every call site below reads the
  // same as before the material cache landed. Nothing per-floor is ever disposed through it.
  const mat = <T extends THREE.Material>(material: T): T => material;
  const solid = (color: number, roughness = 0.82): THREE.MeshStandardMaterial => shared(color, roughness);
  const sheltered = (color: number, strength: number): number =>
    new THREE.Color(color).multiplyScalar(strength).getHex();
  const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(UNIT_BOX, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z); group.add(mesh); return mesh;
  };

  const { width, depth, height, palette, core } = plan;

  // ---- the void: everything outside this floor is black, whichever way the boom swings ----------
  const shroudRadius = Math.hypot(width, depth) / 2 + BOOM + 2;
  const shroud = new THREE.Mesh(keep(new THREE.CylinderGeometry(shroudRadius, shroudRadius, height + 34, 24, 1, false)), VOID_MATERIAL);
  shroud.position.y = (height + 34) / 2 - 17;
  group.add(shroud);

  // ---- the shell: one inside-out box, six faces, three colours ---------------------------------
  // There is no physical roof in the buried room for the city's directional/hemisphere lights to
  // hit. Darker albedo compensates only on the structural surfaces; colourful furniture keeps its
  // authored palette and therefore still gives each room identity.
  const wall = shared(sheltered(palette.wall, 0.33), 0.92, THREE.BackSide);
  const floorMaterial = shared(sheltered(palette.floor, 0.46), 0.95, THREE.BackSide);
  const ceilingMaterial = shared(sheltered(palette.ceiling, 0.31), 0.95, THREE.BackSide);
  const shell = new THREE.Mesh(keep(new THREE.BoxGeometry(width, height, depth)), [wall, wall, ceilingMaterial, floorMaterial, wall, wall]);
  shell.position.y = height / 2;
  group.add(shell);

  const trim = solid(palette.trim, 0.7);
  box(width, 0.14, WALL_T, trim, 0, 0.07, depth / 2 - WALL_T / 2);
  box(width, 0.14, WALL_T, trim, 0, 0.07, -depth / 2 + WALL_T / 2);
  box(WALL_T, 0.14, depth, trim, width / 2 - WALL_T / 2, 0.07, 0);
  box(WALL_T, 0.14, depth, trim, -width / 2 + WALL_T / 2, 0.07, 0);

  // ---- ornamentation, per building (see decorFor): a dado band at hip height, a picture rail, a
  // cornice under the ceiling. Three walls only — the FRONT wall carries the exit doorway on the
  // ground floor and a bar across its mouth read as a barricade. Ten boxes at most, all from the
  // shared material cache, so the whole feature costs nothing the skirting did not already cost.
  const strip = (y: number, thickness: number, material: THREE.Material): void => {
    box(width, thickness, WALL_T + 0.04, material, 0, y, depth / 2 - WALL_T / 2 - 0.02);
    box(WALL_T + 0.04, thickness, depth, material, width / 2 - WALL_T / 2 - 0.02, y, 0);
    box(WALL_T + 0.04, thickness, depth, material, -width / 2 + WALL_T / 2 + 0.02, y, 0);
  };
  if (plan.decor.dado) strip(1.05, 0.1, trim);
  if (plan.decor.rail) strip(2.42, 0.07, trim);
  if (plan.decor.cornice) strip(height - 0.11, 0.18, solid(0xe9e4d8, 0.85));

  // ---- partitions -------------------------------------------------------------------------------
  const partitionMaterial = shared(sheltered(palette.wall, 0.33), 0.9);
  const jamb = solid(palette.trim, 0.6);
  for (const run of plan.walls) buildWall(run, height, { box, partitionMaterial, jamb, partitions });

  // ---- the core: the same shaft on every storey, which is why they line up ----------------------
  // The stair goes in its own group so the occlusion cull can take the whole flight out in one go.
  // A single-storey building has no shaft at all — the rooms took the whole plate.
  if (core.stair) {
    const shaft = new THREE.Group(); shaft.name = 'Stair'; group.add(shaft);
    const shaftBox = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), material);
      mesh.position.set(x, y, z); shaft.add(mesh); return mesh;
    };
    const shaftKit = { box: shaftBox, solid, keep, group: shaft, mat };
    // An ISLAND shaft — any stair the position class stood clear of the back wall — shows its rear
    // to walkable floor, so the rear is sealed: solid up to the mid landing, a balustrade above.
    // The clamp refuses the crossing either way (see obstacles() in interiors.ts); this draws the
    // refusal so it reads as a stairwell's back, not an invisible wall.
    const island = rectMaxZ(core.stair) < plan.depth / 2 - 0.9;
    if (ends.top) {
      // THE TOP OF THE STAIRWELL. The old code drew a full switchback rising into the ceiling with a
      // grey shutter across it — the "blocked off stairs" the owner reported on every top floor.
      // Nobody can ever walk that flight (there is no storey above), so it is not drawn at all: the
      // top floor gets a stair HEAD — the well the flight from below arrives in, railed off where
      // the containment clamp refuses to let you walk, open at the mouth you step out of. On a
      // commercial or industrial building tall enough to qualify, the up side carries a steel
      // ladder to a roof hatch instead of a rail, and E under it takes you out onto the real roof.
      buildStairHead(core.stair, core.stairDir, height, ends.hatch, shaftKit);
    } else {
      // Which side edges are OPEN floor (rail wanted) rather than plate wall or lift shaft.
      const liftOnLow = core.lift !== undefined && Math.abs(rectMaxX(core.lift) - rectMinX(core.stair)) < 0.5;
      const liftOnHigh = core.lift !== undefined && Math.abs(rectMinX(core.lift) - rectMaxX(core.stair)) < 0.5;
      buildStair(core.stair, core.stairDir, height, island, {
        low: rectMinX(core.stair) + plan.width / 2 > 0.35 && !liftOnLow,
        high: plan.width / 2 - rectMaxX(core.stair) > 0.35 && !liftOnHigh,
      }, shaftKit);
    }
    if (ends.ground) {
      // THE FOOT OF THE STAIRWELL. Downstairs from the ground floor there is nothing, and the old
      // grey shutter said so with a wall. The clamp still refuses the step (see interiors.ts), but
      // what you SEE is what a real ground floor does with that dead quarter: under-stair storage.
      buildUnderStair(core.stair, core.stairDir, shaftKit);
    }
    partitions.push({
      mesh: shaft, core: true,
      minX: rectMinX(core.stair), maxX: rectMaxX(core.stair),
      minZ: rectMinZ(core.stair), maxZ: rectMaxZ(core.stair),
    });
  }
  if (core.lift) buildLift(core.lift, height, { box, solid, keep, group, mat, powered });

  // ---- the way out, on the ground floor only ----------------------------------------------------
  if (ends.ground) buildExit(core.entryX, depth, { box, solid, keep, group, mat });

  // ---- props ------------------------------------------------------------------------------------
  for (const prop of plan.props) buildProp(prop, { box, solid, mat, keep, group, powered });

  // ---- light --------------------------------------------------------------------------------------
  // ONLY THE BULBS ARE DRAWN HERE. The real PointLights live in the feature's constant-size pool
  // (interiors.ts) and are repositioned onto plan.lamps — see the header of this file for why a floor
  // must never add or remove a light. The pool also carries the visit-wide ambient and the dim fill
  // that keeps the way out findable with the grid down.
  const shade = sharedGlow(0xfff0cf, 0xfff0cf, 1.1, 0.6);
  powered.push({ material: shade, base: 1.1 });
  for (const spot of plan.lamps) {
    const bulb = new THREE.Mesh(BULB_GEOMETRY, shade);
    bulb.position.set(spot.x, spot.y - 0.06, spot.z); group.add(bulb);
  }

  group.traverse((object) => { object.castShadow = false; object.receiveShadow = false; });

  return {
    group, powered, partitions,
    dispose: () => {
      group.removeFromParent();
      // Geometries are per-floor (the few that are not the shared unit box); materials are the
      // module cache's and are deliberately NOT disposed — see the header.
      for (const geometry of geometries) geometry.dispose();
      group.clear();
    },
  };
}

interface WallKit {
  box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh;
  partitionMaterial: THREE.Material;
  jamb: THREE.Material;
  partitions: Partition[];
}

/** One partition run: the solid stretches either side of its doorway, plus a lintel over it. */
function buildWall(run: Wall, height: number, kit: WallKit): void {
  const { box, partitionMaterial, jamb, partitions } = kit;
  const span = (from: number, to: number, h: number, y: number): void => {
    const length = to - from;
    if (length < 0.02) return;
    const mid = (from + to) / 2;
    const mesh = run.axis === 'x'
      ? box(WALL_T, h, length, partitionMaterial, run.at, y + h / 2, mid)
      : box(length, h, WALL_T, partitionMaterial, mid, y + h / 2, run.at);
    // Only full-height stretches occlude; a lintel over a doorway is above the sightline anyway.
    if (y > 0.01) return;
    partitions.push(run.axis === 'x'
      ? { mesh, minX: run.at - WALL_T, maxX: run.at + WALL_T, minZ: from, maxZ: to }
      : { mesh, minX: from, maxX: to, minZ: run.at - WALL_T, maxZ: run.at + WALL_T });
  };
  if (run.gapWidth === undefined) { span(run.from, run.to, height, 0); return; }
  const gapMin = run.gapCentre! - run.gapWidth / 2;
  const gapMax = run.gapCentre! + run.gapWidth / 2;
  span(run.from, gapMin, height, 0);
  span(gapMax, run.to, height, 0);
  span(gapMin, gapMax, height - DOOR_H, DOOR_H);
  // A dark frame around the opening, so a doorway reads as one from across the room. The posts are
  // occluders too: hiding the plaster span but leaving a dark jamb directly in front of the lens
  // produced a lonely floor-to-ceiling bar across the player in third person.
  const post = (along: number): void => {
    const mesh = run.axis === 'x'
      ? box(WALL_T + 0.06, DOOR_H, 0.12, jamb, run.at, DOOR_H / 2, along)
      : box(0.12, DOOR_H, WALL_T + 0.06, jamb, along, DOOR_H / 2, run.at);
    partitions.push(run.axis === 'x'
      ? { mesh, minX: run.at - WALL_T, maxX: run.at + WALL_T, minZ: along - 0.08, maxZ: along + 0.08 }
      : { mesh, minX: along - 0.08, maxX: along + 0.08, minZ: run.at - WALL_T, maxZ: run.at + WALL_T });
  };
  post(gapMin); post(gapMax);
}

interface Kit {
  box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh;
  solid(color: number, roughness?: number): THREE.MeshStandardMaterial;
  mat<T extends THREE.Material>(material: T): T;
  keep<T extends THREE.BufferGeometry>(geometry: T): T;
  group: THREE.Group;
  powered?: { material: THREE.MeshStandardMaterial; base: number }[];
}

/**
 * THE SWITCHBACK. Two half flights side by side: up the `dir` half from the front to the mid landing
 * at the back, then up the other half from the back to the front again, arriving one storey higher
 * at the spot you set off from. That shape is why the stair works on every storey with no special
 * case at either end — the top of one flight IS the bottom of the next, in the same shaft, at the
 * same x. Which side goes up first is the building's own seeded choice (core.stairDir), so two
 * stairwells on one street no longer all turn the same way.
 *
 * See interiors.ts stairProgress() for the matching altitude function: this draws it, that walks it.
 */
function buildStair(
  shaft: Rect, dir: 1 | -1, height: number, sealedRear: boolean,
  openSides: { low: boolean; high: boolean }, kit: Kit,
): void {
  const { box, solid } = kit;
  const tread = solid(0x77726a, 0.9);
  const nose = solid(0x3b4143, 0.7);
  if (sealedRear) {
    // The back of an island stairwell: panelled to the mid landing, railed above it — what the
    // back of a free-standing switchback actually looks like from the room behind it.
    const landingY = STOREY_HEIGHT * 0.5;
    box(shaft.w, landingY + 0.06, 0.14, solid(0x8d877c, 0.9), shaft.x, (landingY + 0.06) / 2, rectMaxZ(shaft) - 0.07);
    box(shaft.w, 0.07, 0.08, solid(0x4a5254, 0.5), shaft.x, landingY + 1.02, rectMaxZ(shaft) - 0.07);
    for (const t of [-0.33, 0, 0.33]) {
      box(0.07, 1.0, 0.07, solid(0x4a5254, 0.5), shaft.x + t * shaft.w, landingY + 0.5, rectMaxZ(shaft) - 0.07);
    }
  }
  const steps = 9;
  const halfW = shaft.w / 2;
  for (let half = 0; half < 2; half++) {
    const sign = half === 0 ? dir : -dir;       // the `dir` half rises front→back, the other back→front
    const x = shaft.x + sign * halfW / 2;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const along = half === 0 ? -shaft.d / 2 + t * shaft.d : shaft.d / 2 - t * shaft.d;
      const y = (half * 0.5 + t * 0.5) * STOREY_HEIGHT;
      box(halfW - 0.1, 0.14, shaft.d / steps, tread, x, y, shaft.z + along);
      box(halfW - 0.1, 0.06, 0.06, nose, x, y + 0.1, shaft.z + along + (half === 0 ? shaft.d / steps / 2 : -shaft.d / steps / 2));
    }
  }
  // The spine wall between the two flights: it is what stops you stepping sideways off a half
  // landing, and it is the thing that makes the shaft read as a stairwell rather than a ramp.
  box(0.12, height, shaft.d * 0.62, solid(0x8d877c, 0.9), shaft.x, height / 2, shaft.z - shaft.d * 0.19);
  // RAILS DOWN THE OPEN SIDES — sloped with their own flight, posted, and REAL: the clamp carries a
  // matching collider along both side edges (see obstacles() in interiors.ts), because the owner's
  // report was walking up a switchback and drifting off the side of it. The old version drew one
  // floating horizontal rail per side and enforced nothing. A side standing against the plate wall
  // or the lift shaft draws no rail (there is a wall there); the collider holds regardless.
  const steel = solid(0x4a5254, 0.5);
  const rise = STOREY_HEIGHT / 2;
  const slope = Math.atan2(rise, shaft.d);
  for (const side of [-1, 1] as const) {
    if (!(side === -1 ? openSides.low : openSides.high)) continue;
    const railX = shaft.x + side * (halfW - 0.06);
    // This side's flight: the `dir` half rises front→back, the other arrives from above.
    const upThisSide = side === dir;
    const flightY = (z: number): number => {
      const t = (z - (shaft.z - shaft.d / 2)) / shaft.d;
      return upThisSide ? t * rise : STOREY_HEIGHT - t * rise;
    };
    const rail = box(0.07, 0.07, Math.hypot(shaft.d, rise), steel,
      railX, (upThisSide ? rise * 0.5 : STOREY_HEIGHT - rise * 0.5) + 1.0, shaft.z);
    rail.rotation.x = upThisSide ? -slope : slope;
    for (const z of [shaft.z - shaft.d / 2 + 0.4, shaft.z, shaft.z + shaft.d / 2 - 0.4]) {
      box(0.07, 1.0, 0.07, steel, railX, flightY(z) + 0.5, z);
    }
  }
}

/**
 * THE STAIR HEAD — what the top storey has instead of a switchback. The flight from the floor below
 * arrives at the front of the shaft on the down side; everything else in the shaft rectangle is the
 * region the containment clamp refuses (there is nothing above to climb to), so it is railed off
 * like the top landing of any real stairwell rather than shuttered like a crime scene. The rails are
 * drawn where the clamp already refuses — they mark the rule, they do not implement it.
 */
function buildStairHead(shaft: Rect, dir: 1 | -1, height: number, hatch: boolean, kit: Kit): void {
  const { box, solid, keep, group } = kit;
  const steel = solid(0x4a5254, 0.55);
  const post = (x: number, z: number): void => { box(0.07, 1.02, 0.07, steel, x, 0.51, z); };
  const railRun = (x0: number, z0: number, x1: number, z1: number): void => {
    const along = Math.hypot(x1 - x0, z1 - z0);
    if (along < 0.2) return;
    const posts = Math.max(2, Math.round(along / 1.3));
    for (let i = 0; i < posts; i++) post(x0 + (x1 - x0) * i / (posts - 1), z0 + (z1 - z0) * i / (posts - 1));
    box(Math.abs(x1 - x0) + 0.07, 0.07, Math.abs(z1 - z0) + 0.07, steel, (x0 + x1) / 2, 1.02, (z0 + z1) / 2);
  };
  const minX = rectMinX(shaft); const maxX = rectMaxX(shaft);
  const minZ = rectMinZ(shaft); const maxZ = rectMaxZ(shaft);
  const upFrontX = dir === 1 ? [shaft.x, maxX] as const : [minX, shaft.x] as const;
  // The dark well, so the opening reads as a stairwell going down before you step into it.
  const well = new THREE.Mesh(keep(new THREE.BoxGeometry(shaft.w - 0.1, 0.03, shaft.d - 0.1)), MOUTH_MATERIAL);
  well.position.set(shaft.x, 0.015, shaft.z);
  group.add(well);
  // Rails: both sides, the back, the centre line over the spine wall the clamp still enforces, and
  // the up-side front — with a gap for the ladder when this head opens onto the roof.
  railRun(minX, minZ, minX, maxZ);
  railRun(maxX, minZ, maxX, maxZ);
  railRun(minX, maxZ, maxX, maxZ);
  railRun(shaft.x, minZ, shaft.x, maxZ - shaft.d * 0.38);
  if (!hatch) railRun(upFrontX[0], minZ, upFrontX[1], minZ);
  if (hatch) {
    // The way onto the roof: a steel ladder where the up-flight would have started, and a hatch in
    // the ceiling over it. E at the foot of the ladder does the climb (see interiors:roofhatch).
    const foot = hatchFoot(shaft, dir);
    const ladderZ = minZ + 0.35;
    for (const sx of [-0.3, 0.3]) box(0.07, height, 0.07, steel, foot.x + sx, height / 2, ladderZ);
    const rungs = Math.floor(height / 0.38);
    for (let i = 1; i <= rungs; i++) box(0.66, 0.05, 0.05, steel, foot.x, i * height / (rungs + 1), ladderZ);
    const frame = solid(0x37403f, 0.6);
    box(1.5, 0.1, 1.5, frame, foot.x, height - 0.05, foot.z);
    box(1.2, 0.08, 1.2, solid(0x9aa2a4, 0.4), foot.x, height - 0.11, foot.z);
  }
}

/** What the dead quarter at the foot of the stairwell really is: the cupboard under the stairs.
 *  Replaces the grey shutter the owner called out; the clamp still refuses the step (there is no
 *  basement), and now the reason reads as furniture instead of a barricade. */
function buildUnderStair(shaft: Rect, dir: 1 | -1, kit: Kit): void {
  const { box, solid } = kit;
  const lane = shaft.w / 4;
  const x = shaft.x - dir * lane;           // the down side's front quarter — the flight to nowhere
  const z = rectMinZ(shaft) + 0.75;
  box(0.9, 0.62, 0.9, solid(0xa07a4c, 0.85), x - 0.35, 0.31, z);
  box(0.8, 0.5, 0.8, solid(0x8a6a3f, 0.85), x - 0.3, 0.87, z + 0.05);
  box(0.7, 0.9, 0.55, solid(0x5f6a6c, 0.8), x + 0.55, 0.45, z + 0.15);
  box(0.09, 1.35, 0.09, solid(0x8b5a3c, 0.9), x + 0.85, 0.68, z - 0.3);
}

function buildLift(shaft: Rect, height: number, kit: Kit): void {
  const { box, solid, powered } = kit;
  const car = solid(0x4d5457, 0.55);
  box(shaft.w + 0.2, height, 0.14, car, shaft.x, height / 2, rectMaxZ(shaft) + 0.07);
  box(0.14, height, shaft.d, car, rectMinX(shaft) - 0.07, height / 2, shaft.z);
  box(0.14, height, shaft.d, car, rectMaxX(shaft) + 0.07, height / 2, shaft.z);
  // The doors, closed, on the corridor side, with the call panel lit beside them.
  const doors = solid(0x9aa2a4, 0.4);
  for (const sign of [-1, 1]) box(shaft.w / 2 - 0.04, 2.4, 0.1, doors, shaft.x + sign * shaft.w / 4, 1.2, rectMinZ(shaft) - 0.05);
  const panel = sharedGlow(0xf0c657, 0xf0c657, 1.4, 0.4);
  powered?.push({ material: panel, base: panel.emissiveIntensity });
  box(0.18, 0.3, 0.06, panel, rectMinX(shaft) - 0.28, 1.3, rectMinZ(shaft) - 0.05);
}

/** The way back to the street: a recessed dark opening in the front wall, lit, labelled, with a mat
 *  under it you cannot miss walking back down the spine. */
function buildExit(entryX: number, depth: number, kit: Kit): void {
  const { box, solid, keep, group } = kit;
  const doorW = 2.2; const doorH = 3.0;
  box(doorW, doorH, 0.06, MOUTH_MATERIAL, entryX, doorH / 2, -depth / 2 + 0.04);
  const frame = solid(0x37403f, 0.6);
  box(0.22, doorH + 0.22, 0.24, frame, entryX - doorW / 2 - 0.11, (doorH + 0.22) / 2, -depth / 2 + 0.13);
  box(0.22, doorH + 0.22, 0.24, frame, entryX + doorW / 2 + 0.11, (doorH + 0.22) / 2, -depth / 2 + 0.13);
  box(doorW + 0.44, 0.22, 0.24, frame, entryX, doorH + 0.11, -depth / 2 + 0.13);
  const bar = solid(0x6d7679, 0.5);
  for (let i = 0; i < 6; i++) box(0.06, doorH, 0.06, bar, entryX - doorW / 2 + 0.2 + i * (doorW - 0.4) / 5, doorH / 2, -depth / 2 + 0.18);
  const exitSign = createSignMesh(keep(new THREE.PlaneGeometry(1.9, 0.5)), 'EXIT', '#ffe08a', { background: '#16211d' });
  exitSign.position.set(entryX, doorH + 0.58, -depth / 2 + 0.1);
  group.add(exitSign);
  const matDisc = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.5, 1.5, 0.05, 20)), MAT_GLOW_MATERIAL);
  matDisc.position.set(entryX, 0.03, -depth / 2 + EXIT_MAT_IN);
  group.add(matDisc);
  box(2.2, 0.04, 1.4, solid(0x3b3530, 0.98), entryX, 0.02, -depth / 2 + EXIT_MAT_IN);
}

/** How far in from the front wall the exit mat sits. */
export const EXIT_MAT_IN = 1.7;

// ---- the street side -------------------------------------------------------------------------

/** One door's street furniture, kept together so the feature can fade it by distance each frame. */
export interface DoorMarker {
  /** The doorstep, for the distance test. */
  readonly x: number; readonly z: number;
  readonly disc: THREE.Mesh;
  readonly ring: THREE.Mesh;
  /** Frame, sign and glow — everything mounted on the wall itself. */
  readonly bay: THREE.Group;
  readonly discMaterial: THREE.MeshBasicMaterial;
  readonly ringMaterial: THREE.MeshBasicMaterial;
}

export interface BuiltDoorways {
  readonly group: THREE.Group;
  readonly markers: readonly DoorMarker[];
  readonly ids: readonly string[];
  dispose(): void;
}

/**
 * HOW LOUD A DOOR IS ALLOWED TO BE, and this is the second thing the owner sent back.
 *
 * The first version borrowed ShopSystem's entry pad wholesale — a big gold disc, a ring, and a nine
 * metre column of light standing on it. That is exactly right for the six crafted shops in this city
 * and exactly wrong for its four thousand front doors: a street of houses became a field of glowing
 * rings with beams over it, and a signal every building carries is not a signal. His words: "the
 * entrance visuals are a bit strong given it should be for most buildings. Perhaps just a circle on
 * the ground, no column of light."
 *
 * So: the beam is gone outright, the disc is half the radius and a third of the opacity, and BOTH
 * the ring and the frame on the wall FADE IN as you approach — invisible past FADE_FAR, full at
 * FADE_NEAR, which is about a car's length outside the prompt ring. Walk down a street of houses and
 * you see houses; walk up to one and its door lights up. The gold pillar stays where it belongs, on
 * the street economy's genuine objectives.
 */
const FADE_FAR = 26;
const FADE_NEAR = 11;

/** The disc's own opacity at full strength — ShopSystem pulses 0.42..0.60; an ordinary front door
 *  sits well under that, because there are three thousand of them and six of those. */
const DISC_OPACITY = 0.3;

/** Distance falloff for a door marker: 1 on the step, 0 well down the street. */
export function markerFade(distance: number): number {
  if (distance <= FADE_NEAR) return 1;
  if (distance >= FADE_FAR) return 0;
  return (FADE_FAR - distance) / (FADE_FAR - FADE_NEAR);
}

/**
 * A doorway on the FRONT WALL of a real building, plus the pad you stand on. The frame is mounted on
 * the plane the model tagged and scaled to the opening it tagged — BuildingArchitecture's tag on a
 * parcel, the builder's own Kit.door tag on a scattered catalog model — so it lands on the
 * building's own leaf rather than somewhere near it. Nothing is drawn behind the wall plane: if a
 * building were ever missing you would see a frame on nothing, never a facade in a field.
 */
export function buildDoorways(
  doors: readonly InteriorDoor[],
  surfaceHeightAt: (x: number, z: number) => number,
): BuiltDoorways {
  const group = new THREE.Group();
  group.name = 'InteriorDoors';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const markers: DoorMarker[] = [];
  const keep = <T extends THREE.BufferGeometry>(geometry: T): T => { geometries.push(geometry); return geometry; };
  const mat = <T extends THREE.Material>(material: T): T => { materials.push(material); return material; };

  const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
  // A modest circle on the step. Half the radius of a shop pad, and it does not stand up off it.
  const discGeometry = keep(new THREE.CylinderGeometry(0.85, 0.85, 0.05, 18));
  const ringGeometry = keep(new THREE.TorusGeometry(1, 0.045, 6, 20));

  const steel = mat(new THREE.MeshStandardMaterial({ color: 0x2f3735, roughness: 0.6, metalness: 0.35 }));
  const mouth = mat(new THREE.MeshBasicMaterial({ color: 0x090c0f }));

  for (const door of doors) {
    const bay = new THREE.Group();
    // The frame stands at the DOORSTEP's standing height, not the terrain under the wall plane:
    // on a foundation-levelled site the model's leaf sits on the plinth, and probing height AT the
    // face would find the building's own roof. The step is where the player stands to use the
    // door, so its surface is the honest base for the joinery too.
    bay.position.set(door.faceX, surfaceHeightAt(door.x, door.z), door.faceZ);
    bay.rotation.y = door.heading; // local +z faces the street
    const add = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): void => {
      const mesh = new THREE.Mesh(unitBox, material);
      mesh.scale.set(w, h, d); mesh.position.set(x, y, z); bay.add(mesh);
    };
    // THE OPENING THE MODEL DREW, not one we invented — both ways round. A narrow cottage keeps its
    // narrow door, and a 2.5 m cottage wall keeps a 2 m head: the fixed 3.4 m reveal the first
    // version drew reached the eaves on every small house in the city and read as a hole, not a door.
    const openW = Math.max(1.2, Math.min(4.2, door.openWidth));
    const openH = Math.max(2, Math.min(3.6, door.openHeight));
    // Everything sits PROUD of the tagged plane (+z), never inside it — the wall is the city's.
    // A dark reveal and two slim jambs, and that is the lot: the canopy, the fanlight and the folded
    // security gate the first version bolted on turned every cottage on the plot into a shopfront.
    add(openW, openH, 0.08, mouth, 0, openH / 2, 0.05);
    add(0.14, openH + 0.16, 0.16, steel, -openW / 2 - 0.07, (openH + 0.16) / 2, 0.08);
    add(0.14, openH + 0.16, 0.16, steel, openW / 2 + 0.07, (openH + 0.16) / 2, 0.08);
    add(openW + 0.28, 0.14, 0.16, steel, 0, openH + 0.08, 0.08);
    // AND NO NAME BOARD. It was the loudest thing on the wall — a lit sign over every front door in
    // a suburb. (It was also, historically, the thing that overflowed the sign atlas; capacity is
    // 1024 now and buildingIdentity.ts letters the buildings that genuinely carry boards, so the
    // budget is tested rather than hoped about — see ProceduralMaterials.) The name is on the prompt
    // you are standing in to read it. A house does not have a signboard.
    // The circle on the ground, and nothing standing on it. Its own material per door so the fade is
    // per door and not per street — twenty-two MeshBasic materials is nothing next to one beam.
    const stepY = surfaceHeightAt(door.x, door.z);
    const discMaterial = mat(new THREE.MeshBasicMaterial({ color: 0xe8b64c, transparent: true, opacity: DISC_OPACITY, depthWrite: false }));
    const ringMaterial = mat(new THREE.MeshBasicMaterial({ color: 0xf5c451, transparent: true, opacity: 0.75, depthWrite: false }));
    const disc = new THREE.Mesh(discGeometry, discMaterial);
    disc.position.set(door.x, stepY + 0.06, door.z);
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2; ring.position.copy(disc.position); ring.position.y += 0.015;
    markers.push({ x: door.x, z: door.z, disc, ring, bay, discMaterial, ringMaterial });
    group.add(bay, disc, ring);
  }

  return {
    group, markers, ids: doors.map((door) => door.id),
    dispose: () => {
      group.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
}

// ---- furniture ---------------------------------------------------------------------------------

function buildProp(prop: Prop, kit: Kit): void {
  const { box, solid, keep, group, powered } = kit;
  const body = solid(prop.color, 0.8);
  const base = prop.y;
  switch (prop.shape) {
    case 'counter': {
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
      box(prop.w + 0.14, 0.08, prop.d + 0.16, solid(0xd8cdb6, 0.55), prop.x, base + prop.h + 0.04, prop.z);
      break;
    }
    case 'shelf': {
      const alongZ = prop.d > prop.w;
      box(prop.w, prop.h, prop.d, solid(0x6f6a5e, 0.9), prop.x, base + prop.h / 2, prop.z);
      const tins = solid(prop.color, 0.55);
      const span = alongZ ? prop.d : prop.w;
      const count = Math.max(3, Math.round(span / 0.42));
      for (let shelf = 0; shelf < 4; shelf++) {
        const y = base + 0.4 + shelf * (prop.h - 0.5) / 4;
        for (let i = 0; i < count; i++) {
          const t = -span / 2 + 0.22 + i * (span - 0.44) / Math.max(1, count - 1);
          if (alongZ) box(0.2, 0.24, 0.2, tins, prop.x + (prop.x > 0 ? -0.18 : 0.18), y + 0.12, prop.z + t);
          else box(0.2, 0.24, 0.2, tins, prop.x + t, y + 0.12, prop.z - 0.18);
        }
      }
      break;
    }
    case 'bed': {
      box(prop.w, prop.h, prop.d, solid(0x5a4a3c, 0.9), prop.x, base + prop.h / 2, prop.z);
      box(prop.w - 0.12, 0.2, prop.d - 0.12, body, prop.x, base + prop.h + 0.1, prop.z);
      box(0.55, 0.14, prop.d - 0.5, solid(0xe6ded0, 0.9), prop.x - prop.w / 2 + 0.34, base + prop.h + 0.26, prop.z);
      break;
    }
    case 'sofa': {
      box(prop.w, prop.h * 0.55, prop.d, body, prop.x, base + prop.h * 0.28, prop.z);
      box(prop.w * 0.4, prop.h, prop.d, body, prop.x + (prop.x > 0 ? prop.w * 0.3 : -prop.w * 0.3), base + prop.h / 2, prop.z);
      break;
    }
    case 'wardrobe': case 'cabinet': case 'fridge': {
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
      box(0.08, 0.3, 0.06, solid(0xb8b0a0, 0.4), prop.x + (prop.x > 0 ? -prop.w * 0.55 : prop.w * 0.55), base + prop.h * 0.55, prop.z);
      break;
    }
    case 'sack': {
      const mesh = new THREE.Mesh(keep(new THREE.SphereGeometry(0.5, 10, 8)), body);
      mesh.scale.set(prop.w, prop.h * 1.6, prop.d);
      mesh.position.set(prop.x, base + prop.h / 2, prop.z); group.add(mesh);
      break;
    }
    case 'stove': {
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
      const plate = sharedGlow(0x6a2a22, 0x8a2010, 0.7, 0.5);
      powered?.push({ material: plate, base: plate.emissiveIntensity });
      for (let i = 0; i < 2; i++) {
        const ring = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 12)), plate);
        ring.position.set(prop.x - 0.2 + i * 0.4, base + prop.h + 0.02, prop.z); group.add(ring);
      }
      break;
    }
    case 'tv': {
      box(prop.w, prop.h, prop.d, solid(0x1b1f22, 0.6), prop.x, base + prop.h / 2, prop.z);
      const screen = sharedGlow(0x9fc4d8, 0x6f9fc4, 0.9, 0.4);
      powered?.push({ material: screen, base: screen.emissiveIntensity });
      box(prop.w * 0.4, prop.h - 0.12, prop.d - 0.12, screen, prop.x, base + prop.h / 2, prop.z);
      break;
    }
    case 'desk': {
      box(prop.w, 0.08, prop.d, body, prop.x, base + prop.h, prop.z);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        box(0.07, prop.h, 0.07, solid(0x4a4640, 0.7), prop.x + sx * (prop.w / 2 - 0.1), base + prop.h / 2, prop.z + sz * (prop.d / 2 - 0.1));
      }
      const screen = sharedGlow(0x8fb8cc, 0x5f8fb4, 0.8, 0.4);
      powered?.push({ material: screen, base: screen.emissiveIntensity });
      box(0.5, 0.36, 0.05, screen, prop.x, base + prop.h + 0.28, prop.z);
      break;
    }
    case 'plant': {
      const pot = new THREE.Mesh(keep(new THREE.CylinderGeometry(prop.w * 0.32, prop.w * 0.26, prop.h * 0.3, 10)), solid(0x8a5a3c, 0.9));
      pot.position.set(prop.x, base + prop.h * 0.15, prop.z); group.add(pot);
      const leaves = new THREE.Mesh(keep(new THREE.SphereGeometry(prop.w * 0.42, 9, 7)), body);
      leaves.position.set(prop.x, base + prop.h * 0.68, prop.z); group.add(leaves);
      break;
    }
    case 'bucket': case 'stool': case 'drum': {
      const radius = prop.w / 2;
      const mesh = new THREE.Mesh(keep(new THREE.CylinderGeometry(radius, radius * (prop.shape === 'drum' ? 1 : 0.86), prop.h, prop.shape === 'drum' ? 14 : 12)), body);
      mesh.position.set(prop.x, base + prop.h / 2, prop.z); group.add(mesh);
      if (prop.shape === 'drum') {
        for (const t of [0.34, 0.66]) {
          const band = new THREE.Mesh(keep(new THREE.CylinderGeometry(radius * 1.06, radius * 1.06, 0.06, 14)), solid(0x6a6f70, 0.6));
          band.position.set(prop.x, base + prop.h * t, prop.z); group.add(band);
        }
      }
      break;
    }
    case 'rack': {
      // Pallet racking: uprights, a deck per level and a stacked load on it — the thing that makes a
      // shed read as a warehouse rather than a big empty room. Deliberately few meshes per unit:
      // there are up to sixteen of these on a works floor and every one of them is drawn at once.
      const upright = solid(0x4a5254, 0.6);
      for (const sz of [-1, 1]) {
        box(0.11, prop.h, 0.11, upright, prop.x - prop.w / 2 + 0.07, base + prop.h / 2, prop.z + sz * (prop.d / 2 - 0.07));
        box(0.11, prop.h, 0.11, upright, prop.x + prop.w / 2 - 0.07, base + prop.h / 2, prop.z + sz * (prop.d / 2 - 0.07));
      }
      const levels = Math.max(2, Math.round(prop.h / 1.2));
      const deck = solid(0x8a7350, 0.9);
      for (let level = 1; level <= levels; level++) {
        const y = base + level * prop.h / (levels + 0.4);
        box(prop.w, 0.09, prop.d, deck, prop.x, y, prop.z);
        if (level < levels) box(prop.w - 0.34, 0.66, prop.d - 0.5, body, prop.x, y + 0.4, prop.z);
      }
      break;
    }
    case 'pallet': {
      box(prop.w, 0.09, prop.d, body, prop.x, base + 0.05, prop.z);
      for (const t of [-0.35, 0, 0.35]) box(prop.w, 0.07, 0.12, solid(0x7a5f3c, 0.95), prop.x, base + 0.13, prop.z + t * prop.d);
      break;
    }
    case 'bench': {
      box(prop.w, 0.1, prop.d, body, prop.x, base + prop.h, prop.z);
      for (const sz of [-1, 1]) box(prop.w - 0.1, prop.h, 0.1, solid(0x454c4e, 0.7), prop.x, base + prop.h / 2, prop.z + sz * (prop.d / 2 - 0.1));
      box(prop.w * 0.5, 0.42, prop.d * 0.35, solid(0x6a5a3c, 0.85), prop.x, base + prop.h + 0.26, prop.z + prop.d * 0.2);
      break;
    }
    case 'rug': {
      const rug = box(prop.w, 0.03, prop.d, body, prop.x, base + 0.015, prop.z);
      rug.renderOrder = 1;
      break;
    }
    case 'toilet': {
      // Pan, seat, cistern against the wall. The one fixture every bathroom actually has.
      box(prop.w * 0.8, prop.h * 0.5, prop.d * 0.6, body, prop.x, base + prop.h * 0.25, prop.z);
      box(prop.w, prop.h * 0.1, prop.d * 0.75, solid(0xf0f2f0, 0.5), prop.x, base + prop.h * 0.55, prop.z);
      // Cistern against whichever outer wall the pan was set against (furnish puts it at wallX).
      box(0.24, prop.h * 0.55, prop.d * 0.85, body, prop.x + (prop.x > 0 ? 1 : -1) * prop.w * 0.3, base + prop.h * 0.72, prop.z);
      break;
    }
    case 'chair': {
      // A proper chair, back and all — the stool's grown-up sibling for desks and kitchen tables.
      box(prop.w, 0.06, prop.d, body, prop.x, base + prop.h * 0.5, prop.z);
      box(prop.w * 0.85, prop.h * 0.48, 0.06, body, prop.x, base + prop.h * 0.76, prop.z + prop.d * 0.42);
      for (const sx of [-1, 1]) box(0.05, prop.h * 0.5, 0.05, solid(0x3a342e, 0.7), prop.x + sx * (prop.w / 2 - 0.05), base + prop.h * 0.25, prop.z);
      break;
    }
    case 'picture': {
      // A framed print. The thin axis faces the room; the canvas sits proud of the frame a touch so
      // it reads as a picture, not a plaque, from either side.
      const thinX = prop.w < prop.d;
      const frame = solid(0x2e2a24, 0.6);
      box(prop.w, prop.h, prop.d, frame, prop.x, base + prop.h / 2, prop.z);
      if (thinX) box(prop.w + 0.03, prop.h - 0.14, prop.d - 0.14, body, prop.x, base + prop.h / 2, prop.z);
      else box(prop.w - 0.14, prop.h - 0.14, prop.d + 0.03, body, prop.x, base + prop.h / 2, prop.z);
      break;
    }
    case 'lamp': {
      // Standing lamp: base, pole, warm shade. The shade glows on the same powered ramp as the
      // bulbs, so load shedding takes it down with the rest of the room.
      const pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.03, 0.03, prop.h * 0.75, 8)), solid(0x4a4238, 0.6));
      pole.position.set(prop.x, base + prop.h * 0.4, prop.z); group.add(pole);
      box(prop.w * 0.7, 0.05, prop.w * 0.7, body, prop.x, base + 0.03, prop.z);
      const glow = sharedGlow(0xffe6b8, 0xffd489, 0.85, 0.6);
      powered?.push({ material: glow, base: 0.85 });
      const shade = new THREE.Mesh(keep(new THREE.CylinderGeometry(prop.w * 0.34, prop.w * 0.46, 0.34, 10, 1, true)), glow);
      shade.position.set(prop.x, base + prop.h * 0.85, prop.z); group.add(shade);
      break;
    }
    case 'bath': {
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
      box(prop.w - 0.24, 0.12, prop.d - 0.24, solid(0x7f8f96, 0.4), prop.x, base + prop.h - 0.05, prop.z);
      box(0.08, 0.34, 0.08, solid(0xb9c0c2, 0.35), prop.x, base + prop.h + 0.17, prop.z - prop.d / 2 + 0.2);
      break;
    }
    case 'trunk': {
      box(prop.w, prop.h * 0.8, prop.d, body, prop.x, base + prop.h * 0.4, prop.z);
      box(prop.w + 0.06, prop.h * 0.2, prop.d + 0.06, solid(0x3f3a33, 0.7), prop.x, base + prop.h * 0.9, prop.z);
      break;
    }
    case 'rail': {
      box(prop.w, 0.07, prop.d, solid(0x39423f, 0.5), prop.x, base + prop.h, prop.z);
      const posts = Math.max(2, Math.round(prop.d / 1.4));
      for (let i = 0; i < posts; i++) {
        box(0.07, prop.h, 0.07, solid(0x39423f, 0.5), prop.x, base + prop.h / 2, prop.z - prop.d / 2 + i * prop.d / Math.max(1, posts - 1));
      }
      break;
    }
    case 'postboxes': {
      // The flats-lobby postbox wall: a backing panel with a grid of pigeonholes, half of them
      // hanging open — the residential answer to the commercial lobby's service counter.
      box(prop.w * 0.5, prop.h, prop.d, body, prop.x, base + prop.h / 2 + 0.5, prop.z);
      const cell = solid(0x6f6a60, 0.6);
      const openLeaf = solid(0x4a463e, 0.6);
      const cols = Math.max(2, Math.floor(prop.d / 0.5));
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < cols; col++) {
          const open = (row * 7 + col * 3) % 5 === 0; // deterministic scatter of sprung-open leaves
          const along = -prop.d / 2 + 0.28 + col * (prop.d - 0.56) / Math.max(1, cols - 1);
          box(0.06, 0.34, 0.4, open ? openLeaf : cell,
            prop.x + (prop.x > 0 ? -1 : 1) * (prop.w * 0.25 + 0.04), base + 0.85 + row * 0.44, prop.z + along);
        }
      }
      break;
    }
    case 'notice': {
      // createSignMesh's material is a globally cached atlas shared with every street sign in the
      // city — the geometry is ours to dispose, the material emphatically is not.
      const sign = createSignMesh(keep(new THREE.PlaneGeometry(prop.w < prop.d ? prop.d : prop.w, prop.h)), prop.text ?? '', '#f0d9a4', { background: '#20262b' });
      sign.position.set(prop.x, base + prop.h / 2, prop.z);
      if (prop.w < prop.d) sign.rotation.y = prop.x > 0 ? -Math.PI / 2 : Math.PI / 2;
      group.add(sign);
      break;
    }
    default:
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
  }
}
