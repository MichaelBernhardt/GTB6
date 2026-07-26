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

// THESE ARE ALBEDOS IN LINEAR SPACE AND THEY WERE MEASURED, NOT DERIVED.
// Two previous passes solved this palette on paper — a claimed (2.37, 1.87, 1.41) light multiplier
// plus a guess at where the ACES shoulder bites — and both shipped a white salt pan: the last one
// rendered the natural strand at rgb(208,202,188), saturation 0.096, which is bone, not grit.
// Paper does not work here because three multiplies a BufferAttribute straight into the lighting as
// LINEAR values, the sun is warm (0xffd9a0 at 4.4 over a 0xcfe4f5/0x8a7c4d hemisphere), the ACES
// curve at exposure 1.22 crushes saturation above ~0.3, and the `dambed` map multiplies in on top.
//
// So the curve was MEASURED in-engine instead: the real bed sheet was painted with fifteen known
// albedos, rendered through the game's own composer from eye height at noon, and the pixels read back
// (tools note: scratchpad d2d3b/calib2.py). The sampled transfer, greys, albedo -> sRGB pixel:
//     0.02->(76,65,49)  0.04->(99,86,68)  0.07->(126,112,91)  0.10->(147,132,110)
//     0.14->(167,153,131) 0.19->(185,172,151) 0.25->(199,188,169) 0.32->(210,201,184)
//     0.42->(221,213,199) 0.55->(229,223,212)
// Every value below is that table inverted for a chosen screen colour, and the chosen colours are
// stated. Note the shape of it: because the light is warm, a warm grey ON SCREEN needs a slightly
// BLUE albedo IN SOURCE, and 0.2 already renders as 185/255. Change these by re-running the sweep.

/** Resort sand: the two beach polygons only. Screen target rgb(216,190,138) — hue 40, sat 0.36,
 *  deliberately the warmest and most saturated thing on the shore. */
export const RESORT_SAND: Rgb = [0.375, 0.261, 0.158];
/** Drawdown strand: the grey-brown grit between the grass line and the bathtub ring. Screen target
 *  rgb(132,120,103) — hue 30, sat 0.22, val 0.52. Desaturated and mid-toned: grit, not bone. (The
 *  first pass at the inverted table aimed 15% higher and measured 174,167,155 at the player's feet,
 *  still too close to bone, so both natural tones were taken down a stop.) */
export const DRAWDOWN_GRIT: Rgb = [0.068, 0.071, 0.077];
/** The bathtub ring itself — a bleached band right above the current waterline. Screen target
 *  rgb(155,148,135), sat 0.13: paler than the grit above it, which is how a drawdown ring reads. */
export const HIGH_WATER_MARK: Rgb = [0.122, 0.135, 0.152];
/** Silt bed below the waterline. Screen target rgb(70,66,56) — mostly seen through the water. */
export const SUBMERGED_BED: Rgb = [0.015, 0.021, 0.027];
/** The dry veld the shore band abuts. Screen target rgb(218,198,127): MEASURED off the ground mesh
 *  at the player's feet, so the sheet's inland edge fades into the ground instead of ending on a
 *  line. Without this the clipped sheet drew a straight north-south colour seam at the map edge. */
export const VELD_TONE: Rgb = [0.393, 0.304, 0.132];
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
 *
 * `veldFade` (0..1) carries the vertex's distance inland: the sheet no longer covers the whole west
 * band, so its landward edge has to arrive at the colour of the ground it abuts rather than stopping
 * on a line. 0 = on the strand, 1 = ordinary veld.
 */
