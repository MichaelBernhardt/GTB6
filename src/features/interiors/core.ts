/**
 * THE CORE: the one thing about a building's interior that is decided ONCE and is then true on every
 * storey — the stair shaft, the lift shaft, the floor plate they sit in, and how many floors there
 * are. Pure data, no three.js, so the whole thing is unit-testable.
 *
 * WHY THIS IS A SEPARATE TIER FROM THE FLOORS. A tower generated floor by floor has one classic
 * tell: a stair that does not land on the floor below. You can chase that with an alignment pass, or
 * you can make it impossible — put the shaft in the shared core, generated once from the building's
 * own hash, and hand it to every floor as an immovable given. The floors then arrange themselves
 * AROUND it and the alignment problem does not exist rather than being solved. It also means
 * generation cost does not scale with height: Ponte's core is one object whatever its storey count,
 * and only the storey you are standing on is ever built.
 *
 * SEEDING. Everything here comes from `buildingSeed`, which hashes the building's own properties —
 * its position, its footprint, its height, its structural family. The same building is therefore the
 * same building next time, this session and next, and nothing depends on visit order, wall clock or
 * Math.random. Per-floor choices then hash (buildingSeed, floorIndex), so floor 31 is the same floor
 * 31 next week without floor 30 ever having been generated.
 */
import type { EntranceKind } from '../../world/BuildingArchitecture';
import { stablePositionRandom, stableWorldFloat } from '../../world/StableRandom';

/**
 * ROOMS ARE OVERSIZED, AND THE CAMERA IS THE REASON.
 *
 * CameraController sits the camera at the player's eye plus sin(pitch)·boom, and on foot that is a
 * 0.35 rad pitch on a 9.5 unit boom — 4.7 units ABOVE the floor the player is standing on, with no
 * way for a feature to shorten either. A room with a real 3 m ceiling therefore has the camera above
 * its ceiling in literally every frame, which is the doll's-house shot the last attempt shipped.
 *
 * So the clear height is set to hold the camera instead: 5.2 units, with the slab making it 5.7
 * floor to floor. It is a tall room. Every interior in every game of this shape is, for exactly this
 * reason. The inside-out shell is still there as the fallback for the frames where the player is
 * halfway up a flight and the camera does clear the ceiling.
 */
export const STOREY_HEIGHT = 5.7;
/** Interior clear height inside one storey (the rest is slab). Must exceed 1.45 + sin(0.35)·9.5. */
export const CEILING = 5.2;

/**
 * How tall a storey is ON THE FACADE — which is a different number, and deliberately so.
 *
 * How many floors a building HAS is a fact about the building the player is looking at: count the
 * bands of windows. Counting them at the interior's inflated 5.7 would give a twenty-storey tower
 * eleven floors, and the player can see that is wrong from the street. So the count comes from a
 * real storey, and only the STACKING of the interiors uses the oversized one — which nobody can see,
 * because the interiors stand above the roof.
 */
export const FACADE_STOREY = 3.5;
/** From this many storeys up, the building gets a lift as well as a stair. Below it, a stair is
 *  honestly the way people get about; above it, nobody is walking to floor 40. */
export const LIFT_FROM_STOREYS = 6;

/** Width of the spine corridor that runs from the street door to the core. */
export const CORRIDOR = 3.3;
/** No room narrower than this on either axis: the camera boom is 9.5 u and a feature cannot shorten
 *  it, so a room the player cannot be SEEN in is not a room. See interiors.ts for the rest of that. */
export const MIN_ROOM = 5.6;

/**
 * Clear space between the deepest room and the mouth of the stair. The core band at the back of the
 * plate is FULL WIDTH — the room bands stop short of it — so the stair and the lift can be wider than
 * the spine without a room wall ever standing across a flight. This gap is what keeps the two apart:
 * a wall's blocking footprint reaches a player-radius beyond its end, and a flight lane that grazes
 * one is a stair you cannot walk down. It cost a debugging session to find, so it is a named
 * constant with a reason attached rather than a 0.2 somebody will helpfully tidy away.
 *
 * WHY 2.2 AND NOT THE 1.4 IT USED TO BE. The stair's divider wall starts at the shaft mouth, and its
 * blocking footprint (±0.73 in x) used to sit wholly inside the corridor, clear of the room walls'
 * own footprints (inner edge ±0.9 around the spine). Now that the shaft stands seeded OFF the spine,
 * those two bands can overlap in x — and at 1.4 the z gap between a room wall's end and the divider's
 * start was 1.4 − 2·(body 0.65) = 0.1: a sealed corner the axis-separated clamp deadlocks in, found
 * by the QA climber the first time a stair drew an offset. 2.2 leaves a 0.9 walk channel across the
 * whole plate in front of the shaft mouth, at every offset the placement window allows.
 */
