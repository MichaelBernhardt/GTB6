/**
 * EGOLI WAL — the inland dam that replaces the Atlantic seaboard.
 *
 * Johannesburg is landlocked at 1,700 m ASL; an ocean on the west edge was the single most
 * immersion-breaking thing on the map. This generates a Vaal-Dam-style reservoir instead: a
 * shallow flooded basin of drowned river valleys, so the shoreline is deeply crenellated with
 * bays, inlets, reed-fringed arms and headlands rather than a smooth lake edge, with one large
 * island. Water is opaque grey-brown ("vaal" means drab), and the shore is grass to the
 * waterline with concrete slipways — NOT sand.
 *
 * TWO HARD RULES, both of which save a rewrite elsewhere:
 *
 * 1. THE SHORE IS SINGLE-VALUED, x = f(z), sampled at uniform z. src/world/beachfront.ts
 *    coastXAt() and src/world/City.ts coastlineXAt() both model the shore as a function of z
 *    and would silently flatten an overhanging peninsula, and coast.ts's shore ribbon forces
 *    its inland normal to +x. Large amplitude in x at uniform z buys bays and headlands with
 *    no overhangs, and every one of those consumers keeps working untouched.
 *
 * 2. IT OVERHANGS ONLY THE WEST EDGE — but it runs OFF THE TOP AND BOTTOM OF THAT EDGE.
 *    The old ocean overhung west, north AND south, which is what made it read as a sea; the
 *    owner asked for one edge. The first cut of this read that as "pinch it out inside the
 *    map", which put a 2,831-unit ruler-straight cap across the middle of the playable world.
 *    One edge means one edge, not three visible ends: the shore is generated over a band that
 *    extends past the world square at both ends, so the pinch, the taper and the closing cap
 *    all happen off-map and the player only ever sees crenellated shoreline leaving the frame.
 *
 * Deterministic: every wobble is a hash of the dam's name, no Math.random (pipeline contract).
 */
import {
  DAM_ARMS,
  DAM_BAY_AMPLITUDE_M,
  DAM_BAY_WAVELENGTH_M,
  DAM_DETAIL_AMPLITUDE_M,
  DAM_DETAIL_WAVELENGTH_M,
  DAM_END_TAPER_M,
  DAM_ISLAND_RADIUS_M,
  DAM_NAME,
  DAM_SHORE_STEP_M,
} from './config';
import { fbm, nameSeed } from './meander';
import type { Pt } from './types';

const smoothstep = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

export interface DamShoreInput {
  /** Mean shoreline x in projected metres (water lies west of it). */
  meanX: number;
  /** North and south ends of the dam's z-band, projected metres (northZ < southZ). */
  northZ: number;
  southZ: number;
}

export interface DamShore {
  /** Shoreline south -> north (decreasing z), single-valued in x per z. */
  points: Pt[];
  /** The z-band the water occupies; outside it the west band is dry land. */
  northZ: number;
  southZ: number;
  meanX: number;
  /** Westernmost and easternmost shore x, for budgeting the west band. */
  minX: number;
  maxX: number;
}

/** Bays and headlands: symmetric fBm, so the shore wanders BOTH ways about the mean. */
function baysAt(t: number, spanM: number): number {
  const seed = nameSeed(DAM_NAME);
  const along = t * spanM;
  const bays = fbm(seed, along / DAM_BAY_WAVELENGTH_M, 5) * DAM_BAY_AMPLITUDE_M;
  const detail = fbm(seed + 17, along / DAM_DETAIL_WAVELENGTH_M, 3) * DAM_DETAIL_AMPLITUDE_M;
  return bays + detail;
}

/** Drowned-valley arms: smooth notches cut EAST into the shore (positive = inland). */
function armsAt(t: number, spanM: number): number {
  let arms = 0;
  for (const arm of DAM_ARMS) {
    const halfMouth = arm.mouthM / 2;
    const d = Math.abs(t - arm.at) * spanM;
    if (d < halfMouth) arms += arm.depthM * (1 - smoothstep(d / halfMouth));
  }
  return arms;
}

/**
 * Generate the crenellated shoreline, running SOUTH -> NORTH (decreasing z).
 *
 * Two passes: the bay noise is RECENTRED on its own mean before use, so an unlucky seed cannot
 * push the whole shore to one side of `meanX` (the first cut of this did exactly that — every
 * sample landed 16..974 m east of the nominal mean, quietly stealing a kilometre of water).
 */
export function buildDamShore(input: DamShoreInput): DamShore {
  const { meanX, northZ, southZ } = input;
  const spanM = southZ - northZ;
  const steps = Math.max(24, Math.round(spanM / DAM_SHORE_STEP_M));
  const raw: number[] = [];
  for (let i = 0; i <= steps; i++) raw.push(baysAt(i / steps, spanM));
  const bias = raw.reduce((a, b) => a + b, 0) / raw.length;

  const points: Pt[] = [];
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    // Taper both ends so the basin closes into a bay head rather than being sliced off, and
    // pull the shore east there so the water pinches out — lens-shaped, not a rectangle.
    // The taper is an ABSOLUTE distance from each end, not a fraction of the span: the band
    // now overshoots the world square by DAM_OVERSHOOT_M and the taper has to stay inside
    // that overshoot, or the pinch creeps back into the playable map as a visible bend.
    const alongM = t * spanM;
    const endTaper = smoothstep(alongM / DAM_END_TAPER_M) * smoothstep((spanM - alongM) / DAM_END_TAPER_M);
    const pinch = (1 - endTaper) * 1000;
    const x = meanX + (raw[i]! - bias + armsAt(t, spanM)) * endTaper + pinch;
    points.push({ x, z: northZ + t * spanM });
  }
  let minX = Infinity; let maxX = -Infinity;
  for (const p of points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
  return { points, northZ, southZ, meanX, minX, maxX };
}

