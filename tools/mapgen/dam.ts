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
  DAM_CROSS_SHORE_GAIN,
  DAM_DETREND_WINDOW_M,
  DAM_END_RUNOUT_M,
  DAM_END_WEST_M,
  DAM_ISLAND_WEST_NUDGE_M,
  DAM_REACH_EAST_M,
  DAM_REACH_WEST_M,
  DAM_SHORE_MAX_SEG_M,
  DAM_SHORE_QUANTILE,
  DAM_SHORE_STEP_M,
  DAM_SHORE_TOLERANCE_M,
  DAM_SOURCE_SIMPLIFY_M,
  DAM_UNFOLD_ALPHA,
  DAM_UNFOLD_TRACKING,
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
  /** Map ANY point of the real Vaal frame through the shore's exact transform — the same unfold
   *  drift, de-tilt, soft-clip and run-out. Everything grafted from the north-shore extract goes
   *  through this, so the real roads land where they really are relative to the real water. */
  mapPoint: (p: Pt, driftAnchor?: Pt) => Pt;
  /** Polygons/polylines take ONE drift (their centroid's) so the unfold cannot shear them apart. */
  mapPolygon: (pts: Pt[]) => Pt[];
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
export function unfoldToMonotoneZ(points: Pt[], alpha: number, tracking = 0): Pt[] {
  if (points.length === 0) return [];
  const out: Pt[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const ds = Math.hypot(b.x - a.x, b.z - a.z);
    const dz = b.z - a.z;
    // `tracking` is what stops a fjord wall coming out RULER STRAIGHT. With the old
    // max(dz, alpha*ds) rule, a stretch running purely across-shore (dz ~ 0 over kilometres, which
    // is exactly what the side of a drowned valley does) advanced z by alpha*ds and nothing else:
    // both mapped coordinates then became linear functions of the same real coordinate, so the
    // whole flank collapsed onto an exact straight diagonal — a measured 920-unit one. Blending in
    // the true dz keeps the flank responsive to the real shoreline's own wander. Monotone by
    // construction while tracking < alpha, because dz >= -ds.
    out.push({ x: b.x, z: out[out.length - 1]!.z + Math.max(dz, alpha * ds + tracking * dz) });
  }
  return out;
}

/** Value at a quantile of a sample (used to pick the "mean shore" anchor of the real strip). */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))]!;
}

/**
 * DE-TILT the strip: subtract the KILOMETRE-SCALE drift of the across-shore coordinate and keep
 * every excursion below the window untouched.
 *
 * Why this exists. The Vaal's north shore between Grooteiland and Misty Bay runs 8.6 km "east"
 * (in map terms) over 28 km of walked shoreline — it is a diagonal, not a north-south coast. Fitted
 * raw against a west edge, that diagonal is the whole shape: the tanh saturates east at the top of
 * the strip and west at the bottom, the map gets one broad open lobe, and the real drowned valleys
 * — which are excursions of 1-3 km ABOUT that diagonal — are squashed flat against the saturation.
 * That is exactly the "very bland, with a large amount of water" the owner rejected.
 *
 * Removing the drift is the same class of operation as `unfoldToMonotoneZ`: a shear that discards
 * the strip's arbitrary global orientation (we already chose to rotate the whole thing -90 degrees)
 * and keeps its local geometry bit for bit. Afterwards the drowned valleys stand out as ARMS
 * reaching east from a shore that runs north-south, which is what the west edge needs.
 *
 * The average is taken over z (trapezoid-weighted), NOT over vertices: OSM vertex density on this
 * ring swings by 20:1 between a mapped bay and an unmapped straight, and a per-vertex mean would
 * let the dense bays drag the trend into themselves and cancel their own crenellation.
 */
