/**
 * The Ukhahlamba Rand: a synthetic fractal mountain range across the map's far north (owner
 * note: "Make a tall hill range by biasing the map altitudes towards an organic range point...
 * 1/3 the way from the left, on a bit of an angle up towards the right... The top part of the
 * mountains can be snowy").
 *
 * The range is an analytic field over PROJECTED METRES: a crest polyline running north-west out
 * of the Westcliff ridge, along the Melville Koppies / Northcliff koppie chain and off the north
 * edge, with an fBm-wobbled crest line, an explicit summit arc, an asymmetric cross-profile
 * (steep face to the south, broad shoulder to the north) and a 2-D value-noise detail field for
 * natural-looking contours. Influence tapers smoothly to ZERO south of the northern suburbs and
 * west of the rural corridor, so the CBD, corridor and dam never feel it. Deterministic — no
 * Math.random anywhere (pipeline contract).
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

/**
 * EVERY CONSTANT BELOW IS IN PROJECTED METRES relative to CBD_CENTER (+x east, +z south), NOT
 * game units. It used to be game units, which silently broke the moment TARGET_SIZE changed:
 * the old crest reached x 9900 / z -9700, so in a ~10,000-unit world three of its four vertices
 * were off-map and the range vanished while the tests kept passing by sampling coordinates
 * outside the world. compositeElevation now calls ridgeMetresAt(m.x, m.z) with the projected
 * point, so the range is immune to TARGET_SIZE and to future re-crops.
 *
 * SITING (owner: "a natural place to put the mountain is where there are already tracks, which
 * would nicely work as mountain tracks", and it should be "pulled down closer to the CBD").
 *
 * Only highway=track RENDERS — mapData.ts:218 filters highway=path out — so the siting is
 * measured on tracks alone, length-weighted in 900 m cells over the emitted map. Two clusters
 * carry almost all of it:
 *
 *   A  Melville Koppies West Trail       m(-5200,-4030)   ~2.3 km   (lat -26.169, lon 27.991)
 *   B  Northcliff / Blackheath koppies   m(-4270,-5450)   ~4.4 km   (lat -26.157, lon 28.000)
 *
 * which is the Northcliff ridge: the real WSW-ENE quartzite spine and the highest ground in
 * Johannesburg. The crest runs along it. The previous cut aimed at the same chain but put its
 * summit at m(-5113,-8407) — 7,609 units from the CBD, 76.9% of the world width, FURTHER out as
 * a fraction than the pre-shrink map's 71.2% — because the height envelope only reached full
 * strength near z = -7,000, north of both clusters, where the tracks have run out. The height
 * is now driven along the crest by an explicit summit arc (RIDGE_SUMMIT_ARC_M) that sits on
 * cluster B, and the range leaves the north edge at RIDGE_TAIL_FRACTION of full height rather
 * than climbing to a peak out there.
 */
export const RIDGE_CREST: Pt[] = [
  { x: -1800, z: -1800 },   // south-east toe: Westcliff ridge, 2.5 km north-west of the CBD
  { x: -3300, z: -2900 },   // Auckland Park / Brixton
  { x: -4750, z: -4100 },   // cluster A: Melville Koppies
  { x: -4200, z: -5400 },   // cluster B: Northcliff / Blackheath  <- the summit
  { x: -4500, z: -7300 },   // Randpark / Ferndale shoulder
  { x: -5000, z: -10600 },  // runs off the north edge so the range never "comes down"
];

/** Peak crest height ADDED to the base terrain, metres (before along-arc/detail variation). */
export const RIDGE_PEAK_M = 1250;
/** Hard ceiling on the added ridge metres, so stacked noise multipliers can't spike the composite. */
export const RIDGE_MAX_M = 1480;
/**
 * Cross-profile half-widths (METRES): a steep face to the south, a broad northern shoulder.
 * Widened 2.05x from 1200/1900 — the previous cut was, in the previous agent's own words,
 * "narrower than I would like, a distinct ridge rather than a range". At 2500/3800 the massif
 * is 6.3 km across instead of 3.1 km and its footprint over the world square goes 6.9% -> 14.1%,
 * which at the same 1,250 m crest also halves the mean flank gradient, so the koppie tracks on
 * it are drivable rather than a wall.
 */
