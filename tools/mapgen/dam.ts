/**
 * VAALPUNT DAM — the inland reservoir that replaces the Atlantic seaboard, cut from the REAL
 * Vaal Dam shoreline (see vaal.ts for the extract and the -90 degree re-orientation).
 *
 * Johannesburg is landlocked at 1,700 m ASL; an ocean on the west edge was the single most
 * immersion-breaking thing on the map. The first replacement was synthetic — fBm plus three
 * hand-placed notches — and read as noise rather than as a drowned river system. This one is the
 * north-west arm of the actual Vaal: Deneysville and the dam wall at the top, the northern arm
 * reaching east as the waterway, Grooteiland mid-water, the Misty Bay / Vaal Marina shore below.
 *
 * THREE HARD RULES, each of which saves a rewrite elsewhere:
 *
 * 1. THE SHORE IS SINGLE-VALUED, x = f(z), sampled at uniform z. src/world/beachfront.ts
 *    coastXAt() and src/world/City.ts coastlineXAt() both model the shore as a function of z and
 *    would silently flatten an overhanging peninsula, and coast.ts's shore ribbon forces its
 *    inland normal to +x. The real shoreline is emphatically NOT a function of z — it doubles
 *    back constantly — so it is UNFOLDED (see `unfoldToMonotoneZ`) rather than flattened: every
 *    stretch that runs backwards is given a small forward drift proportional to its own length,
 *    which turns a real inlet into a real, slightly sheared inlet instead of a straight line
 *    across its mouth. Nothing is thrown away, so nothing goes straight.
 *
 * 2. THE WATER IS A LOBE HANGING OFF THE WEST EDGE, not a band down the whole of it. It enters
 *    the west edge, bulges east and leaves the west edge again, so BOTH west corners of the world
 *    are dry land. That is the difference between a reservoir and a sea. The two horizontal caps
 *    that close the polygon sit at the band ends, which is only safe because the shore has already
 *    run WEST off the world square by then — `endRunOut` guarantees it, and process.ts asserts it
 *    after the fit so a re-crop cannot quietly bring a cap back into frame.
 *
 * 3. THE REAL DAM IS TWICE THE SIZE OF THE WHOLE MAP (320 km2 against 168 km2), and its northern
 *    arm alone reaches 10 km east where the map has a ~2 km-wide west band. So the strip is scaled
 *    UNIFORMLY (one factor for both axes, after the unfold) and then the across-shore excursions
 *    are soft-clipped with tanh: a 200 m bay keeps 97% of its true depth, the 10 km arm becomes a
 *    broad reach that fits. The compression is smooth, so it introduces no kinks and no flats.
 *
 * Deterministic: nothing here samples Math.random, and the only noise left is the real coastline.
 */
import {
  DAM_END_RUNOUT_M,
  DAM_END_WEST_M,
  DAM_ISLAND_WEST_NUDGE_M,
  DAM_REACH_EAST_M,
  DAM_REACH_WEST_M,
  DAM_SHORE_QUANTILE,
  DAM_SHORE_STEP_M,
  DAM_SOURCE_SIMPLIFY_M,
  DAM_UNFOLD_ALPHA,
} from './config';
import { simplifyPolyline } from './simplify';
import type { Pt } from './types';
import type { VaalFeature, VaalStrip } from './vaal';

const smoothstep = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
/** Smooth one-sided compression: identity near 0, asymptotic to `limit`. */
const softClip = (d: number, limit: number): number => limit * Math.tanh(d / limit);

export interface DamShoreInput {
  /** Mean shoreline x in projected metres (water lies west of it). */
  meanX: number;
  /** Centre of the water's z-band, projected metres. */
  centreZ: number;
  /** Height of the water's z-band, projected metres. MUST leave land in both west corners. */
  zSpan: number;
  /** The real Vaal strip, game-oriented and unscaled (vaal.ts). */
  vaal: VaalStrip;
}

export interface DamShore {
  /** Shoreline south -> north (decreasing z), single-valued in x per z. */
  points: Pt[];
  /** The z-band the water occupies; outside it the west band is dry land to the world edge. */
  northZ: number;
  southZ: number;
  meanX: number;
  /** Westernmost and easternmost shore x, for budgeting the west band. */
  minX: number;
  maxX: number;
  /** Islands (Grooteiland first), already in projected metres. */
  islands: Pt[][];
  /** Real shore furniture, mapped into projected metres. */
  features: VaalFeature[];
  /** Real metres of Vaal per projected metre of map (1 / scale = the shrink factor). */
  scale: number;
  /** Length of the real shoreline this strip was cut from, metres. */
  sourceLengthM: number;
  log: string[];
}

