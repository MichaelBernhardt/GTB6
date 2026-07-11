import type { Collider } from '../world/City';

/** Pure GTA-V-style cover math against the city's AABB building colliders: nearest-face snap,
 *  slide clamping along the face, corner detection and peek eligibility. No three.js, no Game. */

export interface Vec2 { x: number; z: number; }
export interface CoverSpot {
  collider: Collider;
  normal: Vec2;        // outward from the wall face (unit, axis-aligned)
  tangent: Vec2;       // along the face, 90° left of the normal (unit)
  plane: number;       // face coordinate along the normal axis (dot(faceRef, normal))
  span: [number, number]; // face extent in tangent-axis coordinates, span[0] < span[1]
}

export const COVER_ENTER_RANGE = 2.5; // Q snaps to a wall face within this distance
export const COVER_GAP = 0.12;        // daylight between the wall and the player capsule
export const MIN_COVER_HEIGHT = 2.2;  // ledges shorter than the player are not cover
export const CORNER_HOLD = 0.6;       // within this of a face end counts as holding the corner
export const PEEK_STEP = 0.5;         // lateral step around the corner at full peek
export const PEEK_OUT = 0.18;         // slight outward shift so the lean clears the wall
export const COVER_EXIT_HOLD = 0.4;   // seconds of WASD held away from the wall before release
export const SLIDE_SPEED = 4.5;       // A/D crawl along the face, slower than a walk

interface Face { normal: Vec2; plane: number; span: [number, number]; }

function faces(box: Collider): Face[] {
  return [
    { normal: { x: 1, z: 0 }, plane: box.maxX, span: [box.minZ, box.maxZ] },   // t = z
    { normal: { x: -1, z: 0 }, plane: -box.minX, span: [-box.maxZ, -box.minZ] }, // t = -z
    { normal: { x: 0, z: 1 }, plane: box.maxZ, span: [-box.maxX, -box.minX] },   // t = -x
    { normal: { x: 0, z: -1 }, plane: -box.minZ, span: [box.minX, box.maxX] },   // t = x
  ];
}

/** Tangent is the normal rotated 90° so that (normal, tangent) is a consistent right-handed ground frame. */
export function tangentOf(normal: Vec2): Vec2 { return { x: -normal.z, z: normal.x }; }

/** Nearest wall face the point stands in front of (within its span) and within range of; undefined when exposed. */
export function nearestCoverSpot(x: number, z: number, colliders: readonly Collider[], range = COVER_ENTER_RANGE): CoverSpot | undefined {
  let best: CoverSpot | undefined; let bestDistance = range;
  for (const box of colliders) {
    if (box.height < MIN_COVER_HEIGHT) continue;
    for (const face of faces(box)) {
      const distance = x * face.normal.x + z * face.normal.z - face.plane;
      if (distance < 0 || distance > bestDistance) continue;
      const tangent = tangentOf(face.normal);
      const t = x * tangent.x + z * tangent.z;
      if (t < face.span[0] || t > face.span[1]) continue; // beyond the corner: no wall at your back
      best = { collider: box, normal: face.normal, tangent, plane: face.plane, span: face.span };
      bestDistance = distance;
    }
  }
  return best;
}

/** Cover is available whenever the character is grounded, regardless of the world's absolute elevation. */
export function nearestGroundedCoverSpot(x: number, z: number, grounded: boolean, colliders: readonly Collider[], range = COVER_ENTER_RANGE): CoverSpot | undefined {
  return grounded ? nearestCoverSpot(x, z, colliders, range) : undefined;
}

/** Tangential coordinate of a world point along the spot's face. */
export function coverT(spot: CoverSpot, x: number, z: number): number { return x * spot.tangent.x + z * spot.tangent.z; }

/** Slide clamping: the player capsule stays on the face, never past either corner. */
export function clampT(spot: CoverSpot, t: number, radius: number): number {
  const min = spot.span[0] + radius; const max = spot.span[1] - radius;
  if (min >= max) return (spot.span[0] + spot.span[1]) / 2; // face narrower than the player: pin to the middle
  return Math.min(max, Math.max(min, t));
}

/** World position flat against the wall at tangential coordinate t. */
export function coverPosition(spot: CoverSpot, t: number, radius: number): Vec2 {
  const out = spot.plane + radius + COVER_GAP;
  return { x: spot.normal.x * out + spot.tangent.x * t, z: spot.normal.z * out + spot.tangent.z * t };
}

/** -1/+1 when holding the low/high-t corner of the face, 0 mid-wall. A short face resolves to the nearer end. */
export function cornerSide(spot: CoverSpot, t: number, radius: number, hold = CORNER_HOLD): -1 | 0 | 1 {
  const clamped = clampT(spot, t, radius);
  const min = spot.span[0] + radius; const max = spot.span[1] - radius;
  const atLow = clamped <= min + hold; const atHigh = clamped >= max - hold;
  if (atLow && atHigh) return clamped - spot.span[0] <= spot.span[1] - clamped ? -1 : 1;
  return atLow ? -1 : atHigh ? 1 : 0;
}

/** Peek needs a corner to lean around; mid-wall aiming stays tucked (crosshair only, no exposure). */
export function peekEligible(spot: CoverSpot, t: number, radius: number, hold = CORNER_HOLD): boolean {
  return cornerSide(spot, t, radius, hold) !== 0;
}

/** Facing with your back flat to the wall: heading points along the outward normal. */
export function coverHeading(spot: CoverSpot): number { return Math.atan2(spot.normal.x, spot.normal.z); }

/** True when the (unnormalised) WASD world move points away from the wall — holding it releases cover. */
export function movingAway(move: Vec2, normal: Vec2): boolean {
  const length = Math.hypot(move.x, move.z);
  return length > 0 && (move.x * normal.x + move.z * normal.z) / length > 0.5;
}