export const CORE_GAP = 2.2;

/**
 * THE PLATE COMES FROM THE MODEL NOW — the owner's rule, after two rounds of "some are still too
 * large": the interior is the building's ACTUAL footprint times a bounded Tardis factor, PRESERVING
 * ASPECT, so a long thin building gets a long thin interior and a shack stops wearing a 15 × 21
 * hall. The old MIN_PLATE clamp [15.1, 21] inflated every small building to the same rectangle —
 * measured plate/footprint depth ratio median 1.12, p90 1.97, max 4.48 citywide.
 *
 * The factor is the SMALLEST one that makes the interior usable, never a flat bonus: 1.0 for every
 * building that already fits its own grammar (most of the city), rising only as far as the grammar
 * floors below demand. TARDIS_MAX bounds it for single-storey buildings; smaller than that and the
 * building gets an honest SMALL layout (one room, door straight in — see buildCore) instead of
 * inflation. Multi-storey buildings are the one stated exception: a stair plus a corridor is a hard
 * floor ("a hard floor only where an interior stops being usable"), so a narrow three-storey sliver
 * exceeds the bound rather than losing its stair — the audit counts exactly how many do.
 */
export const TARDIS_MAX = 1.4;
/** The full corridor grammar's true minimum width: the spine plus a MIN_ROOM band each side. This
 *  is the relation coreContinuity asserts, so the two cannot drift apart and quietly produce a
 *  floor with no rooms on it. */
export const FULL_MIN_WIDTH = CORRIDOR + 2 * MIN_ROOM + 0.6;
/** Minimum stairless full-grammar depth: one MIN_ROOM band plus the doorway margin. The old 21 was
 *  anti-repetition padding — variety now comes from real footprints, not from a shared clamp. */
export const FLAT_MIN_DEPTH = MIN_ROOM + 0.8;
/** Minimum STAIRED depth: a MIN_ROOM band in front of the core, CORE_GAP, the shaft itself
 *  (0.32 × depth, so solve 0.68 d ≥ 5.6 + 2.2 + 0.3 ⇒ d ≥ 11.9) and the minimum back gap. */
export const STAIR_MIN_DEPTH = 12;
/** The honest small layout's floor: one room the camera can stand in. Never relaxed — this is the
 *  9.5 u boom constraint, not taste. */
export const SMALL_MIN = MIN_ROOM;
export const MAX_PLATE: readonly [number, number] = [30, 34];
/** A works gets a bigger ceiling than a flat: the point of a warehouse is the floor plate, and a
 *  30 × 34 shed with racking down it reads as a shop storeroom rather than a hall. Not larger than
 *  this: solveFloor flood-fills the plate once per solid prop, and the cost is the tile count. */
export const MAX_HALL: readonly [number, number] = [36, 40];

/** An axis-aligned rectangle in floor-local space: origin at the plate centre, +z deeper into the
 *  building (away from the street), +x to your left as you walk in. */
export interface Rect { readonly x: number; readonly z: number; readonly w: number; readonly d: number }

export const rectMinX = (r: Rect): number => r.x - r.w / 2;
export const rectMaxX = (r: Rect): number => r.x + r.w / 2;
export const rectMinZ = (r: Rect): number => r.z - r.d / 2;
export const rectMaxZ = (r: Rect): number => r.z + r.d / 2;
export const rectHas = (r: Rect, x: number, z: number): boolean =>
  x >= rectMinX(r) && x <= rectMaxX(r) && z >= rectMinZ(r) && z <= rectMaxZ(r);

/** What the building is, as far as an interior is concerned. Everything here is read off the parcel
 *  and the architecture's own entrance tag — nothing is typed in. */
export interface BuildingFacts {
  /** Stable id: the building's rounded footprint centre. Survives a rebake of anything but the map. */
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly style: string;
  readonly entrance: EntranceKind;
  /** Building-local x of the tagged entrance — where the model actually drew its door along the
   *  front wall. The spine corridor anchors here, so walking in through an off-centre door puts you
   *  in a corridor that is off-centre by the same relative amount. See buildCore. */
  readonly doorX: number;
}

