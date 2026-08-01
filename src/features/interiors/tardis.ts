/**
 * THE TARDIS TRANSFORM — the one place interior coordinates are related to the real building.
 *
 * Interiors can be bigger than the buildings that hold them: the plate is the footprint times a
 * bounded Tardis factor (see core.ts — the factor exists so a room can hold the 9.5 u camera
 * boom), which still leaves 20.3% of this city's 7,415 interiors exceeding their own massing on
 * at least one axis (was 58.6% under the old MIN_PLATE clamp; tools/qa/interior-scale-audit.ts).
 * Nothing notices while the interior stays sealed 30 u underground. The moment anything relates INSIDE to OUTSIDE, a raw world-unit
 * mapping puts the point in the neighbour's yard: roof exits hit this first (the hatch must open
 * onto the real massing top), and exterior-view windows hit it next. So every inside↔outside
 * mapping goes through here, PROPORTIONALLY — an interior point maps by where it sits ON THE
 * PLATE, never by how many units it is from the centre.
 *
 * THE FRAME. Interior floor-local axes are the building frame rotated a half turn: local +z runs
 * away from the street and the visit heading is door.heading + π, so both horizontal axes flip
 * SIGN as well as scale. Compose the building-local result with build.ts `toWorld(centre,
 * facts.heading, …)` to reach world space.
 *
 * DIRECTIONS ARE NEVER SCALED. The scale is anisotropic (kx ≠ kz almost everywhere), so pushing
 * a direction through it shears it — a wall's outward normal would stop being perpendicular to
 * its own wall. Positions map through this module; directions rotate by the building heading
 * alone.
 *
 * FOR THE DEFERRED WINDOWS WORK (this round's plan defers windows behind an owner playtest of
 * the stall fix and the FPV/true-scale decision): the eye anchor for a window's exterior probe
 * is `interiorToBuildingLocal` snapped to the massing face, and its height above the building
 * base is `facadeHeight`. The rest of that design — per-floor box-projected cubemap probe,
 * staggered one face per frame, quality-gated medium+, `quality?()`/`renderCubeProbe?()` host
 * seams — lives with the round plan and is NOT built yet; the seams are added only when their
 * consumer is.
 */
import { CEILING, type BuildingCore, type BuildingFacts } from './core';

/** Only the fields the transform reads, so tests and future callers stay honest about inputs. */
type CoreShape = Pick<BuildingCore, 'width' | 'depth'>;
type FactsShape = Pick<BuildingFacts, 'width' | 'depth'>;

/** Interior units per exterior unit, per axis. > 1 wherever the plate was clamped UP from a
 *  small footprint (most of the city); the max(1, …) guards degenerate zero-width facts. */
export function tardisScale(core: CoreShape, facts: FactsShape): { kx: number; kz: number } {
  return {
    kx: core.width / Math.max(1, facts.width),
    kz: core.depth / Math.max(1, facts.depth),
  };
}

/** Interior floor-local point -> building-local point on the REAL massing: proportional scale
 *  plus the half-turn sign flip. The plate edge lands exactly on the footprint edge, whatever
 *  the two sizes are. */
export function interiorToBuildingLocal(
  core: CoreShape, facts: FactsShape, lx: number, lz: number,
): { x: number; z: number } {
  const k = tardisScale(core, facts);
  return { x: -lx / k.kx, z: -lz / k.kz };
}

/** Building-local point -> interior floor-local point. Exact inverse of interiorToBuildingLocal
 *  (the pair is what roof ENTRY would use to carry a standing spot inward, and what any future
 *  window carries a looked-at exterior point back through). */
export function buildingLocalToInterior(
  core: CoreShape, facts: FactsShape, x: number, z: number,
): { x: number; z: number } {
  const k = tardisScale(core, facts);
  return { x: -x * k.kx, z: -z * k.kz };
}

/** How much of a facade storey the interior's clear height maps onto: an eye at the CEILING must
 *  stay under the storey's lintel, never in the slab of the floor above. */
export const FACADE_BAND = 0.86;

/**
 * Height ABOVE THE BUILDING'S BASE of an interior point `y` above `floorIndex`'s slab, mapped
 * onto the real facade. Interior storeys are 5.7 u for the camera; facade storeys are whatever
 * the building's own height divides into (~3.5 u — the bands of windows the player counts from
 * the street, see core.ts FACADE_STOREY). Never map interior height 1:1: a third-storey interior
 * eye sits 17 u up, which on a 10.9 u building is above its roof.
 */
export function facadeHeight(
  core: Pick<BuildingCore, 'storeys'>, facts: Pick<BuildingFacts, 'height'>,
  floorIndex: number, y: number,
): number {
  const storey = facts.height / Math.max(1, core.storeys);
  const inStorey = Math.max(0, Math.min(1, y / CEILING));
  return floorIndex * storey + inStorey * storey * FACADE_BAND;
}

/** An XZ rectangle in building-local space — the shape of InteriorDoor['roof']. */
export interface LocalRect {
  readonly minX: number; readonly maxX: number;
  readonly minZ: number; readonly maxZ: number;
}

/** Clamp a building-local point at least `inset` inside a rect (a massing top, a facade face).
 *  A rect too small to hold the inset collapses to its centre rather than inverting. */
export function clampInsideRect(
  rect: LocalRect, x: number, z: number, inset: number,
): { x: number; z: number } {
  const cx = rect.minX + inset > rect.maxX - inset
    ? (rect.minX + rect.maxX) / 2
    : Math.max(rect.minX + inset, Math.min(rect.maxX - inset, x));
  const cz = rect.minZ + inset > rect.maxZ - inset
    ? (rect.minZ + rect.maxZ) / 2
    : Math.max(rect.minZ + inset, Math.min(rect.maxZ - inset, z));
  return { x: cx, z: cz };
}