export const RIDGE_HALF_WIDTH_SOUTH = 2500;
export const RIDGE_HALF_WIDTH_NORTH = 3800;
/** Influence is EXACTLY zero south of this z and fades in full by RIDGE_FULL_Z (CBD guard). */
export const RIDGE_ZERO_Z = -1200;
export const RIDGE_FULL_Z = -3400;
/** Influence is exactly zero west of this x — the rural corridor / dam guard (corridor east
 *  sits at the city's own west edge, around -5,900 m at the current crop). The wider range
 *  needs a wider fade or its northern shoulder stops dead at the farmland. */
export const RIDGE_ZERO_X = -6000;
export const RIDGE_WEST_FADE_M = 1600;
/**
 * Along-crest height profile. `arc` is metres along RIDGE_CREST from the south-east toe.
 * Full height at the summit arc, which is planted on track cluster B; the tail settles to
 * RIDGE_TAIL_FRACTION so the range is still a massif where it leaves the map.
 */
export const RIDGE_RISE_ARC_M = 4300;
export const RIDGE_SUMMIT_ARC_M = 5300;
export const RIDGE_TAIL_ARC_M = 2600;
export const RIDGE_TAIL_FRACTION = 0.58;

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
 * Metres of mountain added to the base terrain at a PROJECTED-METRE point (x east, z south,
 * origin CBD_CENTER). Zero across most of the map (everything south of RIDGE_ZERO_Z or west of
 * RIDGE_ZERO_X); rises organically toward the fBm-wobbled crest with intensity growing north.
 */
export function ridgeMetresAt(x: number, z: number): number {
  const gateSouth = smoothstep((RIDGE_ZERO_Z - z) / (RIDGE_ZERO_Z - RIDGE_FULL_Z));
  const gateWest = smoothstep((x - RIDGE_ZERO_X) / RIDGE_WEST_FADE_M);
  if (gateSouth <= 0 || gateWest <= 0) return 0;
  const { arc, d } = crestAt(x, z);
  // The crest meanders: an fBm lateral offset moves the ridge top so no straight line survives.
  const dEff = d - fbm(RIDGE_SEED, arc / 3400, 3) * 620;
  const halfWidth = (dEff >= 0 ? RIDGE_HALF_WIDTH_SOUTH : RIDGE_HALF_WIDTH_NORTH) * (1 + 0.3 * fbm(RIDGE_SEED + 3, arc / 2600, 2));
  const s = Math.abs(dEff) / halfWidth;
  if (s >= 1) return 0;
  const profile = Math.pow(0.5 * (1 + Math.cos(Math.PI * s)), 1.15); // smooth bell, slightly peaked at the top
  // Along-crest intensity: gentle foothills at the south-east toe, full height at the summit
  // arc (planted on the densest highway=track cluster), then a settled massif running off the
  // north edge. The old form multiplied by smoothstep((-z - 1800) / 5200), which only saturated
  // north of z = -7,000 and therefore put the peak past every track on the map.
  const envelope = smoothstep(arc / RIDGE_RISE_ARC_M)
    * (1 - (1 - RIDGE_TAIL_FRACTION) * smoothstep((arc - RIDGE_SUMMIT_ARC_M) / RIDGE_TAIL_ARC_M));
  const ridged = 1 - Math.abs(fbm(RIDGE_SEED + 7, arc / 2100, 3)); // ridged fBm: distinct peaks and saddles along the top
  const peakVar = 0.68 + 0.5 * Math.pow(ridged, 1.3);
  const detail = 0.62 + 0.5 * (fbm2(RIDGE_SEED + 13, x / 1350, z / 1350, 4) * 0.5 + 0.5); // fractal contours on the flanks
  return Math.min(RIDGE_MAX_M, RIDGE_PEAK_M * envelope * gateSouth * gateWest * peakVar * profile * detail);
}
