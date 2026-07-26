/**
 * SIGNED DISTANCE TO THE DAM'S WATERLINE.
 *
 * The map's west edge used to be modelled as x = f(z): one shoreline x per latitude, water to the
 * west of it. That is only true of a straight coast. The dam is a drowned dendritic river valley —
 * at one latitude you cross land, a flooded valley, a ridge peninsula, another valley, an island —
 * and a single x per z drowns every ridge and every island. Measured on the first wholesale build:
 * roughly 30 km2 of the west band came out as land the water polygon did not cover but the height
 * field had already put below the waterline, i.e. black sunken nothing.
 *
 * So the terrain now asks the real question: HOW FAR AM I FROM THE WATERLINE, AND WHICH SIDE?
 * Positive is land, negative is water. Peninsulas, islands and the channel behind Grooteiland all
 * come out right for free, and the beach/bed profile becomes a function of one scalar instead of
 * a special case per shape.
 *
 * IMPLEMENTATION. The polygon has ~5,600 vertices, so a per-query walk is out. Once, lazily, the
 * west band is rasterised at FIELD_STEP units: a scanline fill marks water, then a two-pass exact
 * Euclidean distance transform (Felzenszwalb & Huttenlocher) gives distance-to-boundary on both
 * sides. Queries are a bilinear sample. Cost is ~0.1 s and ~2 MB, once, and it is deterministic.
 */
import { DAM_ISLAND_RINGS, OCEAN_POLYGON, type MapPt } from './mapData';
import { WORLD_SIZE } from '../config';

/** Grid pitch in world units. The drawn ground mesh has ~70 u vertices, so 8 u is far finer than
 *  anything the terrain can express; it costs one 430k-cell float array. */
const FIELD_STEP = 8;
/** How far past the world square the field extends, so the bed sheet and the border veld both have
 *  a real distance to read instead of falling off the end of the array. */
const FIELD_MARGIN = 1200;
/** Distances are only ever used out to the inland blend, so the field is clamped there. */
export const DAM_FIELD_MAX = 900;

interface Field {
  x0: number; z0: number; cols: number; rows: number; step: number;
  /** Signed distance in world units. Positive = land. */
  d: Float32Array;
}
let field: Field | null | undefined;

/** 1-D squared-distance transform of a sampled function (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, zt: Float64Array): void {
  let k = 0;
  v[0] = 0; zt[0] = -Infinity; zt[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= zt[k]!) {
      k--;
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++; v[k] = q; zt[k] = s; zt[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zt[k + 1]! < q) k++;
    out[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}

/** Exact Euclidean distance (in cells) from every zero cell to the nearest non-zero cell. */
function edt2d(mask: Uint8Array, cols: number, rows: number, wantInside: boolean): Float32Array {
  const INF = 1e12;
  const f = new Float64Array(Math.max(cols, rows));
  const out = new Float64Array(Math.max(cols, rows));
  const v = new Int32Array(Math.max(cols, rows) + 1);
  const zt = new Float64Array(Math.max(cols, rows) + 2);
  const g = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) g[r * cols + c] = (mask[r * cols + c] === (wantInside ? 1 : 0)) ? 0 : INF;
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) f[r] = g[r * cols + c]!;
    edt1d(f, rows, out, v, zt);
    for (let r = 0; r < rows; r++) g[r * cols + c] = out[r]!;
  }
  const res = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) f[c] = g[r * cols + c]!;
    edt1d(f, cols, out, v, zt);
    for (let c = 0; c < cols; c++) res[r * cols + c] = Math.sqrt(out[c]!);
  }
  return res;
}

/** Sorted x crossings of a ring at this z. */
function crossings(ring: readonly MapPt[], z: number, into: number[]): number[] {
  into.length = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!; const b = ring[j]!;
    if ((a.z > z) !== (b.z > z)) into.push(a.x + (b.x - a.x) * ((z - a.z) / (b.z - a.z)));
  }
  into.sort((p, q) => p - q);
  return into;
}

