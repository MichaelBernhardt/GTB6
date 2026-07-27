/**
 * VAALPUNT DAM — the real Vaal Dam, COPIED WHOLESALE onto the map's west edge.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. Four passes tried to make a real shoreline fit by DEFORMING it:
 * an unfold drift, a de-tilt, a tanh soft-clip across the shore, a resample onto an even 35 m grid.
 * Every one of them destroyed the thing that made the source worth having. The owner's diagnosis was
 * the method, not the tuning: "You should possibly be copying the coastline from osm wholesale, and
 * then figuring out how to merge it cleanly with the other map."
 *
 * So this module now does exactly three things to the real geometry, and nothing else:
 *
 *   1. ONE UNIFORM SCALE  (DAM_SCALE, identical on both axes)
 *   2. ONE ROTATION       (DAM_ROTATION_DEG)
 *   3. ONE TRANSLATION    (DAM_ANCHOR lands on the world's west-edge midpoint)
 *
 * and then CLIPS the result against a box that lies wholly OUTSIDE the world square on the west,
 * north and south. There is deliberately no east clip: an east cut would be a straight edge in
 * frame, so the eastward reach is controlled by SELECTION — see tools/mapgen/search-placement.mjs,
 * which searched (scale, rotation, translation) exhaustively against the old ocean's measured
 * budget and picked this stretch. Selection is the only lever; nothing here bends a coordinate.
 *
 * WHAT COMES OUT. `water` is the real outline, and `islands` are the real inner rings — Grooteiland
 * (OSM way 6139539) among them. `envelope` is NOT the shoreline: it is a per-z eastmost-waterline
 * curve, derived from the polygon purely so the older x = f(z) helpers (the shore road hull, beach
 * placement, the border veld) keep working. What the player sees is the polygon.
 */
import {
  DAM_ANCHOR,
  DAM_CLIP_OVERSHOOT_M,
  DAM_ISLAND_MIN_AREA_M2,
  DAM_OVERHANG_M,
  DAM_ROAD_WANDER_M,
  DAM_ROAD_WANDER_WAVE_M,
  DAM_ROTATION_DEG,
  DAM_SCALE,
  DAM_SHORE_MAX_SEG_M,
  DAM_SHORE_STEP_M,
  DAM_SHORE_TOLERANCE_M,
  DAM_SOURCE_SIMPLIFY_M,
} from './config';
import { fbm, nameSeed } from './meander';
import { simplifyPolyline, simplifyRing } from './simplify';
import type { Pt } from './types';
import { toVaalFrame, type VaalFeature, type VaalStrip } from './vaal';

export interface DamShoreInput {
  /** Where the WORLD SQUARE'S WEST EDGE is expected to sit, projected metres. The placement is
   *  anchored to the edge, not to a mean shore x: the whole budget is measured from that edge. */
  worldWestX: number;
  /** Centre of the world square in z, projected metres. */
  centreZ: number;
  /** Half-height of the world square in z, projected metres — the clip box's north/south walls sit
   *  DAM_CLIP_OVERSHOOT_M beyond it, so no closing edge is ever in frame. */
  halfZ: number;
  /** The real Vaal (vaal.ts): water rings and shore furniture, projected, unrotated, unscaled. */
  vaal: VaalStrip;
}

