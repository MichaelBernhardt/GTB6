/**
 * PER-PARCEL FENCES — the suburban norm, planned as pure data.
 *
 * "Everyone has a fence. Some with razor wire, some with spikes. Make that the norm." Every
 * residential parcel rolls a deterministic fence: a low garden wall, a spiked steel palisade, or a
 * razor-wire-topped mesh fence, ringing the stand with a gate aligned to the planned front door.
 * The plan is a pure function of the parcel (stablePositionRandom seeds only), shared verbatim by
 * the drawer (City.buildParcelFence), the collider push, and the QA census
 * (tools/qa/fence-census.ts) — so the fence you see, the fence that stops you, and the fence the
 * audit counts are one fact. No three.js here: the census runs it in plain node.
 *
 * CLIMB CONTRACT (no new mechanics — collider height IS the mechanic): the player clamp only
 * blocks geometry crossing [feet+stepUp, feet+height], and supportHeight lands feet on any top
 * within stepUp — so a fence is crossable exactly when its top <= jump apex + stepUp
 * (10²/(2·27) + 0.55 ≈ 2.40u). Wall 1.25 is hopped trivially; palisade 1.95 takes a real jump;
 * razor 2.30 is barely crossable, and crossing costs blood (Collider.hazard → GameRules
 * FENCE_HAZARD_DAMAGE, razor > spike > none). ParcelFences.test.ts pins this arithmetic.
 *
 * COLLISION CONTRACT: one thin oriented rect per drawn segment, FENCE_THICKNESS wide, grounded on
 * the terrain under its own centre — exactly where the panel is drawn, never an oversized AABB.
 * Fences are derived FROM parcels at cell-build time, so they add nothing to the bake or the map.
 */
import {
  footprintOverlapXZ,
  footprintRailwayClearance,
  footprintRoadClearance,
  LAYOUT_SCALE,
  type GeneratedBuilding,
} from './CityGen';
import { districtAffluence } from './data/neighbourhoods';
import { districtAt, distanceToRoadEdge, pointInAnyPolygon, WATER_POLYGONS } from './mapData';
import { stablePositionRandom } from './StableRandom';

export type FenceKind = 'wall' | 'palisade' | 'razor';
export type FenceHazard = 'spike' | 'razor';

export interface FenceSpec {
  /** Collider height above the terrain under each segment — the climb difficulty, see header. */
  height: number;
  hazard?: FenceHazard;
}

export const FENCE_SPECS: Record<FenceKind, FenceSpec> = {
  wall: { height: 1.25 },
  palisade: { height: 1.95, hazard: 'spike' },
  razor: { height: 2.3, hazard: 'razor' },
};

/** Collider thickness — thin and tight, the airport-fence class of collider. */
export const FENCE_THICKNESS = 0.3;
/** No fence segment stands nearer any road edge than this: keeps every panel off the ~2.2u
 *  sidewalk apron and out of junction mouths (segments that fail are dropped, so a side run
 *  simply stops at the cross street). Kept below FRONTAGE_CLEARANCE + the 1u front inset, so a
 *  front run never trips on the road it faces. */
export const FENCE_ROAD_CLEARANCE = 3.0;
export const FENCE_RAIL_CLEARANCE = 1.5;
/** Panels are drawn (and collided) in runs of at most this, so fences step down Joburg's slopes
 *  segment by segment instead of floating over them. */
export const FENCE_SEGMENT_MAX = 7;
/** Side/back fence line beyond the building footprint. Houses keep >=1.5u of measured air
 *  (RESIDENTIAL_MIN_GAP), so neighbouring stands' fences never touch. */
const SIDE_MARGIN = 0.55;
/** Front fence line beyond the front face: the residential yard (3 authored units, CityGen
 *  ZONE_SHAPE) minus 1u, i.e. one unit behind the sidewalk apron the frontage line matches. */
const FRONT_MARGIN = 3 * LAYOUT_SCALE - 1;
/** Half-width of the gate opening on the street run — a bakkie fits, a removals van does not. */
export const GATE_HALF_WIDTH = 1.35;
/** A fence run may interpenetrate a neighbouring building footprint by at most this before the
 *  segment is dropped (backyard cottages, corner stands at odd angles). */
const NEIGHBOUR_TOLERANCE = 0.05;
/** Depth of the keep-clear strip in front of a neighbour's front face — their doorstep. Kept tight
 *  (a stride) so it only ever catches a panel genuinely standing in a doorway, not the ordinary
 *  boundary between two stands that happen to face each other across a street. */
