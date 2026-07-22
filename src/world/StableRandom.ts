/**
 * Cross-engine positional pseudo-randomness.
 *
 * Math.sin-based hashes are not deterministic across JS engines/CPU architectures: a one-ULP
 * difference in the transcendental result can change a placement decision or model seed. Quantise
 * world coordinates to millimetres, then use only specified 32-bit integer operations so the same
 * map inputs produce the same world on every supported Node/browser platform.
 */
const POSITION_QUANTISATION = 1_000;
const WORLD_FLOAT_QUANTISATION = 100_000_000;
const UINT32_RANGE = 0x1_0000_0000;

function avalanche(value: number): number {
  let hash = value;
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Stable value in [0, 1) for a world-space position and integer salt. */
export function stablePositionRandom(x: number, z: number, salt = 0): number {
  const qx = Math.round(x * POSITION_QUANTISATION);
  const qz = Math.round(z * POSITION_QUANTISATION);
  let hash = 0x811c9dc5;
  hash = Math.imul(hash ^ qx, 0x01000193);
  hash = Math.imul(hash ^ qz, 0x01000193);
  hash = Math.imul(hash ^ salt, 0x01000193);
  return avalanche(hash) / UINT32_RANGE;
}

/** Canonicalise derived world data past known cross-engine transcendental drift (~1e-10). */
export function stableWorldFloat(value: number): number {
  const rounded = Math.round(value * WORLD_FLOAT_QUANTISATION) / WORLD_FLOAT_QUANTISATION;
  return rounded === 0 ? 0 : rounded; // canonical +0 avoids platform/file-format differences from -0
}
