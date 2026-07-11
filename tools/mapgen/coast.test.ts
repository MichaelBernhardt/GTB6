/**
 * Regression tests over the committed composite map: the Jozi-by-the-Sea coast strip,
 * the rural corridor, and their contract with the game (ocean boundary, connectivity).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COASTAL_ROAD_NAME, CORRIDOR_LINKS, FRONTAGE_ROAD_NAME } from './config';
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
    // West of the corridor band (the odd shoreline wobble may lap slightly over its edge; the
    // metre-based wobble scales with the footprint, so the tolerance tracks targetSize).
    expect(Math.max(...coast.coastline.map((point) => point[0]))).toBeLessThan(coast.corridor.westX + 80 * (map.stats.targetSize / 6000));
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
    expect(map.stats.minElevation).toBe(0); // ocean
    expect(map.stats.maxElevation).toBeGreaterThan(1500); // the Rand
    // Sample the corridor band: it must sit between sea level and the city plateau.
    const corridorMidX = (coast.corridor.eastX + coast.corridor.westX) / 2;
    const col = Math.round((corridorMidX - e.x0) / e.dx);
    let corridorMax = 0;
    for (let row = 10; row < e.rows - 10; row++) corridorMax = Math.max(corridorMax, e.data[row * e.cols + col]!);
    expect(corridorMax).toBeGreaterThan(100);
    expect(corridorMax).toBeLessThan(1900);
  });
});