export function shoreColourAt(y: number, z: number, waterY: number, bands: readonly ZBand[], veldFade = 0): Rgb {
  const rise = y - waterY;
  if (rise <= 0) return mix(SUBMERGED_BED, HIGH_WATER_MARK, Math.max(0, 1 + rise / 1.2) * 0.35);
  const fade = Math.min(1, Math.max(0, veldFade));
  const shore = isSandZ(z, bands)
    ? mix(RESORT_SAND, DRAWDOWN_GRIT, Math.min(1, Math.max(0, (rise - SAND_TOP_RISE) / 0.9)))
    : rise <= HIGH_WATER_RISE
      ? HIGH_WATER_MARK
      : mix(HIGH_WATER_MARK, DRAWDOWN_GRIT, Math.min(1, (rise - HIGH_WATER_RISE) / 0.7));
  return fade > 0 ? mix(shore, VELD_TONE, fade) : shore;
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

// ---- The water horizon ---------------------------------------------------------------------------
// A reservoir has to run OUT OF SIGHT, not stop. Mapgen closes the ocean polygon a few thousand units
// past the world edge, which is well inside both the fog and the camera's far plane, so from the shore
// the sheet ends in a dead-level line where water meets sky — measured at 142-166/255 of luminance
// contrast, present in every column of the frame, from eye height at x=-4240. Fog cannot save it:
// FogExp2 at the shipping density 0.00025 still passes a third of the contrast at 4,200 units.
//
// The fix is geometric and it is the same one the engine already relies on everywhere else: put the
// edge PAST the camera's far plane, where the frustum cuts it and the fog is 98% opaque, exactly as
// it cuts the far end of the veld. Nothing else changes — this outline is render-only, so the mapgen
// polygon (and every area/stat/minimap that reads it) is untouched.

/** Clearance past the world square for the rendered water's outer edge. Must exceed Game's camera
 *  far plane (8000 u) so the edge is never inside the frustum from anywhere the player can stand. */
export const WATER_HORIZON_CLEARANCE = 8200;
/** Distance in z over which each shore end swings out to the map edge before running to the horizon.
 *  A right-angle turn there would read as a short level line just off the corner; a diagonal reads as
 *  the shore carrying on past the crop, which is what it is. */
export const WATER_HORIZON_BLEND = 900;

/**
 * Render-only outline for the dam: the real shoreline, then both ends carried out past the camera's
 * far plane and closed off the map.
 *
 * The two run-outs are pinned to `x = -worldHalf` (never further west than the map edge) so they can
 * not open a strip of empty space between the drawn ground and the water at the dry corners: past the
 * shoreline's own z-span the water reaches the map edge, where the terrain covers it.
 */
export function farWaterOutline(
  coastline: readonly MapPt[],
  worldHalf: number,
  clearance = WATER_HORIZON_CLEARANCE,
  blend = WATER_HORIZON_BLEND,
  shoreInland = 0,
): MapPt[] {
  if (coastline.length < 2) return [];
  const first = coastline[0]!;
  const last = coastline[coastline.length - 1]!;
  const far = worldHalf + clearance;
  const edgeX = -worldHalf;
  // sign = the direction this end runs off the map in z (+1 south, -1 north in world axes)
  const firstSign = first.z >= last.z ? 1 : -1;
  // Each run-out sits no further west than the map edge: further west would hang a sliver of water
  // over the empty space beyond the drawn ground. It also never moves EAST of where the shore already
  // is, which would pull the water off a bed that is drawn below the waterline and expose a crater.
  const runOut = (end: MapPt, sign: number): MapPt[] => {
    // Never EAST of the map edge: the far sheet exists to fill the horizon beyond the drawn ground,
    // and a run-out inside the square would stand water on land. (It used to take the max, which
    // was safe only while the shore's own ends were themselves west of the edge — under the
    // wholesale placement they are not, and the sheet reached 1,667 units into the map.)
    const x = Math.min(end.x + shoreInland, edgeX);
    return [{ x, z: end.z + sign * blend }, { x, z: sign * far }];
  };
  return [
    ...coastline.map((point) => ({ x: point.x + shoreInland, z: point.z })),
    ...runOut(last, -firstSign),
    { x: -far, z: -firstSign * far },
    { x: -far, z: firstSign * far },
    ...runOut(first, firstSign).reverse(),
  ];
}
