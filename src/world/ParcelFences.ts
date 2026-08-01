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
import { pointInAnyPolygon, WATER_POLYGONS } from './mapData';
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
/** Chance a parcel is fenced at all — fences are the norm, the odd open stand the exception. */
const FENCED_CHANCE = 0.93;

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

/**
 * The deterministic fence roll for a parcel: fenced or not, and which kind. Kind is quantised to
 * the same 180u neighbourhood tile CityGen uses for house styles (70/30 blended with a per-stand
 * roll), so a street reads as runs of matching fences with the odd upgrade — not confetti.
 * Dense-residential blocks run razor-heavier than the leafy suburbs, as in the real city.
 */
export function fenceKindFor(parcel: Pick<GeneratedBuilding, 'x' | 'z' | 'zone' | 'style'>): FenceKind | undefined {
  if (parcel.zone !== 'residential') return undefined;
  if (seeded(parcel.x, parcel.z, 83) >= FENCED_CHANCE) return undefined;
  const blockX = Math.floor(parcel.x / 180); const blockZ = Math.floor(parcel.z / 180);
  // Wrap-around blend, NOT a weighted average: (block + 0.3·stand) mod 1 stays UNIFORM (adding an
  // independent offset mod 1 preserves the marginal), so the kind fractions below are exact —
  // a plain 70/30 average is trapezoidal and starved the razor tail to a third of its share.
  const roll = (seeded(blockX, blockZ, 84) + seeded(parcel.x, parcel.z, 85) * 0.3) % 1;
  if (parcel.style === 'dense-residential') return roll < 0.3 ? 'wall' : roll < 0.65 ? 'palisade' : 'razor';
  return roll < 0.5 ? 'wall' : roll < 0.85 ? 'palisade' : 'razor';
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
        if ((other.x - x) ** 2 + (other.z - z) ** 2 > ((length + other.width + other.depth) / 2 + 2) ** 2) continue;
        if (footprintOverlapXZ(rect, other) > NEIGHBOUR_TOLERANCE) { blocked = true; break; }
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
