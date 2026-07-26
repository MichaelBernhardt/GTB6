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
  DAM_END_RUNOUT_GRADIENT,
  DAM_END_WEST_M,
  HOOK_RADIUS_M,
  DAM_ISLAND_WEST_NUDGE_M,
  DAM_REACH_EAST_M,
  DAM_ROTATION_DEG,
  DAM_SHORE_MAX_SEG_M,
  DAM_SHORE_QUANTILE,
  DAM_SHORE_STEP_M,
  DAM_SHORE_TOLERANCE_M,
  DAM_SOURCE_SIMPLIFY_M,
  DAM_STRIP_ANCHOR,
  DAM_UNFOLD_ALPHA,
  DAM_UNIFORM_SCALE,
} from './config';
import { simplifyPolyline } from './simplify';
import type { Pt } from './types';
import { toVaalFrame, type VaalFeature, type VaalStrip } from './vaal';

const smoothstep = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

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
  /** The SELECTED stretch of real shoreline, rotated into the map's frame but NOT scaled, folded
   *  or run out — the reference the emitted shore's orientation histogram is graded against
   *  (tools/mapgen/measure-orientation.mjs). Rotation and uniform scale cannot change a histogram,
   *  so every difference between the two is the fold, the run-outs or the reduction. */
  sourceWindow: Pt[];
  /** Map ANY point of the real Vaal frame through the shore's exact transform — the same unfold
   *  drift, de-tilt, soft-clip and run-out. Everything grafted from the north-shore extract goes
   *  through this, so the real roads land where they really are relative to the real water. */
  mapPoint: (p: Pt, driftAnchor?: Pt) => Pt;
  /** Polygons/polylines take ONE fold leaf (their centroid's) so a fold cannot tear them apart. */
  mapPolygon: (pts: Pt[]) => Pt[];
  /** The same, but through a caller-chosen leaf — a building takes its settlement's, not its own. */
  mapPolygonAnchored: (pts: Pt[], anchor: Pt) => Pt[];
  log: string[];
}

/**
 * Force z to increase monotonically WITHOUT changing a single segment's orientation.
 *
 * A real shoreline is not a function of z: it goes east into an inlet, turns, and comes back west
 * at nearly the same z. Two ways to make it one, and only one of them survives the histogram:
 *
 *   FLATTEN (resample the easternmost crossing per z) — replaces every inlet mouth with a
 *     ruler-straight horizontal segment. This map paid for that once already.
 *   SHEAR (the previous fix: drag every backward stretch forward by alpha times its arc length) —
 *     lays that stretch down at atan(alpha) to the east-west axis whatever its real angle was.
 *     Measured on the shipped shore: 67.7% of the emitted length inside 15 degrees of east-west.
 *   REFLECT (this one) — a stretch running backwards advances by |dz|. The segment keeps its
 *     length and its angle to BOTH axes exactly; only the global folding of the coast changes.
 *     The orientation histogram is therefore preserved by construction, because the histogram is
 *     computed on |dx| and |dz| and reflection is exactly the operation it already quotients out.
 *
 * The fold costs z extent (the strip's z span inflates by the ratio of walked |dz| to net dz —
 * measured and logged per build), and that cost is paid honestly in the SCALE, not by stretching
 * one axis. `alpha` is a floor for segments running exactly east-west, which would otherwise
 * advance z by nothing and emit two vertices at one z; the runtime's per-z sampler divides by the
 * z gap, and the reduction pass would delete one of them and with it a real piece of coast.
 *
 * Returns the folded points plus, for every vertex, the affine map z_folded = sign * z + offset
 * that produced it — everything grafted from the infrastructure extract rides its nearest shore
 * vertex's map, so a street that is 40 m from the water stays 40 m from the water across a fold.
 */
export function foldToMonotoneZ(points: Pt[], alpha: number): { folded: Pt[]; sign: number[]; offset: number[] } {
  const folded: Pt[] = [];
  const sign: number[] = [];
  const offset: number[] = [];
  if (points.length === 0) return { folded, sign, offset };
  folded.push({ ...points[0]! });
  sign.push(1);
  offset.push(0);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const ds = Math.hypot(b.x - a.x, b.z - a.z);
    const dz = b.z - a.z;
    const step = Math.max(Math.abs(dz), alpha * ds);
    const z = folded[folded.length - 1]!.z + step;
    folded.push({ x: b.x, z });
    // The segment is a reflection when it ran backwards; the floor case is treated as forward,
    // which is exact to within alpha * ds and only ever applies to near-east-west segments.
    const s = dz < 0 && Math.abs(dz) >= alpha * ds ? -1 : 1;
    sign.push(s);
    offset.push(z - s * b.z);
  }
  return { folded, sign, offset };
}

