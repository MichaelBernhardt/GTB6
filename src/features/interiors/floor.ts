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
 * is 0 or the floor is a bug, and floor.test.ts asserts exactly that over hundreds of real floors.
 *
 * WHAT IS NOT SOLVED HERE, deliberately: nothing about the world. A floor plan does not know where
 * the building stands, how high off the ground it is, or which way it faces. That keeps this file
 * about rooms.
 */
import {
  buildCore, CEILING, coreRandom, CORE_GAP, CORRIDOR, floorRandom, MIN_ROOM, rectMaxX, rectMaxZ, rectMinX, rectMinZ,
  type BuildingCore, type BuildingFacts, type Finish, type Rect,
} from './core';
import { stableWorldFloat } from '../../world/StableRandom';

const q = stableWorldFloat;

export type RoomKind =
  | 'shop' | 'lounge' | 'bedroom' | 'kitchen' | 'office' | 'store' | 'lobby'
  | 'dining' | 'bathroom' | 'study' | 'warehouse' | 'mezzanine' | 'workshop';

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
  | 'stool' | 'stove' | 'basin' | 'bucket' | 'tv' | 'desk' | 'cabinet' | 'plant' | 'notice'
  | 'rack' | 'pallet' | 'drum' | 'bench' | 'rug' | 'bath' | 'trunk' | 'rail';

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

/**
 * The rooms either side of the spine, front to back — the rectangles first, then what each one IS.
 *
 * Splitting it that way is what lets the kind list be entered at a per-building offset (so two
 * neighbours do not both put the lounge in the front-left corner) WITHOUT losing the room the floor
 * is named after: once the rectangles are counted, the signature kind — `kinds[0]`, the lounge in a
 * house, the shop behind a shopfront — is dropped back into one of them if the rotation walked past
 * it. A house whose ground floor is a kitchen and a bedroom is not a house.
 */
function layoutRooms(core: BuildingCore, index: number, kinds: readonly RoomKind[], split: number, rotate: boolean): Room[] {
  const spineMin = core.corridorX - CORRIDOR / 2;
  const spineMax = core.corridorX + CORRIDOR / 2;
  const frontZ = -core.depth / 2;
  // The bands stop well short of the back wall: the core owns that end of the plate, full width, so
  // no room wall can ever stand across the mouth of the stair. See CORE_GAP.
  const backZ = rectMinZ(core.stair) - CORE_GAP;
  const bandDepth = backZ - frontZ;
  const slots: { id: string; rect: Rect; side: 'left' | 'right' }[] = [];
  for (const side of ['left', 'right'] as const) {
    const outer = side === 'left' ? core.width / 2 : -core.width / 2;
    const inner = side === 'left' ? spineMax : spineMin;
    const bandWidth = Math.abs(outer - inner);
    if (bandWidth < MIN_ROOM || bandDepth < MIN_ROOM) continue;
    // How many rooms fit down this band, from the floor's own hash. Bounded so no room is a cupboard.
    const most = Math.max(1, Math.floor(bandDepth / MIN_ROOM));
    const count = Math.max(1, Math.min(most, 1 + Math.floor(floorRandom(core.seed, index, side === 'left' ? 11 : 12) * split)));
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
      slots.push({ id: `${side}${i}`, side, rect: { x: q((outer + inner) / 2), z: q(z + d / 2), w: q(bandWidth), d } });
      z += d;
    }
  }
  const offset = rotate ? Math.floor(floorRandom(core.seed, index, 55) * kinds.length) % kinds.length : 0;
  const chosen = slots.map((_, i) => kinds[(i + offset) % kinds.length]!);
  if (!chosen.includes(kinds[0]!)) chosen[Math.floor(floorRandom(core.seed, index, 56) * chosen.length) % chosen.length] = kinds[0]!;
  return slots.map((slot, i) => ({
    id: slot.id, kind: chosen[i]!, name: roomName(chosen[i]!, core, index, i + 1), rect: slot.rect,
    // The doorway sits in the middle of the room's share of the spine wall, always reachable.
    doorZ: q(slot.rect.z),
    doorSide: slot.side,
  }));
}