/**
 * HOW WELL-KEPT THE INSIDE IS — the axis that stops two houses on one street reading alike.
 *
 * The owner's test is walking up to buildings at random, so the thing that has to vary is what you
 * find when you do. Family alone does not do it: `suburban` is a third of this city's parcels and
 * covers a two-room township house, a Melville semi and a Northcliff double-storey. So every
 * building also carries a finish, drawn from its own hash and its own footprint, and the grammar
 * reads it for palette, room count, what furniture is in the room and what is conspicuously missing.
 */
export type Finish = 'bare' | 'homely' | 'smart';

/**
 * WHERE THE STAIR STANDS — the owner's generation order honoured at last: perimeter → door →
 * STAIR → lift → rooms. The stair is decided before any room exists, so the rooms form AROUND it,
 * which is what lets it go almost anywhere. The class is the FIRST thing the seed buys (before the
 * position within the class), so the citywide histogram is multi-modal rather than one smeared
 * blob around the corridor — which is exactly what round 2 shipped and the owner read as samey.
 *
 *  - back:  the shaft in a full-width band at the back wall (round 2's only shape) — but its x now
 *           runs the whole plate, corridor overlap no longer required.
 *  - mid:   an island core in the middle of the plate, rooms in front of it AND behind it.
 *  - side:  the shaft hard against a side wall, anywhere along the depth.
 *  - front: the shaft right beside the entry, behind a short vestibule, all rooms behind it.
 */
export type StairClass = 'back' | 'mid' | 'side' | 'front';

/** Which grammar the interior runs. 'full' is the corridor plan; 'small' is the honest one-room
 *  layout for buildings that cannot host the corridor within the Tardis bound — door straight in,
 *  no corridor, no partitions, and no pretence. */
export type LayoutKind = 'full' | 'small';

export interface BuildingCore {
  readonly id: string;
  readonly seed: number;
  /** How many storeys this building actually has, from the height the bake gave it. */
  readonly storeys: number;
  /** Interior clear plate. */
  readonly width: number;
  readonly depth: number;
  /** Which grammar this interior runs — see LayoutKind. */
  readonly layout: LayoutKind;
  /** The spine corridor: full depth, anchored on the model's own tagged door (see buildCore). On a
   *  small layout there is no corridor; this simply holds entryX so every reader keeps working. */
  readonly corridorX: number;
  /** The stair shaft — identical on every storey by construction, and ABSENT on a single-storey
   *  building, which has nowhere for a stair to go. 2,766 of this city's 7,415 enterable buildings
   *  are single-storey; every one of them used to carry a full dead shaft. */
  readonly stair?: Rect;
  /** The seeded position class the stair was drawn from. Present exactly when `stair` is. */
  readonly stairClass?: StairClass;
  /** Which side the up-flight of the switchback is on: +1 the +x half rises from this storey, −1
   *  mirrored. Seeded per building, so two stairwells do not all turn the same way. */
  readonly stairDir: 1 | -1;
  /** The lift shaft, on tall buildings only. Also identical on every storey. */
  readonly lift?: Rect;
  /** Where the street door lands on the front wall (floor 0 only), in plate-local x. */
  readonly entryX: number;
  readonly entrance: EntranceKind;
  /** The structural family the parcel was zoned as — what sort of building this is. */
  readonly family: string;
  /** How well-kept it is. See Finish. */
  readonly finish: Finish;
}

/** Where the FRONT room segment stops and the core band begins. Stairless buildings have no core
 *  band, so the rooms run all the way to the back wall — ~7 units of plate a dead shaft used to
 *  waste. Every reader of "how deep may a room be in front of the core" goes through this helper. */
export function coreFrontZ(core: Pick<BuildingCore, 'stair' | 'depth'>): number {
  return core.stair ? rectMinZ(core.stair) - CORE_GAP : core.depth / 2;
}

/** Where the room segment BEHIND the core starts, or undefined when there is no such segment —
 *  either because the shaft stands at the back wall (the classic back class) or because what is
 *  left behind it cannot hold a room. The mid and front stair classes exist because this can now
 *  answer: rooms form around the island core, band behind included. floor.ts and coreContinuity
 *  both read this one helper, so the rooms and the reachability proof cannot disagree. */
export function coreBackZ(core: Pick<BuildingCore, 'stair' | 'depth'>): number | undefined {
  if (!core.stair) return undefined;
  const start = rectMaxZ(core.stair) + CORE_GAP;
  return core.depth / 2 - start >= MIN_ROOM ? start : undefined;
}