const DOORSTEP_LANE = 2.6;

/** The strip immediately in front of a parcel's front face, as a footprint rect. */
function doorstepLane(parcel: GeneratedBuilding): { x: number; z: number; width: number; depth: number; heading: number } {
  const lz = parcel.depth / 2 + DOORSTEP_LANE / 2;
  return {
    x: parcel.x + lz * Math.sin(parcel.heading), z: parcel.z + lz * Math.cos(parcel.heading),
    width: parcel.width * 0.7, depth: DOORSTEP_LANE, heading: parcel.heading,
  };
}
/**
 * Chance a parcel is fenced at all — fences are the norm, the odd open stand the exception, and
 * WHICH stands stay open is a money question. A wall is a purchase: on the poorest streets a stand
 * may carry a wire strand, a hedge or nothing at all, while on the ridge a stand without a wall
 * does not exist. The spread is deliberately narrow — 0.90 at the township end to 0.97 on the
 * ridge, weighting out at the old flat 0.93 citywide — because the owner's rule for this layer is
 * still "everyone has a fence, some with razor wire, some with spikes". The money story belongs in
 * the KIND, not in whether there is one; this is a thumb on the scale, not the mechanism.
 */
const FENCED_CHANCE_POOR = 0.9;
const FENCED_CHANCE_RIDGE = 0.97;
export const fencedChanceFor = (affluence: number): number =>
  FENCED_CHANCE_POOR + (FENCED_CHANCE_RIDGE - FENCED_CHANCE_POOR) * Math.min(1, Math.max(0, affluence));
/** How far out from its gate a stand may look for the street before the ring is refused. A front
 *  run stands FRONT_MARGIN beyond the building face and the frontage line puts that a couple of
 *  units behind the kerb, so a stand that is genuinely on a street finds tarmac inside a handful
 *  of units; 26 is generous enough to allow a deep corner yard and short enough to be cheap. */
const GATE_EXIT_REACH = 26;
const GATE_EXIT_STEP = 0.5;

/** Point (world) inside a parcel-shaped rectangle grown by `side` on x and by `front`/`back` on z. */
function insideGrownFootprint(
  x: number, z: number, parcel: GeneratedBuilding, side: number, front: number, back: number,
): boolean {
  const cos = Math.cos(parcel.heading); const sin = Math.sin(parcel.heading);
  const dx = x - parcel.x; const dz = z - parcel.z;
  const lx = dx * cos - dz * sin; const lz = dx * sin + dz * cos;
  return Math.abs(lx) <= parcel.width / 2 + side && lz >= -(parcel.depth / 2 + back) && lz <= parcel.depth / 2 + front;
}

/**
 * A GATE HAS TO LEAD SOMEWHERE. This is the cross-parcel half of the fence planner, and the fix for
 * the citywide reachability audit's headline finding: 394 front doors were sealed off from the
 * street by fences. Every one of those rings had a gate — the gate simply opened into a pocket that
 * the NEXT stand's ring, or the building it belongs to, closed again. Almost all of them were
 * back-yard masses: CityGen's rear infill puts a cottage behind the street house, ParcelFences
 * ringed it as if it were a stand of its own, and its gate opened onto the back wall of the house
 * in front. A backroom does not have its own fence and its own gate inside somebody else's yard.
 *
 * So a ring is only planned when a straight walk out of its gate reaches a road without crossing a
 * neighbour's walls or a neighbour's yard. Straight rather than a flood fill on purpose: this runs
 * per parcel inside the chunk builder, the answer has to be the same for the drawer, the collider
 * push and the census, and a conservative test can only ever REFUSE a ring — it can never leave one
 * standing across a door. Stands that face their own street pass it in a few units; a mass buried
 * in the middle of a block does not, and goes unfenced, sitting inside the yard it actually belongs
 * to. tools/qa/door-reachability.ts is the audit that holds this to zero.
 */
