/**
 * City-build data (owner's architecture rule A): declarative inputs the procedural massing
 * reads at build time. Editing these values + rebuilding regenerates the whole populated area
 * deterministically — there are NO hand-placed building coordinates anywhere in the runtime.
 *
 * This build round we populate only the CBD test blocks around the player spawn, so the owner
 * can judge scale while driving; the rest of the 6000u map is intentionally left as bare roads.
 * To populate more of the city later, add zones here (or widen the radius) and rebuild — the
 * massing loop in City.buildDistricts fills every zone from the same seeded, data-driven rules.
 *
 * Pure data + pure functions only (anchored to the generated map via placements/mapData) — no
 * three.js — so systems and tests can consume it freely.
 */
import { CBD_CENTER } from '../mapData';
import { SPAWN_POINT } from '../placements';

export interface BuildZone {
  name: string;
  x: number;
  z: number;
  /** Buildings only mass inside this radius (game units) of the zone centre. */
  radius: number;
}

/**
 * Populated massing zones for this build. Anchored to the data-derived CBD spawn / centre so a
 * map rebuild re-centres them automatically instead of stranding buildings at stale coordinates.
 * One zone = "a few blocks around spawn"; ~360u ≈ a dozen CBD blocks of downtown massing.
 */
export const TEST_BUILDING_ZONES: readonly BuildZone[] = [
  { name: 'CBD test blocks', x: SPAWN_POINT.x, z: SPAWN_POINT.z, radius: 360 },
  // Second anchor keeps the strip between spawn and the CBD centre filled when the spawn kerb
  // sits at the district edge (both zones union, so their overlap is harmless).
  { name: 'CBD core', x: CBD_CENTER.x, z: CBD_CENTER.z, radius: 300 },
];

/**
 * Hard cap on procedurally-massed buildings this round. The zones already bound placement to the
 * CBD; the budget is a belt-and-braces ceiling that keeps draw calls near spawn predictable.
 */
export const TEST_BUILDING_BUDGET = 340;

/** True when (x, z) falls inside any populated massing zone for this build. */
export function inBuildZone(x: number, z: number): boolean {
  return TEST_BUILDING_ZONES.some((zone) => (zone.x - x) ** 2 + (zone.z - z) ** 2 <= zone.radius ** 2);
}
