import { foundationTiers, roundedBoxRadius, type BuildingProfile, type GableSpec, type MassingBox, type MassingTier } from './BuildingArchitecture';

/**
 * Coincident-face detection over a building's massing — the guard against two facade quads on one
 * plane.
 *
 * Two same-facing faces on (or within a hair of) the same plane, drawn from one material, give the
 * depth test nothing to break the tie with: which face wins is decided per-triangle and changes
 * with viewpoint, so the wall crawls and flickers as the player moves — and because each box bakes
 * its own facade UV origin, the two grids are usually phase-shifted, so every window is drawn
 * twice. This is exactly how the MARTIAL x SMAL corner tower shipped 925 u² of fighting wall: its
 * L-plan's two ground tiers both computed their -X flank as x - w/2.
 *
 * Not every coplanar pair is a defect. A pier top against a header bottom, a parapet seated on a
 * roof — OPPOSITE-facing pairs — are ordinary assembly contact: backface culling picks one winner
 * and the other is never rasterised. Grounded boxes all share their underside plane at the
 * building base, which faces down into the terrain. And two flat roofs at one height are harmless
 * while a pitched gable sits on top of both. The classifier below separates those from the visible
 * ones, and the vitest sweep (coincidentFaces.test.ts) holds the whole real city at zero visible
 * pairs so a new massing cannot reintroduce the bug.
 *
 * Scope: the boxes recorded by BuildingArchitecture.addBox (every atlas-textured massing volume)
 * plus their foundationTiers mirrors as City draws them. Cylindrical volumes (drum towers, silos,
 * stacks) have no planar faces to fight with and are out of scope, as are thin decorative meshes.
 */

/** The game camera's near plane — src/Game.ts (`new THREE.PerspectiveCamera(60, ..., 0.1, 8000)`). */
export const CAMERA_NEAR = 0.1;
/** Depth attachment precision. Game.ts constructs WebGLRenderer without logarithmicDepthBuffer, so
 *  this is the default 24-bit fixed-point depth buffer. */
export const DEPTH_BITS = 24;

/** Smallest camera-space separation the depth buffer resolves at an eye distance (far >> near, so
 *  the far plane's term is negligible): dz = z² / (near · 2^bits). */
export function depthResolutionAt(distance: number): number {
  return (distance * distance) / (CAMERA_NEAR * 2 ** DEPTH_BITS);
}

/** CBD facades stay legible to roughly this range through the haze (fogDensity 0.00038 leaves 89%
 *  transmittance at 300 u, and a 4.4 u window bay still spans ~10 px at 1080p/60°). Two same-facing
 *  faces separated by less than the buffer can resolve here can tie in the depth test somewhere a
 *  player can see the wall clearly. */
export const CBD_SIGHTLINE = 300;
/** Separation below which a same-facing overlapping pair counts as coincident: ~0.054 u. */
export const COINCIDENT_SEPARATION = depthResolutionAt(CBD_SIGHTLINE);

export interface BoxFace {
  box: number;
  axis: 'x' | 'y' | 'z';
  sign: -1 | 1;
  plane: number;
  /** Flat extent of the face on its two tangential axes (y/z for x-faces, y/x for z-faces, x/z for
   *  y-faces). Rounded boxes' flat regions are inset by the corner radius on both. */
  a0: number; a1: number; b0: number; b1: number;
}

export type PairVerdict =
  /** An exterior surface drawn twice — the defect class. */
  | 'visible'
  /** Both faces are grounded undersides at the building base, facing down into the terrain. */
  | 'buried-underside'
  /** Both undersides rest flush on a third box's top (twin towers on one podium): the shared plane
   *  is the podium roof, and the only way to see either face is from inside the podium. */
  | 'seated-underside'
  /** Coplanar roof tops fully under a pitched gable seated on that plane. */
  | 'gable-covered';

export interface CoincidentPair {
  boxI: number;
  boxJ: number;
  axis: 'x' | 'y' | 'z';
  sign: -1 | 1;
  /** Distance between the two planes. 0 is exact construction-level coincidence. */
  gap: number;
  /** Overlapping flat area shared by the two faces. */
  area: number;
  verdict: PairVerdict;
}

/** The six faces of a massing box, with rounded boxes' flat regions inset by their corner radius
 *  (the plane itself is unchanged — the rounding only shrinks the flat part that can fight). */
export function boxFaces(box: MassingBox, index: number): BoxFace[] {
  const radius = box.rounded ? roundedBoxRadius(box.width, box.depth) : 0;
  const x0 = box.x - box.width / 2; const x1 = box.x + box.width / 2;
  const y0 = box.y - box.height / 2; const y1 = box.y + box.height / 2;
  const z0 = box.z - box.depth / 2; const z1 = box.z + box.depth / 2;
  const faces: BoxFace[] = [];
  for (const sign of [-1, 1] as const) {
    faces.push({ box: index, axis: 'x', sign, plane: sign < 0 ? x0 : x1, a0: y0 + radius, a1: y1 - radius, b0: z0 + radius, b1: z1 - radius });
    faces.push({ box: index, axis: 'z', sign, plane: sign < 0 ? z0 : z1, a0: y0 + radius, a1: y1 - radius, b0: x0 + radius, b1: x1 - radius });
    faces.push({ box: index, axis: 'y', sign, plane: sign < 0 ? y0 : y1, a0: x0 + radius, a1: x1 - radius, b0: z0 + radius, b1: z1 - radius });
  }
  return faces;
}