function roomName(kind: RoomKind, core: BuildingCore, index: number, salt: number): string {
  if (kind === 'office') return `Office ${index}${String.fromCharCode(65 + (salt % 6))}`;
  if (kind === 'shop') return 'The shop floor';
  if (kind === 'lobby') return 'Lobby';
  if (kind === 'store') return 'Store room';
  if (kind === 'bedroom') return 'Bedroom';
  if (kind === 'kitchen') return 'Kitchen';
  if (kind === 'dining') return 'Dining room';
  if (kind === 'bathroom') return 'Bathroom';
  if (kind === 'study') return 'Study';
  if (kind === 'warehouse') return `Bay ${salt % 4 + 1}`;
  if (kind === 'mezzanine') return 'Mezzanine';
  if (kind === 'workshop') return 'Workshop';
  return WALL_NAMES[Math.floor(floorRandom(core.seed, index, 70 + salt) * WALL_NAMES.length) % WALL_NAMES.length] + ' lounge';
}

/** What one floor is: the rooms it can hold, what to call it, how many rooms a band may split into,
 *  and whether the kind list may be entered off its first entry. */
interface FloorGrammar {
  kinds: RoomKind[];
  eyebrow: string;
  blurb: string;
  findLine: string;
  /** Palette family — the finish then picks which of that family's palettes. */
  paint: 'shop' | 'flat' | 'office' | 'house' | 'works';
  /** Upper bound on rooms per band (the draw is 1 .. split, capped by how many actually fit). */
  split: number;
  rotate: boolean;
}

/**
 * WHAT SORT OF FLOOR THIS IS — and every family answers differently, because every family of
 * building now opens and a shed that generates a lounge is worse than a shed that stays shut.
 *
 * The ground floor is what the model's own entrance says it is: a shopfront has a spaza behind it, a
 * roller door has a warehouse bay, a porch has somebody's front room, a lobby has a lobby. What is
 * UPSTAIRS is then the family's own answer — flats over a shop, offices over a lobby, bedrooms over
 * a front room, and the works office on its mezzanine over the warehouse floor, which is where a
 * works office actually is.
 *
 * The finish (see core.ts) decides the rest: how many rooms the plate splits into, which palette,
 * and — in furnish() — what is in the room and what is missing from it.
 */
function floorKinds(core: BuildingCore, index: number): FloorGrammar {
  const { finish } = core;
  const split = finish === 'bare' ? 2 : finish === 'homely' ? 3 : 4;
  if (core.entrance === 'dock') return works(core, index);
  if (core.entrance === 'porch') return house(core, index, split);
  // A kerk, a masjid, a laerskool and a gemeenskapsaal come off the scatter pass, and behind all
  // four doors is the same thing: one big room somebody books, with an office and a store off it.
  // Sending them down the lobby branch would put a dead lift button and a tenants' directory in a
  // church, which is the "a shed that generates a lounge" failure with different furniture.
  if (core.family === 'civic') {
    return { kinds: ['lobby', 'store', 'office'], eyebrow: 'HALL', paint: 'house', split: 2, rotate: index % 2 === 1,
      blurb: 'Stacked plastic chairs, a tea urn, and a roster on the wall in two languages.',
      findLine: 'The tea money, in a biscuit tin.' };
  }
  if (index === 0) {
    if (core.entrance === 'shopfront') {
      return { kinds: ['shop', 'store'], eyebrow: 'SPAZA', paint: 'shop', split, rotate: false,
        blurb: 'Burglar bars, a cold fridge, and everything you actually need at 22:00.',
        findLine: 'Change on the counter — she waves it off.' };
    }
    // A block of flats and an office tower share a front door and share nothing else behind it: one
    // has a caretaker's flat and a store off the lobby, the other has let suites.
    if (core.family === 'dense-residential') {
      return { kinds: ['lobby', 'store', 'lounge'], eyebrow: 'LOBBY', paint: 'flat', split, rotate: true,
        blurb: 'A postbox wall half hanging off, a dead lift button, and levies pinned up since 2011.',
        findLine: 'Loose notes under the visitors book.' };
    }
    return { kinds: ['lobby', 'office'], eyebrow: 'LOBBY', paint: 'office', split, rotate: true,
      blurb: 'A security desk, a dead lift button, and a directory nobody has updated since 2011.',
      findLine: 'Loose notes under the visitors book.' };
  }
  if (core.entrance === 'lobby' && core.storeys >= OFFICE_FROM_STOREYS) {
    return { kinds: ['office', 'office', 'store'], eyebrow: 'OFFICES', paint: 'office', split, rotate: true,
      blurb: 'Half the suites are let, the other half have a phone still ringing in them.',
      findLine: 'Petty cash, in a tin marked PETTY CASH.' };
  }
  const spare = finish === 'bare';
  return {
    kinds: spare ? ['lounge', 'bedroom', 'kitchen'] : ['lounge', 'bedroom', 'kitchen', 'bathroom'],
    eyebrow: 'FLAT', paint: 'flat', split, rotate: true,
    blurb: spare
      ? 'Somebody is cooking, somebody is arguing, and the lift has not worked since you were born.'
      : 'Net curtains, a wall unit, and a burglar gate on a door nobody locks.',
    findLine: 'Coins in a jam tin on the sill.',
  };
}

