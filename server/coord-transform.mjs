/**
 * OLD WORLD -> NEW WORLD coordinate transform, server side.
 *
 * The authoritative Node process runs plain ESM and cannot import src/world/coordTransform.ts, so
 * this is a deliberate second implementation of the SAME similarity. It is not free-floating: the
 * OLD fit below is copied from that file, the NEW fit is read from the committed map's own
 * `stats.fit` (never re-typed), and server/coord-transform.test.mjs asserts this module and the
 * TypeScript one agree to sub-millimetre over the whole world square. If they ever drift, that test
 * fails rather than the game quietly spawning players in a field.
 *
 *   old game -> projected metres :  p = g / OLD.scale + OLD.c
 *   projected metres -> new game :  n = (p - NEW.c) * NEW.scale
 *   collapsed                    :  n = g * k + t,  k = NEW.scale / OLD.scale,
 *                                                   t = (OLD.c - NEW.c) * NEW.scale
 *
 * Uniform scale plus translation, ZERO rotation — both worlds are projections of the same lat/lon
 * space through the same equirectangular projector about CBD_CENTER, which did not move. Headings
 * are therefore unchanged; lengths, radii and clearances multiply by `k`.
 */
import { MAP_FIT, MAP_WORLD_SIZE } from './road-network.mjs';

/** The 19,200-unit world's fit. Frozen literals — see src/world/coordTransform.ts for the derivation. */
export const OLD_FIT = { scale: 1.0087124152139664, cx: -2944.054041502893, cz: -5011.917267310738 };

/** The committed map's fit. The fallback is the 0.75x variant's measured fit, for a map built before stats.fit existed. */
export const NEW_FIT = MAP_FIT ?? { scale: 0.7566014356756289, cx: -2549.146794132407, cz: -2396.374675709927 };

export const TRANSFORM_K = NEW_FIT.scale / OLD_FIT.scale;
export const TRANSFORM_TX = (OLD_FIT.cx - NEW_FIT.cx) * NEW_FIT.scale;
export const TRANSFORM_TZ = (OLD_FIT.cz - NEW_FIT.cz) * NEW_FIT.scale;

/** Old-world game coordinate -> new-world game coordinate. */
export function toNewWorld(point) {
  return { x: point.x * TRANSFORM_K + TRANSFORM_TX, z: point.z * TRANSFORM_K + TRANSFORM_TZ };
}

/** Distances, radii and clearances authored in old game units. */
export function scaleLength(units) { return units * TRANSFORM_K; }

/** True when a transformed point lands inside the new world square. Outside means the content it pointed at is gone. */
export function insideNewWorld(point, margin = 10) {
  const half = MAP_WORLD_SIZE / 2 - margin;
  return Math.abs(point.x) < half && Math.abs(point.z) < half;
}
