/**
 * Regression tests over the COMMITTED generated map
 * (src/world/generated/joburg-map.json). These guard the contract the game
 * will rely on in Phase 2 — above all: the road graph is ONE component.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROAD_WIDTHS } from './config';
import { applyNameOverrides } from './emit';
import type { JoburgMap } from './types';

const mapPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/world/generated/joburg-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8')) as JoburgMap;

const key = (p: [number, number]): string => `${p[0]},${p[1]}`;

describe('generated joburg-map.json', () => {
  it('has a substantial road network with junctions', () => {
    expect(map.roads.length).toBeGreaterThan(200);
    expect(map.stats.totalRoadKm).toBeGreaterThan(100);
    expect(map.junctions.length).toBeGreaterThan(200);
    expect(map.stats.roadCount).toBe(map.roads.length);
    expect(map.stats.junctionCount).toBe(map.junctions.length);
  });

  it('road graph is ONE connected component (by exact shared coordinates)', () => {
    const parent = new Map<string, string>();
    const find = (a: string): string => {
      let root = a;
      while (parent.has(root)) root = parent.get(root)!;
      while (a !== root) {
        const next = parent.get(a)!;
        parent.set(a, root);
        a = next;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const all = new Set<string>();
    for (const road of map.roads) {
      for (let i = 0; i < road.points.length; i++) {
        all.add(key(road.points[i]));
        if (i > 0) union(key(road.points[i - 1]), key(road.points[i]));
      }
    }
    const roots = new Set<string>();
    for (const k of all) roots.add(find(k));
    expect(roots.size).toBe(1);
  });

  it('classifies widths by highway kind', () => {
    for (const road of map.roads) {
      expect(road.width).toBe(ROAD_WIDTHS[road.kind]);
      expect(road.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('fits the configured footprint', () => {
    const half = map.stats.targetSize / 2 + 1;
    for (const road of map.roads) {
      for (const [x, z] of road.points) {
        expect(Math.abs(x)).toBeLessThanOrEqual(half);
        expect(Math.abs(z)).toBeLessThanOrEqual(half);
      }
    }
  });

  it('junction coordinates lie on at least two of the named roads', () => {
    const pointsByRoadName = new Map<string, Set<string>>();
    for (const road of map.roads) {
      let set = pointsByRoadName.get(road.name);
      if (!set) pointsByRoadName.set(road.name, (set = new Set()));
      for (const p of road.points) set.add(key(p));
    }
    for (const junction of map.junctions.slice(0, 500)) {
      const k = key([junction.x, junction.z]);
      const present = junction.roads.filter((name) => pointsByRoadName.get(name)?.has(k));
      expect(present.length).toBeGreaterThanOrEqual(Math.min(2, junction.roads.length));
    }
  });

  it('ships the expected side channels: districts, water, landmarks, tracks, landuse', () => {
    expect(map.districts.length).toBeGreaterThan(20);
    expect(map.water.length).toBeGreaterThan(0);
    expect(map.landmarks.length).toBeGreaterThanOrEqual(4);
    expect(map.tracks.length).toBeGreaterThan(0);
    expect(map.landuse.length).toBeGreaterThan(10);
    expect(map.tracks.every((t) => t.unpaved === true)).toBe(true);
    const names = map.landmarks.map((l) => l.name.toLowerCase()).join('|');
    expect(names).toMatch(/ponte/);
    expect(names).toMatch(/hillbrow/);
  });

  it('carries a plausible elevation grid for the Witwatersrand', () => {
    const e = map.elevation;
    expect(e.data).toHaveLength(e.cols * e.rows);
    expect(map.stats.minElevation).toBeGreaterThan(1200);
    expect(map.stats.maxElevation).toBeLessThan(2200);
    expect(map.stats.maxElevation - map.stats.minElevation).toBeGreaterThan(80);
    expect(e.dx).toBeGreaterThan(0);
    expect(e.dz).toBeGreaterThan(0);
  });

  it('keeps OSM attribution in the metadata', () => {
    expect(map.meta.attribution).toContain('OpenStreetMap');
  });
});

describe('applyNameOverrides', () => {
  it('renames roads and junction references, leaving others untouched', () => {
    const sample: JoburgMap = {
      ...map,
      roads: [
        { name: 'Oxford Road', width: 24, kind: 'primary', points: [[0, 0], [1, 1]] },
        { name: 'Bree Street', width: 18, kind: 'secondary', points: [[0, 0], [2, 2]] },
      ],
      junctions: [{ x: 0, z: 0, roads: ['Oxford Road', 'Bree Street'] }],
    };
    const out = applyNameOverrides(sample, { 'Oxford Road': 'Oxfraud Road' });
    expect(out.roads[0].name).toBe('Oxfraud Road');
    expect(out.roads[1].name).toBe('Bree Street');
    expect(out.junctions[0].roads).toEqual(['Bree Street', 'Oxfraud Road']);
  });
});
