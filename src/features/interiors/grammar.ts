/**
 * The interior grammar: a doorstep in, a room description out. Pure data — no three.js, no game —
 * so the whole layout is unit-testable and the same door always produces the same room.
 *
 * DETERMINISM IS THE CONTRACT. Every choice comes from `stablePositionRandom(door.x, door.z, salt)`
 * and every derived dimension goes through `stableWorldFloat`, so build → dispose → rebuild is
 * byte-identical and nothing here drifts between a headless test and a browser.
 *
 * Room space is LOCAL and right-handed the way the rest of the world is: the origin is the middle
 * of the floor, +z runs away from the door (deeper into the building), +x is to your left as you
 * walk in. The caller rotates the whole group by the door's inward heading.
 */
import { stablePositionRandom, stableWorldFloat } from '../../world/StableRandom';
import type { InteriorDoor, InteriorKind } from '../interiors.state';

export type PropShape = 'box' | 'crate' | 'shelf' | 'counter' | 'bed' | 'stove' | 'table' | 'stool' | 'bucket' | 'drum' | 'cage' | 'notice' | 'curtain' | 'tv' | 'basin';

export interface InteriorProp {
  readonly shape: PropShape;
  /** Centre, in room-local space. `y` is the height of the prop's BASE above the floor. */
  readonly x: number; readonly z: number; readonly y: number;
  readonly w: number; readonly d: number; readonly h: number;
  readonly color: number;
  /** Solid props are clamped against in room-local space, so they are axis-aligned by construction. */
  readonly solid: boolean;
  readonly text?: string;
}

export interface InteriorPalette { wall: number; floor: number; ceiling: number; trim: number; lamp: number }

export interface InteriorLayout {
  readonly id: string;
  readonly kind: InteriorKind;
  readonly name: string;
  readonly eyebrow: string;
  readonly blurb: string;
  /** Interior clear dimensions. The shell is built one wall-thickness outside these. */
  readonly width: number; readonly depth: number; readonly height: number;
  readonly palette: InteriorPalette;
  readonly props: readonly InteriorProp[];
  readonly lamps: readonly { x: number; z: number; y: number; color: number }[];
  /** Where the fixture NPC stands, room-local. Undefined for an empty room. */
  readonly fixture?: { x: number; z: number; name: string };
  /** Rand found the first time you come in. Small, generous, celebrated — never a grind. */
  readonly find: number;
  readonly findLine: string;
}

const SPAZA_WALLS = [0xd8c9a4, 0xc9d6cf, 0xe2d3b0, 0xcbbfa6];
const FLAT_WALLS = [0xbfc4c0, 0xd3ccbc, 0xb9bec6, 0xc8bfae];
const STOCK = [0xd8563f, 0xe4a72c, 0x3f7fbf, 0x4f9d5a, 0xd9d2c2, 0x8b5a3c];

/** Local point on a wall run. `t` is 0..1 along the wall, `inset` is how far off it the prop sits. */
function alongWall(wall: 'back' | 'left' | 'right' | 'front', t: number, width: number, depth: number, inset: number): { x: number; z: number } {
  const span = wall === 'back' || wall === 'front' ? width : depth;
  const along = (t - 0.5) * (span - 1.2);
  if (wall === 'back') return { x: along, z: depth / 2 - inset };
  if (wall === 'front') return { x: along, z: -depth / 2 + inset };
  if (wall === 'left') return { x: width / 2 - inset, z: along };
  return { x: -width / 2 + inset, z: along };
}

const q = stableWorldFloat;

export function generateInterior(door: InteriorDoor): InteriorLayout {
  const rnd = (salt: number): number => stablePositionRandom(door.x, door.z, salt);
  const pick = <T>(list: readonly T[], salt: number): T => list[Math.floor(rnd(salt) * list.length) % list.length]!;
  if (door.kind === 'ponte') return ponte(door, rnd, pick);
  return door.kind === 'spaza' ? spaza(door, rnd, pick) : flat(door, rnd, pick);
}

