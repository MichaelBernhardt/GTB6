/**
 * OLD WORLD -> NEW WORLD coordinate transform.
 *
 * The map was re-cropped (2/3 of the fetched bbox, shifted east) and re-scaled (0.75x, so
 * ~1.32 m per game unit instead of ~0.99). Every authored world coordinate — placement seeds,
 * server anchors, persisted save positions — was written against the OLD world and lands in the
 * wrong place in the new one.
 *
 * THE MAPPING IS EXACT, NOT APPROXIMATE, and it is a pure SIMILARITY: uniform scale plus
 * translation, with ZERO rotation. Two facts make that true, and both are asserted below:
 *
 *  1. Both worlds are projections of the same lat/lon space through the SAME equirectangular
 *     projector, whose reference latitude comes from CBD_CENTER (tools/mapgen/projection.ts,
 *     called with CBD_CENTER — NOT with the bbox). CBD_CENTER did not change, so
 *     metresPerDegLon is identical in both worlds and no lat/lon round trip is needed.
 *  2. The fit is game = (projected_metres - c) * scale, so composing old-invert with new-apply
 *     collapses to n = g * k + t.
 *
 *      old game -> projected metres :  p = g / OLD.scale + OLD.c
 *      projected metres -> new game :  n = (p - NEW.c) * NEW.scale
 *      collapsed                    :  n = g * k + t
 *                                      k  = NEW.scale / OLD.scale
 *                                      t  = (OLD.c - NEW.c) * NEW.scale
 *
 * Headings and rotations are UNCHANGED (no rotation term). Lengths, radii and clearances
 * multiply by `k` — transform points but not radii and you invert topologies like the Kelvin
 * Yard fence test.
 */
import { MAP_STATS, MAP_WORLD_SIZE } from './mapData';

/**
 * The OLD world's fit, frozen as literals so this keeps working after tools/mapgen/config.ts
 * changes. Recovered by least squares over all 108 OSM place=suburb|quarter|neighbourhood
 * nodes against the committed map's districts[0..107] (extractDistrictNodes preserves OSM
 * element order and process.ts emits in that order, so the correspondence is 1:1).
 * Maximum residual over the 108 points: 0.0053 units — which is the emitted JSON's own 2-dp
 * rounding, not fit error. This IS the transform.
 */
export const OLD_FIT = {
  /** Game units per projected metre. */
  scale: 1.0087124152139664,
  metresPerUnit: 0.9913628,
  /** Projected-metre centre the old fit was built around. */
  cx: -2944.054041502893,
  cz: -5011.917267310738,
  targetSize: 18000,
  worldSize: 19200,
} as const;

/**
 * The projection both worlds share. If CBD_CENTER ever moves, metresPerDegLon changes and this
 * whole file silently becomes wrong — hence the assertion in the test suite.
 */
export const PROJECTION = {
  originLat: -26.205,
  originLon: 28.043,
  metresPerDegLat: 111_132,
  /** 111132 * cos(-26.205 deg). */
  metresPerDegLon: 111_132 * Math.cos((-26.205 * Math.PI) / 180),
} as const;

export interface Fit { scale: number; cx: number; cz: number }

/**
 * The NEW world's fit. Shipped in stats.fit by the pipeline (process.ts). The literal fallback
 * covers a map built before stats.fit existed; it is the 0.75x variant's measured fit.
 */
export const NEW_FIT: Fit = MAP_STATS.fit ?? {
  scale: 0.7566014356756289,
  cx: -2549.146794132407,
  cz: -2396.374675709927,
};

/** Uniform scale factor, old game units -> new game units. */
export const TRANSFORM_K = NEW_FIT.scale / OLD_FIT.scale;
/** Translation, applied after the scale. */
export const TRANSFORM_TX = (OLD_FIT.cx - NEW_FIT.cx) * NEW_FIT.scale;
export const TRANSFORM_TZ = (OLD_FIT.cz - NEW_FIT.cz) * NEW_FIT.scale;

export interface XZ { x: number; z: number }

/** Old-world game coordinate -> new-world game coordinate. */
export function toNewWorld(p: XZ): XZ {
  return { x: p.x * TRANSFORM_K + TRANSFORM_TX, z: p.z * TRANSFORM_K + TRANSFORM_TZ };
}

/** New-world game coordinate -> old-world game coordinate (for verification / rollback). */
export function toOldWorld(p: XZ): XZ {
  return { x: (p.x - TRANSFORM_TX) / TRANSFORM_K, z: (p.z - TRANSFORM_TZ) / TRANSFORM_K };
}

/**
 * Distances, radii, clearances and thresholds authored in old game units. Points and lengths
 * must BOTH be transformed or relative topology breaks.
 */
export function scaleLength(units: number): number {
  return units * TRANSFORM_K;
}

/** Headings are rotation-free under a similarity — provided for symmetry and documentation. */
export function toNewHeading(heading: number): number {
  return heading;
}

/** Old game coordinate -> lat/lon, for classifying what survives the crop. */
export function toLatLon(p: XZ): { lat: number; lon: number } {
  const mx = p.x / OLD_FIT.scale + OLD_FIT.cx;
  const mz = p.z / OLD_FIT.scale + OLD_FIT.cz;
  return {
    lat: PROJECTION.originLat - mz / PROJECTION.metresPerDegLat,
    lon: PROJECTION.originLon + mx / PROJECTION.metresPerDegLon,
  };
}

/**
 * True when a transformed point lands inside the new world square (with a small margin, the
 * same one SaveManager uses). Coordinates outside cannot be rescued by arithmetic — the content
 * they pointed at is genuinely gone and they must be re-sited by hand.
 */
export function insideNewWorld(p: XZ, margin = 10): boolean {
  const half = MAP_WORLD_SIZE / 2 - margin;
  return Math.abs(p.x) < half && Math.abs(p.z) < half;
}