export interface DamShore {
  /** THE WATER. The real Vaal outline under the similarity, clipped to the off-map box. */
  water: Pt[];
  /** Real island rings (Grooteiland first), same transform, same clip. */
  islands: Pt[][];
  /** The REAL waterline, as open polylines: the clipped rings minus the clip box's own walls. This
   *  is what the map strokes as "coast"; see realShorePieces. */
  shore: Pt[][];
  /** Derived eastmost-waterline curve, south -> north. NOT the shoreline; see the module header. */
  points: Pt[];
  /** z extent of the water inside/near the world square. */
  northZ: number;
  southZ: number;
  /** Mean of the derived envelope — kept for the callers that site things "on the shore". */
  meanX: number;
  minX: number;
  maxX: number;
  features: VaalFeature[];
  /** The one uniform scale. Map metres per real metre. */
  scale: number;
  sourceLengthM: number;
  /** The selected real stretch, rotated only — the reference an orientation histogram is graded
   *  against. A rotation and a uniform scale cannot change a histogram, so any difference between
   *  this and the emitted shore would be a deformation. There is none: they are the same curve. */
  sourceWindow: Pt[];
  /** Real point -> map point. A pure similarity. The second argument is accepted and IGNORED: it
   *  used to select a fold leaf, and there is no fold any more. */
  mapPoint: (p: Pt, anchor?: Pt) => Pt;
  mapPolygon: (pts: Pt[]) => Pt[];
  mapPolygonAnchored: (pts: Pt[], anchor?: Pt) => Pt[];
  /** Re-clip the placed water against a different (exact) world square — process.ts calls this once
   *  the fit is known, so the "no closing edge in frame" guarantee is measured, not hoped for. */
  clipTo: (world: { minX: number; maxX: number; minZ: number; maxZ: number }) => { water: Pt[]; islands: Pt[][]; shore: Pt[][] };
  log: string[];
}

// ---- geometry helpers ---------------------------------------------------------------------

/** Sutherland-Hodgman against one half-plane. The clip region is convex, so one ring comes out. */
function clipHalfPlane(poly: Pt[], inside: (p: Pt) => boolean, cut: (a: Pt, b: Pt) => Pt): Pt[] {
  if (poly.length === 0) return poly;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i + poly.length - 1) % poly.length]!;
    const b = poly[i]!;
    const ia = inside(a); const ib = inside(b);
    if (ib) { if (!ia) out.push(cut(a, b)); out.push(b); }
    else if (ia) out.push(cut(a, b));
  }
  return out;
}

/**
 * Clip to the off-map box: west, north and south only.
 *
 * D2, structurally. Every edge this introduces lies exactly ON a wall of the box, and all three
 * walls are outside the world square by construction, so a closing edge cannot be in frame. There
 * is no east wall — an east cut would be a straight line across open water in the middle of the
 * playable map, which is the defect three previous passes shipped in one form or another.
 */
export function clipToOffMapBox(poly: Pt[], box: { westX: number; northZ: number; southZ: number }): Pt[] {
  let cur = poly;
  cur = clipHalfPlane(cur, (p) => p.x >= box.westX,
    (a, b) => ({ x: box.westX, z: a.z + (b.z - a.z) * ((box.westX - a.x) / (b.x - a.x)) }));
  cur = clipHalfPlane(cur, (p) => p.z >= box.northZ,
    (a, b) => ({ x: a.x + (b.x - a.x) * ((box.northZ - a.z) / (b.z - a.z)), z: box.northZ }));
  cur = clipHalfPlane(cur, (p) => p.z <= box.southZ,
    (a, b) => ({ x: a.x + (b.x - a.x) * ((box.southZ - a.z) / (b.z - a.z)), z: box.southZ }));
  return cur;
}

/**
 * Split a clipped ring into the pieces that are REAL WATERLINE, dropping every segment that lies on
 * a wall of the clip box.
 *
 * R1's second straight line. The map strokes the water polygon to draw the coast, and the polygon
 * carries the clip's own walls, so the box's west wall came out as a bright ruler-straight coastline
 * across the off-map margin. A wall is not a shore and must not be drawn as one. Note this is a
 * RENDER-SIDE distinction only: the polygon that fills the water, floods the height field and tests
 * point-in-water is untouched, so nothing about the geometry changes.
 */
export function realShorePieces(
  ring: Pt[], box: { westX: number; northZ: number; southZ: number }, epsM = 0.5,
): Pt[][] {
  if (ring.length < 2) return [];
  const onWall = (a: Pt, b: Pt): boolean =>
    (Math.abs(a.x - box.westX) < epsM && Math.abs(b.x - box.westX) < epsM)
    || (Math.abs(a.z - box.northZ) < epsM && Math.abs(b.z - box.northZ) < epsM)
    || (Math.abs(a.z - box.southZ) < epsM && Math.abs(b.z - box.southZ) < epsM);
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!; const b = ring[(i + 1) % ring.length]!;
    if (onWall(a, b)) { if (cur.length >= 2) pieces.push(cur); cur = []; continue; }
    if (!cur.length) cur.push(a);
    cur.push(b);
  }
  if (cur.length >= 2) pieces.push(cur);
  // The walk starts at an arbitrary vertex, so a shore that crosses it arrives as two pieces whose
  // ends coincide. Rejoin them; a stroke with a seam in it shows at high zoom.
  if (pieces.length >= 2) {
    const first = pieces[0]!; const last = pieces[pieces.length - 1]!;
    if (Math.hypot(last[last.length - 1]!.x - first[0]!.x, last[last.length - 1]!.z - first[0]!.z) < epsM) {
      pieces[0] = last.concat(first.slice(1));
      pieces.pop();
    }
  }
  return pieces;
}

