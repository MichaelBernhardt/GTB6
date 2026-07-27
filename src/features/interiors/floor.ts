/**
 * ONE STOREY, GENERATED ON DEMAND from hash(building, floor number), inheriting the core as an
 * immovable given. Pure data — no three.js — so a floor can be solved and PROVEN in a unit test.
 *
 * THE PLAN. A spine corridor runs from the street door at the front wall to the stair and lift at the
 * back. The bands either side of it are split into rooms, and each room gets a doorway onto the
 * spine. That is a real building plan, it reads as one, and it makes the connectivity claim
 * structural rather than hopeful: every room touches the spine, the spine touches the core.
 *
 * BUT STRUCTURAL IS NOT PROVEN, so it is proven. `solveFloor` flood-fills a grid of the finished
 * floor — walls with their doorways open, every solid piece of furniture in place — from the tile
 * the player actually lands on, and reports how many walkable tiles it could not reach. Furniture is
 * placed under that same test: a chair that would seal a doorway is refused before it is ever
 * returned, in a fixed order, so the refusal is as deterministic as the placement. `plan.unreachable`
 * is 0 or the floor is a bug, and interiors.test.ts asserts exactly that over hundreds of floors.
 *
 * WHAT IS NOT SOLVED HERE, deliberately: nothing about the world. A floor plan does not know where
 * the building stands, how high off the ground it is, or which way it faces. That keeps this file
 * about rooms.
 */
import {
  buildCore, CEILING, CORE_GAP, CORRIDOR, floorRandom, MIN_ROOM, rectMaxX, rectMaxZ, rectMinX, rectMinZ,
  type BuildingCore, type BuildingFacts, type Rect,
} from './core';
import { stableWorldFloat } from '../../world/StableRandom';

const q = stableWorldFloat;

export type RoomKind = 'shop' | 'lounge' | 'bedroom' | 'kitchen' | 'office' | 'store' | 'lobby';

export interface Room {
  readonly id: string;
  readonly kind: RoomKind;
  readonly name: string;
  readonly rect: Rect;
  /** Doorway centre on the wall this room shares with the spine, and which side the spine is on. */
  readonly doorZ: number;
  readonly doorSide: 'left' | 'right';
}

/** A partition run. `gapCentre`/`gapWidth` are the doorway cut out of it (undefined = solid). */
export interface Wall {
  readonly axis: 'x' | 'z';
  /** Position of the wall line on its own axis. */
  readonly at: number;
  /** Extent along the other axis. */
  readonly from: number;
  readonly to: number;
  readonly gapCentre?: number;
  readonly gapWidth?: number;
}

export type PropShape =
  | 'counter' | 'shelf' | 'crate' | 'sack' | 'fridge' | 'bed' | 'wardrobe' | 'sofa' | 'table'
  | 'stool' | 'stove' | 'basin' | 'bucket' | 'tv' | 'desk' | 'cabinet' | 'plant' | 'notice';

export interface Prop {
  readonly shape: PropShape;
  readonly x: number; readonly z: number; readonly y: number;
  readonly w: number; readonly d: number; readonly h: number;
  readonly color: number;
  /** Solid props are clamped against, and were proven not to seal a doorway. */
  readonly solid: boolean;
  readonly text?: string;
}

export interface Lamp { readonly x: number; readonly z: number; readonly y: number; readonly color: number }

export interface FloorPlan {
  readonly core: BuildingCore;
  readonly index: number;
  readonly label: string;
  readonly eyebrow: string;
  readonly blurb: string;
  /** What the first visit finds. Small, celebrated, and true to the room it was found in. */
  readonly findLine: string;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly rooms: readonly Room[];
  readonly walls: readonly Wall[];
  readonly props: readonly Prop[];
  readonly lamps: readonly Lamp[];
  readonly palette: { wall: number; floor: number; ceiling: number; trim: number };
  /** Where the player lands arriving on this floor by stair or lift: on the spine, clear of the shaft. */
  readonly landing: { x: number; z: number };
  /** Where a fixture NPC stands, if this floor has one. */
  readonly fixture?: { x: number; z: number; name: string };
  /** THE PROOF. Walkable tiles the flood fill could not reach from the landing. Must be 0. */
  readonly unreachable: number;
  readonly walkable: number;
}