/**
 * A HOUSE, and there are 1,138 of them: this is the family a player is most likely to walk up to, so
 * it is the one that most needs not to repeat. Three readable grades, and inside each the hash still
 * moves the room count, the kind order and the furniture.
 */
function house(core: BuildingCore, index: number, split: number): FloorGrammar {
  const upstairs = index > 0;
  if (core.family === 'estate') {
    return {
      kinds: upstairs ? ['bedroom', 'bathroom', 'study', 'bedroom'] : ['lounge', 'dining', 'kitchen', 'study'],
      eyebrow: upstairs ? 'UPSTAIRS' : 'HOUSE', paint: 'house', split, rotate: true,
      blurb: upstairs
        ? 'Carpet up the stairs, a linen cupboard, and an alarm panel blinking in the passage.'
        : 'Underfloor heating nobody switches on, and a beam that cost more than the car outside.',
      findLine: upstairs ? 'A roll of notes in the bedside drawer.' : 'Housekeeping money in the bowl by the door.',
    };
  }
  if (core.family === 'rural') {
    return {
      kinds: upstairs ? ['bedroom', 'store'] : ['kitchen', 'lounge', 'bedroom'],
      eyebrow: 'PLOT', paint: 'house', split: 2, rotate: true,
      blurb: 'A coal stove, a radio on the windowsill, and the nearest neighbour eleven kilometres off.',
      findLine: 'Notes folded into the tea caddy.',
    };
  }
  if (core.finish === 'bare') {
    return {
      kinds: upstairs ? ['bedroom', 'store'] : ['lounge', 'kitchen', 'bedroom'],
      eyebrow: 'HOUSE', paint: 'house', split: 2, rotate: true,
      blurb: 'One room doing four jobs, a paraffin stove, and a prepaid meter counting down.',
      findLine: 'Coins in a jam tin on the sill.',
    };
  }
  if (core.finish === 'smart') {
    return {
      kinds: upstairs ? ['bedroom', 'bathroom', 'study'] : ['lounge', 'dining', 'kitchen'],
      eyebrow: upstairs ? 'UPSTAIRS' : 'HOUSE', paint: 'house', split, rotate: true,
      blurb: upstairs
        ? 'Three doors off a landing and a geyser you can hear from all of them.'
        : 'Wooden floors, a pressed ceiling, and a bakkie key hook by the kitchen door.',
      findLine: 'A twenty under the fruit bowl.',
    };
  }
  return {
    kinds: upstairs ? ['bedroom', 'bathroom'] : ['lounge', 'kitchen', 'bedroom'],
    eyebrow: 'HOUSE', paint: 'house', split, rotate: true,
    blurb: 'A lounge suite in plastic, a display cabinet, and the kettle permanently on.',
    findLine: 'Change in the mug on the shelf.',
  };
}

/**
 * A WORKS. The owner is right that this is content and not a compromise: an empty floor plate with
 * racking down it and a roller door at the end of it is a room this city has never had. The plate is
 * clamped larger (MAX_HALL), the bands are ONE bay each rather than a run of rooms, and the storey
 * above the floor is the works office on its mezzanine.
 */
