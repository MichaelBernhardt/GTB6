import type { Pt } from './types';

/** Perpendicular distance from `p` to the segment a-b. */
export function pointToSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/**
 * Douglas-Peucker polyline simplification. Endpoints are always preserved.
 * `tolerance` is the maximum allowed perpendicular deviation.
 */
export function simplifyPolyline(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = pointToSegmentDistance(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Douglas-Peucker on a CLOSED ring. A ring's first and last vertex coincide, so a single DP call
 * has a degenerate base segment and keeps nothing; the ring is split at the vertex farthest from
 * the first and each half is reduced. Like DP generally, this only ever DELETES vertices — it never
 * moves one and never invents one, which is why it is allowed on the imported dam outline.
 */
export function simplifyRing(ring: Pt[], tolerance: number): Pt[] {
  if (ring.length <= 4) return ring.slice();
  let far = 0; let fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i]!.x - ring[0]!.x) ** 2 + (ring[i]!.z - ring[0]!.z) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = simplifyPolyline(ring.slice(0, far + 1), tolerance);
  const b = simplifyPolyline(ring.slice(far), tolerance);
  return a.concat(b.slice(1));
}

/**
 * Simplify a polyline while pinning specific vertex indices (junctions):
 * the line is split at every pinned index and each piece is simplified
 * independently, so pinned vertices always survive.
 */
export function simplifyWithPins(points: Pt[], pinnedIndices: Set<number>, tolerance: number): Pt[] {
  const cuts = [0, ...[...pinnedIndices].filter((i) => i > 0 && i < points.length - 1).sort((a, b) => a - b), points.length - 1];
  const output: Pt[] = [];
  for (let c = 0; c < cuts.length - 1; c++) {
    const piece = simplifyPolyline(points.slice(cuts[c], cuts[c + 1] + 1), tolerance);
    for (let i = c === 0 ? 0 : 1; i < piece.length; i++) output.push(piece[i]);
  }
  return output;
}
