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
 * Floor plates are clamped: a 5 u cottage still has to hold a room a camera can stand in, and a 60 u
 * warehouse floor should not be a stadium. The lower bound is DERIVED from the corridor and the
 * minimum room so the two cannot drift apart and quietly produce a floor with no rooms on it —
 * coreContinuity asserts the same relation, and floor.test.ts asserts that over the real city.
 *
 * The minimum DEPTH is 21 rather than 18 for a reason that only shows up citywide: a band has to be
 * 2 × MIN_ROOM deep before it can hold two rooms, and at 18 it was 10.9, so every house on the
 * minimum plate got exactly one room a side and a street of them all read alike. At 21 the band is
 * 13.9, the hash can choose one room or two, and the street stops repeating.
 */
export const MIN_PLATE: readonly [number, number] = [CORRIDOR + 2 * MIN_ROOM + 0.6, 21];
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

export interface BuildingCore {
  readonly id: string;
  readonly seed: number;
  /** How many storeys this building actually has, from the height the bake gave it. */
  readonly storeys: number;
  /** Interior clear plate. */
  readonly width: number;
  readonly depth: number;
  /** The spine corridor: full depth, anchored on the model's own tagged door (see buildCore). */
  readonly corridorX: number;
  /** The stair shaft — identical on every storey by construction, and ABSENT on a single-storey
   *  building, which has nowhere for a stair to go. 2,766 of this city's 7,415 enterable buildings
   *  are single-storey; every one of them used to carry a full dead shaft. */
  readonly stair?: Rect;
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

/** Where the room bands stop and the core band begins. Stairless buildings have no core band, so the
 *  rooms run all the way to the back wall — ~7 units of plate a dead shaft used to waste. Every
 *  reader of "how deep may a room be" goes through this one helper. */
export function coreFrontZ(core: Pick<BuildingCore, 'stair' | 'depth'>): number {
  return core.stair ? rectMinZ(core.stair) - CORE_GAP : core.depth / 2;
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

/**
 * The core, from the building and nothing else — and this is where the owner's ordered brief is
 * actually consumed: perimeter (the plate), then the DOOR from the model's own tag, then the stair,
 * then the lift, each spending the building's hash so the skeleton varies as well as the paint.
 *
 * The old version put the corridor on a seeded offset and then derived EVERYTHING else from the
 * plate rectangle in closed form: the stair's rear edge was 0.30 off the back wall on all 7,415
 * enterable buildings, the shaft was 4.30 × 5.40 on all of them, and the lift stood exactly +1.5
 * from the stair's right edge on all 1,151 lifted ones. Same skeleton, seven thousand times.
 */
export function buildCore(facts: BuildingFacts): BuildingCore {
  const seed = buildingSeed(facts);
  // 1. PERIMETER: the building's real footprint, clamped so a cottage still holds the camera and a
  // warehouse floor is not a stadium.
  const ceiling = facts.entrance === 'dock' ? MAX_HALL : MAX_PLATE;
  const width = stableWorldFloat(clamp(facts.width - 0.9, MIN_PLATE[0], ceiling[0]));
  const depth = stableWorldFloat(clamp(facts.depth - 0.9, MIN_PLATE[1], ceiling[1]));
  // Storeys from the height the bake actually generated, never a guess, counted at a real facade
  // storey so the number matches the bands of windows the player counted from the street. A 6 m
  // cottage is one storey; whatever the tallest thing in the CBD turns out to be gets exactly as
  // many floors as it is tall.
  const storeys = Math.max(1, Math.floor((facts.height - 0.4) / FACADE_STOREY));

  // 2. THE DOOR. The spine is anchored where the model actually drew its entrance: the interior
  // frame is the building frame rotated a half turn (hence the sign flip), the plate may be clamped
  // wider or narrower than the footprint (hence the proportional scale), and the corridor still
  // leaves a room-sized band on both sides (hence the clamp). 2,835 of this city's tagged doors sit
  // genuinely off the facade centre, so this one line buys 2,835 off-centre corridors for free —
  // and, more importantly, walking in a corner door no longer materialises you centre-front.
  const slack = Math.max(0, width / 2 - CORRIDOR / 2 - MIN_ROOM);
  const doorScale = width / Math.max(1, facts.width);
  const corridorX = stableWorldFloat(clamp(-facts.doorX * doorScale, -slack, slack));

  // 3. THE STAIR — only where there is a storey for it to reach. Its x is a seeded draw across the
  // window that keeps at least a metre of shared mouth with the spine; its rear gap off the back
  // wall is a seeded 0.3..1.5; which way the switchback turns is a seeded coin. 4. THE LIFT, on
  // tall buildings, stands on a seeded side of the shaft.
  const placed = storeys >= 2
    ? placeShafts(seed, width, depth, corridorX, storeys >= LIFT_FROM_STOREYS)
    : undefined;

  return {
    id: facts.id, seed, storeys, width, depth, corridorX,
    stair: placed?.stair,
    stairDir: coreRandom(seed, 6) < 0.5 ? 1 : -1,
    lift: placed?.lift,
    // The street door lands on the spine, so walking in puts you in the corridor facing the core.
    entryX: corridorX,
    entrance: facts.entrance,
    family: facts.style,
    finish: finishFor(facts, seed),
  };
}

/** Stair (and lift) placement, all seeded. Kept out of buildCore so the fitting rules read in one
 *  place: the shaft keeps ≥1u of shared mouth with the spine, stays on the plate, and on a lifted
 *  building leaves room for the car on its chosen side — pulling toward the roomier side, and in
 *  the last resort landing back on the spine, which fits everywhere the old layout fitted. */
function placeShafts(
  seed: number, width: number, depth: number, corridorX: number, needsLift: boolean,
): { stair: Rect; lift?: Rect } {
  const stairWidth = stableWorldFloat(CORRIDOR + 1.0);
  const shaftDepth = stableWorldFloat(Math.min(depth * 0.32, 5.4));
  const backGap = stableWorldFloat(0.3 + coreRandom(seed, 5) * 1.2);
  const backZ = stableWorldFloat(depth / 2 - shaftDepth / 2 - backGap);
  const window = (CORRIDOR + stairWidth) / 2 - 1.0;
  const plateLimit = width / 2 - stairWidth / 2 - 0.2;
  let stairX = clamp(corridorX + (coreRandom(seed, 4) * 2 - 1) * window, -plateLimit, plateLimit);
  let lift: Rect | undefined;
  if (needsLift) {
    const liftW = 2.4;
    const span = stairWidth / 2 + 0.3 + liftW; // stair centre -> lift outer edge
    const limit = width / 2 - 0.2;
    let side: 1 | -1 = coreRandom(seed, 7) < 0.5 ? 1 : -1;
    if (Math.abs(stairX + side * span) > limit) side = side === 1 ? -1 : 1;
    if (Math.abs(stairX + side * span) > limit) {
      // Neither side fits from here: pull the shaft toward the roomier side until the lift lands on
      // the plate, still inside the spine-overlap window; failing even that, back onto the spine.
      side = stairX > 0 ? -1 : 1;
      stairX = clamp(side === 1 ? limit - span : -limit + span, corridorX - window, corridorX + window);
      if (Math.abs(stairX + side * span) > limit + 1e-6) { stairX = corridorX; side = corridorX > 0 ? -1 : 1; }
    }
    stairX = stableWorldFloat(stairX);
    lift = {
      x: stableWorldFloat(stairX + side * (stairWidth / 2 + 0.3 + liftW / 2)),
      z: backZ, w: liftW, d: stableWorldFloat(Math.min(shaftDepth, 2.8)),
    };
  }
  return { stair: { x: stableWorldFloat(stairX), z: backZ, w: stairWidth, d: shaftDepth }, lift };
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
  // A stair exists exactly when there is a storey for it to reach.
  if (core.storeys >= 2 && !core.stair) return 'a multi-storey building with no stair';
  if (core.storeys < 2 && core.stair) return 'a single-storey building carrying a dead stair shaft';
  if (core.storeys < 2 && core.lift) return 'a single-storey building carrying a lift';
  if (core.lift && !core.stair) return 'a lift with no stair beside it';
  if (core.stair) {
    if (!inside(core.stair, plate)) return 'stair shaft leaves the floor plate';
    // The spine must genuinely share a mouth with the shaft, or the stair is walled off from the
    // front door. The shaft may now stand seeded off the spine, so this is an overlap width, not an
    // exact-centre check — but the overlap must be wide enough to walk through.
    const mouth = Math.min(rectMaxX(core.stair), core.corridorX + CORRIDOR / 2)
      - Math.max(rectMinX(core.stair), core.corridorX - CORRIDOR / 2);
    if (mouth < 0.9) return 'the stair shaft has drifted off the spine';
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
  // The room band in front of the core (the whole plate, on a stairless building) must hold a room.
  if (coreFrontZ(core) + core.depth / 2 < MIN_ROOM) return 'the plate is too shallow to hold a room in front of the core';
  return undefined;
}

function inside(inner: Rect, outer: Rect): boolean {
  return rectMinX(inner) >= rectMinX(outer) - 1e-6 && rectMaxX(inner) <= rectMaxX(outer) + 1e-6
    && rectMinZ(inner) >= rectMinZ(outer) - 1e-6 && rectMaxZ(inner) <= rectMaxZ(outer) + 1e-6;
}

function overlaps(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-6;
}
