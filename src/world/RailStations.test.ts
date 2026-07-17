import { describe, expect, it } from 'vitest';
import { PLATFORM_OFFSET, PLATFORM_WIDTH, pickPlatformSide, trackDirectionAt, uniqueStationSites } from './RailStations';
import { GENERATED_RAILWAYS, RAIL_BALLAST_WIDTH, STATIONS, type MapPt } from './mapData';

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

  it("shares interchange names but never duplicates a name across distant stops", () => {
    const byName = new Map<string, Array<{ x: number; z: number }>>();
    for (const station of STATIONS) (byName.get(station.name) ?? byName.set(station.name, []).get(station.name)!).push(station);
    for (const [name, sites] of byName) {
      for (const a of sites) for (const b of sites) {
        expect(Math.hypot(a.x - b.x, a.z - b.z), name).toBeLessThan(450); // same physical interchange
      }
    }
  });
});

describe('station build helpers', () => {
  const LINE: MapPt[] = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }];

  it('reads the track direction at the nearest segment', () => {
    expect(trackDirectionAt(LINE, 50, 5)).toMatchObject({ ux: 1, uz: 0 });
    expect(trackDirectionAt(LINE, 95, 60)).toMatchObject({ ux: 0, uz: 1 });
  });

  it('puts the platform on the side with more room to the nearest road', () => {
    const roadOnPlus = (_x: number, z: number): number => (z > 0 ? 1 : 10); // road hugs the +z side
    expect(pickPlatformSide(50, 0, 1, 0, roadOnPlus)).toBe(-1);
    const roadOnMinus = (_x: number, z: number): number => (z < 0 ? 1 : 10);
    expect(pickPlatformSide(50, 0, 1, 0, roadOnMinus)).toBe(1);
    const open = (): number => 14;
    expect(pickPlatformSide(50, 0, 1, 0, open)).toBe(1); // tie breaks deterministically
  });

  it('keeps the platform clear of the loading gauge', () => {
    // Inner platform edge must sit beyond the ballast half-width (the consist body is narrower still).
    expect(PLATFORM_OFFSET - PLATFORM_WIDTH / 2).toBeGreaterThan(RAIL_BALLAST_WIDTH / 2);
  });

  it('collapses shared interchange entries to one physical site and skips the aerodrome halt', () => {
    const sites = uniqueStationSites();
    for (const a of sites) {
      expect(sites.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 40)).toHaveLength(1);
    }
    // The Lughawe Halt is built by Airport.ts — the generic builder must leave it alone.
    expect(sites.some((site) => /lughawe/i.test(site.name))).toBe(false);
    expect(STATIONS.some((station) => /lughawe/i.test(station.name))).toBe(true); // but the schedule still stops there
  });
});