/** Families whose flat roofs are part of the game: stand on them, drop in through them, climb out
 *  onto them. Houses keep their pitched roofs to themselves. */
const ROOF_FAMILIES = new Set(['downtown', 'mixed-use', 'industrial']);

/** Whether this building's top stair opens onto its roof: commercial/industrial only, and taller
 *  than two storeys — the owner's line, measured at 2,143 of 7,415 doors citywide. */
export function hasRoofAccess(core: Pick<BuildingCore, 'storeys' | 'family'>): boolean {
  return core.storeys > 2 && ROOF_FAMILIES.has(core.family);
}

/** Where the roof ladder stands: the foot of the shaft on the up side, which is exactly where the
 *  up-flight would have started if there were another storey to climb to. */
export function hatchFoot(stair: Rect, dir: 1 | -1): { x: number; z: number } {
  return { x: stair.x + dir * stair.w / 4, z: rectMinZ(stair) + 0.7 };
}

/**
 * The finish, from the building itself.
 *
 * Some families answer outright: an estate villa is smart, a works and a farm cottage are bare, a
 * tower is smart unless its own hash says otherwise. The families that cover the whole city — houses
 * and flats — take a weighted draw where the building's FOOTPRINT counts for a third: a small house
 * on a low draw is a two-room place with a paraffin stove, a big one on a high draw is a semi with a
 * sofa suite. Suburban footprints run 316 / 747 / 1085 m² at the tenth, half and ninetieth
 * percentile, which is what the 1100 normalises against.
 */
export function finishFor(facts: BuildingFacts, seed: number): Finish {
  if (facts.style === 'estate') return 'smart';
  if (facts.style === 'industrial' || facts.style === 'rural') return 'bare';
  const draw = coreRandom(seed, 21);
  if (facts.style === 'downtown') return draw < 0.22 ? 'homely' : 'smart';
  const size = Math.min(1, (facts.width * facts.depth) / 1100);
  const score = draw * 0.64 + size * 0.36;
  return score < 0.36 ? 'bare' : score < 0.74 ? 'homely' : 'smart';
}

/**
 * The building's own hash. Position dominates (two buildings never share a footprint centre); the
 * footprint, height and family are folded in so a building that CHANGES becomes a different building
 * rather than silently keeping a plan that no longer fits it.
 */
export function buildingSeed(facts: BuildingFacts): number {
  const shape = stablePositionRandom(facts.width, facts.depth, facts.style.length);
  const mass = stablePositionRandom(facts.height, shape * 1000, 17);
  return Math.floor(stablePositionRandom(facts.x, facts.z, Math.floor(mass * 4093)) * 0x7fffffff);
}

/** Stable 0..1 draw for a building-level choice. */
export function coreRandom(seed: number, salt: number): number {
  return stablePositionRandom(seed, salt, 0x5eed);
}

/** Stable 0..1 draw for a choice on ONE floor: hash(building, floor, salt). This is what makes a
 *  floor deterministic without any other floor ever having existed. */