/** Doorway clear width. Wide enough that the containment clamp cannot wedge you in a jamb. */
const DOOR_W = 2.0;
/** Flood-fill tile. Fine enough to notice a sealed doorway, coarse enough to be free. */
const TILE = 0.45;
/** Half-width of the walking body the flood fill uses. Matches PLAYER.radius closely enough that a
 *  gap this pass calls open is a gap the clamp lets you through. */
const BODY = 0.42;

const WALL_NAMES = ['Ngwenya', 'Marabastad', 'Kliptown', 'Alexandra', 'Vrededorp', 'Doornfontein', 'Fordsburg', 'Sophiatown'];

// ---- the plan --------------------------------------------------------------------------------

/** The rooms either side of the spine, front to back. */
function layoutRooms(core: BuildingCore, index: number, kinds: readonly RoomKind[]): Room[] {
  const rooms: Room[] = [];
  const spineMin = core.corridorX - CORRIDOR / 2;
  const spineMax = core.corridorX + CORRIDOR / 2;
  const frontZ = -core.depth / 2;
  // The bands stop well short of the back wall: the core owns that end of the plate, full width, so
  // no room wall can ever stand across the mouth of the stair. See CORE_GAP.
  const backZ = rectMinZ(core.stair) - CORE_GAP;
  const bandDepth = backZ - frontZ;
  let kindAt = 0;
  for (const side of ['left', 'right'] as const) {
    const outer = side === 'left' ? core.width / 2 : -core.width / 2;
    const inner = side === 'left' ? spineMax : spineMin;
    const bandWidth = Math.abs(outer - inner);
    if (bandWidth < MIN_ROOM || bandDepth < MIN_ROOM) continue;
    // How many rooms fit down this band, from the floor's own hash. Bounded so no room is a cupboard.
    const most = Math.max(1, Math.floor(bandDepth / MIN_ROOM));
    const count = Math.max(1, Math.min(most, 1 + Math.floor(floorRandom(core.seed, index, side === 'left' ? 11 : 12) * 3)));
    // Uneven splits, but every share is at least a fair third of an even one, so nothing degenerates.
    const shares: number[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const share = 0.7 + floorRandom(core.seed, index, (side === 'left' ? 20 : 40) + i) * 0.6;
      shares.push(share); total += share;
    }
    let z = frontZ;
    for (let i = 0; i < count; i++) {
      const d = q(bandDepth * shares[i]! / total);
      const rect: Rect = { x: q((outer + inner) / 2), z: q(z + d / 2), w: q(bandWidth), d };
      const kind = kinds[kindAt % kinds.length]!;
      kindAt++;
      rooms.push({
        id: `${side}${i}`, kind, name: roomName(kind, core, index, kindAt),
        rect,
        // The doorway sits in the middle of the room's share of the spine wall, always reachable.
        doorZ: q(rect.z),
        doorSide: side,
      });
      z += d;
    }
  }
  return rooms;
}

function roomName(kind: RoomKind, core: BuildingCore, index: number, salt: number): string {
  if (kind === 'office') return `Office ${index}${String.fromCharCode(65 + (salt % 6))}`;
  if (kind === 'shop') return 'The shop floor';
  if (kind === 'lobby') return 'Lobby';
  if (kind === 'store') return 'Store room';
  if (kind === 'bedroom') return 'Bedroom';
  if (kind === 'kitchen') return 'Kitchen';
  return WALL_NAMES[Math.floor(floorRandom(core.seed, index, 70 + salt) * WALL_NAMES.length) % WALL_NAMES.length] + ' lounge';
}

/**
 * What sort of floor this is. Ground floors are what the model's own entrance says they are — a
 * shopfront has a shop behind it, a porch has somebody's front room, a lobby has a lobby. Upstairs
 * is flats over a shop, offices over a lobby, more house over a porch. Short on purpose: a spaza, a
 * flat and an office are enough variety to start.
 */