function build(): Field | null {
  const ocean = OCEAN_POLYGON;
  if (!ocean || ocean.points.length < 4) return null;
  let minX = Infinity; let maxX = -Infinity;
  for (const p of ocean.points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
  const half = WORLD_SIZE / 2;
  const x0 = Math.max(-half - FIELD_MARGIN, minX - FIELD_MARGIN);
  const x1 = Math.min(half, maxX + DAM_FIELD_MAX + FIELD_MARGIN);
  const z0 = -half - FIELD_MARGIN; const z1 = half + FIELD_MARGIN;
  const cols = Math.ceil((x1 - x0) / FIELD_STEP) + 1;
  const rows = Math.ceil((z1 - z0) / FIELD_STEP) + 1;
  const mask = new Uint8Array(cols * rows);
  const xs: number[] = []; const isle: number[] = [];
  for (let r = 0; r < rows; r++) {
    const z = z0 + r * FIELD_STEP;
    const w = crossings(ocean.points, z, xs).slice();
    if (w.length < 2) continue;
    for (let i = 0; i + 1 < w.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((w[i]! - x0) / FIELD_STEP));
      const c1 = Math.min(cols - 1, Math.floor((w[i + 1]! - x0) / FIELD_STEP));
      for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
    }
    for (const ring of DAM_ISLAND_RINGS) {
      const s = crossings(ring, z, isle);
      for (let i = 0; i + 1 < s.length; i += 2) {
        const c0 = Math.max(0, Math.ceil((s[i]! - x0) / FIELD_STEP));
        const c1 = Math.min(cols - 1, Math.floor((s[i + 1]! - x0) / FIELD_STEP));
        for (let c = c0; c <= c1; c++) mask[r * cols + c] = 0;
      }
    }
  }
  const dOut = edt2d(mask, cols, rows, true);   // land cells: distance to the nearest water cell
  const dIn = edt2d(mask, cols, rows, false);   // water cells: distance to the nearest land cell
  const d = new Float32Array(cols * rows);
  const cap = DAM_FIELD_MAX;
  for (let i = 0; i < d.length; i++) {
    d[i] = mask[i] === 1
      ? -Math.min(cap, dIn[i]! * FIELD_STEP)
      : Math.min(cap, dOut[i]! * FIELD_STEP);
  }
  return { x0, z0, cols, rows, step: FIELD_STEP, d };
}

/** Signed distance from (x,z) to the dam's waterline in world units. Positive = land, negative =
 *  water. Anything comfortably inland returns DAM_FIELD_MAX, which is what the callers want. */
export function damSignedDistance(x: number, z: number): number {
  if (field === undefined) field = build();
  const f = field;
  if (!f) return DAM_FIELD_MAX;
  let c = (x - f.x0) / f.step; let r = (z - f.z0) / f.step;
  if (c < 0 || r < 0 || c > f.cols - 1 || r > f.rows - 1) return DAM_FIELD_MAX;
  const c0 = Math.floor(c); const r0 = Math.floor(r);
  const c1 = Math.min(f.cols - 1, c0 + 1); const r1 = Math.min(f.rows - 1, r0 + 1);
  const fx = c - c0; const fz = r - r0;
  const a = f.d[r0 * f.cols + c0]!; const b = f.d[r0 * f.cols + c1]!;
  const cc = f.d[r1 * f.cols + c0]!; const dd = f.d[r1 * f.cols + c1]!;
  return (a + (b - a) * fx) * (1 - fz) + (cc + (dd - cc) * fx) * fz;
}

/** True inside the dam (islands excluded). Cheap: the field already knows. */
export function inDamWater(x: number, z: number): boolean {
  return damSignedDistance(x, z) < 0;
}

/** Test hook: forget the cached field (used when a test swaps the map data). */
export function resetDamField(): void { field = undefined; }