export function detrendAcrossShore(points: Pt[], windowM: number): { detrended: Pt[]; trend: number[] } {
  const n = points.length;
  const trend = new Array<number>(n).fill(0);
  if (n < 3) return { detrended: points.map((p) => ({ ...p })), trend };
  // STEP 1 — the strip's global TILT, as a z-weighted least-squares line. This is the one degree of
  // freedom that is purely an artefact of which slice of a round reservoir we cut, and removing it
  // costs no crenellation at all: a straight line has no bays. Everything after it is optional.
  {
    let w = 0; let sz = 0; let sx = 0; let szz = 0; let szx = 0;
    for (let i = 1; i < n; i++) {
      const dz = points[i]!.z - points[i - 1]!.z;
      const z = (points[i]!.z + points[i - 1]!.z) / 2;
      const x = (points[i]!.x + points[i - 1]!.x) / 2;
      w += dz; sz += z * dz; sx += x * dz; szz += z * z * dz; szx += z * x * dz;
    }
    const den = w * szz - sz * sz;
    if (w > 1e-6 && Math.abs(den) > 1e-6) {
      const slope = (w * szx - sz * sx) / den;
      const intercept = (sx - slope * sz) / w;
      for (let i = 0; i < n; i++) trend[i] = intercept + slope * points[i]!.z;
    }
  }
  const tilted = points.map((p, i) => ({ x: p.x - trend[i]!, z: p.z }));
  if (windowM <= 0) return { detrended: tilted, trend };
  // STEP 2 — residual low-frequency drift, over a window chosen to be much longer than the longest
  // arm worth keeping. A window SHORTER than an arm cancels that arm, which is the whole reason
  // this is a separate, tunable step rather than baked into the tilt removal above.
  points = tilted;
  // Trapezoid prefix integrals of x dz, so the window mean is an integral over z, not a vertex mean.
  const zs = points.map((p) => p.z);
  const cumZ = new Array<number>(n).fill(0);
  const cumXZ = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dz = zs[i]! - zs[i - 1]!;
    cumZ[i] = cumZ[i - 1]! + dz;
    cumXZ[i] = cumXZ[i - 1]! + ((points[i]!.x + points[i - 1]!.x) / 2) * dz;
  }
  /** Integral of x dz from the strip start up to an arbitrary z (linear inside a segment). */
  const upTo = (z: number): { z: number; xz: number } => {
    if (z <= zs[0]!) return { z: 0, xz: 0 };
    if (z >= zs[n - 1]!) return { z: cumZ[n - 1]!, xz: cumXZ[n - 1]! };
    let lo = 0; let hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (zs[mid]! <= z) lo = mid; else hi = mid; }
    const a = points[lo]!; const b = points[hi]!;
    const span = b.z - a.z;
    const t = span === 0 ? 0 : (z - a.z) / span;
    const xAt = a.x + (b.x - a.x) * t;
    return { z: cumZ[lo]! + (z - a.z), xz: cumXZ[lo]! + ((a.x + xAt) / 2) * (z - a.z) };
  };
  const half = windowM / 2;
  const drift = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    // The window SHRINKS at the two ends rather than clamping, so the trend hugs the data there and
    // the residual tapers to ~0 — which is what lets the run-out ramps start from a known level.
    const lo = upTo(zs[i]! - half);
    const hi = upTo(zs[i]! + half);
    const span = hi.z - lo.z;
    drift[i] = span > 1e-6 ? (hi.xz - lo.xz) / span : points[i]!.x;
  }
  for (let i = 0; i < n; i++) trend[i] += drift[i]!;
  return { detrended: points.map((p, i) => ({ x: p.x - drift[i]!, z: p.z })), trend };
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
  const unfolded = unfoldToMonotoneZ(source, DAM_UNFOLD_ALPHA, DAM_UNFOLD_TRACKING);
  // De-tilt: the strip's kilometre-scale drift goes, its drowned valleys stay (see detrendAcrossShore).
  const { detrended, trend } = detrendAcrossShore(unfolded, DAM_DETREND_WINDOW_M);
  const rawNorthZ = detrended[0]!.z;
  const rawSouthZ = detrended[detrended.length - 1]!.z;
  const scale = zSpan / (rawSouthZ - rawNorthZ);
  const rawMidZ = (rawNorthZ + rawSouthZ) / 2;
  const xRef = quantile(detrended.map((p) => p.x), DAM_SHORE_QUANTILE);

  // The unfold stands every backward-running stretch on end, which inflates the strip's z extent
  // (measured below) without touching its across-shore extent. Fitting one uniform factor after
  // that is NOT isotropic — it squashes every bay by exactly the inflation, which is why the
  // drowned valleys came out as shallow scallops. The gain multiplies the across-shore residual
  // back up; at DAM_CROSS_SHORE_GAIN = the inflation the fit is isotropic with the real dam again.
  const rawZExtent = Math.max(1, vaal.span.z);
  const unfoldInflation = (rawSouthZ - rawNorthZ) / rawZExtent;
  const gain = DAM_CROSS_SHORE_GAIN;
  const mapX = (x: number): number => {
    const d = (x - xRef) * scale * gain;
    return meanX + (d >= 0 ? softClip(d, DAM_REACH_EAST_M) : -softClip(-d, DAM_REACH_WEST_M));
  };
  const mapZ = (z: number): number => centreZ + (z - rawMidZ) * scale;

  const fitted: Pt[] = detrended.map((p) => ({ x: mapX(p.x), z: mapZ(p.z) }));

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
  const dropNorth = Math.max(0, fitted[0]!.x - target);
  const dropSouth = Math.max(0, fitted[fitted.length - 1]!.x - target);
  const zNorth = fitted[0]!.z; const zSouth = fitted[fitted.length - 1]!.z;
  const endRunOut = (z: number): number =>
    dropNorth * (1 - smoothstep((z - zNorth) / DAM_END_RUNOUT_M))
    + dropSouth * (1 - smoothstep((zSouth - z) / DAM_END_RUNOUT_M));
  for (const p of fitted) p.x -= endRunOut(p.z);

  /**
   * ADAPTIVE REDUCTION — the whole of C1. Douglas-Peucker in MAP metres on the fitted shore:
   * vertices survive where the shore turns and are dropped only where it is genuinely straight,
   * so the emitted segment lengths inherit the real coastline's 20:1 spread instead of the even
   * pitch a resample imposes. The only thing added back is a ceiling on segment length, which
   * subdivides straights (never bays) so the beach / road / runtime window samplers always find a
   * vertex nearby.
   */
  const reduced = capSegmentLength(simplifyPolyline(fitted, DAM_SHORE_TOLERANCE_M), DAM_SHORE_MAX_SEG_M);
  // Strictly increasing z: the unfold guarantees non-decreasing, but a zero-length real segment
  // can still emit a duplicate, and the runtime's binary-search sampler divides by (b.z - a.z).
  const grid: Pt[] = [];
  for (const p of reduced) {
    if (grid.length > 0 && p.z - grid[grid.length - 1]!.z < 1e-4) continue;
    grid.push(p);
  }

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
    // Everything grafted from the extract rides the SAME de-tilt as the shore (its nearest source
    // vertex's trend), or Deneysville's street grid lands a kilometre out into the water.
    return { x: mapX(p.x - trend[best]!) - endRunOut(z), z };
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

  // Segment-length spread is the proof that the reduction is adaptive rather than a resample: a
  // uniform pitch has a coefficient of variation near 0, a real shoreline's is well above 1.
  const segs: number[] = [];
  for (let i = 1; i < points.length; i++) segs.push(Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  const segMean = segs.reduce((s, v) => s + v, 0) / Math.max(1, segs.length);
  const segCv = Math.sqrt(segs.reduce((s, v) => s + (v - segMean) ** 2, 0) / Math.max(1, segs.length)) / Math.max(1e-6, segMean);
  const sortedSegs = [...segs].sort((a, b) => a - b);
  const sq = (q: number): number => sortedSegs[Math.max(0, Math.min(sortedSegs.length - 1, Math.round((sortedSegs.length - 1) * q)))] ?? 0;

  log.push(
    `dam: real Vaal north-shore strip ${(vaal.span.lengthM / 1000).toFixed(1)} km of shoreline over ` +
      `${(vaal.span.z / 1000).toFixed(1)} x ${(vaal.span.x / 1000).toFixed(1)} km of the real dam, ` +
      `fitted at 1:${(1 / scale).toFixed(1)} along-shore (unfold alpha ${DAM_UNFOLD_ALPHA} inflates z x${unfoldInflation.toFixed(2)}, ` +
      `across-shore gain ${gain} => 1:${(1 / (scale * gain)).toFixed(1)} across, source simplify ${DAM_SOURCE_SIMPLIFY_M} real m, ` +
      `de-tilt window ${(DAM_DETREND_WINDOW_M / 1000).toFixed(1)} km, ${source.length} source pts)`,
  );
  log.push(
    `dam: ${points.length}-pt shore (adaptive DP ${DAM_SHORE_TOLERANCE_M} map m, seg min ${sq(0).toFixed(0)} / ` +
      `median ${sq(0.5).toFixed(0)} / max ${sq(1).toFixed(0)} m, CV ${segCv.toFixed(2)}), x ${Math.round(minX)}..${Math.round(maxX)}, ` +
      `band z ${Math.round(fitted[0]!.z)}..${Math.round(fitted[fitted.length - 1]!.z)}, ` +
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
    mapPoint,
    mapPolygon,
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
  steps = 96,
): Pt[] {
  const south = shore.points[0]!;
  const north = shore.points[shore.points.length - 1]!;
  // The sweep's far boundary: `marginM` outside the world square on every side, and never east of
  // the shore ends themselves (the run-out has already taken those west of the square).
  const farWest = Math.min(world.minX, Math.min(north.x, south.x)) - marginM;
  const farNorth = Math.min(world.minZ, north.z) - marginM;
  const farSouth = Math.max(world.maxZ, south.z) + marginM;
  const out: Pt[] = [];
  // Quarter-arc off the north end: leaves N heading due north (continuing the coast) and arrives at
  // the far north-west heading due west. Both tangents are exact, so there is no corner at the join
  // and none at the far end either — it is one continuously turning curve, sampled densely.
  const quarter = Math.max(24, Math.round(steps / 2));
  // `bend` shapes how early the westward motion starts; 1 is a plain quarter-ellipse, which turns
  // continuously along its whole length. Pulling it below 1 was tried and is worse — it flattens the
  // arc into something very close to a straight diagonal.
  const bend = 1;
  for (let i = 1; i <= quarter; i++) {
    const a = ((i / quarter) * Math.PI) / 2;
    out.push({
      x: north.x + (farWest - north.x) * (1 - Math.cos(a)) ** bend,
      z: north.z + (farNorth - north.z) * Math.sin(a),
    });
  }
  // The far west run, subdivided so no single emitted segment is enormous.
  const west = Math.max(8, Math.round(steps / 3));
  for (let i = 1; i < west; i++) out.push({ x: farWest, z: farNorth + ((farSouth - farNorth) * i) / west });
  // Mirror-image quarter-arc back onto the south end.
  for (let i = 0; i <= quarter; i++) {
    const u = ((1 - i / quarter) * Math.PI) / 2; // pi/2 at the far south-west, 0 at the shore end
    out.push({
      x: south.x + (farWest - south.x) * (1 - Math.cos(u)) ** bend,
      z: south.z + (farSouth - south.z) * Math.sin(u),
    });
  }
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