function floorKinds(core: BuildingCore, index: number): { kinds: RoomKind[]; eyebrow: string; blurb: string; findLine: string } {
  if (index === 0) {
    if (core.entrance === 'shopfront') {
      return { kinds: ['shop', 'store'], eyebrow: 'SPAZA', blurb: 'Burglar bars, a cold fridge, and everything you actually need at 22:00.',
        findLine: 'Change on the counter — she waves it off.' };
    }
    if (core.entrance === 'lobby') {
      return { kinds: ['lobby', 'office'], eyebrow: 'LOBBY', blurb: 'A security desk, a dead lift button, and a directory nobody has updated since 2011.',
        findLine: 'Loose notes under the visitors book.' };
    }
    return { kinds: ['lounge', 'kitchen', 'bedroom'], eyebrow: 'FLAT', blurb: 'No water in the taps, no lift, and one extension cord doing the work of a substation.',
      findLine: 'Coins in a jam tin on the sill.' };
  }
  if (core.entrance === 'lobby' && core.storeys >= OFFICE_FROM_STOREYS) {
    return { kinds: ['office', 'office', 'store'], eyebrow: 'OFFICES', blurb: 'Half the suites are let, the other half have a phone still ringing in them.',
      findLine: 'Petty cash, in a tin marked PETTY CASH.' };
  }
  return { kinds: ['lounge', 'bedroom', 'kitchen'], eyebrow: 'FLAT', blurb: 'Somebody is cooking, somebody is arguing, and the lift has not worked since you were born.',
    findLine: 'Coins in a jam tin on the sill.' };
}

/** From this many storeys up, a lobby building is offices rather than flats. */
const OFFICE_FROM_STOREYS = 6;

const PALETTES: Record<string, { wall: number; floor: number; ceiling: number; trim: number }> = {
  shop: { wall: 0xd8c9a4, floor: 0x6d5a48, ceiling: 0xe6e2d8, trim: 0x2f3a3d },
  flat: { wall: 0xc4c8c2, floor: 0x8a8378, ceiling: 0xd8d4cb, trim: 0x39413f },
  office: { wall: 0xb9c0c4, floor: 0x5f6668, ceiling: 0xdfe3e4, trim: 0x2b3335 },
};

// ---- the solver ------------------------------------------------------------------------------

export function solveFloor(facts: BuildingFacts, index: number, core = buildCore(facts)): FloorPlan {
  const { kinds, eyebrow, blurb, findLine } = floorKinds(core, index);
  const rooms = layoutRooms(core, index, kinds);
  const walls = buildWalls(core, rooms);
  const paletteKey = eyebrow === 'SPAZA' ? 'shop' : eyebrow === 'OFFICES' || eyebrow === 'LOBBY' ? 'office' : 'flat';

  // The landing: on the spine just in front of the shaft, which is where a stair or a lift puts you
  // down and, on the ground floor, where the street door leaves you facing the building.
  const landing = { x: q(core.corridorX), z: q(rectMinZ(core.stair) - 1.4) };

  const grid = new Grid(core);
  for (const wall of walls) grid.blockWall(wall);

  // Furniture goes in LAST and each solid piece has to earn its place: if putting it down would cut
  // any walkable tile off from the landing, it does not go down. Fixed order in, fixed order out.
  const props: Prop[] = [];
  for (const candidate of furnish(core, index, rooms)) {
    if (!candidate.solid) { props.push(candidate); continue; }
    grid.blockProp(candidate);
    if (grid.reaches(landing)) props.push(candidate);
    else grid.unblockProp(candidate);
  }

  const reach = grid.flood(landing);
  return {
    core, index,
    label: index === 0 ? 'Ground floor' : `Floor ${index}`,
    eyebrow, blurb, findLine,
    width: core.width, depth: core.depth, height: CEILING,
    rooms, walls, props,
    lamps: lampsFor(core, rooms),
    palette: PALETTES[paletteKey]!,
    landing,
    fixture: fixtureFor(core, index, rooms),
    unreachable: reach.walkable - reach.reached,
    walkable: reach.walkable,
  };
}

