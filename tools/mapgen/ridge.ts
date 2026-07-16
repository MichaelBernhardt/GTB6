/**
 * The Ukhahlamba Rand: a synthetic fractal mountain range across the map's far north (owner
 * note: "Make a tall hill range by biasing the map altitudes towards an organic range point...
 * 1/3 the way from the left, on a bit of an angle up towards the right... The top part of the
 * mountains can be snowy").
 *
 * The range is an analytic field in GAME-UNIT space: a crest polyline rising from ~1/3 in from
 * the west edge at mid-map height up toward the top-right corner, with an fBm-wobbled crest
 * line, fBm-varied peak heights along the arc, an asymmetric cross-profile (steep dramatic face
 * to the south, broad shoulder running off the north edge) and a 2-D value-noise detail field
 * for natural-looking contours. Influence tapers smoothly to ZERO south of the northern suburbs
 * and west of the rural corridor, so the CBD, corridor and coast never feel it. Deterministic —
 * no Math.random anywhere (pipeline contract).
 */
import { fbm } from './meander';
import type { Pt } from './types';

/** Hash a 2-D integer lattice point into [-1, 1] (deterministic, no RNG state). */
function hashLattice2(seed: number, ix: number, iz: number): number {
  const s = Math.sin(ix * 127.1 + iz * 269.5 + seed * 419.2) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

const smootherstep = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const smoothstep = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** 2-D value noise in [-1, 1], smooth between integer lattice points. */
function valueNoise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x); const iz = Math.floor(z);
  const fx = smootherstep(x - ix); const fz = smootherstep(z - iz);
  const a = hashLattice2(seed, ix, iz); const b = hashLattice2(seed, ix + 1, iz);
  const c = hashLattice2(seed, ix, iz + 1); const d = hashLattice2(seed, ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** 2-D fractional Brownian motion in ~[-1, 1]: a few octaves of 2-D value noise. */
export function fbm2(seed: number, x: number, z: number, octaves = 4): number {
  let sum = 0; let amp = 1; let freq = 1; let norm = 0;
  for (let o = 0; o < octaves; o++) { sum += amp * valueNoise2(seed + o * 31.7, x * freq, z * freq); norm += amp; amp *= 0.5; freq *= 2.03; }
  return sum / norm;
}

const RIDGE_SEED = 7331;

/** Approximate top-ridge line: from 1/3 in from the west edge at mid-map height, angling up
 *  toward (and off) the top-right corner. North is -z; the last vertex sits past the east edge
 *  so the range never "comes down" at the map boundary. */
export const RIDGE_CREST: Pt[] = [
  { x: -3200, z: -3300 },
  { x: -400, z: -7300 },
  { x: 3600, z: -9000 },
  { x: 9900, z: -9700 },
];

/** Peak crest height ADDED to the base terrain, metres (before along-arc/detail variation). */
export const RIDGE_PEAK_M = 1250;
/** Hard ceiling on the added ridge metres, so stacked noise multipliers can't spike the composite. */
export const RIDGE_MAX_M = 1480;
/** Cross-profile half-widths (game units): a steep face to the south, a broad northern shoulder. */
export const RIDGE_HALF_WIDTH_SOUTH = 1550;
export const RIDGE_HALF_WIDTH_NORTH = 2650;
/** Influence is EXACTLY zero south of this z and fades in full by RIDGE_FULL_Z (CBD guard). */
export const RIDGE_ZERO_Z = -1600;
export const RIDGE_FULL_Z = -3100;
/** Influence is exactly zero west of this x (rural corridor / coast guard; corridor east ~ -4665). */
export const RIDGE_ZERO_X = -4500;

interface CrestHit { arc: number; d: number; }

const CREST_SEGS = RIDGE_CREST.slice(0, -1).map((a, i) => {
  const b = RIDGE_CREST[i + 1]!; const len = Math.hypot(b.x - a.x, b.z - a.z);
  return { a, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, len };
});
const CREST_ARC0 = CREST_SEGS.reduce<number[]>((acc, seg) => { acc.push(acc[acc.length - 1]! + seg.len); return acc; }, [0]);
export const RIDGE_CREST_LENGTH = CREST_ARC0[CREST_ARC0.length - 1]!;

/** Closest point on the crest polyline: arc length along it + SIGNED perpendicular distance
 *  (positive = south-east flank, negative = north-west shoulder). */
function crestAt(x: number, z: number): CrestHit {
  let best: CrestHit = { arc: 0, d: Infinity }; let bestAbs = Infinity;
  for (let i = 0; i < CREST_SEGS.length; i++) {
    const seg = CREST_SEGS[i]!;
    const px = x - seg.a.x; const pz = z - seg.a.z;
    const t = Math.max(0, Math.min(seg.len, px * seg.ux + pz * seg.uz));
    const dx = px - seg.ux * t; const dz = pz - seg.uz * t;
    const abs = Math.hypot(dx, dz);
    if (abs < bestAbs) { bestAbs = abs; best = { arc: CREST_ARC0[i]! + t, d: dx * -seg.uz + dz * seg.ux }; }
  }
  return best;
}

/**
 * Metres of mountain added to the base terrain at a game-unit point. Zero across most of the
 * map (everything south of RIDGE_ZERO_Z or west of RIDGE_ZERO_X); rises organically toward the
 * fBm-wobbled crest with intensity growing toward the top edge.
 */
export function ridgeMetresAt(x: number, z: number): number {
  const gateSouth = smoothstep((RIDGE_ZERO_Z - z) / (RIDGE_ZERO_Z - RIDGE_FULL_Z));
  const gateWest = smoothstep((x - RIDGE_ZERO_X) / 1100);
  if (gateSouth <= 0 || gateWest <= 0) return 0;
  const { arc, d } = crestAt(x, z);
  // The crest meanders: an fBm lateral offset moves the ridge top so no straight line survives.
  const dEff = d - fbm(RIDGE_SEED, arc / 3400, 3) * 620;
  const halfWidth = (dEff >= 0 ? RIDGE_HALF_WIDTH_SOUTH : RIDGE_HALF_WIDTH_NORTH) * (1 + 0.3 * fbm(RIDGE_SEED + 3, arc / 2600, 2));
  const s = Math.abs(dEff) / halfWidth;
  if (s >= 1) return 0;
  const profile = Math.pow(0.5 * (1 + Math.cos(Math.PI * s)), 1.15); // smooth bell, slightly peaked at the top
  // Intensity grows toward the top edge: the south-western tail emerges as gentle foothills and the
  // range only reaches full height near the north boundary (the street grid keeps modest relief).
  const envelope = smoothstep(arc / 5200) * smoothstep((-z - 2200) / 6200);
  const ridged = 1 - Math.abs(fbm(RIDGE_SEED + 7, arc / 2100, 3)); // ridged fBm: distinct peaks and saddles along the top
  const peakVar = 0.68 + 0.5 * Math.pow(ridged, 1.3);
  const detail = 0.62 + 0.5 * (fbm2(RIDGE_SEED + 13, x / 1350, z / 1350, 4) * 0.5 + 0.5); // fractal contours on the flanks
  return Math.min(RIDGE_MAX_M, RIDGE_PEAK_M * envelope * gateSouth * gateWest * peakVar * profile * detail);
}