/** True when a pitched gable seated on `plane` covers the whole rect (a0/a1 = x, b0/b1 = z). Only
 *  quarter-turn yaws exist in this city, so the rotated footprint is still axis-aligned. */
function gableCovers(gables: readonly GableSpec[], plane: number, a0: number, a1: number, b0: number, b1: number): boolean {
  for (const gable of gables) {
    if (Math.abs(gable.y - plane) > 0.3) continue; // a roof floating above the plane hides nothing at its edge-on angle
    const cos = Math.abs(Math.cos(gable.ry)); const sin = Math.abs(Math.sin(gable.ry));
    const halfX = (cos * gable.width + sin * gable.depth) / 2;
    const halfZ = (sin * gable.width + cos * gable.depth) / 2;
    if (a0 >= gable.x - halfX && a1 <= gable.x + halfX && b0 >= gable.z - halfZ && b1 <= gable.z + halfZ) return true;
  }
  return false;
}

/** True when some third box's top plane matches `plane` and its footprint covers the rect — the
 *  pair of undersides rests on that box and cannot be seen from outside it. */
function seatedOn(boxes: readonly MassingBox[], skipI: number, skipJ: number, plane: number, a0: number, a1: number, b0: number, b1: number): boolean {
  for (let index = 0; index < boxes.length; index++) {
    if (index === skipI || index === skipJ) continue;
    const box = boxes[index]!;
    if (Math.abs(box.y + box.height / 2 - plane) > 1e-3) continue;
    if (a0 >= box.x - box.width / 2 - 1e-3 && a1 <= box.x + box.width / 2 + 1e-3
      && b0 >= box.z - box.depth / 2 - 1e-3 && b1 <= box.z + box.depth / 2 + 1e-3) return true;
  }
  return false;
}

/** Every same-facing near-coincident overlapping face pair among the boxes, classified. Opposite-
 *  facing coplanar pairs (assembly contact) are not reported: backface culling resolves them. */
export function coincidentPairs(
  boxes: readonly MassingBox[],
  gables: readonly GableSpec[] = [],
  tolerance = COINCIDENT_SEPARATION,
): CoincidentPair[] {
  const faces = boxes.flatMap(boxFaces);
  const groundY = boxes.length ? Math.min(...boxes.map((box) => box.y - box.height / 2)) : 0;
  const pairs: CoincidentPair[] = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i]!; const b = faces[j]!;
      if (a.box === b.box || a.axis !== b.axis || a.sign !== b.sign) continue;
      const gap = Math.abs(a.plane - b.plane);
      if (gap > tolerance) continue;
      const overlapA = Math.min(a.a1, b.a1) - Math.max(a.a0, b.a0);
      const overlapB = Math.min(a.b1, b.b1) - Math.max(a.b0, b.b0);
      if (overlapA <= 1e-3 || overlapB <= 1e-3) continue;
      const area = overlapA * overlapB;
      if (area < 0.05) continue;
      const plane = (a.plane + b.plane) / 2;
      const rect = [Math.max(a.a0, b.a0), Math.min(a.a1, b.a1), Math.max(a.b0, b.b0), Math.min(a.b1, b.b1)] as const;
      let verdict: PairVerdict = 'visible';
      if (a.axis === 'y' && a.sign < 0 && a.plane <= groundY + 1e-3) verdict = 'buried-underside';
      else if (a.axis === 'y' && a.sign < 0 && seatedOn(boxes, a.box, b.box, plane, ...rect)) verdict = 'seated-underside';
      else if (a.axis === 'y' && a.sign > 0 && gableCovers(gables, plane, ...rect)) verdict = 'gable-covered';
      pairs.push({ boxI: a.box, boxJ: b.box, axis: a.axis, sign: a.sign, gap, area, verdict });
    }
  }
  return pairs;
}

/** The concrete foundation boxes City.buildOneBuilding will draw under a profile: one sharp box per
 *  grounded tier, mirrored down. Only their x/z flanks matter — the tops sit directly under the
 *  massing that grounds them and the bottoms are buried — so callers audit them with axis filters. */
export function foundationBoxes(tiers: readonly MassingTier[], drop = 4): MassingBox[] {
  return foundationTiers(tiers, Math.min(...tiers.map((tier) => tier.y0)) - drop).map((tier) => ({
    x: (tier.minX + tier.maxX) / 2, y: (tier.y0 + tier.y1) / 2, z: (tier.minZ + tier.maxZ) / 2,
    width: tier.maxX - tier.minX, height: tier.y1 - tier.y0, depth: tier.maxZ - tier.minZ,
    rounded: false,
  }));
}

/** Full audit of one planned building: massing-box pairs plus the exposed flanks of the foundation
 *  mirror (the retaining wall on a sloped parcel repeats every coincidence of the tiers it mirrors). */
export function auditProfile(profile: BuildingProfile, tolerance = COINCIDENT_SEPARATION): CoincidentPair[] {
  const massing = coincidentPairs(profile.boxes, profile.gables, tolerance);
  const foundations = profile.tiers.length === 0 ? [] : coincidentPairs(foundationBoxes(profile.tiers), [], tolerance)
    .filter((pair) => pair.axis !== 'y');
  return [...massing, ...foundations.map((pair) => ({ ...pair, boxI: -1 - pair.boxI, boxJ: -1 - pair.boxJ }))];
}