function works(core: BuildingCore, index: number): FloorGrammar {
  if (index === 0) {
    // The other side of the floor is another bay more often than not, and otherwise the fitting shop
    // or the goods store — which is what a works of this size actually has off its floor.
    const draw = floorRandom(core.seed, 0, 61);
    const mate: RoomKind = draw < 0.55 ? 'warehouse' : draw < 0.82 ? 'workshop' : 'store';
    return {
      kinds: ['warehouse', mate], eyebrow: 'WORKS', paint: 'works', split: 1, rotate: false,
      blurb: mate === 'workshop'
        ? 'Racking to the roof, a fitting shop off the floor, and a radio nobody has retuned since 1994.'
        : 'Racking to the roof, a forklift on charge, and a radio nobody has retuned since 1994.',
      findLine: 'Wage packet still in the pigeonhole.',
    };
  }
  return {
    kinds: ['mezzanine', 'office', 'workshop', 'store'], eyebrow: 'MEZZANINE', paint: 'works', split: 3, rotate: true,
    blurb: 'A works office over the floor, with a window onto it and a kettle furred solid.',
    findLine: 'Petty cash, in a tin marked PETTY CASH.',
  };
}

/** From this many storeys up, a lobby building is offices rather than flats. */
const OFFICE_FROM_STOREYS = 6;

/**
 * Palettes, by family and then by finish. Three per family so a street of houses is not one colour,
 * and the finish keeps them honest: bare is unpainted plaster and a bare screed, smart is a painted
 * wall over a wooden floor.
 */
const PALETTES: Record<string, Record<Finish, { wall: number; floor: number; ceiling: number; trim: number }>> = {
  shop: {
    bare: { wall: 0xd8c9a4, floor: 0x6d5a48, ceiling: 0xe6e2d8, trim: 0x2f3a3d },
    homely: { wall: 0xd8c9a4, floor: 0x6d5a48, ceiling: 0xe6e2d8, trim: 0x2f3a3d },
    smart: { wall: 0xe2d9bd, floor: 0x7b6650, ceiling: 0xeeeae0, trim: 0x2f3a3d },
  },
  flat: {
    bare: { wall: 0xbcb7a8, floor: 0x77706a, ceiling: 0xcac5ba, trim: 0x3a403e },
    homely: { wall: 0xc4c8c2, floor: 0x8a8378, ceiling: 0xd8d4cb, trim: 0x39413f },
    smart: { wall: 0xd5d8d0, floor: 0x94836a, ceiling: 0xe2e0d6, trim: 0x333b3a },
  },
  office: {
    bare: { wall: 0xaeb4b6, floor: 0x585e60, ceiling: 0xcdd2d3, trim: 0x2b3335 },
    homely: { wall: 0xb9c0c4, floor: 0x5f6668, ceiling: 0xdfe3e4, trim: 0x2b3335 },
    smart: { wall: 0xc7cfd2, floor: 0x6b5c48, ceiling: 0xe8ecec, trim: 0x25302f },
  },
  house: {
    bare: { wall: 0xb9ae99, floor: 0x8a8073, ceiling: 0xc6bcaa, trim: 0x4a4034 },
    homely: { wall: 0xcfc3a8, floor: 0x8b6b4a, ceiling: 0xded6c4, trim: 0x46392c },
    smart: { wall: 0xe0dbcb, floor: 0x9c7448, ceiling: 0xefebe0, trim: 0x3b3128 },
  },
  works: {
    bare: { wall: 0x9aa0a0, floor: 0x6e7272, ceiling: 0xb3b8b8, trim: 0x39423f },
    homely: { wall: 0xa4aaa8, floor: 0x74797a, ceiling: 0xbcc0bf, trim: 0x39423f },
    smart: { wall: 0xacb2b0, floor: 0x7b807f, ceiling: 0xc3c7c5, trim: 0x39423f },
  },
};

/**
 * WHAT COLOUR SOMEBODY PAINTED IT. The finish decides the floor, the ceiling and the trim; the wall
 * is the building's own choice, from its own hash, out of its family's range. It is the cheapest
 * variation in the file and the one a player reads first: the difference between walking into two
 * houses is largely the difference between a green passage and a cream one.
 */
