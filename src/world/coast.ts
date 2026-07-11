/**
 * Pure coast geometry: turns the shoreline polyline + beach z-spans into the vertex data for
 * the drivable sand/rock shore strip, and derives the ocean's premium water site. No three.js
 * here so the maths is unit-testable; City.ts wraps the output in buffers and materials.
 *
 * The named beach polygons (BEACH_POLYGONS) are misplaced by the mapgen graft — real Cape coords
 * land inland of the *synthetic* coastline — so we honour only WHERE along the shore (z) each beach
 * sits and paint golden sand there, laying the geometry itself against the true waterline.
 */
import type { MapPolygon, MapPt } from './mapData';

/** Water-surface y for the ocean (matches the generated dams so waterlines agree). Land sits at 0. */
export const OCEAN_Y = 0.045;
/** Dark seabed just above the ground plane: gives the transparent ocean its depth colour. */
export const SEABED_Y = 0.012;
/** Sand/rock strip sits below the waterline so the ocean laps over its seaward lip (no gap). */
export const SHORE_Y = 0.03;

/** How far the strip reaches under the water (seaward) and up the land (inland), in world units. */
export const SHORE_SEA_WIDTH = 9;
export const SHORE_LAND_WIDTH = 56;
/** Beach z-spans are padded so each golden patch reads with a little presence along the shore. */
export const BEACH_Z_PAD = 24;

export interface ZBand { minZ: number; maxZ: number; }

/** Where along the shore (z) golden sand replaces the default rock, from the beach polygons' z-extent. */
export function beachBands(beaches: readonly MapPolygon[], pad = BEACH_Z_PAD): ZBand[] {
  return beaches.map((beach) => ({ minZ: beach.minZ - pad, maxZ: beach.maxZ + pad }));
}

export function isSandZ(z: number, bands: readonly ZBand[]): boolean {
  return bands.some((band) => z >= band.minZ && z <= band.maxZ);
}

export type Rgb = readonly [number, number, number];

export interface ShoreRibbonOptions {
  seaWidth?: number;
  landWidth?: number;
  y?: number;
  bands: readonly ZBand[];
  sand: Rgb;
  rock: Rgb;
}

export interface ShoreRibbon {
  positions: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

/**
 * Two-row triangle strip that follows the coastline: an inner (seaward) edge dipped under the water
 * and an outer (inland) edge, coloured golden sand inside a beach band and rock elsewhere. The inland
 * normal is forced to +x (the ocean is always west), so the strip never folds back over the sea.
 */
export function buildShoreRibbon(coastline: readonly MapPt[], opts: ShoreRibbonOptions): ShoreRibbon {
  const sea = opts.seaWidth ?? SHORE_SEA_WIDTH;
  const land = opts.landWidth ?? SHORE_LAND_WIDTH;
  const y = opts.y ?? SHORE_Y;
  const positions: number[] = []; const uvs: number[] = []; const colors: number[] = []; const indices: number[] = [];
  if (coastline.length < 2) return { positions, uvs, colors, indices };
  let distance = 0;
  for (let i = 0; i < coastline.length; i++) {
    const point = coastline[i]!;
    const prev = coastline[Math.max(0, i - 1)]!;
    const next = coastline[Math.min(coastline.length - 1, i + 1)]!;
    const dx = next.x - prev.x; const dz = next.z - prev.z; const length = Math.hypot(dx, dz) || 1;
    let nx = -dz / length; let nz = dx / length;
    if (nx < 0) { nx = -nx; nz = -nz; } // inland is east (+x): the ocean lies to the west
    if (i > 0) { const back = coastline[i - 1]!; distance += Math.hypot(point.x - back.x, point.z - back.z); }
    const [r, g, b] = isSandZ(point.z, opts.bands) ? opts.sand : opts.rock;
    // seaward vertex (under the water), then inland vertex (toward the coast road)
    positions.push(point.x - nx * sea, y, point.z - nz * sea, point.x + nx * land, y, point.z + nz * land);
    uvs.push(0, distance / 22, 1, distance / 22);
    colors.push(r, g, b, r, g, b);
    if (i < coastline.length - 1) { const base = i * 2; indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3); }
  }
  return { positions, uvs, colors, indices };
}