/** Signed area (positive = clockwise in this x/z frame). Used only to size and order islands. */
function ringArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j]!.x + pts[i]!.x) * (pts[j]!.z - pts[i]!.z);
  return Math.abs(s) / 2;
}

/** Every x where the horizontal line at `z` crosses the ring, sorted. */
function crossings(poly: Pt[], z: number): number[] {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!; const b = poly[j]!;
    if ((a.z > z) !== (b.z > z)) xs.push(a.x + (b.x - a.x) * ((z - a.z) / (b.z - a.z)));
  }
  return xs.sort((p, q) => p - q);
}

/** Subdivide long straights so window samplers always find a vertex nearby. Never touches bays. */
function capSegmentLength(points: Pt[], maxM: number): Pt[] {
  if (points.length < 2) return points.slice();
  const out: Pt[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / maxM));
    for (let k = 1; k <= steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps });
  }
  return out;
}

// ---- the placement ---------------------------------------------------------------------------

export function buildDamShore(input: DamShoreInput): DamShore {
  const { worldWestX, centreZ, halfZ, vaal } = input;
  const log: string[] = [];

  // Douglas-Peucker at a couple of real metres. This DELETES vertices, it never moves or invents
  // one, so the shape is still the source's; it just isn't carrying 29,514 points into the game.
  const outer = simplifyRing(vaal.outer, DAM_SOURCE_SIMPLIFY_M);

  // ONE uniform scale, ONE rotation, ONE translation. That is the whole transform.
  const k = DAM_SCALE;
  const th = (DAM_ROTATION_DEG * Math.PI) / 180;
  const cs = Math.cos(th); const sn = Math.sin(th);
  const anchor = toVaalFrame(DAM_ANCHOR.lat, DAM_ANCHOR.lon);
  const mapPoint = (p: Pt): Pt => {
    const dx = p.x - anchor.x; const dz = p.z - anchor.z;
    return { x: worldWestX + (dx * cs + dz * sn) * k, z: centreZ + (-dx * sn + dz * cs) * k };
  };
  const mapPolygon = (pts: Pt[]): Pt[] => pts.map((p) => mapPoint(p));

  const placedOuter = mapPolygon(outer);
  const placedIslands = vaal.islands.map((i) => ({ id: i.id, pts: mapPolygon(simplifyRing(i.points, DAM_SOURCE_SIMPLIFY_M)) }));

  const boxFor = (world: { minX: number; minZ: number; maxZ: number }): { westX: number; northZ: number; southZ: number } => ({
    westX: world.minX - DAM_OVERHANG_M,
    northZ: world.minZ - DAM_CLIP_OVERSHOOT_M,
    southZ: world.maxZ + DAM_CLIP_OVERSHOOT_M,
  });
  const clipTo = (world: { minX: number; maxX: number; minZ: number; maxZ: number }): { water: Pt[]; islands: Pt[][]; shore: Pt[][] } => {
    const box = boxFor(world);
    const water = clipToOffMapBox(placedOuter, box);
    const islands = placedIslands
      .map((i) => ({ id: i.id, pts: clipToOffMapBox(i.pts, box) }))
      // An island only ships if it is a real, visible piece of land inside the frame. Anything
      // smaller is sub-pixel at this scale, and an island drawn on dry veld is worse than none.
      .filter((i) => i.pts.length >= 3 && ringArea(i.pts) >= DAM_ISLAND_MIN_AREA_M2
        && i.pts.some((p) => p.x > world.minX && p.x < world.maxX && p.z > world.minZ && p.z < world.maxZ))
      .sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
    const shore = realShorePieces(water, box).concat(islands.flatMap((i) => realShorePieces(i.pts, box)));
    return { water, islands: islands.map((i) => i.pts), shore };
  };

  const provisionalWorld = { minX: worldWestX, maxX: worldWestX + 4 * halfZ, minZ: centreZ - halfZ, maxZ: centreZ + halfZ };
  const { water, islands, shore } = clipTo(provisionalWorld);
  if (water.length < 8) {
    throw new Error(`dam: the placement puts no water on the west edge — check DAM_ANCHOR / DAM_ROTATION_DEG / DAM_SCALE`);
  }

  // ---- the derived x = f(z) envelope ---------------------------------------------------------
  // Sampled per z ON PURPOSE: it exists only to answer "how far east does the water reach at this
  // latitude" for the shore road hull, the beach placement and the veld inner edge. The rendered
  // waterline is `water`, which is untouched real geometry.
  let wMinZ = Infinity; let wMaxZ = -Infinity;
  for (const p of water) { if (p.z < wMinZ) wMinZ = p.z; if (p.z > wMaxZ) wMaxZ = p.z; }
  const northZ = Math.max(wMinZ, provisionalWorld.minZ);
  const southZ = Math.min(wMaxZ, provisionalWorld.maxZ);
  const steps = Math.max(16, Math.round((southZ - northZ) / DAM_SHORE_STEP_M));
  const raw: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const z = northZ + ((southZ - northZ) * i) / steps;
    const xs = crossings(water, z);
    // eastmost waterline at this z; if the line misses the water entirely, fall back to the box
    raw.push({ x: xs.length ? xs[xs.length - 1]! : worldWestX - DAM_OVERHANG_M, z });
  }
  const envelope = capSegmentLength(simplifyPolyline(raw, DAM_SHORE_TOLERANCE_M), DAM_SHORE_MAX_SEG_M);
  const points = envelope.slice().reverse(); // south -> north, the order every consumer expects

  let minX = Infinity; let maxX = -Infinity;
  for (const p of water) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
  const meanX = envelope.reduce((s, p) => s + p.x, 0) / envelope.length;

  // measured, so the budget is in the build log rather than in a comment
  const worldW = provisionalWorld.maxX - provisionalWorld.minX;
  let wet = 0; let wetRows = 0; let reachSum = 0; let reachMax = 0;
  for (let i = 0; i <= steps; i++) {
    const z = northZ + ((southZ - northZ) * i) / steps;
    const xs = crossings(water, z);
    if (!xs.length) continue;
    const east = xs[xs.length - 1]!;
    if (east <= provisionalWorld.minX) continue;
    wetRows++;
    const reach = Math.min(east, provisionalWorld.maxX) - provisionalWorld.minX;
    reachSum += reach; if (reach > reachMax) reachMax = reach;
    for (let j = 0; j + 1 < xs.length; j += 2) {
      wet += Math.max(0, Math.min(xs[j + 1]!, provisionalWorld.maxX) - Math.max(xs[j]!, provisionalWorld.minX));
    }
  }

  log.push(
    `dam: WHOLESALE placement — one uniform scale ${k} (1:${(1 / k).toFixed(2)}, both axes), one rotation ` +
      `${DAM_ROTATION_DEG} deg, one translation (real ${DAM_ANCHOR.lat},${DAM_ANCHOR.lon} -> the world's west-edge ` +
      `midpoint). No fold, no de-tilt, no soft-clip, no resample, no run-out.`,
  );
  log.push(
    `dam: real outline ${vaal.outer.length} -> ${outer.length} pts (DP ${DAM_SOURCE_SIMPLIFY_M} real m), clipped to ` +
      `${water.length} pts west of x ${Math.round(worldWestX - DAM_OVERHANG_M)} and inside z ` +
      `${Math.round(provisionalWorld.minZ - DAM_CLIP_OVERSHOOT_M)}..${Math.round(provisionalWorld.maxZ + DAM_CLIP_OVERSHOOT_M)}; ` +
      `${islands.length} island(s) kept of ${vaal.islands.length} real inner rings`,
  );
  log.push(
    `dam: budget — water width ${Math.round(maxX - minX)} m, west overhang ${Math.round(worldWestX - minX)} m, ` +
      `mean reach ${Math.round(reachSum / Math.max(1, wetRows))} m, max reach ${Math.round(reachMax)} m, ` +
      `wet latitudes ${(100 * wetRows / (steps + 1)).toFixed(0)}%, water area ` +
      `${(100 * wet / Math.max(1, wetRows) / worldW * (wetRows / (steps + 1))).toFixed(1)}% of the world square`,
  );

  return {
    water,
    islands,
    shore,
    points,
    northZ,
    southZ,
    meanX,
    minX,
    maxX,
    features: vaal.features.map((f) => ({ ...f, p: mapPoint(f.p) })),
    scale: k,
    sourceLengthM: vaal.span.lengthM,
    // rotation only, no scale/translate: the histogram reference
    sourceWindow: outer.map((p) => ({ x: p.x * cs + p.z * sn, z: -p.x * sn + p.z * cs })),
    mapPoint: (p: Pt): Pt => mapPoint(p),
    mapPolygon,
    mapPolygonAnchored: (pts: Pt[]): Pt[] => mapPolygon(pts),
    clipTo,
    log,
  };
}

