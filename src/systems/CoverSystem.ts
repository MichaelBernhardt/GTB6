import { PLAYER } from '../config';
import { colliderBase, colliderTop, type Collider } from '../world/City';

/** Pure GTA-V-style cover math against the city's building colliders (axis-aligned OR heading-rotated):
 *  nearest-face snap, slide clamping along the face, corner detection and peek eligibility. No three.js, no Game. */

export interface Vec2 { x: number; z: number; }
export interface CoverSpot {
  collider: Collider;
  normal: Vec2;        // outward from the wall face (unit; axis-aligned box → cardinal, rotated box → the face's true normal)
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

/** The four wall faces as (outward normal, plane, tangential span). All the cover math below is written in
 *  generic normal/tangent dot products, so this is the ONE spot that has to know a collider's orientation:
 *  an axis-aligned box yields the literal N/S/E/W faces, and a heading'd box yields its true rotated faces
 *  (each derived from the box centre, local half-extents and rotated local axes). */
function faces(box: Collider): Face[] {
  if (box.heading === undefined) return [
    { normal: { x: 1, z: 0 }, plane: box.maxX, span: [box.minZ, box.maxZ] },   // t = z
    { normal: { x: -1, z: 0 }, plane: -box.minX, span: [-box.maxZ, -box.minZ] }, // t = -z
    { normal: { x: 0, z: 1 }, plane: box.maxZ, span: [-box.maxX, -box.minX] },   // t = -x
    { normal: { x: 0, z: -1 }, plane: -box.minZ, span: [box.minX, box.maxX] },   // t = x
  ];
  const cx = (box.minX + box.maxX) / 2; const cz = (box.minZ + box.maxZ) / 2;
  const c = Math.cos(box.heading); const s = Math.sin(box.heading);
  const eX: Vec2 = { x: c, z: -s }; const eZ: Vec2 = { x: s, z: c }; // world directions of the box's local +x / +z axes
  const hw = box.hw!; const hd = box.hd!;
  // For an outward normal n with half-depth halfN and tangential half-width hT: plane = C·n + halfN, and the
  // face spans C·τ ± hT along τ = tangentOf(n). (Verified to reduce exactly to the axis-aligned literals above.)
  const face = (n: Vec2, halfN: number, hT: number): Face => {
    const t = tangentOf(n); const ct = cx * t.x + cz * t.z;
    return { normal: n, plane: cx * n.x + cz * n.z + halfN, span: [ct - hT, ct + hT] };
  };
  return [
    face(eX, hw, hd),
    face({ x: -eX.x, z: -eX.z }, hw, hd),
    face(eZ, hd, hw),
    face({ x: -eZ.x, z: -eZ.z }, hd, hw),
  ];
}

/** Tangent is the normal rotated 90° so that (normal, tangent) is a consistent right-handed ground frame. */
export function tangentOf(normal: Vec2): Vec2 { return { x: -normal.z, z: normal.x }; }

/** Nearest wall face the point stands in front of (within its span) and within range of; undefined when exposed.
 *  With feetY given, only faces whose vertical span actually shields a player at that elevation qualify: the wall
 *  must rise from underfoot to at least head-hiding height, so a podium below a rooftop player is no cover. */
export function nearestCoverSpot(x: number, z: number, colliders: readonly Collider[], range = COVER_ENTER_RANGE, feetY?: number): CoverSpot | undefined {
  let best: CoverSpot | undefined; let bestDistance = range;
  for (const box of colliders) {
    if (feetY === undefined ? box.height < MIN_COVER_HEIGHT
      : colliderBase(box) > feetY + PLAYER.stepUp || colliderTop(box) < feetY + MIN_COVER_HEIGHT) continue;
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

/** Cover is available whenever the character is grounded, regardless of the world's absolute elevation
 *  (the PR #34 gate); feetY additionally restricts candidates to faces that shield that elevation. */
export function nearestGroundedCoverSpot(x: number, z: number, grounded: boolean, colliders: readonly Collider[], range = COVER_ENTER_RANGE, feetY?: number): CoverSpot | undefined {
  return grounded ? nearestCoverSpot(x, z, colliders, range, feetY) : undefined;
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