type Rnd = (salt: number) => number;
type Pick = <T>(list: readonly T[], salt: number) => T;

// ---- spaza shop ---------------------------------------------------------------------------------

/** A tuck shop in the front room of somebody's house: a counter you cannot get behind, stock on the
 *  wall behind mesh, crates of empties, and a cage window that is how you are served after dark. */
function spaza(door: InteriorDoor, rnd: Rnd, pick: Pick): InteriorLayout {
  const width = q(5.6 + rnd(1) * 2.4);
  const depth = q(6.4 + rnd(2) * 2.6);
  const height = q(2.65 + rnd(3) * 0.45);
  const props: InteriorProp[] = [];
  const counterZ = q(depth / 2 - 2.1);
  props.push({ shape: 'counter', x: 0, z: counterZ, y: 0, w: q(width - 1.4), d: 0.72, h: 1.06, color: 0x8a6a3f, solid: true });
  // Shelf bays behind the counter: how many is the main thing that makes one spaza not another.
  const bays = 2 + Math.floor(rnd(4) * 3);
  for (let i = 0; i < bays; i++) {
    const spot = alongWall('back', bays === 1 ? 0.5 : i / (bays - 1), width, depth, 0.34);
    props.push({ shape: 'shelf', x: q(spot.x), z: q(spot.z), y: 0, w: q(1.0 + rnd(10 + i) * 0.5), d: 0.34, h: q(1.7 + rnd(20 + i) * 0.5), color: pick(STOCK, 30 + i), solid: false });
  }
  const fridgeSide = rnd(5) < 0.5 ? 'left' : 'right';
  // Well in front of the counter's z band: a chest freezer parked against the serving counter is
  // the one furniture clash the layout test can actually catch.
  const fridge = alongWall(fridgeSide, 0.25, width, depth, 0.42);
  props.push({ shape: 'box', x: q(fridge.x), z: q(fridge.z), y: 0, w: 0.72, d: 1.5, h: 1.62, color: 0xdfe6e4, solid: true });
  const crates = 2 + Math.floor(rnd(6) * 3);
  for (let i = 0; i < crates; i++) {
    const spot = alongWall(fridgeSide === 'left' ? 'right' : 'left', 0.2 + i * 0.2, width, depth, 0.5);
    props.push({ shape: 'crate', x: q(spot.x), z: q(spot.z), y: q(i % 2 === 0 ? 0 : 0.34), w: 0.62, d: 0.62, h: 0.34, color: pick([0xc8452f, 0x2f6fa8, 0x3f8a4c], 40 + i), solid: false });
  }
  props.push({ shape: 'cage', x: 0, z: q(counterZ - 0.62), y: 1.06, w: q(width - 1.4), d: 0.08, h: q(height - 1.2), color: 0x5e6668, solid: false });
  props.push({ shape: 'notice', x: q(-width / 2 + 0.14), z: q(-depth / 2 + 1.6), y: 1.5, w: 0.05, d: 0.62, h: 0.44, color: 0xf2e6c8, solid: false, text: pick(['NO CREDIT', 'AIRTIME HERE', 'NO CREDIT ASK YOUR MOTHER', 'ICE COLD'], 7) });
  return {
    id: door.id, kind: 'spaza', name: door.name, eyebrow: 'SPAZA',
    blurb: 'Front room, burglar bars, and everything you actually need at 22:00.',
    width, depth, height,
    palette: { wall: pick(SPAZA_WALLS, 8), floor: 0x6d5a48, ceiling: 0xe6e2d8, trim: 0x2f3a3d, lamp: 0xffd9a0 },
    props,
    lamps: [{ x: 0, z: 0, y: q(height - 0.35), color: 0xffe0b0 }],
    fixture: { x: 0, z: q(counterZ + 0.9), name: 'Shopkeeper' },
    find: 40 + Math.floor(rnd(9) * 5) * 10,
    findLine: 'Change on the counter — she waves it off.',
  };
}