/**
 * The dam-shore road, as a MONOTONE-SAFE function of z rather than a perpendicular offset.
 *
 * offsetPolyline() folds catastrophically on a shore with drowned-valley arms — the road dives into
 * every inlet, self-intersects at the headlands and emits needle slivers. Instead: a running MAXIMUM
 * (eastmost) of the shore x over a window wider than the arms, plus the set-back, then smoothed. It
 * is single-valued in z by construction, can never cross the water, and reads as causeways across
 * the bay mouths — which is what a real dam-shore road does.
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
  const base: Pt[] = [];
  // THE FLOOR WANDERS. Where the water is far west there is no waterline for the hull to follow,
  // so the road fell back on a CONSTANT x and emitted a single 3,892-unit dead-straight segment
  // down the map — 5.3 km of ruler, which is the same defect class as the straight water cap, just
  // wearing a road's colours. The fallback is now a deterministic fBm wander that only ever runs
  // EAST of the dry line, so the running maximum below still guarantees the road cannot reach the
  // water: the clearance argument is unchanged, and the line is no longer a line.
  const wanderSeed = nameSeed('Dam Wal Road dry line');
  const wanderAt = (z: number): number =>
    DAM_ROAD_WANDER_M * (0.5 + 0.5 * fbm(wanderSeed, z / DAM_ROAD_WANDER_WAVE_M, 3));
  for (let i = steps; i >= 0; i--) {
    const z = span.northZ + ((span.southZ - span.northZ) * i) / steps;
    base.push({ x: Math.max(floorX, shoreByZ.inBand(z) ? shoreByZ.xAt(z) : -Infinity), z });
  }
  const window = Math.max(1, Math.round(windowM / DAM_SHORE_STEP_M));
  // The wander goes on AFTER the running maximum, never before: a hull whose window (960 m) is
  // comparable to the wander's wavelength simply takes the wander's peaks and flattens the troughs,
  // which is how the first attempt at this still emitted a 2.7 km straight.
  const hull: Pt[] = base.map((p, i) => {
    let east = p.x;
    for (let k = Math.max(0, i - window); k <= Math.min(base.length - 1, i + window); k++) {
      if (base[k]!.x > east) east = base[k]!.x;
    }
    return { x: east + setbackM + wanderAt(p.z), z: p.z };
  });
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
 * Re-clip the placed water against the EXACT world square.
 *
 * The closure is the clip box itself: three walls, all outside the square. There is no sweep, no
 * hook and no cap to hide any more — the old two-point horizontal closure (C4/D2) and the curved
 * sweep that replaced it are both gone, because a box that never enters the frame cannot show an
 * edge in the frame.
 */
export function buildDamPolygon(
  shore: DamShore,
  world: { minX: number; maxX: number; minZ: number; maxZ: number },
): Pt[] {
  return shore.clipTo(world).water;
}

/**
 * Envelope x at an arbitrary z, plus whether z is inside the dam's z band. Used by the composite
 * elevation pass and by everything that sites objects "along the shore".
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
