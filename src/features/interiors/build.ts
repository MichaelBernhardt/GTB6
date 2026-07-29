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
import { rectMaxX, rectMaxZ, rectMinX, rectMinZ, STOREY_HEIGHT, type Rect } from './core';
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
  readonly lamps: readonly THREE.PointLight[];
  readonly powered: readonly { material: THREE.MeshStandardMaterial; base: number }[];
  readonly partitions: readonly Partition[];
  dispose(): void;
}

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

export function buildFloor(plan: FloorPlan, ends: { ground: boolean; top: boolean }): BuiltFloor {
  const group = new THREE.Group();
  group.name = `Floor:${plan.core.id}:${plan.index}`;

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const lamps: THREE.PointLight[] = [];
  const powered: { material: THREE.MeshStandardMaterial; base: number }[] = [];
  const partitions: Partition[] = [];
  const keep = <T extends THREE.BufferGeometry>(geometry: T): T => { geometries.push(geometry); return geometry; };
  const mat = <T extends THREE.Material>(material: T): T => { materials.push(material); return material; };
  const solid = (color: number, roughness = 0.82): THREE.MeshStandardMaterial => mat(new THREE.MeshStandardMaterial({ color, roughness }));
  const sheltered = (color: number, strength: number): number =>
    new THREE.Color(color).multiplyScalar(strength).getHex();
  const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), material);
    mesh.position.set(x, y, z); group.add(mesh); return mesh;
  };

  const { width, depth, height, palette, core } = plan;

  // ---- the void: everything outside this floor is black, whichever way the boom swings ----------
  const shroudRadius = Math.hypot(width, depth) / 2 + BOOM + 2;
  const voidMaterial = mat(new THREE.MeshBasicMaterial({ color: 0x05070a, side: THREE.BackSide, fog: false }));
  const shroud = new THREE.Mesh(keep(new THREE.CylinderGeometry(shroudRadius, shroudRadius, height + 34, 24, 1, false)), voidMaterial);
  shroud.position.y = (height + 34) / 2 - 17;
  group.add(shroud);

  // ---- the shell: one inside-out box, six faces, three colours ---------------------------------
  // There is no physical roof in the buried room for the city's directional/hemisphere lights to
  // hit. Darker albedo compensates only on the structural surfaces; colourful furniture keeps its
  // authored palette and therefore still gives each room identity.
  const wall = mat(new THREE.MeshStandardMaterial({ color: sheltered(palette.wall, 0.33), roughness: 0.92, side: THREE.BackSide }));
  const floorMaterial = mat(new THREE.MeshStandardMaterial({ color: sheltered(palette.floor, 0.46), roughness: 0.95, side: THREE.BackSide }));
  const ceilingMaterial = mat(new THREE.MeshStandardMaterial({ color: sheltered(palette.ceiling, 0.31), roughness: 0.95, side: THREE.BackSide }));
  const shell = new THREE.Mesh(keep(new THREE.BoxGeometry(width, height, depth)), [wall, wall, ceilingMaterial, floorMaterial, wall, wall]);
  shell.position.y = height / 2;
  group.add(shell);

  const trim = solid(palette.trim, 0.7);
  box(width, 0.14, WALL_T, trim, 0, 0.07, depth / 2 - WALL_T / 2);
  box(width, 0.14, WALL_T, trim, 0, 0.07, -depth / 2 + WALL_T / 2);
  box(WALL_T, 0.14, depth, trim, width / 2 - WALL_T / 2, 0.07, 0);
  box(WALL_T, 0.14, depth, trim, -width / 2 + WALL_T / 2, 0.07, 0);

  // ---- partitions -------------------------------------------------------------------------------
  const partitionMaterial = mat(new THREE.MeshStandardMaterial({ color: sheltered(palette.wall, 0.33), roughness: 0.9 }));
  const jamb = solid(palette.trim, 0.6);
  for (const run of plan.walls) buildWall(run, height, { box, partitionMaterial, jamb, partitions });

  // ---- the core: the same shaft on every storey, which is why they line up ----------------------
  // The stair goes in its own group so the occlusion cull can take the whole flight out in one go.
  const shaft = new THREE.Group(); shaft.name = 'Stair'; group.add(shaft);
  const shaftBox = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), material);
    mesh.position.set(x, y, z); shaft.add(mesh); return mesh;
  };
  buildStair(core.stair, height, { box: shaftBox, solid, keep, group: shaft, mat });
  partitions.push({
    mesh: shaft, core: true,
    minX: rectMinX(core.stair), maxX: rectMaxX(core.stair),
    minZ: rectMinZ(core.stair), maxZ: rectMaxZ(core.stair),
  });
  // A stair has to stop somewhere: there is no storey over the top one and no basement under the
  // ground, so the half flight that would lead nowhere is shuttered. Drawn here and clamped against
  // in interiors.ts from the SAME rectangle, so a locked stair looks locked and behaves locked.
  const shutter = solid(0x5b625f, 0.7);
  for (const [enabled, direction] of [[ends.top, 1], [ends.ground, -1]] as [boolean, 1 | -1][]) {
    if (!enabled) continue;
    const cap = stairCap(core.stair, direction);
    box(cap.w, 2.1, cap.d, shutter, cap.x, 1.05, cap.z);
  }
  if (core.lift) buildLift(core.lift, height, { box, solid, keep, group, mat, powered });

  // ---- the way out, on the ground floor only ----------------------------------------------------
  if (ends.ground) buildExit(core.entryX, depth, { box, solid, keep, group, mat });

  // ---- props ------------------------------------------------------------------------------------
  for (const prop of plan.props) buildProp(prop, { box, solid, mat, keep, group, powered });

  // ---- light --------------------------------------------------------------------------------------
  // A room you cannot see is the bug this feature shipped with. Belt (an ambient the grid cannot take
  // away entirely), braces (the lamps), and the shroud keeps neither from leaking into the city.
  group.add(new THREE.AmbientLight(0xffe9cc, 0.24));
  const shade = mat(new THREE.MeshStandardMaterial({ color: 0xfff0cf, emissive: 0xfff0cf, emissiveIntensity: 1.1, roughness: 0.6 }));
  powered.push({ material: shade, base: shade.emissiveIntensity });
  for (const spot of plan.lamps) {
    const lamp = new THREE.PointLight(spot.color, INTERIOR_LAMP_INTENSITY, 22, 1.5);
    lamp.position.set(spot.x, spot.y, spot.z);
    group.add(lamp); lamps.push(lamp);
    const bulb = new THREE.Mesh(keep(new THREE.SphereGeometry(0.13, 10, 8)), shade);
    bulb.position.set(spot.x, spot.y - 0.06, spot.z); group.add(bulb);
  }
  // A dim fill so the corners are never pure black even with the grid down — you must always be able
  // to find the way out.
  const fill = new THREE.PointLight(0x9fb0c8, 5, 44, 1.1);
  fill.position.set(0, height * 0.82, -depth * 0.2);
  group.add(fill);

  group.traverse((object) => { object.castShadow = false; object.receiveShadow = false; });

  return {
    group, lamps, powered, partitions,
    dispose: () => {
      group.removeFromParent();
      group.traverse((object) => { if (object instanceof THREE.Light) object.dispose(); });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
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
 * THE SWITCHBACK. Two half flights side by side: up the +x half from the front to the mid landing at
 * the back, then up the −x half from the back to the front again, arriving one storey higher at the
 * spot you set off from. That shape is why the stair works on every storey with no special case at
 * either end — the top of one flight IS the bottom of the next, in the same shaft, at the same x.
 *
 * See interiors.ts stairHeight() for the matching altitude function: this draws it, that walks it.
 */
function buildStair(shaft: Rect, height: number, kit: Kit): void {
  const { box, solid } = kit;
  const tread = solid(0x77726a, 0.9);
  const nose = solid(0x3b4143, 0.7);
  const steps = 9;
  const halfW = shaft.w / 2;
  for (let half = 0; half < 2; half++) {
    const sign = half === 0 ? 1 : -1;           // +x half rises front→back, −x half back→front
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
  // A handrail down the outside of each flight.
  for (const sign of [-1, 1]) {
    box(0.07, 0.07, shaft.d, solid(0x4a5254, 0.5), shaft.x + sign * (halfW - 0.08), STOREY_HEIGHT * (sign > 0 ? 0.25 : 0.75) + 1.0, shaft.z);
  }
}

function buildLift(shaft: Rect, height: number, kit: Kit): void {
  const { box, solid, mat, powered } = kit;
  const car = solid(0x4d5457, 0.55);
  box(shaft.w + 0.2, height, 0.14, car, shaft.x, height / 2, rectMaxZ(shaft) + 0.07);
  box(0.14, height, shaft.d, car, rectMinX(shaft) - 0.07, height / 2, shaft.z);
  box(0.14, height, shaft.d, car, rectMaxX(shaft) + 0.07, height / 2, shaft.z);
  // The doors, closed, on the corridor side, with the call panel lit beside them.
  const doors = solid(0x9aa2a4, 0.4);
  for (const sign of [-1, 1]) box(shaft.w / 2 - 0.04, 2.4, 0.1, doors, shaft.x + sign * shaft.w / 4, 1.2, rectMinZ(shaft) - 0.05);
  const panel = mat(new THREE.MeshStandardMaterial({ color: 0xf0c657, emissive: 0xf0c657, emissiveIntensity: 1.4, roughness: 0.4 }));
  powered?.push({ material: panel, base: panel.emissiveIntensity });
  box(0.18, 0.3, 0.06, panel, rectMinX(shaft) - 0.28, 1.3, rectMinZ(shaft) - 0.05);
}

/** The way back to the street: a recessed dark opening in the front wall, lit, labelled, with a mat
 *  under it you cannot miss walking back down the spine. */
function buildExit(entryX: number, depth: number, kit: Kit): void {
  const { box, solid, mat, keep, group } = kit;
  const doorW = 2.2; const doorH = 3.0;
  const mouth = mat(new THREE.MeshBasicMaterial({ color: 0x0a0d10, fog: false }));
  box(doorW, doorH, 0.06, mouth, entryX, doorH / 2, -depth / 2 + 0.04);
  const frame = solid(0x37403f, 0.6);
  box(0.22, doorH + 0.22, 0.24, frame, entryX - doorW / 2 - 0.11, (doorH + 0.22) / 2, -depth / 2 + 0.13);
  box(0.22, doorH + 0.22, 0.24, frame, entryX + doorW / 2 + 0.11, (doorH + 0.22) / 2, -depth / 2 + 0.13);
  box(doorW + 0.44, 0.22, 0.24, frame, entryX, doorH + 0.11, -depth / 2 + 0.13);
  const bar = solid(0x6d7679, 0.5);
  for (let i = 0; i < 6; i++) box(0.06, doorH, 0.06, bar, entryX - doorW / 2 + 0.2 + i * (doorW - 0.4) / 5, doorH / 2, -depth / 2 + 0.18);
  const exitSign = createSignMesh(keep(new THREE.PlaneGeometry(1.9, 0.5)), 'EXIT', '#ffe08a', { background: '#16211d' });
  exitSign.position.set(entryX, doorH + 0.58, -depth / 2 + 0.1);
  group.add(exitSign);
  const matGlow = mat(new THREE.MeshBasicMaterial({ color: 0xe8b64c, transparent: true, opacity: 0.34, fog: false }));
  const matDisc = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.5, 1.5, 0.05, 20)), matGlow);
  matDisc.position.set(entryX, 0.03, -depth / 2 + EXIT_MAT_IN);
  group.add(matDisc);
  box(2.2, 0.04, 1.4, solid(0x3b3530, 0.98), entryX, 0.02, -depth / 2 + EXIT_MAT_IN);
}