/** The partitions: one run down each side of the spine, cut by a doorway per room, plus the cross
 *  walls between rooms in the same band. */
function buildWalls(core: BuildingCore, rooms: readonly Room[]): Wall[] {
  const walls: Wall[] = [];
  const spineMin = core.corridorX - CORRIDOR / 2;
  const spineMax = core.corridorX + CORRIDOR / 2;
  for (const room of rooms) {
    // The wall between this room and the spine, with its doorway cut out.
    walls.push({
      axis: 'x', at: q(room.doorSide === 'left' ? spineMax : spineMin),
      from: q(rectMinZ(room.rect)), to: q(rectMaxZ(room.rect)),
      gapCentre: room.doorZ, gapWidth: DOOR_W,
    });
    // The cross wall at the room's far (deeper) end, unless it is the last in its band.
    const deeper = rooms.find((other) => other.doorSide === room.doorSide && Math.abs(rectMinZ(other.rect) - rectMaxZ(room.rect)) < 0.01);
    if (deeper) {
      walls.push({
        axis: 'z', at: q(rectMaxZ(room.rect)),
        from: q(Math.min(rectMinX(room.rect), rectMaxX(room.rect))),
        to: q(Math.max(rectMinX(room.rect), rectMaxX(room.rect))),
      });
    }
  }
  return walls;
}

function lampsFor(core: BuildingCore, rooms: readonly Room[]): Lamp[] {
  const lamps: Lamp[] = [{ x: q(core.corridorX), z: q(-core.depth / 4), y: q(CEILING - 0.35), color: 0xffe6bd }];
  lamps.push({ x: q(core.corridorX), z: q(rectMinZ(core.stair) - 0.8), y: q(CEILING - 0.35), color: 0xdfe8ff });
  for (const room of rooms) lamps.push({ x: q(room.rect.x), z: q(room.rect.z), y: q(CEILING - 0.35), color: 0xfff0c4 });
  return lamps;
}

function fixtureFor(core: BuildingCore, index: number, rooms: readonly Room[]): { x: number; z: number; name: string } | undefined {
  // One person per floor at most, and only where somebody would actually be standing.
  const host = rooms.find((room) => room.kind === 'shop') ?? rooms.find((room) => room.kind === 'lobby')
    ?? (floorRandom(core.seed, index, 91) < 0.55 ? rooms.find((room) => room.kind === 'lounge') : undefined);
  if (!host) return undefined;
  const name = host.kind === 'shop' ? 'Shopkeeper' : host.kind === 'lobby' ? 'Security' : 'Tenant';
  return { x: q(host.rect.x), z: q(host.rect.z + host.rect.d * 0.22), name };
}

// ---- furniture --------------------------------------------------------------------------------

const STOCK = [0xd8563f, 0xe4a72c, 0x3f7fbf, 0x4f9d5a, 0xd9d2c2, 0x8b5a3c];

/** Everything this floor would LIKE to have, in a fixed order. The solver takes them one at a time
 *  and keeps only those that do not seal a doorway, so what comes back is both furnished and open. */