// ---- hijacked flat ------------------------------------------------------------------------------

/** A flat in a hijacked block: one illegal connection, water in buckets, and a laminated levy
 *  notice from a "Body Corporate" that has never once fixed a lift. */
function flat(door: InteriorDoor, rnd: Rnd, pick: Pick): InteriorLayout {
  const width = q(6.0 + rnd(1) * 2.2);
  const depth = q(6.8 + rnd(2) * 2.4);
  const height = q(2.55 + rnd(3) * 0.25);
  const props: InteriorProp[] = [];
  const bedSide = rnd(4) < 0.5 ? 'left' : 'right';
  const bed = alongWall(bedSide, 0.7, width, depth, 1.05);
  props.push({ shape: 'bed', x: q(bed.x), z: q(bed.z), y: 0, w: 1.9, d: 1.3, h: 0.42, color: pick([0x8a4a52, 0x3f5f77, 0x6a6f4a], 5), solid: true });
  const kitchen = alongWall('back', 0.28, width, depth, 0.5);
  props.push({ shape: 'stove', x: q(kitchen.x), z: q(kitchen.z), y: 0, w: 0.68, d: 0.5, h: 0.86, color: 0x3c4245, solid: true });
  props.push({ shape: 'basin', x: q(kitchen.x + 1.05), z: q(kitchen.z), y: 0, w: 0.86, d: 0.52, h: 0.9, color: 0xb8bcbb, solid: true });
  const buckets = 2 + Math.floor(rnd(6) * 3);
  for (let i = 0; i < buckets; i++) {
    const spot = alongWall('back', 0.62 + i * 0.11, width, depth, 0.42);
    props.push({ shape: 'bucket', x: q(spot.x), z: q(spot.z), y: 0, w: 0.34, d: 0.34, h: 0.38, color: pick([0x2f6fa8, 0xd8563f, 0x3f8a4c, 0xe4a72c], 50 + i), solid: false });
  }
  props.push({ shape: 'table', x: q(-0.2), z: q(-0.4), y: 0, w: 1.15, d: 0.78, h: 0.74, color: 0x9a7b52, solid: true });
  const stools = 1 + Math.floor(rnd(7) * 3);
  for (let i = 0; i < stools; i++) props.push({ shape: 'stool', x: q(-0.2 + Math.cos(i * 2.1) * 0.95), z: q(-0.4 + Math.sin(i * 2.1) * 0.95), y: 0, w: 0.38, d: 0.38, h: 0.44, color: pick([0xd6d0c4, 0x2f4f4a, 0xb03a2e], 60 + i), solid: false });
  if (rnd(8) < 0.6) props.push({ shape: 'tv', x: q(width / 2 - 0.36), z: q(-depth / 2 + 1.8), y: 0.72, w: 0.14, d: 0.86, h: 0.52, color: 0x1b1f22, solid: false });
  props.push({ shape: 'curtain', x: q(-width / 2 + 0.12), z: 0, y: q(height - 1.9), w: 0.06, d: q(depth * 0.42), h: 1.5, color: pick([0xc46a4a, 0x4a6a8a, 0x6a8a5a], 9), solid: false });
  props.push({ shape: 'notice', x: 0, z: q(-depth / 2 + 0.12), y: 1.55, w: 0.62, d: 0.05, h: 0.44, color: 0xf4efdc, solid: false, text: 'BODY CORPORATE · LEVIES DUE' });
  return {
    id: door.id, kind: 'flat', name: door.name, eyebrow: 'FLAT',
    blurb: 'No water in the taps, no lift, and one extension cord doing the work of a substation.',
    width, depth, height,
    palette: { wall: pick(FLAT_WALLS, 10), floor: 0x8a8378, ceiling: 0xd8d4cb, trim: 0x39413f, lamp: 0xfff0c4 },
    props,
    lamps: [{ x: 0, z: q(depth * 0.12), y: q(height - 0.22), color: 0xfff0c4 }],
    find: 20 + Math.floor(rnd(11) * 4) * 10,
    findLine: 'Coins in a jam tin on the sill.',
  };
}