function gateReachesStreet(
  parcel: GeneratedBuilding, gateX: number, gateZ: number, neighbours: readonly GeneratedBuilding[],
): boolean {
  const outX = Math.sin(parcel.heading); const outZ = Math.cos(parcel.heading);
  const cull: GeneratedBuilding[] = [];
  for (const other of neighbours) {
    if (other.x === parcel.x && other.z === parcel.z) continue;
    const reach = GATE_EXIT_REACH + (other.width + other.depth) / 2 + FRONT_MARGIN;
    if ((other.x - gateX) ** 2 + (other.z - gateZ) ** 2 > reach * reach) continue;
    cull.push(other);
  }
  for (let t = GATE_EXIT_STEP; t <= GATE_EXIT_REACH; t += GATE_EXIT_STEP) {
    const x = gateX + outX * t; const z = gateZ + outZ * t;
    if (distanceToRoadEdge(x, z) <= 0.5) return true;
    for (const other of cull) {
      // The neighbour's walls, and — where the neighbour is a stand that will ring itself — the
      // yard inside that ring. Either one is a wall across this gate's way out.
      const fenced = other.zone === 'residential';
      if (insideGrownFootprint(x, z, other, fenced ? SIDE_MARGIN : 0, fenced ? FRONT_MARGIN : 0, fenced ? SIDE_MARGIN : 0)) return false;
    }
  }
  return false;
}

/** One straight fence piece: world placement for colliders/audits, building-local placement for
 *  the mesh (the chunk builder adds meshes in the parcel's rotated frame). `along` is the local
 *  axis the run follows — 'x' runs face the street, 'z' runs are the side boundaries. */
export interface FenceSegment {
  x: number;
  z: number;
  heading: number;
  length: number;
  lx: number;
  lz: number;
  along: 'x' | 'z';
}

export interface FencePost { x: number; z: number; lx: number; lz: number; }

export interface FencePlan {
  kind: FenceKind;
  height: number;
  hazard?: FenceHazard;
  segments: FenceSegment[];
  posts: FencePost[];
  /** Building-local x of the gate centre on the front run (aligned to the planned entrance). */
  gateLx: number;
}

/** Structural twin of City's Collider — kept here so the census audits the EXACT rectangle the
 *  game registers, from the same function. y0 is the terrain height under the segment centre. */
export interface FenceCollider {
  minX: number; maxX: number; minZ: number; maxZ: number;
  height: number; y0: number;
  heading?: number; hw?: number; hd?: number;
  hazard?: FenceHazard;
}

const seeded = stablePositionRandom;

/** Kind fractions as [wall, palisade, razor], summing to 1, at one anchor on the wealth axis. */
type FenceMix = readonly [wall: number, palisade: number, razor: number];

/**
 * THE SECURITY MIX IS A U, NOT A RAMP — which is the whole point of reading wealth here.
 *
 * The obvious model (poor = razor, rich = nothing) is wrong about Joburg in both directions. What
 * actually happens is that HARDNESS bottoms out in the middle:
 *   - the poorest streets run razor wire and spiked palisade on principle, because that is what is
 *     affordable and what is expected — mesh and a coil, not masonry;
 *   - the ordinary middle runs the low garden wall, which is a boundary marker with a gate in it
 *     rather than a defence, and is why 'wall' peaks here and nowhere else;
 *   - the leafy old-money ridge hardens again into the paranoid look: high walls, electric strands
 *     and a palisade gate you can see the garden through. It goes back UP the hardness axis, but as
 *     palisade rather than razor — razor wire is not a Westcliff material.
 * So the three anchors below are interpolated piecewise about FENCE_MIX_PIVOT, and the U shows up
 * in palisade+razor: ~0.88 poor, ~0.34 ordinary, ~0.50 ridge. tools/qa/fence-census.ts prints
 * exactly that column per wealth band; it is the number to re-read after touching these.
 *
 * WEALTH IS THE ONLY AXIS HERE, and dropping the old per-STYLE split is deliberate rather than a
 * simplification. CityGen now decides the house/flat/villa family off the same districtAffluence,
 * so a dense-residential parcel IS mostly a poor-district parcel — reading both would count one
 * fact twice and over-drive the razor tail in the inner city. A house in Yeoville has razor wire on
 * its wall; the fence belongs to the street, not to the massing standing behind it.
 */
const FENCE_MIX_POOR: FenceMix = [0.12, 0.36, 0.52];
const FENCE_MIX_ORDINARY: FenceMix = [0.66, 0.28, 0.06];
const FENCE_MIX_RIDGE: FenceMix = [0.5, 0.47, 0.03];
/** Where the ordinary middle — the bottom of the U — sits on the 0..1 affluence axis. */
const FENCE_MIX_PIVOT = 0.5;

