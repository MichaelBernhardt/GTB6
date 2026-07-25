/**
 * Regression tests over the committed composite map: the Jozi-by-the-Sea coast strip,
 * the rural corridor, and their contract with the game (ocean boundary, connectivity).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COASTAL_ROAD_NAME, CORRIDOR_LINKS, DAM_ARMS, DAM_LEVEL_M, FRONTAGE_ROAD_NAME } from './config';
import { RIDGE_ZERO_Z } from './ridge';
import type { JoburgMap } from './types';

const mapPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/world/generated/joburg-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8')) as JoburgMap;
const coast = map.coast!;
const rural = map.rural!;

function pointInPolygon(polygon: [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!; const b = polygon[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

describe('Jozi-by-the-Sea coast', () => {
  it('ships coastline, ocean, beaches, harbour and corridor extents', () => {
    expect(coast).toBeDefined();
    expect(coast.coastline.length).toBeGreaterThan(30);
    expect(coast.ocean.length).toBeGreaterThan(coast.coastline.length);
    expect(coast.beaches.length).toBeGreaterThanOrEqual(1);
    expect(coast.corridor.westX).toBeLessThan(coast.corridor.eastX);
    expect(coast.harbour.x).toBeLessThan(coast.corridor.westX); // the quay is on the coast strip
  });

  it('runs off the top AND bottom of the world square — no visible cap (D1)', () => {
    // The polygon closes with two horizontal caps. Both must be outside the world square, or
    // water stops in a ruler-straight line inside the playable map (it once did, 4,276 units
    // in from the north edge, with dry veld immediately north of it).
    const half = map.stats.targetSize / 2;
    const zs = coast.ocean.map((point) => point[1]);
    expect(Math.min(...zs)).toBeLessThan(-half - 200);
    expect(Math.max(...zs)).toBeGreaterThan(half + 200);
    const inWorld = (p: [number, number]): boolean => Math.abs(p[0]) <= half && Math.abs(p[1]) <= half;
    for (let i = 0; i < coast.ocean.length; i++) {
      const a = coast.ocean[i]!; const b = coast.ocean[(i + 1) % coast.ocean.length]!;
      if (!inWorld(a) && !inWorld(b)) continue;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(300); // no straight run in frame
    }
  });

  it('coastline forms a continuous south-to-north boundary along the west edge', () => {
    // Scale-invariant: the synthetic shoreline step is ~420 m, so cap the gap in metres
    // (keeps passing across TARGET_SIZE tweaks instead of a hard-coded unit threshold).
    let previous = coast.coastline[0]!;
    for (const point of coast.coastline.slice(1)) {
      const gapM = Math.hypot(point[0] - previous[0], point[1] - previous[1]) * map.stats.metresPerUnit;
      expect(gapM).toBeLessThan(620);
      previous = point;
    }
    const zs = coast.coastline.map((point) => point[1]);
    const span = Math.max(...zs) - Math.min(...zs);
    expect(span).toBeGreaterThan(map.stats.targetSize * 0.9); // spans (almost) the whole west edge
    // The dam's drowned-valley arms cut EAST into the corridor by design (DAM_ARMS depth), so
    // the tolerance is the deepest arm converted to units, not a fixed wobble allowance.
    const deepestArmUnits = Math.max(...DAM_ARMS.map((arm) => arm.depthM)) / map.stats.metresPerUnit;
    expect(Math.max(...coast.coastline.map((point) => point[0]))).toBeLessThan(coast.corridor.westX + deepestArmUnits + 60);
  });

  it('no road crosses into the ocean (quays excepted — they end at the water)', () => {
    const offenders: string[] = [];
    for (const road of map.roads) {
      if (road.name === 'Kaapstad Quay') continue; // the pier is supposed to reach the water
      for (let index = 0; index < road.points.length; index += 2) {
        const point = road.points[index]!;
        if (pointInPolygon(coast.ocean, point[0], point[1])) { offenders.push(`${road.name}@${point[0]},${point[1]}`); break; }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the coastal highway exists and joins the network (single component is proved elsewhere)', () => {
    const highway = map.roads.filter((road) => road.name === COASTAL_ROAD_NAME);
    expect(highway.length).toBeGreaterThanOrEqual(1);
    const key = (point: [number, number]): string => `${point[0]},${point[1]}`;
    const highwayKeys = new Set(highway.flatMap((road) => road.points.map(key)));
    const otherKeys = new Set(map.roads.filter((road) => road.name !== COASTAL_ROAD_NAME).flatMap((road) => road.points.map(key)));
    let shared = 0;
    for (const k of highwayKeys) if (otherKeys.has(k)) shared++;
    expect(shared).toBeGreaterThanOrEqual(4); // both corridor links, the quay, and the orbital ends
  });

  it('registers the ocean and premium dams for the tiered water system', () => {
    expect(map.stats.oceanKm2).toBeGreaterThan(5);
    expect(map.stats.landKm2).toBeGreaterThan(100);
  });
});

describe('rural corridor', () => {
  it('is a real drive: within the owner range, crossed by both creative links', () => {
    // Corridor width is metre-denominated (CORRIDOR_WIDTH_M), so in units it scales with the
    // footprint: ~0.15 of targetSize (≈918u at 6000, ≈5512u at 36000) — "a little drive" that grows
    // proportionally with the map.
    expect(map.stats.corridorWidthUnits).toBeGreaterThanOrEqual(map.stats.targetSize * 0.1);
    expect(map.stats.corridorWidthUnits).toBeLessThanOrEqual(map.stats.targetSize * 0.2);
    const names = new Set(map.roads.map((road) => road.name));
    for (const link of CORRIDOR_LINKS) expect(names.has(link.name), link.name).toBe(true);
    expect(names.has(FRONTAGE_ROAD_NAME)).toBe(true);
  });

  it('has farmland fields, farm buildings and dirt tracks inside the corridor band', () => {
    const fields = map.landuse.filter((area) => area.kind === 'farmland');
    expect(fields.length).toBeGreaterThanOrEqual(6);
    for (const field of fields) {
      for (const point of field.points) {
        expect(point[0]).toBeGreaterThan(coast.corridor.westX - 120 * (map.stats.targetSize / 6000));
        expect(point[0]).toBeLessThan(coast.corridor.eastX + 120 * (map.stats.targetSize / 6000));
      }
    }
    expect(rural.farms.length).toBeGreaterThanOrEqual(6);
    expect(rural.farms.every((farm) => farm.x > coast.corridor.westX && farm.x < coast.corridor.eastX)).toBe(true);
    const plaasTracks = map.tracks.filter((track) => track.name === 'Plaas track');
    expect(plaasTracks.length).toBeGreaterThanOrEqual(3);
  });

  it('serves boerewors rolls at Ouma se Padstal (names-overrides applied)', () => {
    expect(rural.padstal.name).toBe('Ouma se Padstal');
    expect(map.landmarks.some((landmark) => landmark.name === 'Ouma se Padstal' && landmark.kind === 'padstal')).toBe(true);
  });

  it('bakes gentle corridor hills and sea level into the composite height grid', () => {
    const e = map.elevation;
    expect(e.data).toHaveLength(e.cols * e.rows);
    expect(map.stats.minElevation).toBe(DAM_LEVEL_M); // the reservoir surface, not sea level
    expect(map.stats.maxElevation).toBeGreaterThan(1500); // the Rand
    // Sample the corridor band: it must sit between sea level and the city plateau.
    const corridorMidX = (coast.corridor.eastX + coast.corridor.westX) / 2;
    const col = Math.round((corridorMidX - e.x0) / e.dx);
    let corridorMax = 0;
    for (let row = 10; row < e.rows - 10; row++) corridorMax = Math.max(corridorMax, e.data[row * e.cols + col]!);
    expect(corridorMax).toBeGreaterThan(DAM_LEVEL_M);
    expect(corridorMax).toBeLessThan(1900);
  });

  it('raises a tall fractal range along the top edge, tapered off the CBD, corridor and ocean', () => {
    const e = map.elevation;
    const ridge = e.ridge!;
    expect(ridge).toHaveLength(e.data.length);
    const at = (col: number, row: number): number => ridge[row * e.cols + col]!;
    const colOf = (x: number): number => Math.round((x - e.x0) / e.dx);
    const rowOf = (z: number): number => Math.round((z - e.z0) / e.dz);
    expect(Math.max(...ridge)).toBeGreaterThan(1000); // the crest genuinely towers over the ~1750 m plateau
    // Everything south of the CBD guard carries EXACTLY zero mountain. The guard is authored in
    // PROJECTED metres (RIDGE_ZERO_Z), so derive its game-unit row from the shipped fit instead
    // of hard-coding a z that only meant something at the old footprint.
    const { scale, cz } = map.stats.fit!;
    const guardZ = (RIDGE_ZERO_Z - cz) * scale;
    for (let row = rowOf(guardZ) + 1; row < e.rows; row++) for (let col = 0; col < e.cols; col++) expect(at(col, row)).toBe(0);
    const cbd = { x: -map.stats.fit!.cx * scale, z: -cz * scale };
    expect(at(colOf(cbd.x), rowOf(cbd.z))).toBe(0); // Joburg CBD
    // The ocean/coast columns and the rural corridor carry none either.
    for (let row = 0; row < e.rows; row++) {
      expect(at(2, row)).toBe(0);
      expect(at(colOf((coast.corridor.westX + coast.corridor.eastX) / 2), row)).toBe(0);
    }
  });
});
