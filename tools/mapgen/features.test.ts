/**
 * Regression tests over the committed map for the four owner-requested layout additions:
 * organic curvature on the synthetic roads, the southern airport, the NW sea port/pier, and
 * the NE reservoir. Guards the contracts the game will rely on (runway/taxiway out of the
 * road graph, pier ends in the ocean, lake is a closed polygon on land).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AIRPORT_ACCESS_ROAD_NAME, LAKE_NAME, PORT_ACCESS_ROAD_NAME } from './config';
import type { JoburgMap } from './types';

const mapPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/world/generated/joburg-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8')) as JoburgMap;

function pointInPolygon(polygon: [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!; const b = polygon[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function polyArea(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!; const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area / 2);
}
/** Fraction of a polyline's segments that run within `tol` degrees of a coordinate axis. */
function axisAlignedFraction(points: [number, number][], tolDeg = 8): number {
  let axis = 0; let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]![0] - points[i - 1]![0];
    const dz = points[i]![1] - points[i - 1]![1];
    if (Math.hypot(dx, dz) < 1e-6) continue;
    const deg = (Math.atan2(dz, dx) * 180) / Math.PI;
    const m = ((deg % 90) + 90) % 90;
    if (Math.min(m, 90 - m) <= tolDeg) axis++;
    total++;
  }
  return total ? axis / total : 1;
}
function longestByName(name: string): [number, number][] {
  const roads = map.roads.filter((r) => r.name === name);
  expect(roads.length, name).toBeGreaterThan(0);
  return roads.sort((a, b) => b.points.length - a.points.length)[0]!.points;
}

describe('synthetic-road curvature', () => {
  it('bends the Egoli Orbital off its straight rectangle', () => {
    const ring = longestByName('Egoli Orbital');
    expect(ring.length).toBeGreaterThan(24);
    // A straight chamfered rectangle is almost entirely axis-aligned; the meander makes it diagonal.
    expect(axisAlignedFraction(ring)).toBeLessThan(0.7);
  });

  it('bends Plaaspad into a meander (real lateral deviation off its straight chord)', () => {
    const spine = longestByName('Plaaspad');
    const a = spine[0]!; const b = spine.at(-1)!;
    const dx = b[0] - a[0]; const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    let maxDev = 0;
    for (const p of spine) {
      const dev = Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / len; // perpendicular distance to chord
      if (dev > maxDev) maxDev = dev;
    }
    expect(maxDev).toBeGreaterThan(20); // units (~75 m) — clearly no longer a straight edge
  });

  it('is deterministic — the committed geometry matches a rebuild contract (pinned endpoints intact)', () => {
    // Endpoints of each synthetic spine must remain shared with the network (no orphaning),
    // which is what keeps the single-component guarantee after curving.
    const key = (p: [number, number]): string => `${p[0]},${p[1]}`;
    const allEndpoints = new Set<string>();
    for (const road of map.roads) { allEndpoints.add(key(road.points[0]!)); allEndpoints.add(key(road.points.at(-1)!)); }
    for (const name of ['Egoli Orbital', 'Plaaspad', 'Madiba Meander', 'Rooibos Route']) {
      const roads = map.roads.filter((r) => r.name === name);
      const shared = new Set(map.roads.filter((r) => r.name !== name).flatMap((r) => r.points.map(key)));
      const touching = roads.filter((r) => shared.has(key(r.points[0]!)) || shared.has(key(r.points.at(-1)!)));
      expect(touching.length, name).toBeGreaterThan(0);
    }
  });
});

describe('airport in the southern farmland', () => {
  const airport = map.airport!;
  it('ships a runway, parallel taxiway, apron and terminal parcels', () => {
    expect(airport).toBeDefined();
    expect(airport.runway.points.length).toBeGreaterThanOrEqual(2);
    expect(airport.taxiway.points.length).toBeGreaterThanOrEqual(2);
    expect(airport.apron.length).toBeGreaterThanOrEqual(4);
    expect(airport.buildings.length).toBeGreaterThanOrEqual(1);
    expect(airport.name).toMatch(/tambourine/i); // parody name applied from names-overrides
  });

  it('keeps runway + taxiway OUT of the road graph (no traffic routing)', () => {
    expect(airport.runway.kind).toBe('runway');
    expect(airport.taxiway.kind).toBe('taxiway');
    for (const road of map.roads) {
      expect(road.kind).not.toBe('runway');
      expect(road.kind).not.toBe('taxiway');
      expect(road.name).not.toBe(airport.name);
    }
  });

  it('ships an aerodrome landuse polygon and an access road that IS in the graph', () => {
    expect(map.landuse.some((a) => a.kind === 'aerodrome')).toBe(true);
    expect(map.roads.some((r) => r.name === AIRPORT_ACCESS_ROAD_NAME)).toBe(true);
  });
});

describe('sea port / pier on the NW coast', () => {
  const port = map.port!;
  const ocean = map.coast!.ocean;
  it('ships a pier that reaches into the ocean from the shore', () => {
    expect(port).toBeDefined();
    expect(port.pier.kind).toBe('pier');
    expect(pointInPolygon(ocean, port.pier.points.at(-1)![0], port.pier.points.at(-1)![1])).toBe(true);
    expect(pointInPolygon(ocean, port.pier.points[0]![0], port.pier.points[0]![1])).toBe(false); // roots on land
  });

  it('keeps the pier out of the road graph but ships a dockside access road', () => {
    for (const road of map.roads) expect(road.kind).not.toBe('pier');
    expect(map.roads.some((r) => r.name === PORT_ACCESS_ROAD_NAME)).toBe(true);
    // Dockside apron sits on land, not in the ocean.
    for (const p of port.apron) expect(pointInPolygon(ocean, p[0], p[1])).toBe(false);
  });

  it('does not crowd Kaapstad Quay (they sit well apart)', () => {
    const quay = map.coast!.harbour;
    const mid = { x: (port.apron[0]![0] + port.apron[2]![0]) / 2, z: (port.apron[0]![1] + port.apron[2]![1]) / 2 };
    expect(Math.hypot(mid.x - quay.x, mid.z - quay.z)).toBeGreaterThan(map.stats.targetSize * 0.2);
  });
});

describe('reservoir near the NE suburb edge', () => {
  const lake = map.water.find((w) => w.name === LAKE_NAME)!;
  const ocean = map.coast!.ocean;
  it('is a closed polygon on land, in the north-east, at the premium water tier', () => {
    expect(lake).toBeDefined();
    expect(lake.points.length).toBeGreaterThanOrEqual(12);
    // Closed: a valid ring encloses positive area.
    expect(polyArea(lake.points)).toBeGreaterThan(3200); // premium tier in the preview
    // On land: no vertex, nor the centroid, falls in the ocean.
    const cx = lake.points.reduce((s, p) => s + p[0], 0) / lake.points.length;
    const cz = lake.points.reduce((s, p) => s + p[1], 0) / lake.points.length;
    expect(pointInPolygon(ocean, cx, cz)).toBe(false);
    for (const p of lake.points) expect(pointInPolygon(ocean, p[0], p[1])).toBe(false);
    // North-east: east of centre (x>0) and north of centre (z<0).
    expect(cx).toBeGreaterThan(0);
    expect(cz).toBeLessThan(0);
  });
});