/**
 * The dam-shore road, as a MONOTONE-SAFE function of z rather than a perpendicular offset of
 * the shoreline.
 *
 * offsetPolyline() folds catastrophically on a shore with 900 m drowned-valley arms — the road
 * dives into every inlet, self-intersects at the headlands and emits needle slivers, and no
 * amount of pre-smoothing fixes it because the arms are deeper than any sane offset. Instead:
 * take a running MAXIMUM (eastmost) of the shore x over a window wider than the arms, add the
 * set-back, then smooth. The result is single-valued in z by construction, can never cross the
 * water, and reads as causeways across the bay mouths — which is exactly what a real dam-shore
 * road does.
 */
export function buildShoreRoad(shore: DamShore, setbackM: number, windowM = 900, clip?: { northZ: number; southZ: number }): Pt[] {
  // CLIP FIRST. The water polygon runs off the top and bottom of the world square; the ROAD
  // must not. makeFitTransform measures the fit from the road bbox, so a Victoria Road that
  // followed the full extended shore would stretch that bbox by the whole overshoot and shrink
  // the city inside the world square by about a third.
  const pts = clip
    ? shore.points.filter((p) => p.z >= clip.northZ && p.z <= clip.southZ)
    : shore.points;
  if (pts.length < 2) return shore.points.slice();
  const window = Math.max(1, Math.round(windowM / DAM_SHORE_STEP_M));
  const hull: Pt[] = pts.map((p, i) => {
    let east = p.x;
    for (let k = Math.max(0, i - window); k <= Math.min(pts.length - 1, i + window); k++) {
      if (pts[k]!.x > east) east = pts[k]!.x;
    }
    return { x: east + setbackM, z: p.z };
  });
  // Two smoothing passes over x only (z stays on its uniform grid, so it cannot fold).
  let smooth = hull;
  for (let pass = 0; pass < 2; pass++) {
    smooth = smooth.map((p, i) => {
      const a = smooth[Math.max(0, i - 1)]!; const b = smooth[Math.min(smooth.length - 1, i + 1)]!;
      return { x: (a.x + 2 * p.x + b.x) / 4, z: p.z };
    });
  }
  return smooth;
}

/**
 * Close the shore into a water polygon by running west past the world edge, so there is no
 * visible far shore — the same trick the ocean used, but on one edge only.
 */
export function buildDamPolygon(shore: DamShore, westX: number): Pt[] {
  const first = shore.points[0]!;
  const last = shore.points[shore.points.length - 1]!;
  return [...shore.points, { x: westX, z: last.z }, { x: westX, z: first.z }];
}

/**
 * One large island, Vaal-style: an fBm-wobbled ellipse. Emitted as a scrub landuse polygon
 * (plus a local elevation bump) rather than a hole in the water, which avoids new plumbing
 * in the runtime's Water.ts.
 */
export function buildDamIsland(shore: DamShore, offsetWestM = 520, centerZ?: number): { center: Pt; polygon: Pt[] } {
  // centerZ is the CITY's own mid-z, not the band's: the band now overshoots the world square
  // by 3 km at each end, so its midpoint is no longer a point the player can see.
  const midZ = centerZ ?? (shore.northZ + shore.southZ) / 2;
  const center: Pt = { x: shore.meanX - offsetWestM, z: midZ };
  const seed = nameSeed(`${DAM_NAME} island`);
  const polygon: Pt[] = [];
  const steps = 26;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    // Periodic noise sampled on the unit circle so the outline closes without a seam.
    const wobble = 1 + 0.22 * (fbm(seed, Math.cos(angle) * 1.7 + 3.1, 3) + fbm(seed + 5, Math.sin(angle) * 1.7 + 8.3, 3));
    polygon.push({
      x: center.x + Math.cos(angle) * DAM_ISLAND_RADIUS_M * wobble,
      z: center.z + Math.sin(angle) * DAM_ISLAND_RADIUS_M * 0.62 * wobble,
    });
  }
  return { center, polygon };
}

/**
 * Shore x at an arbitrary z by nearest-vertex lookup, plus whether z is inside the dam's band.
 * Used by the composite elevation pass — the water test must be band-AND-west, not just
 * west-of-nearest-shore-point, or the dry veld north and south of the dam floods.
 */
export function damSampler(shore: DamShore): { xAt: (z: number) => number; inBand: (z: number) => boolean } {
  return {
    xAt: (z: number): number => {
      let best = shore.points[0]!; let bestD = Infinity;
      for (const p of shore.points) {
        const d = Math.abs(p.z - z);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best.x;
    },
    inBand: (z: number): boolean => z >= shore.northZ && z <= shore.southZ,
  };
}
