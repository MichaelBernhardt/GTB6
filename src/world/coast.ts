/**
 * Pure coast geometry: turns the shoreline polyline + beach z-spans into the vertex data for
 * the drivable sand/rock shore strip, and derives the ocean's premium water site. No three.js
 * here so the maths is unit-testable; City.ts wraps the output in buffers and materials.
 *
 * The named beach polygons (BEACH_POLYGONS) are now cut by mapgen as crescents that follow the
 * MEASURED waterline at the two real resorts (Misty Bay and Leboya Bay), so they are already on
 * land — the old Cape graft put all 24 vertices of Three Anchor Bay inside the water. We still key
 * the sand PAINT off their z-extent alone (beachBands) rather than their outline, because the
 * drivable strip is generated against the true waterline and must agree with it exactly.
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

// ---- Reservoir shore palette -------------------------------------------------------------------
// A Vaal-Dam shore is NOT a seaside. Three things are true of it and none of them are golden sand:
//   1. the level swings — the real dam went from near-empty in 2025 to over 102% through 2026 — so
//      there is a wide DRAWDOWN STRAND of pale grey-brown grit exposed below the grass line, with a
//      visible bathtub ring where the water last stood;
//   2. the bed under the water is silt, not white sand;
//   3. the only proper sand is at the resorts, which is exactly where the beach polygons are.
// The owner kept the sand and the real place settled why: "Misty bay has some resorts and sandy
// beaches, hence the choice." So sand survives, but it is zoned rather than smeared everywhere.

/** Resort sand: the two beach polygons only (Misty Bay and Leboya Bay). */
export const RESORT_SAND: Rgb = [0.86, 0.75, 0.52];
/** Drawdown strand: pale grey-brown grit between the grass line and the bathtub ring. */
export const DRAWDOWN_GRIT: Rgb = [0.60, 0.57, 0.48];
/** The bathtub ring itself — a bleached band right above the current waterline. */
export const HIGH_WATER_MARK: Rgb = [0.74, 0.71, 0.60];
/** Silt bed below the waterline. */
export const SUBMERGED_BED: Rgb = [0.33, 0.32, 0.27];
/**
 * Height above the waterline (world units) that the bathtub ring covers, and the height at which
 * resort sand gives way to normal cover. These are HEIGHTS, but what the player sees is a WIDTH,
 * and the width is height / slope: City's strand profile now spends the whole BEACH_INLAND width
 * on the drop from BEACH_TOP_Y to the waterline, so a 0.75-unit ring is tens of units across
 * instead of the two or three it was on the old single ramp to SEA_FLOOR_Y.
 */
export const HIGH_WATER_RISE = 0.62;
/** Height above the waterline at which the resort sand gives way to normal ground cover. */
export const SAND_TOP_RISE = 1.15;

const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Colour for one vertex of the dam bed / strand sheet, from its HEIGHT relative to the water
 * surface (not its x): the bathtub ring is a water-level phenomenon, so keying it off height makes
 * it follow every bay and headland for free, and it stays right if the water level is ever moved.
 */
export function shoreColourAt(y: number, z: number, waterY: number, bands: readonly ZBand[]): Rgb {
  const rise = y - waterY;
  if (rise <= 0) return mix(SUBMERGED_BED, HIGH_WATER_MARK, Math.max(0, 1 + rise / 1.2) * 0.35);
  if (isSandZ(z, bands)) return mix(RESORT_SAND, DRAWDOWN_GRIT, Math.min(1, Math.max(0, (rise - SAND_TOP_RISE) / 0.9)));
  if (rise <= HIGH_WATER_RISE) return HIGH_WATER_MARK;
  return mix(HIGH_WATER_MARK, DRAWDOWN_GRIT, Math.min(1, (rise - HIGH_WATER_RISE) / 0.7));
}

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
