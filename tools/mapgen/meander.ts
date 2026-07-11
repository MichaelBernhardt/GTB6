/**
 * Organic curvature for the SYNTHETIC roads (owner note: "The Egoli and Plaaspad are far
 * too straight and should look a bit more meandering and organic").
 *
 * Deterministic perpendicular value-noise (fBm, 2-3 octaves) is laid along each road's arc
 * length, tapered to zero near every pinned vertex (junction attachment points), then the
 * densified result is Chaikin-smoothed span-by-span so the curves stay gentle and drivable
 * with no kinks. No Math.random anywhere — same seed in, same polyline out.
 */
import type { Pt } from './types';

/** Hash an integer lattice index into [-1, 1] (deterministic, no RNG state). */
function hashLattice(seed: number, i: number): number {
  const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

const smootherstep = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** 1-D value noise in [-1, 1], smooth (C2) between integer lattice points. */
function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hashLattice(seed, i);
  const b = hashLattice(seed, i + 1);
  return a + (b - a) * smootherstep(f);
}

/** Fractional Brownian motion: a few octaves of value noise, normalised to ~[-1, 1]. */
export function fbm(seed: number, x: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(seed + o * 17.13, x * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Stable seed from a road name so each road gets its own (repeatable) wobble. */
export function nameSeed(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

export interface MeanderOptions {
  /** Peak perpendicular offset (metres). */
  amplitude: number;
  /** Base noise wavelength (metres) — larger = gentler, lower-frequency curves. */
  wavelength: number;
  /** fBm octaves (2-3). */
  octaves?: number;
  /** Deterministic seed. */
  seed: number;
  /** Densify spacing before offsetting (metres). */
  step?: number;
  /** Amplitude ramps from 0 to full over this distance from the nearest pin (metres). */
  taper?: number;
  /** Chaikin corner-cutting passes per span (endpoints preserved). */
  chaikin?: number;
}

/** One meander output vertex; `pin` is the source index when it reuses a pinned node. */
export interface MeanderVertex {
  p: Pt;
  pin: number | null;
}

/** Chaikin corner-cutting that preserves the first and last vertex exactly. */
function chaikin(points: Pt[], passes: number): Pt[] {
  let pts = points;
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 3) break;
    const out: Pt[] = [pts[0]!];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    out.push(pts[pts.length - 1]!);
    pts = out;
  }
  return pts;
}

/** Resample a polyline at ~`step` m spacing, returning point + unit perpendicular + arc len. */
function densify(points: Pt[], step: number): Array<{ p: Pt; nx: number; nz: number; s: number }> {
  const out: Array<{ p: Pt; nx: number; nz: number; s: number }> = [];
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen < 1e-6) continue;
    const tx = (b.x - a.x) / segLen;
    const tz = (b.z - a.z) / segLen;
    const nx = -tz;
    const nz = tx;
    const steps = Math.max(1, Math.round(segLen / step));
    const last = i === points.length - 2;
    for (let k = 0; k < steps + (last ? 1 : 0); k++) {
      const t = Math.min(1, (k * step) / segLen);
      out.push({ p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, nx, nz, s: acc + t * segLen });
    }
    acc += segLen;
  }
  if (out.length === 0) out.push({ p: points[0]!, nx: 0, nz: 0, s: 0 });
  return out;
}

/**
 * Meander a polyline: perpendicular fBm offset along the arc, tapered to zero at each pinned
 * vertex, densified and Chaikin-smoothed per span. Pinned vertices keep their exact position
 * (so shared/junction nodes stay connected); private interior vertices become new points.
 *
 * `pins` are indices into `points` that must not move (always includes 0 and the last index).
 */
export function meanderPolyline(points: Pt[], pins: number[], opt: MeanderOptions): MeanderVertex[] {
  if (points.length < 2) return points.map((p, i) => ({ p, pin: i }));
  const octaves = opt.octaves ?? 3;
  const step = opt.step ?? 90;
  const taper = opt.taper ?? Math.min(opt.wavelength * 0.5, 220);
  const passes = opt.chaikin ?? 2;

  const pinSet = new Set(pins);
  pinSet.add(0);
  pinSet.add(points.length - 1);
  const ordered = [...pinSet].sort((a, b) => a - b);

  // Cumulative arc length at each original vertex (for coherent global noise phase).
  const arc: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    arc.push(arc[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  }

  const out: MeanderVertex[] = [{ p: { ...points[ordered[0]!]! }, pin: ordered[0]! }];
  for (let k = 0; k < ordered.length - 1; k++) {
    const a = ordered[k]!;
    const b = ordered[k + 1]!;
    const span = points.slice(a, b + 1);
    const spanStartArc = arc[a]!;
    const spanLen = arc[b]! - spanStartArc;
    const samples = densify(span, step);
    // Offset every sample except the two span ends (kept exactly on the pins).
    const offset: Pt[] = samples.map((sample, idx) => {
      if (idx === 0 || idx === samples.length - 1) return sample.p;
      const distToPin = Math.min(sample.s, spanLen - sample.s);
      const amp = opt.amplitude * Math.min(1, distToPin / Math.max(1, taper));
      const d = amp * fbm(opt.seed, (spanStartArc + sample.s) / opt.wavelength, octaves);
      return { x: sample.p.x + sample.nx * d, z: sample.p.z + sample.nz * d };
    });
    const smoothed = chaikin(offset, passes);
    // Drop the first point (already emitted as the previous span's end / this span's start pin),
    // emit interior points as new nodes, and the last point as pin `b`.
    for (let i = 1; i < smoothed.length - 1; i++) out.push({ p: smoothed[i]!, pin: null });
    out.push({ p: { ...points[b]! }, pin: b });
  }
  return out;
}