function furnish(core: BuildingCore, index: number, rooms: readonly Room[]): Prop[] {
  const out: Prop[] = [];
  const rnd = (salt: number): number => floorRandom(core.seed, index, salt);
  const pick = <T>(list: readonly T[], salt: number): T => list[Math.floor(rnd(salt) * list.length) % list.length]!;
  let salt = 200;
  for (const room of rooms) {
    const { rect } = room;
    // Against the OUTER wall of the band, so the doorway end of the room stays clear.
    const outer = room.doorSide === 'left' ? rectMaxX(rect) : rectMinX(rect);
    const inward = room.doorSide === 'left' ? -1 : 1;
    const wallX = (inset: number): number => q(outer + inward * inset);
    salt += 20;
    switch (room.kind) {
      case 'shop': {
        out.push({ shape: 'counter', x: q(rect.x), z: q(rectMaxZ(rect) - 1.5), y: 0, w: q(rect.w - 2.2), d: 0.9, h: 1.06, color: 0x8a6a3f, solid: true });
        const bays = 2 + Math.floor(rnd(salt) * 3);
        for (let i = 0; i < bays; i++) {
          out.push({ shape: 'shelf', x: wallX(0.55), z: q(rectMinZ(rect) + 1.4 + i * 1.9), y: 0, w: 0.5, d: q(1.5 + rnd(salt + i) * 0.4), h: q(2.0 + rnd(salt + 9 + i) * 0.5), color: pick(STOCK, salt + i), solid: false });
        }
        out.push({ shape: 'fridge', x: wallX(0.7), z: q(rectMaxZ(rect) - 3.2), y: 0, w: 1.0, d: 2.0, h: 1.9, color: 0xdfe6e4, solid: true });
        for (let i = 0; i < 3; i++) out.push({ shape: 'crate', x: q(rect.x + inward * 0.6), z: q(rectMinZ(rect) + 1.1 + i * 0.95), y: q(i % 2 === 0 ? 0 : 0.42), w: 0.8, d: 0.8, h: 0.42, color: pick([0xc8452f, 0x2f6fa8, 0x3f8a4c], salt + 3 + i), solid: false });
        out.push({ shape: 'notice', x: wallX(0.1), z: q(rect.z), y: 2.0, w: 0.05, d: 1.4, h: 0.9, color: 0xf2e6c8, solid: false, text: pick(['NO CREDIT', 'AIRTIME HERE', 'ICE COLD'], salt + 7) });
        break;
      }
      case 'store': {
        for (let i = 0; i < 4; i++) out.push({ shape: 'sack', x: wallX(0.8), z: q(rectMinZ(rect) + 1.2 + i * 1.1), y: q(i % 2 === 0 ? 0 : 0.42), w: 0.95, d: 0.7, h: 0.42, color: pick([0xd8cdb0, 0xe6dcc0, 0xcfc4a6], salt + i), solid: false });
        out.push({ shape: 'shelf', x: q(rect.x), z: q(rectMaxZ(rect) - 0.7), y: 0, w: q(rect.w - 1.6), d: 0.5, h: 2.2, color: 0x8b5a3c, solid: false });
        break;
      }
      case 'bedroom': {
        out.push({ shape: 'bed', x: wallX(1.4), z: q(rect.z), y: 0, w: 2.3, d: 1.9, h: 0.5, color: pick([0x8a4a52, 0x3f5f77, 0x6a6f4a], salt), solid: true });
        out.push({ shape: 'wardrobe', x: wallX(0.5), z: q(rectMinZ(rect) + 1.1), y: 0, w: 0.6, d: 1.7, h: 2.3, color: 0x6a5340, solid: true });
        break;
      }
      case 'kitchen': {
        out.push({ shape: 'stove', x: wallX(0.6), z: q(rect.z - 0.9), y: 0, w: 0.9, d: 0.7, h: 0.9, color: 0x3c4245, solid: true });
        out.push({ shape: 'basin', x: wallX(0.6), z: q(rect.z + 0.9), y: 0, w: 1.1, d: 0.7, h: 0.95, color: 0xb8bcbb, solid: true });
        for (let i = 0; i < 3; i++) out.push({ shape: 'bucket', x: wallX(1.6), z: q(rectMaxZ(rect) - 1.0 - i * 0.6), y: 0, w: 0.42, d: 0.42, h: 0.46, color: pick([0x2f6fa8, 0xd8563f, 0x3f8a4c], salt + i), solid: false });
        break;
      }
      case 'lounge': {
        out.push({ shape: 'sofa', x: wallX(1.2), z: q(rect.z), y: 0, w: 0.95, d: 2.2, h: 0.8, color: pick([0x6a5a4a, 0x4a5a63, 0x7a6a52], salt), solid: true });
        out.push({ shape: 'table', x: q(rect.x), z: q(rect.z), y: 0, w: 1.2, d: 0.9, h: 0.5, color: 0x9a7b52, solid: true });
        out.push({ shape: 'tv', x: q(outer - inward * (rect.w - 1.0)), z: q(rect.z), y: 0.75, w: 0.2, d: 1.2, h: 0.75, color: 0x1b1f22, solid: false });
        for (let i = 0; i < 2; i++) out.push({ shape: 'stool', x: q(rect.x + inward * 1.1), z: q(rect.z - 0.8 + i * 1.6), y: 0, w: 0.44, d: 0.44, h: 0.48, color: pick([0xd6d0c4, 0x2f4f4a, 0xb03a2e], salt + i), solid: false });
        break;
      }
      case 'office': {
        out.push({ shape: 'desk', x: wallX(1.3), z: q(rect.z - 0.6), y: 0, w: 1.9, d: 0.95, h: 0.74, color: 0x8d7a5f, solid: true });
        out.push({ shape: 'stool', x: wallX(2.5), z: q(rect.z - 0.6), y: 0, w: 0.5, d: 0.5, h: 0.48, color: 0x2f3a44, solid: false });
        out.push({ shape: 'cabinet', x: wallX(0.4), z: q(rectMaxZ(rect) - 1.0), y: 0, w: 0.5, d: 1.2, h: 1.5, color: 0x606a6d, solid: true });
        out.push({ shape: 'plant', x: q(rect.x), z: q(rectMinZ(rect) + 0.9), y: 0, w: 0.7, d: 0.7, h: 1.3, color: 0x3f6a3a, solid: false });
        break;
      }
      case 'lobby': {
        out.push({ shape: 'counter', x: wallX(1.4), z: q(rect.z), y: 0, w: 1.1, d: q(Math.min(3.2, rect.d - 1.6)), h: 1.06, color: 0x6a5340, solid: true });
        out.push({ shape: 'plant', x: q(rect.x), z: q(rectMinZ(rect) + 1.0), y: 0, w: 0.8, d: 0.8, h: 1.5, color: 0x3f6a3a, solid: false });
        out.push({ shape: 'notice', x: wallX(0.1), z: q(rectMaxZ(rect) - 1.4), y: 1.9, w: 0.05, d: 1.3, h: 1.0, color: 0xf4efdc, solid: false, text: 'LEVIES DUE' });
        break;
      }
    }
  }
  return out;
}

