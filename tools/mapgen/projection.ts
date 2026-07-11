import type { Pt } from './types';

/** Metres per degree of latitude (WGS84 mean, good enough at -26°). */
export const METRES_PER_DEG_LAT = 111_132;

/**
 * Equirectangular projection centred on `origin`, in metres.
 * +x is east, +z is south — matching the game's ground plane where the
 * Joburg CBD should end up on the positive-z (southern) side of centre.
 */
export function makeProjector(origin: { lat: number; lon: number }) {
  const metresPerDegLon = METRES_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return (lat: number, lon: number): Pt => ({
    x: (lon - origin.lon) * metresPerDegLon,
    z: (origin.lat - lat) * METRES_PER_DEG_LAT, // south positive: lat below origin => +z
  });
}

/**
 * Fit a bounding box (projected metres) into a square of `targetSize` game
 * units, preserving aspect ratio and centring the content on the origin.
 * Returns the transform plus the resulting metres-per-unit scale.
 */
export function makeFitTransform(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  targetSize: number,
) {
  const extentX = bounds.maxX - bounds.minX;
  const extentZ = bounds.maxZ - bounds.minZ;
  const extent = Math.max(extentX, extentZ);
  const scale = targetSize / extent;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  return {
    scale,
    metresPerUnit: 1 / scale,
    apply: (p: Pt): Pt => ({ x: (p.x - cx) * scale, z: (p.z - cz) * scale }),
  };
}

export function boundsOf(points: Iterable<Pt>): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function polylineLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return total;
}