const WALL_TINTS: Record<string, readonly number[]> = {
  shop: [0xd8c9a4, 0xcdd0bd, 0xdcc0a4, 0xc9cbc4],
  flat: [0xc4c8c2, 0xcfc9b8, 0xbcc4c8, 0xcdc4c4],
  office: [0xb9c0c4, 0xc4c4bc, 0xb4bec0, 0xc8c4b8],
  house: [0xcfc3a8, 0xc0cbbe, 0xd6c4bc, 0xbfc6cd, 0xd4cdb2, 0xc8bda6],
  works: [0x9aa0a0, 0xa2a09a, 0x99a2a6, 0xa6a2a0],
};

function paletteFor(paint: string, core: BuildingCore): { wall: number; floor: number; ceiling: number; trim: number } {
  const base = PALETTES[paint]![core.finish];
  const tints = WALL_TINTS[paint]!;
  return { ...base, wall: tints[Math.floor(coreRandom(core.seed, 33) * tints.length) % tints.length]! };
}

// ---- the solver ------------------------------------------------------------------------------

export function solveFloor(facts: BuildingFacts, index: number, core = buildCore(facts)): FloorPlan {
  const { kinds, eyebrow, blurb, findLine, paint, split, rotate } = floorKinds(core, index);
  const rooms = layoutRooms(core, index, kinds, split, rotate);
  const walls = buildWalls(core, rooms);

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
    palette: paletteFor(paint, core),
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

const FIXTURE_NAMES: Partial<Record<RoomKind, string>> = {
  shop: 'Shopkeeper', lobby: 'Security', warehouse: 'Storeman', lounge: 'Tenant', dining: 'Tenant',
};

function fixtureFor(core: BuildingCore, index: number, rooms: readonly Room[]): { x: number; z: number; name: string } | undefined {
  // One person per floor at most, and only where somebody would actually be standing.
  const host = rooms.find((room) => room.kind === 'shop') ?? rooms.find((room) => room.kind === 'lobby')
    ?? rooms.find((room) => room.kind === 'warehouse')
    ?? (floorRandom(core.seed, index, 91) < 0.55
      ? rooms.find((room) => room.kind === 'lounge') ?? rooms.find((room) => room.kind === 'dining')
      : undefined);
  if (!host) return undefined;
  return { x: q(host.rect.x), z: q(host.rect.z + host.rect.d * 0.22), name: FIXTURE_NAMES[host.kind] ?? 'Tenant' };
}

// ---- furniture --------------------------------------------------------------------------------

const STOCK = [0xd8563f, 0xe4a72c, 0x3f7fbf, 0x4f9d5a, 0xd9d2c2, 0x8b5a3c];

/** Rooms somebody lives or works in every day, and therefore rooms that accumulate one more thing. */
const LIVED_IN = new Set<RoomKind>(['lounge', 'bedroom', 'kitchen', 'dining', 'study', 'office']);

/** Everything this floor would LIKE to have, in a fixed order. The solver takes them one at a time
 *  and keeps only those that do not seal a doorway, so what comes back is both furnished and open. */
function furnish(core: BuildingCore, index: number, rooms: readonly Room[]): Prop[] {
  const out: Prop[] = [];
  const rnd = (salt: number): number => floorRandom(core.seed, index, salt);
  const pick = <T>(list: readonly T[], salt: number): T => list[Math.floor(rnd(salt) * list.length) % list.length]!;
  const bare = core.finish === 'bare';
  const smart = core.finish === 'smart';
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
        out.push(bare
          ? { shape: 'trunk', x: wallX(0.6), z: q(rectMinZ(rect) + 1.1), y: 0, w: 0.7, d: 1.3, h: 0.62, color: 0x5f4a34, solid: true }
          : { shape: 'wardrobe', x: wallX(0.5), z: q(rectMinZ(rect) + 1.1), y: 0, w: 0.6, d: 1.7, h: 2.3, color: 0x6a5340, solid: true });
        if (smart) {
          out.push({ shape: 'rug', x: q(rect.x), z: q(rect.z), y: 0, w: q(Math.min(2.6, rect.w - 3.4)), d: 1.8, h: 0.03, color: pick([0x6b4a3a, 0x3f5560], salt + 4), solid: false });
          out.push({ shape: 'cabinet', x: wallX(0.5), z: q(rectMaxZ(rect) - 1.1), y: 0, w: 0.5, d: 0.8, h: 0.7, color: 0x6d5236, solid: true });
        }
        break;
      }
      case 'kitchen': {
        out.push({ shape: 'stove', x: wallX(0.6), z: q(rect.z - 0.9), y: 0, w: 0.9, d: 0.7, h: 0.9, color: bare ? 0x6f6a5e : 0x3c4245, solid: true });
        out.push({ shape: 'basin', x: wallX(0.6), z: q(rect.z + 0.9), y: 0, w: 1.1, d: 0.7, h: 0.95, color: 0xb8bcbb, solid: true });
        if (!bare) out.push({ shape: 'fridge', x: wallX(0.7), z: q(rectMinZ(rect) + 1.3), y: 0, w: 0.9, d: 0.9, h: 1.7, color: 0xdfe6e4, solid: true });
        if (smart) out.push({ shape: 'table', x: q(rect.x), z: q(rectMaxZ(rect) - 1.6), y: 0, w: 1.3, d: 0.9, h: 0.76, color: 0x8a6a44, solid: true });
        for (let i = 0; i < (bare ? 4 : 2); i++) out.push({ shape: 'bucket', x: wallX(1.6), z: q(rectMaxZ(rect) - 1.0 - i * 0.6), y: 0, w: 0.42, d: 0.42, h: 0.46, color: pick([0x2f6fa8, 0xd8563f, 0x3f8a4c], salt + i), solid: false });
        break;
      }
      case 'lounge': {
        // The room the finish shows up in most: a plastic chair and a paraffin lamp, a lounge suite
        // in its wrapper, or a rug and a wall unit. Same room, three houses.
        out.push({ shape: 'sofa', x: wallX(1.2), z: q(rect.z), y: 0, w: 0.95, d: 2.2, h: 0.8, color: pick(bare ? [0x6f6a5e, 0x5f5a52, 0x77705f] : [0x6a5a4a, 0x4a5a63, 0x7a6a52], salt), solid: true });
        if (smart) out.push({ shape: 'rug', x: q(rect.x), z: q(rect.z), y: 0, w: q(Math.min(3.4, rect.w - 2.4)), d: q(Math.min(2.6, rect.d - 2.2)), h: 0.03, color: pick([0x8a4438, 0x3f5560, 0x6b5a34], salt + 2), solid: false });
        out.push(bare
          ? { shape: 'crate', x: q(rect.x), z: q(rect.z), y: 0, w: 0.85, d: 0.85, h: 0.5, color: 0xa07a4c, solid: false }
          : { shape: 'table', x: q(rect.x), z: q(rect.z), y: 0, w: 1.2, d: 0.9, h: 0.5, color: 0x9a7b52, solid: true });
        if (!bare) out.push({ shape: 'tv', x: q(outer - inward * (rect.w - 1.0)), z: q(rect.z), y: 0.75, w: 0.2, d: 1.2, h: 0.75, color: 0x1b1f22, solid: false });
        if (smart) out.push({ shape: 'cabinet', x: q(outer - inward * (rect.w - 0.5)), z: q(rectMinZ(rect) + 1.4), y: 0, w: 0.5, d: 1.6, h: 1.8, color: 0x6d5236, solid: true });
        for (let i = 0; i < (bare ? 3 : 2); i++) out.push({ shape: 'stool', x: q(rect.x + inward * 1.1), z: q(rect.z - 0.8 + i * (bare ? 1.05 : 1.6)), y: 0, w: 0.44, d: 0.44, h: 0.48, color: pick([0xd6d0c4, 0x2f4f4a, 0xb03a2e], salt + i), solid: false });
        if (bare) out.push({ shape: 'bucket', x: wallX(2.6), z: q(rectMaxZ(rect) - 0.9), y: 0, w: 0.42, d: 0.42, h: 0.46, color: 0x2f6fa8, solid: false });
        if (smart) out.push({ shape: 'plant', x: q(outer - inward * (rect.w - 0.7)), z: q(rectMaxZ(rect) - 0.9), y: 0, w: 0.8, d: 0.8, h: 1.6, color: 0x3f6a3a, solid: false });
        break;
      }
      case 'dining': {
        out.push({ shape: 'table', x: q(rect.x), z: q(rect.z), y: 0, w: q(Math.min(2.4, rect.w - 2.6)), d: 1.1, h: 0.76, color: 0x7a5636, solid: true });
        for (let i = 0; i < 4; i++) {
          out.push({ shape: 'stool', x: q(rect.x + (i < 2 ? -1 : 1) * 0.95), z: q(rect.z - 0.55 + (i % 2) * 1.1), y: 0, w: 0.46, d: 0.46, h: 0.5, color: 0x5b4630, solid: false });
        }
        out.push({ shape: 'cabinet', x: wallX(0.45), z: q(rect.z), y: 0, w: 0.55, d: q(Math.min(2.2, rect.d - 1.8)), h: 1.9, color: 0x6a4f34, solid: true });
        if (smart) out.push({ shape: 'plant', x: q(rect.x), z: q(rectMinZ(rect) + 0.9), y: 0, w: 0.8, d: 0.8, h: 1.5, color: 0x3f6a3a, solid: false });
        break;
      }
      case 'bathroom': {
        out.push({ shape: 'bath', x: wallX(1.0), z: q(rect.z), y: 0, w: 1.5, d: 2.0, h: 0.62, color: 0xe4e6e2, solid: true });
        out.push({ shape: 'basin', x: wallX(0.55), z: q(rectMinZ(rect) + 1.2), y: 0, w: 0.9, d: 0.6, h: 0.92, color: 0xd8dcdb, solid: true });
        if (bare) out.push({ shape: 'bucket', x: q(rect.x), z: q(rectMaxZ(rect) - 1.0), y: 0, w: 0.44, d: 0.44, h: 0.48, color: 0x3f8a4c, solid: false });
        break;
      }
      case 'study': {
        out.push({ shape: 'desk', x: wallX(1.3), z: q(rect.z - 0.5), y: 0, w: 1.7, d: 0.9, h: 0.74, color: 0x7c6446, solid: true });
        out.push({ shape: 'stool', x: wallX(2.5), z: q(rect.z - 0.5), y: 0, w: 0.5, d: 0.5, h: 0.48, color: 0x3a3430, solid: false });
        out.push({ shape: 'shelf', x: wallX(0.5), z: q(rectMaxZ(rect) - 1.5), y: 0, w: 0.5, d: q(Math.min(2.2, rect.d - 2.4)), h: 2.1, color: 0x8b5a3c, solid: false });
        break;
      }
      case 'warehouse': {
        // Racking down the outer wall with a real aisle behind it, pallets on the floor, drums in
        // the corner and a bench by the door. Anything that would close the aisle is refused by the
        // solver, so the bay is always walkable however the hash lays it out. Few LONG racks rather
        // than many short ones: at a metre a unit this bay was 700 boxes and forty flood fills, and
        // the solver pays a full fill for every solid piece it tries.
        const runs = rect.w > 9.5 ? [1.05, 4.2] : [1.05];
        let bay = 0;
        for (const inset of runs) {
          const count = Math.max(2, Math.min(4, Math.round(rect.d / 9)));
          const unit = q(Math.min(6.5, (rect.d - 2.4) / count - 0.9));
          for (let i = 0; i < count; i++) {
            out.push({
              shape: 'rack', x: wallX(inset), z: q(rectMinZ(rect) + 1.2 + unit / 2 + i * (rect.d - 2.4 - unit) / Math.max(1, count - 1)),
              y: 0, w: 1.4, d: unit, h: q(Math.min(3.6, CEILING - 1.2)), color: pick([0xb4622f, 0x3f6f9a, 0x8a8f92], salt + i + bay), solid: true,
            });
          }
          bay += 7;
        }
        for (let i = 0; i < 4; i++) {
          out.push({ shape: 'pallet', x: q(rect.x + inward * (0.4 + (i % 2) * 1.5)), z: q(rectMinZ(rect) + 1.6 + i * 1.4), y: 0, w: 1.2, d: 1.0, h: 0.18, color: 0x9c7b4c, solid: false });
        }
        for (let i = 0; i < 3; i++) {
          out.push({ shape: 'drum', x: q(outer - inward * (rect.w - 0.85)), z: q(rectMaxZ(rect) - 1.0 - i * 0.75), y: 0, w: 0.62, d: 0.62, h: 0.88, color: pick([0x2f6a4a, 0x8a3a2c, 0x2f4f7a], salt + i), solid: false });
        }
        out.push({ shape: 'bench', x: q(outer - inward * (rect.w - 1.1)), z: q(rectMinZ(rect) + 1.6), y: 0, w: 0.8, d: 2.2, h: 0.9, color: 0x5f6a6c, solid: true });
        out.push({ shape: 'notice', x: wallX(0.1), z: q(rect.z), y: 2.1, w: 0.05, d: 1.5, h: 0.9, color: 0xf2e6c8, solid: false, text: pick(['HARD HATS', 'NO SMOKING', 'BAY CLEAR'], salt + 5) });
        break;
      }
      case 'mezzanine': {
        // The lip onto the floor below, at knee height so it reads as a rail and never blocks a body.
        out.push({ shape: 'rail', x: q(outer - inward * (rect.w - 0.25)), z: q(rect.z), y: 0.5, w: 0.1, d: q(rect.d - 1.2), h: 0.55, color: 0x39423f, solid: false });
        for (let i = 0; i < 3; i++) {
          out.push({ shape: 'crate', x: wallX(0.9), z: q(rectMinZ(rect) + 1.2 + i * 1.5), y: q(i === 1 ? 0.62 : 0), w: 1.0, d: 1.0, h: 0.62, color: pick([0xc8452f, 0x2f6fa8, 0x3f8a4c], salt + i), solid: false });
        }
        out.push({ shape: 'desk', x: q(rect.x), z: q(rectMaxZ(rect) - 1.4), y: 0, w: 1.7, d: 0.9, h: 0.74, color: 0x7a6a52, solid: true });
        break;
      }
      case 'workshop': {
        out.push({ shape: 'bench', x: wallX(0.9), z: q(rect.z), y: 0, w: 0.9, d: q(Math.min(3.2, rect.d - 1.6)), h: 0.92, color: 0x5f6a6c, solid: true });
        out.push({ shape: 'shelf', x: wallX(0.4), z: q(rectMinZ(rect) + 1.2), y: 0, w: 0.45, d: 1.6, h: 2.2, color: 0x6f6a5e, solid: false });
        for (let i = 0; i < 2; i++) out.push({ shape: 'drum', x: q(rect.x + inward * 0.8), z: q(rectMaxZ(rect) - 1.1 - i * 0.8), y: 0, w: 0.62, d: 0.62, h: 0.88, color: pick([0x8a3a2c, 0x2f4f7a], salt + i), solid: false });
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
    // ONE THING THAT IS ONLY IN THIS ROOM, in this building. Every room of a kind is otherwise laid
    // out the same way, and the owner's test is walking into two of them and telling them apart —
    // so each lived-in room draws one extra piece, or none, from its own slot in the hash.
    if (LIVED_IN.has(room.kind)) {
      const extra = Math.floor(rnd(salt + 13) * (smart ? 5 : bare ? 3 : 4));
      const backZ = q(rectMaxZ(rect) - 1.2);
      if (extra === 1) out.push({ shape: 'shelf', x: wallX(0.45), z: backZ, y: 0, w: 0.45, d: 1.4, h: 2.0, color: 0x7a6144, solid: false });
      else if (extra === 2) out.push({ shape: 'trunk', x: q(rect.x + inward * 1.3), z: backZ, y: 0, w: 0.8, d: 1.2, h: 0.55, color: pick([0x5f4a34, 0x46505a, 0x6a5f4a], salt + 14), solid: false });
      else if (extra === 3) out.push({ shape: 'plant', x: q(outer - inward * (rect.w - 0.75)), z: backZ, y: 0, w: 0.75, d: 0.75, h: 1.35, color: 0x3f6a3a, solid: false });
      else if (extra === 4) out.push({ shape: 'rug', x: q(rect.x), z: q(rect.z + 0.4), y: 0, w: q(Math.min(2.8, rect.w - 2.8)), d: 1.7, h: 0.03, color: pick([0x7a4638, 0x3f5560, 0x6b5a34], salt + 15), solid: false });
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