export function floorRandom(seed: number, floor: number, salt: number): number {
  return stablePositionRandom(seed + floor * 7919, salt, 0x1f1002);
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** How much clear z the entry needs in front of anything solid: the exit mat (1.7 in) plus a
 *  stride. The front stair class parks the shaft exactly this far in; coreContinuity asserts no
 *  class ever parks it closer. */
export const ENTRY_KEEP = 3.2;
/** Clear channel kept between an island core and the spine, so the corridor stays a corridor all
 *  the way past the stair to the rooms behind it. */
const SPINE_CLEAR = 0.7;

/**
 * The core, from the building and nothing else — and this is where the owner's ordered brief is
 * actually consumed: perimeter (the plate, FROM THE FOOTPRINT now), then the DOOR from the model's
 * own tag, then the stair — position CLASS first, then the position within it — then the lift,
 * each spending the building's hash so the skeleton varies as well as the paint.
 *
 * Round 1 derived everything in closed form: one skeleton, 7,415 times. Round 2 seeded the stair
 * within ±2.8 of the corridor in the back band — which the owner still read as samey, because it
 * IS: every stair was a back-band stair near the spine. Round 3 spends the seed on the position
 * class before anything else, so back / mid / side / front are different SHAPES of building, not
 * different millimetres.
 */
export function buildCore(facts: BuildingFacts): BuildingCore {
  const seed = buildingSeed(facts);
  // Storeys from the height the bake actually generated, never a guess, counted at a real facade
  // storey so the number matches the bands of windows the player counted from the street. A 6 m
  // cottage is one storey; whatever the tallest thing in the CBD turns out to be gets exactly as
  // many floors as it is tall.
  const storeys = Math.max(1, Math.floor((facts.height - 0.4) / FACADE_STOREY));

  // 1. PERIMETER — from the building's ACTUAL footprint (less the walls), times the smallest Tardis
  // factor that reaches the grammar floors, SAME factor on both axes so the aspect survives. The
  // per-axis ceilings still stop a warehouse floor being a stadium; they are the one place aspect
  // can still shear, and only on buildings already at the cap.
  const ceiling = facts.entrance === 'dock' ? MAX_HALL : MAX_PLATE;
  const bareW = Math.max(1, facts.width - 0.9);
  const bareD = Math.max(1, facts.depth - 0.9);
  const small = storeys === 1
    && (bareW * TARDIS_MAX < FULL_MIN_WIDTH || bareD * TARDIS_MAX < FLAT_MIN_DEPTH);
  if (small) {
    // THE HONEST SMALL LAYOUT: one room, door straight in. The only floor is the camera's — a room
    // the 9.5 u boom cannot stand in is not a room — so the factor here can exceed TARDIS_MAX on a
    // genuine shack, but the result is a 6 u room, not a 15 × 21 hall.
    const factor = Math.max(1, SMALL_MIN / bareW, SMALL_MIN / bareD);
    const width = stableWorldFloat(Math.min(bareW * factor, ceiling[0]));
    const depth = stableWorldFloat(Math.min(bareD * factor, ceiling[1]));
    const entryX = stableWorldFloat(clamp(
      -facts.doorX * (width / Math.max(1, facts.width)), -(width / 2 - 1.55), width / 2 - 1.55));
    return {
      id: facts.id, seed, storeys, width, depth, layout: 'small',
      corridorX: entryX, entryX,
      stairDir: coreRandom(seed, 6) < 0.5 ? 1 : -1,
      entrance: facts.entrance, family: facts.style, finish: finishFor(facts, seed),
    };
  }
  // The full grammar's floors. Single-storey buildings reached here inside the Tardis bound (the
  // small cutoff above is exactly that test); multi-storey buildings take the floor even past the
  // bound, because a stair plus a corridor is where an interior stops being usable — the audit
  // counts how many pay it.
  const depthFloor = storeys >= 2 ? STAIR_MIN_DEPTH : FLAT_MIN_DEPTH;
  const factor = Math.max(1, FULL_MIN_WIDTH / bareW, depthFloor / bareD);
  const width = stableWorldFloat(Math.min(bareW * factor, ceiling[0]));
  const depth = stableWorldFloat(Math.min(bareD * factor, ceiling[1]));

  // 2. THE DOOR. The spine is anchored where the model actually drew its entrance: the interior
  // frame is the building frame rotated a half turn (hence the sign flip), the plate may be scaled
  // off the footprint (hence the proportional map — which stays exact as the two converge), and
  // the corridor still leaves a room-sized band on both sides (hence the clamp). 2,835 of this
  // city's tagged doors sit genuinely off the facade centre, so this one line buys 2,835
  // off-centre corridors for free.
  const slack = Math.max(0, width / 2 - CORRIDOR / 2 - MIN_ROOM);
  const doorScale = width / Math.max(1, facts.width);
  const corridorX = stableWorldFloat(clamp(-facts.doorX * doorScale, -slack, slack));

  // 3. THE STAIR — only where there is a storey for it to reach, class first, then the spot.
  // 4. THE LIFT, on tall buildings, beside the stair on a seeded side.
  const placed = storeys >= 2
    ? placeShafts(seed, width, depth, corridorX, storeys >= LIFT_FROM_STOREYS)
    : undefined;

  return {
    id: facts.id, seed, storeys, width, depth, layout: 'full', corridorX,
    stair: placed?.stair,
    stairClass: placed?.stairClass,
    stairDir: coreRandom(seed, 6) < 0.5 ? 1 : -1,
    lift: placed?.lift,
    // The street door lands on the spine, so walking in puts you in the corridor facing the core.
    entryX: corridorX,
    entrance: facts.entrance,
    family: facts.style,
    finish: finishFor(facts, seed),
  };
}

const LIFT_W = 2.4;

/**
 * Stair (and lift) placement: the position CLASS is drawn first, from the classes that genuinely
 * fit this plate, and only then the position within the class — so the entropy lands where the eye
 * can see it. Kept out of buildCore so the fitting rules read in one place:
 *
 *  - Every class keeps the shaft on the plate and at least ENTRY_KEEP off the front wall.
 *  - A class with rooms BEHIND the core (mid, front, and side when depth allows) must leave the
 *    spine clear beside the shaft-plus-lift block, or the corridor to those rooms is a lie —
 *    coreContinuity asserts exactly this, and the flood fill proves it per floor.
 *  - The back class is the universal fallback: it fits every plate the grammar admits, which is
 *    what lets the others refuse honestly instead of squeezing.
 */
function placeShafts(
  seed: number, width: number, depth: number, corridorX: number, needsLift: boolean,
): { stair: Rect; lift?: Rect; stairClass: StairClass } {
  const stairW = stableWorldFloat(CORRIDOR + 1.0);
  const shaftD = stableWorldFloat(Math.min(depth * 0.32, 5.4));
  const plateLimit = width / 2 - stairW / 2 - 0.2;
  // The whole block the plate has to host: the shaft, plus the lift stuck to its side on lifted
  // buildings. `blockW` is its full width; the lift adds to ONE side, chosen later.
  const blockW = needsLift ? stairW + 0.3 + LIFT_W : stairW;
  // Room left beside the spine on each side, for classes that must not block the corridor.
  const sideRoom = (side: 1 | -1): number =>
    side === 1 ? width / 2 - 0.2 - (corridorX + CORRIDOR / 2 + SPINE_CLEAR)
      : (corridorX - CORRIDOR / 2 - SPINE_CLEAR) - (-width / 2 + 0.2);
  const fitsAside = Math.max(sideRoom(1), sideRoom(-1)) >= blockW;
  // z windows. mid needs a MIN_ROOM band plus CORE_GAP on BOTH sides of the shaft; front needs the
  // vestibule in front and a room band behind; side spans the widest honest range.
  const zMin = -depth / 2 + ENTRY_KEEP + shaftD / 2;                        // front-most any class allows
  const zMidLo = -depth / 2 + MIN_ROOM + CORE_GAP + shaftD / 2;
  const zMidHi = depth / 2 - MIN_ROOM - CORE_GAP - shaftD / 2;
  const zBackRoom = depth / 2 - MIN_ROOM - CORE_GAP - shaftD / 2;           // rear-most with rooms behind
  const zBack = depth / 2 - shaftD / 2 - 0.3;                               // hard against the back wall
  // A back-wall shaft's seeded rear gap may only grow while the FRONT room band keeps MIN_ROOM —
  // on the minimum staired plate that pins the gap near 0.3; deeper plates get the full 1.2 play.
  // (STAIR_MIN_DEPTH is derived at gap 0.3, so this is what keeps the derivation honest.)
  const gapPlay = Math.max(0, Math.min(1.2, depth - shaftD - CORE_GAP - MIN_ROOM - 0.3));

  // WHICH CLASSES FIT. Weights are the design intent — back stays the commonest because most real
  // buildings do put the stair at the back — and the seeded draw walks the fitting subset.
  const candidates: { name: StairClass; weight: number; fits: boolean }[] = [
    { name: 'back', weight: 0.34, fits: true },
    { name: 'mid', weight: 0.28, fits: fitsAside && zMidHi - zMidLo > 0.5 },
    { name: 'side', weight: 0.22, fits: fitsAside },
    { name: 'front', weight: 0.16, fits: fitsAside && zBackRoom >= zMin },
  ];
  const fitting = candidates.filter((entry) => entry.fits);
  const total = fitting.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = coreRandom(seed, 50) * total;
  let stairClass: StairClass = 'back';
  for (const entry of fitting) {
    roll -= entry.weight;
    if (roll <= 0) { stairClass = entry.name; break; }
  }

  // THE SIDE the block stands on, for the classes that must clear the spine: seeded, flipped when
  // the seeded side cannot host the block. (fitsAside guaranteed at least one side can.)
  let side: 1 | -1 = coreRandom(seed, 53) < 0.5 ? 1 : -1;
  if (stairClass !== 'back' && sideRoom(side) < blockW) side = side === 1 ? -1 : 1;
  const liftSpan = stairW / 2 + 0.3 + LIFT_W;    // stair centre -> lift outer edge

  /** The x window for a clear-the-spine stair on `side`, RESERVING the lift's room up front: the
   *  lift goes outboard (toward the wall) when the window can afford it — a lobby reads
   *  stair-then-lift from the corridor — and inboard otherwise, with the whole block still clear
   *  of the spine either way. fitsAside proved the block fits, so the window is never empty. */
  const asideWindow = (): { xLo: number; xHi: number; liftSide: 1 | -1 } => {
    const spineEdge = side === 1 ? corridorX + CORRIDOR / 2 + SPINE_CLEAR : corridorX - CORRIDOR / 2 - SPINE_CLEAR;
    const wallEdge = side * (width / 2 - 0.2);
    if (!needsLift) {
      const a = spineEdge + side * stairW / 2; const b = wallEdge - side * stairW / 2;
      return { xLo: Math.min(a, b), xHi: Math.max(a, b), liftSide: side };
    }
    const outA = spineEdge + side * stairW / 2; const outB = wallEdge - side * liftSpan;
    if ((outB - outA) * side >= 0) return { xLo: Math.min(outA, outB), xHi: Math.max(outA, outB), liftSide: side };
    const inA = spineEdge + side * (LIFT_W + 0.3 + stairW / 2); const inB = wallEdge - side * stairW / 2;
    return { xLo: Math.min(inA, inB), xHi: Math.max(inA, inB), liftSide: side === 1 ? -1 : 1 };
  };

  let stairX: number;
  let backZ: number;
  let liftSide: 1 | -1 = coreRandom(seed, 7) < 0.5 ? 1 : -1;
  if (stairClass === 'back') {
    // The round-2 shape, x UNCHAINED: the shaft may stand anywhere across the plate — the band at
    // the back is full width and open, so the corridor no longer needs to share a mouth with it.
    backZ = stableWorldFloat(depth / 2 - shaftD / 2 - (0.3 + coreRandom(seed, 5) * gapPlay));
    stairX = clamp((coreRandom(seed, 52) * 2 - 1) * plateLimit, -plateLimit, plateLimit);
    if (needsLift) {
      // The old fitting rules, minus the spine chain: seeded side, flip to fit, pull the shaft
      // toward the roomier side in the last resort — which fits everywhere the old layout fitted.
      const limit = width / 2 - 0.2;
      if (Math.abs(stairX + liftSide * liftSpan) > limit) liftSide = liftSide === 1 ? -1 : 1;
      if (Math.abs(stairX + liftSide * liftSpan) > limit) {
        liftSide = stairX > 0 ? -1 : 1;
        stairX = clamp(liftSide === 1 ? limit - liftSpan : -limit + liftSpan, -plateLimit, plateLimit);
      }
    }
  } else {
    const window = asideWindow();
    liftSide = window.liftSide;
    if (stairClass === 'side') {
      // Hard against the seeded wall — as hard as the lift's own room allows. The depth draw runs
      // over the two HONEST sub-ranges only: far enough forward that rooms still fit behind, or
      // close enough to the back that the leftover is a wall gap — never a half-dead strip a room
      // cannot use and a player cannot read.
      stairX = side === 1 ? window.xHi : window.xLo;
      const spans: [number, number][] = [[Math.max(zMin, depth / 2 - shaftD / 2 - 0.3 - gapPlay), zBack]];
      if (zBackRoom >= zMin) spans.unshift([zMin, zBackRoom]);
      const length = spans.reduce((sum, [lo, hi]) => sum + Math.max(0, hi - lo), 0);
      let at = coreRandom(seed, 51) * length;
      backZ = zBack;
      for (const [lo, hi] of spans) {
        const span = Math.max(0, hi - lo);
        if (at <= span) { backZ = stableWorldFloat(lo + at); break; }
        at -= span;
      }
    } else {
      // mid / front: the island, x anywhere in the clear window.
      stairX = window.xLo + coreRandom(seed, 52) * (window.xHi - window.xLo);
      backZ = stairClass === 'mid'
        ? stableWorldFloat(zMidLo + coreRandom(seed, 51) * (zMidHi - zMidLo))
        : stableWorldFloat(zMin + coreRandom(seed, 51) * Math.max(0, Math.min(zBackRoom, zMin + 1.5) - zMin));
    }
  }
  stairX = stableWorldFloat(stairX);
  const lift = needsLift ? liftAt(stairX, liftSide, backZ, stairW, shaftD) : undefined;
  return { stair: { x: stairX, z: backZ, w: stairW, d: shaftD }, lift, stairClass };
}

function liftAt(stairX: number, side: 1 | -1, backZ: number, stairW: number, shaftD: number): Rect {
  return {
    x: stableWorldFloat(stairX + side * (stairW / 2 + 0.3 + LIFT_W / 2)),
    z: backZ, w: LIFT_W, d: stableWorldFloat(Math.min(shaftD, 2.8)),
  };
}

/**
 * THE CORE IS CONTINUOUS FROM THE STREET TO THE TOP — the second half of the walkability claim, and
 * the reason it is enough to prove each floor reaches its own core.
 *
 * There is nothing to search: the shaft is ONE rectangle, shared by every storey, so if it is inside
 * the plate and the ground floor's entry lands on the corridor that leads to it, every storey is
 * connected to every other one. This returns the reason it would NOT hold, so a test can assert the
 * property instead of trusting the paragraph above.
 */
export function coreContinuity(core: BuildingCore): string | undefined {
  const plate: Rect = { x: 0, z: 0, w: core.width, d: core.depth };
  if (core.layout === 'small') {
    // The honest one-room layout: no core at all, a room the camera can stand in, the door on it.
    if (core.stair || core.lift) return 'a small layout carrying a core';
    if (core.storeys !== 1) return 'a small layout on a multi-storey building';
    if (core.width < SMALL_MIN - 1e-6 || core.depth < SMALL_MIN - 1e-6) return 'a small room the camera cannot stand in';
    if (Math.abs(core.entryX) + 1.1 > core.width / 2) return 'the door lands off the small plate';
    return undefined;
  }
  // A stair exists exactly when there is a storey for it to reach.
  if (core.storeys >= 2 && !core.stair) return 'a multi-storey building with no stair';
  if (core.storeys < 2 && core.stair) return 'a single-storey building carrying a dead stair shaft';
  if (core.storeys < 2 && core.lift) return 'a single-storey building carrying a lift';
  if (core.lift && !core.stair) return 'a lift with no stair beside it';
  if (core.stair) {
    if (!core.stairClass) return 'a stair with no position class recorded';
    if (!inside(core.stair, plate)) return 'stair shaft leaves the floor plate';
    // The entry must stay clear: no class may park the shaft over the doormat.
    if (rectMinZ(core.stair) + core.depth / 2 < ENTRY_KEEP - 1e-6) return 'the stair shaft stands on the doormat';
    // ROOMS BEHIND THE CORE need the corridor to squeeze PAST it — the full-width open band in
    // front of the shaft is how the mouth is reached now (the old shared-mouth rule is gone with
    // the back-band monopoly), but a core standing across the spine with rooms behind it would
    // orphan them. The flood fill proves this per floor; this catches it per building.
    if (coreBackZ(core) !== undefined) {
      for (const shaft of [core.stair, core.lift]) {
        if (!shaft) continue;
        const clear = rectMinX(shaft) >= core.corridorX + CORRIDOR / 2 - 1e-6
          || rectMaxX(shaft) <= core.corridorX - CORRIDOR / 2 + 1e-6;
        if (!clear) return 'the core blocks the corridor to the rooms behind it';
      }
    }
  }
  if (core.lift && !inside(core.lift, plate)) return 'lift shaft leaves the floor plate';
  if (core.lift && core.stair && overlaps(core.stair, core.lift)) return 'lift shaft cuts into the stair';
  if (Math.abs(core.entryX - core.corridorX) > 0.01) return 'the street door does not land on the spine';
  if (Math.abs(core.corridorX) + CORRIDOR / 2 > core.width / 2) return 'the spine leaves the floor plate';
  if (core.storeys >= LIFT_FROM_STOREYS && !core.lift) return 'a tall building with no lift';
  // Both bands either side of the spine have to be able to hold a room, or the floor above has
  // nothing on it but a corridor.
  for (const band of [core.width / 2 - (core.corridorX + CORRIDOR / 2), core.corridorX - CORRIDOR / 2 + core.width / 2]) {
    if (band < MIN_ROOM - 1e-6) return 'a band beside the spine is too narrow to hold a room';
  }
  // SOMEWHERE must hold a room: in front of the core, or — on the front and deep-side classes —
  // behind it. A floor with no rooms at all is a corridor pretending.
  const front = coreFrontZ(core) + core.depth / 2 >= MIN_ROOM;
  if (!front && coreBackZ(core) === undefined) return 'the plate holds no room on either side of the core';
  return undefined;
}

function inside(inner: Rect, outer: Rect): boolean {
  return rectMinX(inner) >= rectMinX(outer) - 1e-6 && rectMaxX(inner) <= rectMaxX(outer) + 1e-6
    && rectMinZ(inner) >= rectMinZ(outer) - 1e-6 && rectMaxZ(inner) <= rectMaxZ(outer) + 1e-6;
}

function overlaps(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-6;
}