/** How far in from the front wall the exit mat sits. */
export const EXIT_MAT_IN = 1.7;

/** The shutter across the half flight that leads nowhere: +1 caps the way up, −1 the way down.
 *  Exported so the containment clamp blocks exactly the rectangle that was drawn. */
export function stairCap(shaft: Rect, direction: 1 | -1): Rect {
  return { x: shaft.x + direction * shaft.w / 4, z: rectMinZ(shaft) + 0.25, w: shaft.w / 2, d: 0.3 };
}

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
    bay.position.set(door.faceX, surfaceHeightAt(door.faceX, door.faceZ), door.faceZ);
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
    // a suburb — and it was also a real bug: ProceduralMaterials' sign atlas holds 512 distinct
    // boards for a city that already draws about 470, and a name list per door family pushed it over
    // the top, so doorways came out wearing some other building's text. The name is on the prompt you
    // are standing in to read it. A house does not have a signboard.
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
  const { box, solid, mat, keep, group, powered } = kit;
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
      const plate = mat(new THREE.MeshStandardMaterial({ color: 0x6a2a22, emissive: 0x8a2010, emissiveIntensity: 0.7, roughness: 0.5 }));
      powered?.push({ material: plate, base: plate.emissiveIntensity });
      for (let i = 0; i < 2; i++) {
        const ring = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 12)), plate);
        ring.position.set(prop.x - 0.2 + i * 0.4, base + prop.h + 0.02, prop.z); group.add(ring);
      }
      break;
    }
    case 'tv': {
      box(prop.w, prop.h, prop.d, solid(0x1b1f22, 0.6), prop.x, base + prop.h / 2, prop.z);
      const screen = mat(new THREE.MeshStandardMaterial({ color: 0x9fc4d8, emissive: 0x6f9fc4, emissiveIntensity: 0.9, roughness: 0.4 }));
      powered?.push({ material: screen, base: screen.emissiveIntensity });
      box(prop.w * 0.4, prop.h - 0.12, prop.d - 0.12, screen, prop.x, base + prop.h / 2, prop.z);
      break;
    }
    case 'desk': {
      box(prop.w, 0.08, prop.d, body, prop.x, base + prop.h, prop.z);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        box(0.07, prop.h, 0.07, solid(0x4a4640, 0.7), prop.x + sx * (prop.w / 2 - 0.1), base + prop.h / 2, prop.z + sz * (prop.d / 2 - 0.1));
      }
      const screen = mat(new THREE.MeshStandardMaterial({ color: 0x8fb8cc, emissive: 0x5f8fb4, emissiveIntensity: 0.8, roughness: 0.4 }));
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
