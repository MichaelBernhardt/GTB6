import { stablePositionRandom } from './StableRandom';

/**
 * THE OUTLINE OF A POTHOLE — one function, three consumers.
 *
 * A pothole is drawn by `City`, rattled over by `Game`, and scored by `JoziFlowSystem`, and all three
 * have to agree on where its edge is. A near-miss award for a gap the player can SEE they drove
 * through — or a wheel-alignment bill for tar that looks clear — is a worse bug than a round pothole.
 * So the silhouette lives here and the drawn geometry is nothing but it tessellated: `City` fans the
 * vertex radii, `Game` asks for the radius toward the car, `JoziFlowSystem` asks for the radius facing
 * the tyre line.
 *
 * What is measured is the DRAWN POLYGON, not the smooth curve behind it. Between two vertices the
 * renderer draws a chord, and on a lobed outline that chord falls up to 11% of `r` — 0.17u, most of
 * the 0.28u award gate — inside the curve. Scoring the curve would therefore charge the player for
 * tar that is visibly clear on exactly the shapes this change exists to create. `potholeRadiusAt`
 * returns the chord.
 *
 * `r` keeps its old meaning of a single honest scalar: the harmonics are mean-1 and the elongation is
 * AREA-PRESERVING (semi-axes r·stretch and r/stretch), so `r` remains the equivalent-area radius the
 * placement code has always taken it for — measured, the enclosed area stays within 9% of πr². What
 * changed is that nothing measures distance to a circle of that radius any more.
 *
 * Everything except the long axis is derived from the hole's own world position, so two players on
 * two machines get the identical hole with nothing stored, baked or sent — and `stablePositionRandom`
 * rather than the `Math.sin` hash `City` places with, because a one-ULP difference in a transcendental
 * must not be able to move a scored edge between machines. A hazard that MOVES would reshape itself;
 * potholes never do.
 *
 * The axis is the one thing a hole's coordinates cannot tell you: only the road network knows which
 * way the traffic that broke the tar was running.
 */
export interface PotholeHazard {
  readonly x: number;
  readonly z: number;
  /** Equivalent-area radius — the mean of the outline, not its maximum. */
  readonly r: number;
  /** Bearing of the long axis (the road), as `atan2(dz, dx)` to match the outline's own angle. */
  readonly axis?: number;
}

export interface PotholeRim {
  /** Inner edge of the broken-tar collar: the outline itself. Nothing is ever drawn over the hole. */
  readonly inner: number;
  /** Outer edge. Equal to the inner edge where the tar is still holding, and City draws nothing there. */
  readonly outer: number;
}

const TAU = Math.PI * 2;

/** Segments around the outline. The silhouette is the whole point of the shape, but these are drawn
 *  for every pothole in the 2 km chunk ring, so the count is a budget: see the tri counts in the
 *  commit. 20 puts a break every 18°, roughly a third of a metre of edge on a typical hole. */
export const POTHOLE_SEGMENTS = 20;
const SEGMENT_ARC = TAU / POTHOLE_SEGMENTS;
const SEGMENT_SINE = Math.sin(SEGMENT_ARC);

/** Radial harmonics: one big off-centre lobe, then progressively finer breaks in the tar. Mean 1, so
 *  they redistribute the outline around `r` rather than inflating it. */
const LOBES: ReadonlyArray<{ harmonic: number; amplitude: number; salt: number }> = [
  { harmonic: 1, amplitude: 0.14, salt: 72 },
  { harmonic: 2, amplitude: 0.10, salt: 73 },
  { harmonic: 3, amplitude: 0.07, salt: 74 },
  { harmonic: 5, amplitude: 0.04, salt: 75 },
];
const LOBE_SPAN = LOBES.reduce((total, lobe) => total + lobe.amplitude, 0);

/** Water and tyres break tar ALONG the lane, so the hole is stretched down the road it sits in. */
const MIN_STRETCH = 1.1;
const STRETCH_RANGE = 0.3;

/** Nothing can reach past `r ×` this. Lets the per-frame hit test reject on a squared distance
 *  without hashing anything, which is what keeps a 1361-pothole linear scan cheap. */