// ---- the walkability grid ----------------------------------------------------------------------

/**
 * The floor as tiles. A tile is walkable when a body of the player's own radius, centred on it,
 * clears every wall and every solid prop — the same question the containment clamp asks each frame,
 * asked once, everywhere at once.
 *
 * Blockers are COUNTED rather than flagged, so a prop that is tried and refused can be lifted again
 * exactly, without rebuilding the grid and without the "undo left something behind" class of bug.
 */
class Grid {
  private readonly nx: number;
  private readonly nz: number;
  private readonly count: Uint16Array;
  private readonly x0: number;
  private readonly z0: number;

  constructor(core: BuildingCore) {
    this.x0 = -core.width / 2; this.z0 = -core.depth / 2;
    this.nx = Math.max(1, Math.ceil(core.width / TILE));
    this.nz = Math.max(1, Math.ceil(core.depth / TILE));
    this.count = new Uint16Array(this.nx * this.nz);
    // The outer shell: the player can never stand within a body radius of it, so neither can a tile
    // claim to be walkable there. Without this a corner tile behind a wardrobe reads as an
    // unreachable spot the player could never have stood in anyway.
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.cx(ix); const z = this.cz(iz);
        if (Math.abs(x) > core.width / 2 - BODY || Math.abs(z) > core.depth / 2 - BODY) this.count[this.index(ix, iz)]++;
      }
    }
    // A shaft is not floor: you do not walk through the lift, you ride in it.
    if (core.lift) this.mark(core.lift, 0, 1);
  }

  private index(ix: number, iz: number): number { return iz * this.nx + ix; }
  private cx(ix: number): number { return this.x0 + (ix + 0.5) * TILE; }
  private cz(iz: number): number { return this.z0 + (iz + 0.5) * TILE; }

  /** Tile range a world span touches, so marking a wardrobe costs a wardrobe and not a whole floor. */
  private span(low: number, high: number, origin: number, n: number): [number, number] {
    return [Math.max(0, Math.floor((low - origin) / TILE)), Math.min(n - 1, Math.ceil((high - origin) / TILE))];
  }

  private mark(rect: Rect, grow: number, delta: 1 | -1): void {
    const [ix0, ix1] = this.span(rect.x - rect.w / 2 - grow, rect.x + rect.w / 2 + grow, this.x0, this.nx);
    const [iz0, iz1] = this.span(rect.z - rect.d / 2 - grow, rect.z + rect.d / 2 + grow, this.z0, this.nz);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.cx(ix); const z = this.cz(iz);
        if (Math.abs(x - rect.x) < rect.w / 2 + grow && Math.abs(z - rect.z) < rect.d / 2 + grow) {
          this.count[this.index(ix, iz)] += delta;
        }
      }
    }
  }

  blockWall(wall: Wall): void {
    const onX = wall.axis === 'x';
    const [ix0, ix1] = onX
      ? this.span(wall.at - BODY, wall.at + BODY, this.x0, this.nx)
      : this.span(wall.from - BODY, wall.to + BODY, this.x0, this.nx);
    const [iz0, iz1] = onX
      ? this.span(wall.from - BODY, wall.to + BODY, this.z0, this.nz)
      : this.span(wall.at - BODY, wall.at + BODY, this.z0, this.nz);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.cx(ix); const z = this.cz(iz);
        const on = wall.axis === 'x' ? x : z;
        const along = wall.axis === 'x' ? z : x;
        if (Math.abs(on - wall.at) > BODY) continue;
        if (along < wall.from - BODY || along > wall.to + BODY) continue;
        // The doorway: the body has to fit between the jambs, or it is not a doorway.
        if (wall.gapWidth !== undefined && Math.abs(along - wall.gapCentre!) <= wall.gapWidth / 2 - BODY) continue;
        this.count[this.index(ix, iz)]++;
      }
    }
  }

  /** A prop you can walk over is not a blocker — the containment clamp uses the same 0.55 m sill. */
  private static blocks(prop: Prop): boolean { return prop.solid && prop.h >= 0.55; }

  blockProp(prop: Prop): void {
    if (Grid.blocks(prop)) this.mark({ x: prop.x, z: prop.z, w: prop.w, d: prop.d }, BODY, 1);
  }

  unblockProp(prop: Prop): void {
    if (Grid.blocks(prop)) this.mark({ x: prop.x, z: prop.z, w: prop.w, d: prop.d }, BODY, -1);
  }

  private cachedSeed?: number;

  /** Nearest open tile to a point, so a landing a centimetre inside a jamb still seeds the fill.
   *  Cached: the landing is the same point on every one of the ~25 fills a furnishing pass runs, and
   *  it is only ever re-searched if something has since been put down on top of it. */
  private seed(at: { x: number; z: number }): number | undefined {
    if (this.cachedSeed !== undefined && !this.count[this.cachedSeed]) return this.cachedSeed;
    let best: number | undefined; let bestDistance = Infinity;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const cell = this.index(ix, iz);
        if (this.count[cell]) continue;
        const distance = Math.hypot(this.cx(ix) - at.x, this.cz(iz) - at.z);
        if (distance < bestDistance) { bestDistance = distance; best = cell; }
      }
    }
    this.cachedSeed = best;
    return best;
  }

  flood(from: { x: number; z: number }): { walkable: number; reached: number } {
    let walkable = 0;
    for (const cell of this.count) if (!cell) walkable++;
    const start = this.seed(from);
    if (start === undefined) return { walkable, reached: 0 };
    const seen = new Uint8Array(this.nx * this.nz);
    const stack = [start];
    seen[start] = 1;
    let reached = 0;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      reached++;
      const ix = cell % this.nx; const iz = (cell - ix) / this.nx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const jx = ix + dx; const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const next = this.index(jx, jz);
        if (seen[next] || this.count[next]) continue;
        seen[next] = 1; stack.push(next);
      }
    }
    return { walkable, reached };
  }

  reaches(from: { x: number; z: number }): boolean {
    const { walkable, reached } = this.flood(from);
    return walkable === reached;
  }
}