export function fenceMixFor(affluence: number): FenceMix {
  const money = Math.min(1, Math.max(0, affluence));
  const above = money > FENCE_MIX_PIVOT;
  const from = above ? FENCE_MIX_ORDINARY : FENCE_MIX_POOR;
  const to = above ? FENCE_MIX_RIDGE : FENCE_MIX_ORDINARY;
  const t = above ? (money - FENCE_MIX_PIVOT) / (1 - FENCE_MIX_PIVOT) : money / FENCE_MIX_PIVOT;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

/**
 * The deterministic fence roll for a parcel: fenced or not, and which kind. Kind is quantised to
 * the same 180u neighbourhood tile CityGen uses for house styles (70/30 blended with a per-stand
 * roll), so a street reads as runs of matching fences with the odd upgrade — not confetti. The
 * thresholds those runs are cut against come from the stand's own district (see fenceMixFor): the
 * tile decides WHERE in the mix a stand lands, the district decides what the mix is. A tile that
 * straddles a district line therefore changes character across the line, which is what a Joburg
 * boundary street actually looks like, and every other per-parcel system (facades, casts, traffic)
 * reads the same per-parcel district rather than a tile-quantised one.
 */
export function fenceKindFor(parcel: Pick<GeneratedBuilding, 'x' | 'z' | 'zone'>): FenceKind | undefined {
  if (parcel.zone !== 'residential') return undefined;
  const affluence = districtAffluence(districtAt(parcel.x, parcel.z));
  if (seeded(parcel.x, parcel.z, 83) >= fencedChanceFor(affluence)) return undefined;
  const blockX = Math.floor(parcel.x / 180); const blockZ = Math.floor(parcel.z / 180);
  // Wrap-around blend, NOT a weighted average: (block + 0.3·stand) mod 1 stays UNIFORM (adding an
  // independent offset mod 1 preserves the marginal), so the kind fractions below are exact —
  // a plain 70/30 average is trapezoidal and starved the razor tail to a third of its share.
  const roll = (seeded(blockX, blockZ, 84) + seeded(parcel.x, parcel.z, 85) * 0.3) % 1;
  const mix = fenceMixFor(affluence);
  return roll < mix[0] ? 'wall' : roll < mix[0] + mix[1] ? 'palisade' : 'razor';
}

interface FenceRun { along: 'x' | 'z'; at: number; from: number; to: number; }

/**
 * Plan one parcel's fence ring. Undefined when the parcel is unfenced (wrong zone, the unfenced
 * roll, a massing that carries its own yard wall, or nothing survives the clearance checks).
 *
 *  - `massing` — the architecture massing index (suburban massing 6, the stoep house, already
 *    ships a walled yard; fencing it twice would draw a fence through a wall).
 *  - `entranceX` — building-local x of the planned front door; the gate gap is cut there so no
 *    door is ever walled off (parity with BuildingArchitecture.planEntrance).
 *  - `neighbours` — every parcel in the 3x3 cell neighbourhood; segments that would cross a
 *    neighbouring footprint (the backyard cottage, the corner stand) are dropped.
 */
export function planParcelFence(
  parcel: GeneratedBuilding,
  options: { massing: number; entranceX?: number; neighbours?: readonly GeneratedBuilding[] },
): FencePlan | undefined {
  const kind = fenceKindFor(parcel);
  if (!kind) return undefined;
  if (parcel.style === 'suburban' && options.massing === 6) return undefined;
  const spec = FENCE_SPECS[kind];
  const halfWidth = parcel.width / 2 + SIDE_MARGIN;
  const frontZ = parcel.depth / 2 + FRONT_MARGIN;
  const backZ = -(parcel.depth / 2 + SIDE_MARGIN);
  if (halfWidth < GATE_HALF_WIDTH + 1.6) return undefined; // no room for a gate and two panels
  const gateLx = Math.min(halfWidth - GATE_HALF_WIDTH - 1.2,
    Math.max(-(halfWidth - GATE_HALF_WIDTH - 1.2), options.entranceX ?? 0));

  const cosH = Math.cos(parcel.heading); const sinH = Math.sin(parcel.heading);
  if (!gateReachesStreet(parcel, parcel.x + gateLx * cosH + frontZ * sinH, parcel.z - gateLx * sinH + frontZ * cosH,
    options.neighbours ?? [])) return undefined;

  const runs: FenceRun[] = [
    { along: 'x', at: frontZ, from: -halfWidth, to: gateLx - GATE_HALF_WIDTH },
    { along: 'x', at: frontZ, from: gateLx + GATE_HALF_WIDTH, to: halfWidth },
    { along: 'x', at: backZ, from: -halfWidth, to: halfWidth },
    // Side runs stop at the front/back runs so corners are owned once (the estate-wall lesson).
    { along: 'z', at: -halfWidth, from: backZ + FENCE_THICKNESS / 2, to: frontZ - FENCE_THICKNESS / 2 },
    { along: 'z', at: halfWidth, from: backZ + FENCE_THICKNESS / 2, to: frontZ - FENCE_THICKNESS / 2 },
  ];

  const cos = Math.cos(parcel.heading); const sin = Math.sin(parcel.heading);
  const toWorld = (lx: number, lz: number): [number, number] =>
    [parcel.x + lx * cos + lz * sin, parcel.z - lx * sin + lz * cos];
  const neighbours = options.neighbours ?? [];

  const segments: FenceSegment[] = [];
  const posts: FencePost[] = [];
  const postKeys = new Set<string>();
  const addPost = (lx: number, lz: number): void => {
    const key = `${Math.round(lx * 8)},${Math.round(lz * 8)}`;
    if (postKeys.has(key)) return;
    postKeys.add(key);
    const [x, z] = toWorld(lx, lz);
    posts.push({ x, z, lx, lz });
  };

  for (const run of runs) {
    const total = run.to - run.from;
    if (total < 1.2) continue;
    const pieces = Math.max(1, Math.ceil(total / FENCE_SEGMENT_MAX));
    for (let piece = 0; piece < pieces; piece++) {
      const from = run.from + (total * piece) / pieces;
      const to = run.from + (total * (piece + 1)) / pieces;
      const length = to - from;
      const centre = (from + to) / 2;
      const lx = run.along === 'x' ? centre : run.at;
      const lz = run.along === 'x' ? run.at : centre;
      const [x, z] = toWorld(lx, lz);
      const heading = run.along === 'x' ? parcel.heading : parcel.heading + Math.PI / 2;
      if (footprintRoadClearance(x, z, length, FENCE_THICKNESS, heading) < FENCE_ROAD_CLEARANCE) continue;
      if (footprintRailwayClearance(x, z, length, FENCE_THICKNESS, heading) < FENCE_RAIL_CLEARANCE) continue;
      if (pointInAnyPolygon(WATER_POLYGONS, x, z)) continue;
      const rect = { x, z, width: length, depth: FENCE_THICKNESS, heading };
      let blocked = false;
      for (const other of neighbours) {
        if (other.x === parcel.x && other.z === parcel.z) continue; // the parcel's own footprint is a margin away by construction
        if ((other.x - x) ** 2 + (other.z - z) ** 2 > ((length + other.width + other.depth) / 2 + DOORSTEP_LANE + 2) ** 2) continue;
        if (footprintOverlapXZ(rect, other) > NEIGHBOUR_TOLERANCE) { blocked = true; break; }
        // …and not across their DOORSTEP either, which is the same rule one step out from the wall:
        // the audit's one surviving fence-sealed door was a stand with no ring of its own walled in
        // by a neighbour whose own gate led out perfectly well. A panel standing in the strip
        // immediately in front of a neighbour's front face is a panel across their way in.
        if (footprintOverlapXZ(rect, doorstepLane(other)) > NEIGHBOUR_TOLERANCE) { blocked = true; break; }
      }
      if (blocked) continue;
      segments.push({ x, z, heading, length, lx, lz, along: run.along });
      if (run.along === 'x') { addPost(from, run.at); addPost(to, run.at); }
      else { addPost(run.at, from); addPost(run.at, to); }
    }
  }
  if (segments.length === 0) return undefined;
  return { kind, height: spec.height, hazard: spec.hazard, segments, posts, gateLx };
}

/**
 * The collider for one drawn segment — the ONE definition the game registers and the census
 * audits. Enclosing AABB for the broad phase; the true footprint is the oriented rect (heading,
 * hw, hd) unless the segment is quarter-snapped, where the AABB is already exact (the same
 * convention as City.tierToWorldCollider).
 */
export function fenceSegmentCollider(segment: FenceSegment, spec: Pick<FencePlan, 'height' | 'hazard'>, groundY: number): FenceCollider {
  const cos = Math.cos(segment.heading); const sin = Math.sin(segment.heading);
  const hw = segment.length / 2; const hd = FENCE_THICKNESS / 2;
  const nx = Math.abs(hw * cos) + Math.abs(hd * sin);
  const nz = Math.abs(hw * sin) + Math.abs(hd * cos);
  const box: FenceCollider = {
    minX: segment.x - nx, maxX: segment.x + nx, minZ: segment.z - nz, maxZ: segment.z + nz,
    height: spec.height, y0: groundY, hazard: spec.hazard,
  };
  if (Math.abs(cos) > 1e-4 && Math.abs(sin) > 1e-4) { box.heading = segment.heading; box.hw = hw; box.hd = hd; }
  return box;
}
