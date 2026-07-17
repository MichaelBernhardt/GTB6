import { describe, expect, it } from 'vitest';
import { buildStations, normalizeOsmName, planLineStops, pointAtArc, polylineArc, projectOntoPolyline, STATION_PLAN_DEFAULTS } from './stations';
import type { Pt } from './types';

/** A straight 12 km west→east test line. */
const LINE: Pt[] = [{ x: 0, z: 0 }, { x: 12000, z: 0 }];
const DISTRICTS = [
  { name: 'Riverlea', x: 1000, z: 400 },
  { name: 'Crown', x: 6100, z: -300 },
  { name: 'Jeppe', x: 11500, z: 200 },
];

describe('polyline helpers', () => {
  it('measures arc length and projects points onto the line', () => {
    expect(polylineArc(LINE)).toBe(12000);
    expect(projectOntoPolyline(LINE, 3000, 80)).toMatchObject({ s: 3000, dist: 80 });
    expect(pointAtArc(LINE, 4500)).toMatchObject({ x: 4500, z: 0 });
    expect(pointAtArc(LINE, 99999)).toMatchObject({ x: 12000, z: 0 }); // clamped
  });
});

describe('planLineStops', () => {
  it('always covers both ends and keeps every gap in the 2.5–5 km band', () => {
    const stops = planLineStops(LINE, []);
    expect(stops[0]!.s).toBe(0);
    expect(stops[stops.length - 1]!.s).toBe(12000);
    for (let i = 1; i < stops.length; i++) {
      const gap = stops[i]!.s - stops[i - 1]!.s;
      expect(gap).toBeGreaterThanOrEqual(STATION_PLAN_DEFAULTS.maxGap / 2);
      expect(gap).toBeLessThanOrEqual(STATION_PLAN_DEFAULTS.maxGap);
    }
  });

  it('snaps OSM stations within reach and ignores far-off ones', () => {
    const stops = planLineStops(LINE, [
      { name: 'Crown', x: 6000, z: 90 },        // 90 m off the line: snaps
      { name: 'Faraway', x: 6000, z: 4000 },    // 4 km off: not this line's station
    ]);
    expect(stops.some((stop) => stop.osmName === 'Crown')).toBe(true);
    expect(stops.some((stop) => stop.osmName === 'Faraway')).toBe(false);
  });

  it('merges an OSM stop near a line end into the end station instead of doubling up', () => {
    const stops = planLineStops(LINE, [{ name: 'Endhuis', x: 11800, z: 20 }]);
    const last = stops[stops.length - 1]!;
    expect(last.s).toBe(12000);
    expect(last.osmName).toBe('Endhuis');
    expect(stops.filter((stop) => stop.osmName === 'Endhuis')).toHaveLength(1);
  });

  it('collapses OSM stops packed closer than the minimum spacing', () => {
    const stops = planLineStops(LINE, [
      { name: 'Twin A', x: 6000, z: 50 },
      { name: 'Twin B', x: 6400, z: 20 }, // 400 m on: same physical stop, nearer the rails
    ]);
    const twins = stops.filter((stop) => stop.osmName?.startsWith('Twin'));
    expect(twins).toHaveLength(1);
    expect(twins[0]!.osmName).toBe('Twin B');
  });
});

describe('buildStations', () => {
  it('names synthesized stops after the nearest district and keeps OSM names', () => {
    const { stations } = buildStations([{ name: 'Test Line', points: LINE }], [{ name: 'Crown', x: 6000, z: 40 }], DISTRICTS);
    expect(stations.map((s) => s.name)).toContain('Crown Station'); // normalized OSM name
    expect(stations[0]!.name).toBe('Riverlea Station'); // synthetic end named from the district
    expect(stations.every((s) => s.line === 'Test Line')).toBe(true);
  });

  it('is deterministic (same inputs, byte-identical plan)', () => {
    const a = buildStations([{ name: 'Test Line', points: LINE }], [{ name: 'Crown', x: 6000, z: 40 }], DISTRICTS);
    const b = buildStations([{ name: 'Test Line', points: LINE }], [{ name: 'Crown', x: 6000, z: 40 }], DISTRICTS);
    expect(a.stations).toEqual(b.stations);
  });

  it('disambiguates repeated district names with a compass suffix', () => {
    const oneDistrict = [{ name: 'Riverlea', x: 6000, z: 0 }];
    const { stations } = buildStations([{ name: 'Test Line', points: LINE }], [], oneDistrict);
    const names = stations.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length); // all unique
    expect(names.some((name) => /-(Oos|Wes|Noord|Suid) /.test(name))).toBe(true);
  });

  it("gives the Lughawe Spur the airport's existing halt and a junction at the mainline end", () => {
    const spur: Pt[] = [{ x: 0, z: 0 }, { x: 3000, z: 0 }];
    const { stations } = buildStations([{ name: 'Lughawe Spur', points: spur }], [], DISTRICTS);
    expect(stations[stations.length - 1]!.name).toBe('Lughawe Halt');
    expect(stations[0]!.name).toMatch(/Junction$/);
  });

  it('reuses an existing station name when another line ends at the same interchange', () => {
    const branch: Pt[] = [{ x: 6000, z: 0 }, { x: 6000, z: 4000 }];
    const { stations } = buildStations(
      [{ name: 'Main', points: LINE }, { name: 'Branch', points: branch }],
      [{ name: 'Crown', x: 6000, z: 40 }],
      DISTRICTS,
    );
    const branchStart = stations.find((s) => s.line === 'Branch' && s.s === 0)!;
    expect(branchStart.name).toBe('Crown Station'); // shares the mainline stop it branches from
  });
});

describe('normalizeOsmName', () => {
  it('appends Station to bare names and leaves flavoured ones alone', () => {
    expect(normalizeOsmName('Crown')).toBe('Crown Station');
    expect(normalizeOsmName('Lughawe Halt')).toBe('Lughawe Halt');
    expect(normalizeOsmName('Johannesburg Park Station')).toBe('Johannesburg Park Station');
  });
});