/**
 * Force z to increase monotonically WITHOUT flattening anything.
 *
 * A real shoreline is not a function of z: it goes east into an inlet, turns, and comes back west
 * at nearly the same z. Resampling that "easternmost crossing per z" replaces every inlet mouth
 * with a ruler-straight horizontal segment — the exact defect this map already paid for once.
 * Instead each step advances z by at least `alpha` times its own arc length, so a stretch that
 * ran backwards is sheared forward in proportion to how long it is. An inlet stays an inlet; it
 * just leans. Every x excursion, and therefore all the crenellation, survives untouched.
 */
export function unfoldToMonotoneZ(points: Pt[], alpha: number): Pt[] {
  if (points.length === 0) return [];
  const out: Pt[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const ds = Math.hypot(b.x - a.x, b.z - a.z);
    out.push({ x: b.x, z: out[out.length - 1]!.z + Math.max(b.z - a.z, alpha * ds) });
  }
  return out;
}

/** Value at a quantile of a sample (used to pick the "mean shore" anchor of the real strip). */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))]!;
}

/**
 * Fit the real Vaal strip to the map's west edge and return the crenellated shoreline,
 * south -> north (decreasing z), plus the islands and the shore furniture in the same frame.
 */
export function buildDamShore(input: DamShoreInput): DamShore {
  const { meanX, centreZ, zSpan, vaal } = input;
  const log: string[] = [];

  // Trim the real vertex soup to the detail the map can actually show. At the fitted scale the
  // tolerance below works out around 10-15 projected metres, i.e. finer than DAM_SHORE_STEP_M,
  // so the emitted shore is limited by the resample pitch and not by this. (The pipeline's own
  // SIMPLIFY_TOLERANCE_M of 8 m is for ROADS in map metres — applying it here would keep ~1,700
  // source vertices that the resample then throws away, and cost a slower unfold for nothing.)
  const source = simplifyPolyline(vaal.shore, DAM_SOURCE_SIMPLIFY_M);
  const unfolded = unfoldToMonotoneZ(source, DAM_UNFOLD_ALPHA);
  const rawNorthZ = unfolded[0]!.z;
  const rawSouthZ = unfolded[unfolded.length - 1]!.z;
  const scale = zSpan / (rawSouthZ - rawNorthZ);
  const rawMidZ = (rawNorthZ + rawSouthZ) / 2;
  const xRef = quantile(source.map((p) => p.x), DAM_SHORE_QUANTILE);

  const mapX = (x: number): number => {
    const d = (x - xRef) * scale;
    return meanX + (d >= 0 ? softClip(d, DAM_REACH_EAST_M) : -softClip(-d, DAM_REACH_WEST_M));
  };
  const mapZ = (z: number): number => centreZ + (z - rawMidZ) * scale;

  const fitted: Pt[] = unfolded.map((p) => ({ x: mapX(p.x), z: mapZ(p.z) }));

  // Resample onto a uniform z grid. After the unfold this is a plain interpolation — no crossing
  // search, no branch choice, no flats.
  const steps = Math.max(24, Math.round(zSpan / DAM_SHORE_STEP_M));
  const northZ = fitted[0]!.z;
  const grid: Pt[] = [];
  let cursor = 0;
  for (let i = 0; i <= steps; i++) {
    const z = northZ + (zSpan * i) / steps;
    while (cursor < fitted.length - 2 && fitted[cursor + 1]!.z < z) cursor++;
    const a = fitted[cursor]!; const b = fitted[cursor + 1]!;
    const t = b.z === a.z ? 0 : Math.max(0, Math.min(1, (z - a.z) / (b.z - a.z)));
    grid.push({ x: a.x + (b.x - a.x) * t, z });
  }

  /**
   * Run the two ends of the band WEST off the world square.
   *
   * The lobe's ends are not caps: the shoreline curves back west and leaves the frame, so nothing
   * straight is ever visible and both west corners stay dry. Whatever the real shore happens to be
   * doing at the cut, the last DAM_END_RUNOUT_M of band is pulled west by a smoothstep ramp until
   * the end vertex sits DAM_END_WEST_M west of the mean — comfortably past the world edge. The
   * crenellation rides on the ramp, so the run-out is curved coastline, not a diagonal.
   */
  const target = meanX - DAM_END_WEST_M;
  const dropNorth = Math.max(0, grid[0]!.x - target);
  const dropSouth = Math.max(0, grid[grid.length - 1]!.x - target);
  const zNorth = grid[0]!.z; const zSouth = grid[grid.length - 1]!.z;
  const endRunOut = (z: number): number =>
    dropNorth * (1 - smoothstep((z - zNorth) / DAM_END_RUNOUT_M))
    + dropSouth * (1 - smoothstep((zSouth - z) / DAM_END_RUNOUT_M));
  for (const p of grid) p.x -= endRunOut(p.z);

  /** Map any point of the real Vaal strip into the map, sharing the shore's exact transform. */
  const mapPoint = (p: Pt, driftAnchor?: Pt): Pt => {
    const anchor = driftAnchor ?? p;
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < source.length; i++) {
      const d = (source[i]!.x - anchor.x) ** 2 + (source[i]!.z - anchor.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const drift = unfolded[best]!.z - source[best]!.z;
    const z = mapZ(p.z + drift);
    return { x: mapX(p.x) - endRunOut(z), z };
  };
  /** Polygons take ONE drift (their centroid's) so the unfold cannot shear them apart. */
  const mapPolygon = (pts: Pt[]): Pt[] => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    return pts.map((p) => mapPoint(p, { x: cx, z: cz }));
  };

  const islands = vaal.islands.map((island) =>
    // Nudged west: the tanh that squeezes the 10 km arm into the band squeezes the channel behind
    // the island with it, and Grooteiland ends up touching the shore instead of floating in a
    // 1.4 km channel. The nudge restores a boat-width of water on its landward side.
    mapPolygon(island.points).map((p) => ({ x: p.x - DAM_ISLAND_WEST_NUDGE_M, z: p.z })),
  );
  const features = vaal.features.map((f) => ({ ...f, p: mapPoint(f.p) }));

  // Emit south -> north (decreasing z), the order every consumer already expects.
  const points = grid.slice().reverse();
  let minX = Infinity; let maxX = -Infinity;
  for (const p of points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }

  log.push(
    `dam: real Vaal north-shore strip ${(vaal.span.lengthM / 1000).toFixed(1)} km of shoreline over ` +
      `${(vaal.span.z / 1000).toFixed(1)} x ${(vaal.span.x / 1000).toFixed(1)} km of the real dam, ` +
      `fitted at 1:${(1 / scale).toFixed(1)} (unfold alpha ${DAM_UNFOLD_ALPHA}, source simplify ${DAM_SOURCE_SIMPLIFY_M} m ` +
      `= ${(DAM_SOURCE_SIMPLIFY_M * scale).toFixed(1)} map m)`,
  );
  log.push(
    `dam: ${points.length}-pt shore, x ${Math.round(minX)}..${Math.round(maxX)} ` +
      `(${Math.round(maxX - minX)} m of crenellation), band z ${Math.round(grid[0]!.z)}..${Math.round(grid[grid.length - 1]!.z)}, ` +
      `ends run out to x ${Math.round(grid[0]!.x)} / ${Math.round(grid[grid.length - 1]!.x)}`,
  );

  return {
    points,
    northZ: grid[0]!.z,
    southZ: grid[grid.length - 1]!.z,
    meanX,
    minX,
    maxX,
    islands,
    features,
    scale,
    sourceLengthM: vaal.span.lengthM,
    log,
  };
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
 *
 * `floorX` is what makes the lobe work: the water now stops well short of the world's north and
 * south edges, and outside the band there is no waterline for the road to follow. It falls back
 * to the dry line instead, so Dam Wal Road still spans the whole city block (the outer loop's two
 * connectors hang off its ends) without being dragged 1.2 km west by the run-outs.
 */
export function buildShoreRoad(
  shore: DamShore,
  setbackM: number,
  windowM: number,
  span: { northZ: number; southZ: number },
  floorX: number,
): Pt[] {
  const shoreByZ = damSampler(shore);
  const steps = Math.max(8, Math.round((span.southZ - span.northZ) / DAM_SHORE_STEP_M));
  // South -> north, matching the shoreline's own order.
  const base: Pt[] = [];
  for (let i = steps; i >= 0; i--) {
    const z = span.northZ + ((span.southZ - span.northZ) * i) / steps;
    base.push({ x: Math.max(floorX, shoreByZ.inBand(z) ? shoreByZ.xAt(z) : -Infinity), z });
  }
  const window = Math.max(1, Math.round(windowM / DAM_SHORE_STEP_M));
  const hull: Pt[] = base.map((p, i) => {
    let east = p.x;
    for (let k = Math.max(0, i - window); k <= Math.min(base.length - 1, i + window); k++) {
      if (base[k]!.x > east) east = base[k]!.x;
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
 * visible far shore. The two horizontal caps sit at the band ends — safe only because the shore
 * has already run out west of the world square there (see `endRunOut`).
 */
export function buildDamPolygon(shore: DamShore, westX: number): Pt[] {
  const first = shore.points[0]!;
  const last = shore.points[shore.points.length - 1]!;
  return [...shore.points, { x: westX, z: last.z }, { x: westX, z: first.z }];
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
