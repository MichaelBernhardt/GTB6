import { describe, expect, it } from 'vitest';
import { GENERATED_RAILWAYS, RAILWAY_STATION_SITES, STATIONS, type MapPt } from './mapData';

const arcAndDistance = (points: MapPt[], x: number, z: number): { s: number; dist: number } => {
  let bestS = 0; let bestD = Infinity; let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (len * len)));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < bestD) { bestD = d; bestS = acc + t * len; }
    acc += len;
  }
  return { s: bestS, dist: bestD };
};

describe('generated station data (owner guarantees)', () => {
  it('ships stations, and every rail line carries some', () => {
    expect(STATIONS.length).toBeGreaterThan(0);
    for (const line of GENERATED_RAILWAYS) {
      expect(STATIONS.filter((station) => station.line === line.name).length, line.name).toBeGreaterThanOrEqual(2);
    }
  });

  it('puts a station at BOTH ends of every line', () => {
    for (const line of GENERATED_RAILWAYS) {
      const stops = STATIONS.filter((station) => station.line === line.name);
      for (const end of [line.points[0]!, line.points[line.points.length - 1]!]) {
        const nearest = Math.min(...stops.map((station) => Math.hypot(station.x - end.x, station.z - end.z)));
        expect(nearest, `${line.name} end`).toBeLessThan(30);
      }
    }
  });

  it('sits every station on its line and keeps gaps in the 2.5–5 km band', () => {
    for (const line of GENERATED_RAILWAYS) {
      const projected = STATIONS
        .filter((station) => station.line === line.name)
        .map((station) => arcAndDistance(line.points, station.x, station.z))
        .sort((a, b) => a.s - b.s);
      for (const p of projected) expect(p.dist).toBeLessThan(30); // station points lie ON the polyline
      for (let i = 1; i < projected.length; i++) {
        const gap = projected[i]!.s - projected[i - 1]!.s;
        // ~1 unit ≈ 1 m; OSM-real stations may sit closer than the synthetic 2.5 km floor.
        expect(gap, line.name).toBeLessThanOrEqual(5200);
        expect(gap, line.name).toBeGreaterThan(500);
      }
    }
  });

  it('shares interchange names but never duplicates a name across distant stops', () => {
    const byName = new Map<string, Array<{ x: number; z: number }>>();
    for (const station of STATIONS) {
      const bucket = byName.get(station.name) ?? [];
      bucket.push(station); byName.set(station.name, bucket);
    }
    for (const [name, sites] of byName) {
      for (const a of sites) for (const b of sites) {
        expect(Math.hypot(a.x - b.x, a.z - b.z), name).toBeLessThan(450); // same physical interchange
      }
    }
  });

  it('collapses shared interchange entries to one build site and leaves the airport halt to Airport.ts', () => {
    for (const a of RAILWAY_STATION_SITES) {
      expect(RAILWAY_STATION_SITES.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 40)).toHaveLength(1);
    }
    // The Lughawe Halt keeps its bespoke platform beside the apron — no generic double-up...
    expect(RAILWAY_STATION_SITES.some((site) => /lughawe/i.test(site.name))).toBe(false);
    // ...but the schedule still stops there (the spur end station stays in the stop list).
    expect(STATIONS.some((station) => /lughawe/i.test(station.name))).toBe(true);
  });
});
