import { describe, expect, it } from 'vitest';
import { MAP_LANDMARKS, MAP_STATS, MAP_WORLD_SIZE, METRES_PER_UNIT, districtCenter } from './mapData';
import {
  NEW_FIT,
  OLD_FIT,
  PROJECTION,
  TRANSFORM_K,
  insideNewWorld,
  scaleLength,
  toLatLon,
  toNewHeading,
  toNewWorld,
  toOldWorld,
} from './coordTransform';

/** Old-world game coordinates, read out of the map committed before the re-crop. */
const OLD = {
  /** CBD_CENTER (lat -26.205, lon 28.043) under the old fit. */
  cbdCenter: { x: 2969.6963, z: 5055.5786 },
  /** The district literally named 'Joburg CBD'. */
  joburgCbd: { x: 2913.55, z: 5332.41 },
  hillbrowTower: { x: 3600.91, z: 3036.78 },
  ponteTower: { x: 4394.25, z: 3439 },
  /** Rivonia Cellars' search seed — Sandton, and known to be cropped out. */
  rivoniaCellars: { x: 5368, z: -7894 },
} as const;

describe('coordTransform', () => {
  it('freezes the projection both worlds share (if CBD_CENTER moves, everything here is wrong)', () => {
    expect(PROJECTION.originLat).toBe(-26.205);
    expect(PROJECTION.originLon).toBe(28.043);
    expect(PROJECTION.metresPerDegLon).toBeCloseTo(99_709.83, 1);
    // The emitted map must still be a projection about that same origin: CBD_CENTER (0,0 in
    // projected metres) has to land where the transform says it does.
    const viaTransform = toNewWorld(OLD.cbdCenter);
    const viaFit = { x: (0 - NEW_FIT.cx) * NEW_FIT.scale, z: (0 - NEW_FIT.cz) * NEW_FIT.scale };
    expect(viaTransform.x).toBeCloseTo(viaFit.x, 1);
    expect(viaTransform.z).toBeCloseTo(viaFit.z, 1);
  });

  it('round-trips to double-precision noise', () => {
    let worst = 0;
    for (let x = -9000; x <= 9000; x += 617) {
      for (let z = -9000; z <= 9000; z += 613) {
        const back = toOldWorld(toNewWorld({ x, z }));
        worst = Math.max(worst, Math.abs(back.x - x), Math.abs(back.z - z));
      }
    }
    // 1e-6 rather than 1e-12 so a constant typo is caught, not just float noise.
    expect(worst).toBeLessThan(1e-6);
  });

  it('is a pure similarity: uniform scale, no rotation, no shear', () => {
    const a = toNewWorld({ x: 0, z: 0 });
    const bx = toNewWorld({ x: 1000, z: 0 });
    const bz = toNewWorld({ x: 0, z: 1000 });
    expect(bx.z - a.z).toBeCloseTo(0, 9); // x displacement produces no z
    expect(bz.x - a.x).toBeCloseTo(0, 9); // z displacement produces no x
    expect(bx.x - a.x).toBeCloseTo(bz.z - a.z, 9); // same scale on both axes
    expect(scaleLength(1000)).toBeCloseTo(bx.x - a.x, 9);
    expect(toNewHeading(1.234)).toBe(1.234);
  });

  it('shrinks by the product of the crop and the scale compression', () => {
    // ~0.75: the bbox crop does not change units-per-metre, only the 0.75x compression does,
    // and the two worlds were fitted to the same road bbox.
    expect(TRANSFORM_K).toBeGreaterThan(0.70);
    expect(TRANSFORM_K).toBeLessThan(0.80);
    expect(METRES_PER_UNIT).toBeGreaterThan(OLD_FIT.metresPerUnit);
  });

  it('lands known CBD landmarks on their new-world counterparts', () => {
    // The transform must agree with where the pipeline actually put these, within a couple of
    // units (the emitted JSON is rounded to 2 dp and OSM landmark ids are stable).
    const cases: Array<[string, { x: number; z: number }, RegExp]> = [
      ['Hillbrow tower', OLD.hillbrowTower, /hillbrow/i],
      ['Ponte Tower', OLD.ponteTower, /ponte/i],
    ];
    for (const [label, oldPos, pattern] of cases) {
      const landmark = MAP_LANDMARKS.find((l) => pattern.test(l.name));
      expect(landmark, `${label} must survive the crop`).toBeDefined();
      const moved = toNewWorld(oldPos);
      expect(Math.hypot(moved.x - landmark!.x, moved.z - landmark!.z)).toBeLessThan(3);
    }
  });

  it('lands the CBD district inside the new Joburg CBD district', () => {
    const moved = toNewWorld(OLD.joburgCbd);
    const cbd = districtCenter('Joburg CBD');
    expect(cbd).toBeDefined();
    expect(Math.hypot(moved.x - cbd!.x, moved.z - cbd!.z)).toBeLessThan(3);
    expect(insideNewWorld(moved)).toBe(true);
  });

  it('inverts old coordinates back to their real lat/lon', () => {
    const cbd = toLatLon(OLD.cbdCenter);
    expect(cbd.lat).toBeCloseTo(-26.205, 4);
    expect(cbd.lon).toBeCloseTo(28.043, 4);
    // Ponte Tower really is in Berea, just east of and below the CBD.
    const ponte = toLatLon(OLD.ponteTower);
    expect(ponte.lat).toBeGreaterThan(-26.20);
    expect(ponte.lon).toBeGreaterThan(28.05);
  });

  it('reports cropped-out coordinates as outside rather than silently relocating them', () => {
    // Rivonia Cellars sits in Sandton, which the 2/3 crop cannot reach. The transform still
    // produces a number — the caller must check insideNewWorld(), which is the whole point.
    const moved = toNewWorld(OLD.rivoniaCellars);
    const { lat } = toLatLon(OLD.rivoniaCellars);
    expect(lat).toBeGreaterThan(MAP_STATS.bbox!.north);
    expect(insideNewWorld(moved)).toBe(false);
  });

  it('keeps in-crop coordinates inside the new world', () => {
    for (const p of [OLD.cbdCenter, OLD.joburgCbd, OLD.hillbrowTower, OLD.ponteTower]) {
      const moved = toNewWorld(p);
      expect(Math.abs(moved.x)).toBeLessThan(MAP_WORLD_SIZE / 2);
      expect(Math.abs(moved.z)).toBeLessThan(MAP_WORLD_SIZE / 2);
    }
  });
});