// ---- bespoke: Ponte Tower -----------------------------------------------------------------------

/** The one hand-authored room, to prove the bespoke path runs through the same builder as the
 *  grammar: Ponte's core landing — the famous light well, a bucket brigade on the stairs, and the
 *  single illegal connection feeding the whole floor. Fixed by hand; nothing here is rolled. */
function ponte(door: InteriorDoor, rnd: Rnd, pick: Pick): InteriorLayout {
  const width = 10.4; const depth = 12.6; const height = 3.6;
  const props: InteriorProp[] = [];
  // The light well: a square parapet you can walk around but not into, dead centre.
  const well = 3.4;
  props.push({ shape: 'box', x: 0, z: 1.2, y: 0, w: well, d: well, h: 1.05, color: 0x6f6a60, solid: true });
  // Bucket brigade up the stair wall.
  for (let i = 0; i < 7; i++) {
    props.push({ shape: 'bucket', x: -width / 2 + 0.7 + (i % 2) * 0.42, z: -depth / 2 + 1.4 + i * 0.62, y: i * 0.24, w: 0.34, d: 0.34, h: 0.38, color: pick([0x2f6fa8, 0xd8563f, 0x3f8a4c, 0xe4a72c], 70 + i), solid: false });
  }
  props.push({ shape: 'drum', x: width / 2 - 0.9, z: depth / 2 - 1.4, y: 0, w: 0.72, d: 0.72, h: 0.92, color: 0x8a4a2e, solid: true });
  props.push({ shape: 'drum', x: width / 2 - 0.9, z: depth / 2 - 2.4, y: 0, w: 0.72, d: 0.72, h: 0.92, color: 0x4a5a3a, solid: true });
  props.push({ shape: 'crate', x: -width / 2 + 1.1, z: depth / 2 - 1.6, y: 0, w: 0.9, d: 0.9, h: 0.5, color: 0x2f6fa8, solid: false });
  props.push({ shape: 'crate', x: -width / 2 + 1.1, z: depth / 2 - 1.6, y: 0.5, w: 0.9, d: 0.9, h: 0.5, color: 0xc8452f, solid: false });
  props.push({ shape: 'notice', x: 0, z: -depth / 2 + 0.12, y: 1.7, w: 0.9, d: 0.05, h: 0.62, color: 0xf4efdc, solid: false, text: 'BODY CORPORATE · NO WATER TUESDAY' });
  props.push({ shape: 'notice', x: width / 2 - 0.14, z: -1.2, y: 1.6, w: 0.05, d: 0.8, h: 0.5, color: 0xe8dcc0, solid: false, text: 'FLOOR 7 · KEEP THE STAIRS CLEAR' });
  return {
    id: door.id, kind: 'ponte', name: 'Ponte — seventh floor', eyebrow: 'PONTE CITY',
    blurb: 'Fifty-four floors of core, and every one of them shouts back at you.',
    width, depth, height,
    palette: { wall: 0x9c968a, floor: 0x5c5a55, ceiling: 0x77726a, trim: 0x2b2f31, lamp: 0xfff2cf },
    props,
    lamps: [
      { x: 0, z: 1.2, y: height - 0.2, color: 0xdfe8ff },
      { x: -width / 2 + 1.2, z: -depth / 2 + 1.6, y: height - 0.6, color: 0xffd79a },
    ],
    fixture: { x: width / 2 - 2.3, z: -depth / 2 + 2.2, name: 'Levy collector' },
    // Bespoke rooms still pay the same small, celebrated find — the reward test does not care how
    // the room was authored. `rnd` is read once so the bespoke path is exercised by the same seed.
    find: 60 + Math.floor(rnd(1) * 4) * 10,
    findLine: 'R-notes tucked behind the levy notice. Nobody saw.',
  };
}