/** Value at a quantile of a sample (used to pick the "mean shore" anchor of the real strip). */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))]!;
}

/** Subdivide any segment longer than `maxM` so window samplers (beaches, the road hull, the
 *  runtime's nearest-vertex lookups) always find a vertex nearby. Adaptivity survives: this only
 *  adds points on genuinely straight runs, never removes the dense ones in the bays. */
function capSegmentLength(points: Pt[], maxM: number): Pt[] {
  if (points.length < 2) return points.slice();
  const out: Pt[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / maxM));
    for (let k = 1; k <= steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps });
  }
  return out;
}

/**
 * Fit the real Vaal strip to the map's west edge and return the crenellated shoreline,
 * south -> north (decreasing z), plus the islands and the shore furniture in the same frame.
 */
export function buildDamShore(input: DamShoreInput): DamShore {
  const { meanX, centreZ, zSpan, vaal } = input;
  const log: string[] = [];

  // Keep the REAL vertex distribution. The tolerance here is a few real metres — far finer than
  // anything the map can show — because the reduction that matters happens AFTER the fit, in map
  // metres, where it can be adaptive: dense in the bays and inlets, sparse on the straights. The
  // previous pass simplified at 35 real metres and then RESAMPLED the result onto an even 35 m
  // pitch, which is what erased the crenellation: an even pitch throws away exactly the thing
  // that distinguishes a real shoreline from a smooth curve.
  const source = simplifyPolyline(vaal.shore, DAM_SOURCE_SIMPLIFY_M);

  // 1. ROTATE. A rigid rotation of the real geometry — see DAM_ROTATION_DEG for why the map's
  //    narrow axis has to be pointed down a different real direction than "across the north shore".
  const theta = (DAM_ROTATION_DEG * Math.PI) / 180;
  const cosT = Math.cos(theta); const sinT = Math.sin(theta);
  const rotate = (p: Pt): Pt => ({ x: p.x * cosT - p.z * sinT, z: p.x * sinT + p.z * cosT });
  const rotated = source.map(rotate);

  // 2. FOLD to a function of z, reflecting rather than shearing (foldToMonotoneZ).
  const { folded, sign, offset } = foldToMonotoneZ(rotated, DAM_UNFOLD_ALPHA);

  // 3. WINDOW. The band is zSpan tall in map metres, so it is zSpan / scale tall in real metres,
  //    centred on the real anchor point. Everything outside the window is simply not shore: north
  //    and south of the band the west strip is dry veld out to the world edge.
  const scale = DAM_UNIFORM_SCALE;
  const windowH = zSpan / scale;
  const anchorRot = rotate(toVaalFrame(DAM_STRIP_ANCHOR.lat, DAM_STRIP_ANCHOR.lon));
  let anchorI = 0; let anchorD = Infinity;
  for (let i = 0; i < rotated.length; i++) {
    const d = (rotated[i]!.x - anchorRot.x) ** 2 + (rotated[i]!.z - anchorRot.z) ** 2;
    if (d < anchorD) { anchorD = d; anchorI = i; }
  }
  if (Math.sqrt(anchorD) > 600) {
    throw new Error(`dam: DAM_STRIP_ANCHOR is ${Math.round(Math.sqrt(anchorD))} m off the real shoreline — it must be ON it, or the window lands somewhere else on the dam`);
  }
  const midZ = folded[anchorI]!.z;
  const lo = midZ - windowH / 2; const hi = midZ + windowH / 2;
  const windowIdx: number[] = [];
  for (let i = 0; i < folded.length; i++) if (folded[i]!.z >= lo && folded[i]!.z <= hi) windowIdx.push(i);
  if (windowIdx.length < 32) {
    throw new Error(`dam: the strip window is empty at anchor ${DAM_STRIP_ANCHOR.lat},${DAM_STRIP_ANCHOR.lon} — check DAM_UNIFORM_SCALE / DAM_STRIP_ANCHOR`);
  }

  // 4. UNIFORM SIMILARITY. One factor, both axes. `xRef` is the across-shore quantile that lands
  //    at the deepest inland reach; everything else follows rigidly from it.
  const xRef = quantile(windowIdx.map((i) => folded[i]!.x), DAM_SHORE_QUANTILE);
  const mapX = (x: number): number => meanX + DAM_REACH_EAST_M + (x - xRef) * scale;
  const mapZ = (z: number): number => centreZ + (z - midZ) * scale;

  const fitted: Pt[] = windowIdx.map((i) => ({ x: mapX(folded[i]!.x), z: mapZ(folded[i]!.z) }));

  /**
   * Run the two ends of the band WEST past the world square — the only non-similarity left.
   *
   * The lobe's ends are not caps: the shoreline curves back west and leaves the frame, so nothing
   * straight is ever visible and both west corners stay dry. The ramp is SLOPE-LIMITED
   * (DAM_END_RUNOUT_GRADIENT): its length is whatever its own drop needs at a fixed gentle
   * gradient, so an end that already sits west pays nothing and the ramp's own segments land at one
   * known angle instead of shearing the whole band. The crenellation rides on the ramp, so the
   * run-out is still curved coastline.
   */
  const target = meanX - DAM_END_WEST_M;
  const dropNorth = Math.max(0, fitted[0]!.x - target);
  const dropSouth = Math.max(0, fitted[fitted.length - 1]!.x - target);
  const zNorth = fitted[0]!.z; const zSouth = fitted[fitted.length - 1]!.z;
  // smoothstep peaks at 1.5x the average gradient, so the length carries that factor.
  const runOutM = (drop: number): number => Math.min(zSpan * 0.45, (drop / DAM_END_RUNOUT_GRADIENT) * 1.5);
  const lenNorth = runOutM(dropNorth); const lenSouth = runOutM(dropSouth);
  const endRunOut = (z: number): number =>
    (lenNorth > 0 ? dropNorth * (1 - smoothstep((z - zNorth) / lenNorth)) : 0)
    + (lenSouth > 0 ? dropSouth * (1 - smoothstep((zSouth - z) / lenSouth)) : 0);
  for (const p of fitted) p.x -= endRunOut(p.z);

  /**
   * ADAPTIVE REDUCTION. Douglas-Peucker in MAP metres on the fitted shore: vertices survive where
   * the shore turns and are dropped only where it is genuinely straight, so the emitted segment
   * lengths inherit the real coastline's 20:1 spread instead of the even pitch a resample imposes.
   * The only thing added back is a ceiling on segment length, which subdivides straights (never
   * bays) so the beach / road / runtime window samplers always find a vertex nearby.
   */
  const reduced = capSegmentLength(simplifyPolyline(fitted, DAM_SHORE_TOLERANCE_M), DAM_SHORE_MAX_SEG_M);
  // Strictly increasing z: the fold guarantees non-decreasing, but a zero-length real segment can
  // still emit a duplicate, and the runtime's binary-search sampler divides by (b.z - a.z).
  const grid: Pt[] = [];
  for (const p of reduced) {
    if (grid.length > 0 && p.z - grid[grid.length - 1]!.z < 1e-4) continue;
    grid.push(p);
  }

  /**
   * Map ANY point of the real Vaal frame through the shore's exact transform. The rotation and the
   * similarity are global; the FOLD is not, so a point takes its nearest shore vertex's leaf of the
   * fold (z_folded = sign * z + offset). That is what keeps a slipway on the water and a street
   * grid on its own side of a headland.
   */
  const mapPoint = (p: Pt, driftAnchor?: Pt): Pt => {
    const q = rotate(p);
    const a = rotate(driftAnchor ?? p);
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < rotated.length; i++) {
      const d = (rotated[i]!.x - a.x) ** 2 + (rotated[i]!.z - a.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const z = mapZ(sign[best]! * q.z + offset[best]!);
    return { x: mapX(q.x) - endRunOut(z), z };
  };
  /** Polygons take ONE fold leaf (their centroid's) so a fold cannot tear them apart. */
  const mapPolygonAnchored = (pts: Pt[], anchor: Pt): Pt[] => pts.map((p) => mapPoint(p, anchor));
  const mapPolygon = (pts: Pt[]): Pt[] => mapPolygonAnchored(pts, {
    x: pts.reduce((t, p) => t + p.x, 0) / pts.length,
    z: pts.reduce((t, p) => t + p.z, 0) / pts.length,
  });

  // Islands only ship if they land inside the band; the uniform fit puts most of the real dam's
  // islets outside the window, and an island drawn on dry veld is worse than no island.
  const islands = vaal.islands
    .map((island) =>
      // Nudged west so the channel behind Grooteiland stays a channel rather than touching the shore.
      mapPolygon(island.points).map((p) => ({ x: p.x - DAM_ISLAND_WEST_NUDGE_M, z: p.z })),
    )
    .filter((pts) => {
      const cz = pts.reduce((t, p) => t + p.z, 0) / pts.length;
      const cx = pts.reduce((t, p) => t + p.x, 0) / pts.length;
      return cz > grid[0]!.z && cz < grid[grid.length - 1]!.z && cx > meanX - DAM_END_WEST_M * 0.7;
    });
  const features = vaal.features.map((f) => ({ ...f, p: mapPoint(f.p) }));

  // Emit south -> north (decreasing z), the order every consumer already expects.
  const points = grid.slice().reverse();
  let minX = Infinity; let maxX = -Infinity;
  for (const p of points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }

  // Segment-length spread is the proof that the reduction is adaptive rather than a resample: a
  // uniform pitch has a coefficient of variation near 0, a real shoreline's is well above 1.
  const segs: number[] = [];
  for (let i = 1; i < points.length; i++) segs.push(Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  const segMean = segs.reduce((s, v) => s + v, 0) / Math.max(1, segs.length);
  const segCv = Math.sqrt(segs.reduce((s, v) => s + (v - segMean) ** 2, 0) / Math.max(1, segs.length)) / Math.max(1e-6, segMean);
  const sortedSegs = [...segs].sort((a, b) => a - b);
  const sq = (q: number): number => sortedSegs[Math.max(0, Math.min(sortedSegs.length - 1, Math.round((sortedSegs.length - 1) * q)))] ?? 0;

  // How much of the real coast the window cut, and what the fold cost — both are needed to read
  // the scale honestly: 33 km of real shoreline folded 1.6x and scaled 0.44 is 14 km of emitted
  // coast inside a 9 km band, which is what "crenellated" means arithmetically.
  let windowArc = 0;
  for (let k = 1; k < windowIdx.length; k++) {
    const a0 = rotated[windowIdx[k - 1]!]!; const b0 = rotated[windowIdx[k]!]!;
    windowArc += Math.hypot(b0.x - a0.x, b0.z - a0.z);
  }
  const netZ = Math.abs(rotated[windowIdx[windowIdx.length - 1]!]!.z - rotated[windowIdx[0]!]!.z);
  const foldInflation = windowH / Math.max(1, netZ);

  log.push(
    `dam: UNIFORM fit — rotate ${DAM_ROTATION_DEG} deg, scale ${scale} on BOTH axes (1:${(1 / scale).toFixed(2)}), ` +
      `no de-tilt, no soft-clip. Window ${(windowArc / 1000).toFixed(1)} km of real shoreline ` +
      `(${windowIdx.length} of ${source.length} source pts) about ${DAM_STRIP_ANCHOR.lat},${DAM_STRIP_ANCHOR.lon}; ` +
      `monotone fold reflects, inflating z x${foldInflation.toFixed(2)}`,
  );
  log.push(
    `dam: ${points.length}-pt shore (adaptive DP ${DAM_SHORE_TOLERANCE_M} map m, seg min ${sq(0).toFixed(0)} / ` +
      `median ${sq(0.5).toFixed(0)} / max ${sq(1).toFixed(0)} m, CV ${segCv.toFixed(2)}), x ${Math.round(minX)}..${Math.round(maxX)}, ` +
      `band z ${Math.round(grid[0]!.z)}..${Math.round(grid[grid.length - 1]!.z)}, run-outs drop ` +
      `${Math.round(dropNorth)} m over ${Math.round(lenNorth)} m / ${Math.round(dropSouth)} m over ${Math.round(lenSouth)} m`,
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
    sourceWindow: windowIdx.map((i) => ({ ...rotated[i]! })),
    mapPoint,
    mapPolygon,
    mapPolygonAnchored,
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
 * Close the shore into a water polygon.
 *
 * THE DEFECT THIS REPLACES (C4). The old closure was two points: run west from each band end at
 * the end's own z. That drew two dead-straight, exactly-horizontal 2,029-unit segments whose
 * nearest ends were 321 units (425 m) west of the world square — real rendered mesh (City.ts pushes
 * the whole polygon as one water site, Water.ts turns it into a ShapeGeometry) with void above it,
 * and FogExp2 at 0.00025 attenuates about 1% at that range, so fog hid nothing. The previous test
 * only looked at segments whose MIDPOINT was inside the world square, which structurally cannot see
 * a cap sitting just outside it.
 *
 * THE FIX. The closure is now a smooth, densely-sampled sweep from the north band end round the
 * west to the south band end. Near the shore ends it is CONTINUOUSLY CURVING with short segments,
 * so it reads as coastline leaving the frame rather than as an edge; the long straight runs only
 * appear on the far side of the sweep, `marginM` beyond the world square in every direction. The
 * caller passes the world rectangle in projected metres, so the guarantee is measured against the
 * square that actually ships rather than against a hand-tuned run-out constant.
 */
export function buildDamPolygon(
  shore: DamShore,
  world: { minX: number; maxX: number; minZ: number; maxZ: number },
  marginM: number,
  // Sampling density of the closure sweep. It is raised well above the old 96 because the test
  // that guards this (coast.test 'no ruler-straight run') measures the closest approach of any
  // closure segment LONGER than 120 units: the arc leaves the shore end close to the square, so
  // what matters is that the segments there are short, not that the arc starts far away.
  steps = 260,
): Pt[] {
  const south = shore.points[0]!;
  const north = shore.points[shore.points.length - 1]!;
  // The sweep's far boundary: `marginM` outside the world square on every side, and never east of
  // the shore ends themselves (the run-out has already taken those west of the square).
  const farWest = Math.min(world.minX, Math.min(north.x, south.x)) - marginM - HOOK_RADIUS_M;
  const farNorth = Math.min(world.minZ, north.z) - marginM;
  const farSouth = Math.max(world.maxZ, south.z) + marginM;
  const out: Pt[] = [];
  /**
   * A TIGHT HOOK first, then the long sweep.
   *
   * The old closure left the shore end on a 2,600-unit-radius quarter-ellipse, which means it runs
   * very nearly parallel to the coast for its first kilometre — a long, near-straight synthetic
   * edge sitting just outside the world square, exactly the thing the cap defect was. The hook
   * turns the polygon through 90 degrees on a HOOK_RADIUS arc so it is heading due west within a
   * few hundred metres, and it does that OUTSIDE the square where a corner cannot be seen. The
   * long sweep then carries it to `marginM` beyond the square on every side.
   */
  const hook = (end: Pt, sign: 1 | -1): void => {
    const steps2 = 20;
    for (let i = 1; i <= steps2; i++) {
      const a = (i / steps2) * (Math.PI / 2);
      out.push({ x: end.x - HOOK_RADIUS_M * Math.sin(a), z: end.z + sign * HOOK_RADIUS_M * (1 - Math.cos(a)) });
    }
  };
  // North end: hook away from the coast, then sweep round to the far north-west heading due west.
  hook(north, -1);
  const hookedNorth = out[out.length - 1]!;
  const quarter = Math.max(24, Math.round(steps / 2));
  // `bend` shapes how early the westward motion starts; 1 is a plain quarter-ellipse, which turns
  // continuously along its whole length. Pulling it below 1 was tried and is worse — it flattens the
  // arc into something very close to a straight diagonal.
  const bend = 1;
  for (let i = 1; i <= quarter; i++) {
    const a = ((i / quarter) * Math.PI) / 2;
    out.push({
      x: hookedNorth.x + (farWest - hookedNorth.x) * Math.sin(a),
      z: hookedNorth.z + (farNorth - hookedNorth.z) * (1 - Math.cos(a)) ** bend,
    });
  }
  // The far west run, subdivided so no single emitted segment is enormous.
  const west = Math.max(8, Math.round(steps / 3));
  for (let i = 1; i < west; i++) out.push({ x: farWest, z: farNorth + ((farSouth - farNorth) * i) / west });
  // Mirror-image sweep back toward the south end, then its own hook onto the shore.
  const southHook: Pt[] = [];
  { const steps2 = 20;
    for (let i = steps2; i >= 1; i--) {
      const a = (i / steps2) * (Math.PI / 2);
      southHook.push({ x: south.x - HOOK_RADIUS_M * Math.sin(a), z: south.z - HOOK_RADIUS_M * (1 - Math.cos(a)) });
    } }
  const hookedSouth = southHook[0]!;
  for (let i = 0; i <= quarter; i++) {
    const u = ((1 - i / quarter) * Math.PI) / 2; // pi/2 at the far south-west, 0 at the hook
    out.push({
      x: hookedSouth.x + (farWest - hookedSouth.x) * Math.sin(u),
      z: hookedSouth.z + (farSouth - hookedSouth.z) * (1 - Math.cos(u)) ** bend,
    });
  }
  out.push(...southHook);
  return [...shore.points, ...out];
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