export const POTHOLE_MAX_RADIUS_FACTOR = (MIN_STRETCH + STRETCH_RANGE) * (1 + LOBE_SPAN);

/** Broken-tar collar. Swings negative on purpose: a real rim is wide where the edge has crumbled and
 *  absent where the tar still holds, not a uniform 1.22× band. */
const RIM_BASE = 0.13;
const RIM_SWING = 0.20;
const RIM_RIPPLE = 0.08;
/** Below this the collar has closed up entirely and City draws no quad there at all. */
export const RIM_MIN_SPAN = 0.012;

/** The smooth curve the drawn polygon is sampled from. Deliberately NOT exported: nothing should ever
 *  measure a clearance against an edge the renderer does not draw. */
function smoothRadius(hole: PotholeHazard, angle: number): number {
  const delta = angle - (hole.axis ?? 0);
  const stretch = MIN_STRETCH + stablePositionRandom(hole.x, hole.z, 71) * STRETCH_RANGE;
  // Area-preserving ellipse with semi-axes stretch and 1/stretch, in units of r.
  const ellipse = 1 / Math.hypot(Math.cos(delta) / stretch, Math.sin(delta) * stretch);
  let lobes = 1;
  for (const lobe of LOBES) {
    lobes += lobe.amplitude * Math.cos(lobe.harmonic * delta + stablePositionRandom(hole.x, hole.z, lobe.salt) * TAU);
  }
  return hole.r * ellipse * lobes;
}

/** Outline radius at tessellation vertex `segment` — the sample City turns into a triangle fan. */
export function potholeVertexRadius(hole: PotholeHazard, segment: number): number {
  return smoothRadius(hole, segment * SEGMENT_ARC);
}

/** Radius of the DRAWN silhouette at a world angle (`atan2(dz, dx)`): the chord between the two
 *  vertices either side of it, which is the edge the player is actually looking at. */
export function potholeRadiusAt(hole: PotholeHazard, angle: number): number {
  const segment = Math.floor(angle / SEGMENT_ARC);
  const start = segment * SEGMENT_ARC;
  // Harmonics of an integer multiple of the angle: sampling at start and start + arc is identical
  // whichever turn of the circle `angle` came off, so atan2's [-π, π) needs no normalising.
  const from = smoothRadius(hole, start);
  const to = smoothRadius(hole, start + SEGMENT_ARC);
  // Polar equation of the line through (from, start) and (to, start + arc).
  return (from * to * SEGMENT_SINE) / (from * Math.sin(angle - start) + to * Math.sin(start + SEGMENT_ARC - angle));
}

/** Outline radius toward a direction — the form every gameplay caller wants. Not normalised. */
export function potholeRadiusToward(hole: PotholeHazard, dirX: number, dirZ: number): number {
  return potholeRadiusAt(hole, Math.atan2(dirZ, dirX));
}

/**
 * The collar's two edges at tessellation vertex `segment`, in world units from the hole's centre.
 *
 * Nothing is drawn INSIDE the outline. An earlier pass gave the collar an inner lip at the end the
 * tyres strike, as a suggestion of a broken-down ramp rather than a clean edge; from above it turned
 * a stretched hole into a wedge with a straight grey chord across it, and from the driver's eye — the
 * only view that matters at 60 km/h — the collar is barely legible at all, let alone anything inside
 * the hole. So the dark silhouette IS the outline, unobscured, and the collar sits entirely outside it.
 */
export function potholeRimAt(hole: PotholeHazard, segment: number): PotholeRim {
  const delta = segment * SEGMENT_ARC - (hole.axis ?? 0);
  const radius = potholeVertexRadius(hole, segment);
  const collarPhase = stablePositionRandom(hole.x, hole.z, 76) * TAU;
  const ripplePhase = stablePositionRandom(hole.x, hole.z, 77) * TAU;
  const collar = Math.max(0, RIM_BASE + RIM_SWING * Math.cos(delta + collarPhase) + RIM_RIPPLE * Math.cos(2 * delta + ripplePhase));
  return { inner: radius, outer: radius * (1 + collar) };
}
