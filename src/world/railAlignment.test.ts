import { describe, expect, it } from 'vitest';
import {
  RAIL_DECONFLICT_DEFAULTS, deconflictRailway, resampleRail, simplifyRail,
  type RailPt, type RailRoadProbe, type RailRoadProbeFn,
} from './railAlignment';

/** A single infinite straight road of half-width `half` lying along the x axis at z = `at`. */
const straightRoad = (at: number, half: number): RailRoadProbeFn => (_x, z) => {
  const span = Math.abs(z - at);
  return { clearance: span - half, awayX: 0, awayZ: z >= at ? 1 : -1, dirX: 1, dirZ: 0, half };
};

const worstClearance = (points: readonly RailPt[], probe: RailRoadProbeFn): number => {
  let worst = Infinity;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!; const b = points[index + 1]!;
    const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const at = probe(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (at) worst = Math.min(worst, at.clearance);
    }
  }
  return worst;
};

describe('rail/road deconfliction', () => {
  it('resamples to an even pitch and keeps both endpoints exactly', () => {
    const out = resampleRail([{ x: 0, z: 0 }, { x: 100, z: 0 }], 8);
    expect(out[0]).toEqual({ x: 0, z: 0 });
    expect(out[out.length - 1]).toEqual({ x: 100, z: 0 });
    for (let i = 1; i < out.length - 1; i++) {
      expect(Math.hypot(out[i]!.x - out[i - 1]!.x, out[i]!.z - out[i - 1]!.z)).toBeCloseTo(8, 6);
    }
  });

  it('only ever deletes vertices when simplifying, never moves one', () => {
    const points = [{ x: 0, z: 0 }, { x: 10, z: 0.1 }, { x: 20, z: 0 }, { x: 30, z: 9 }];
    const out = simplifyRail(points, 0.35);
    expect(out).toHaveLength(3);
    for (const point of out) expect(points).toContainEqual(point);
  });

  it('pushes a line that runs INSIDE a road out of it', () => {
    // A line lying 2 u off the centreline of a 10.5 u half-width road: buried for its whole length.
    const line: RailPt[] = [{ x: -600, z: 2 }, { x: 600, z: 2 }];
    const probe = straightRoad(0, 10.5);
    expect(worstClearance(line, probe)).toBeLessThan(0);

    const out = deconflictRailway(line, probe, { ...RAIL_DECONFLICT_DEFAULTS, endTaper: 0 });
    const required = RAIL_DECONFLICT_DEFAULTS.corridorHalf + RAIL_DECONFLICT_DEFAULTS.clearance;
    expect(worstClearance(out.points, probe)).toBeGreaterThanOrEqual(required - 0.01);
    expect(out.crossings).toHaveLength(0);
    expect(out.maxShift).toBeGreaterThan(0);
  });

  it('commits a whole conflict run to ONE side instead of flip-flopping across the centreline', () => {
    // Weaving across the road centreline flips the per-sample "open" direction sample by sample. Deciding
    // per sample and smoothing cancels the pushes to nothing and the line never leaves the tar.
    const line: RailPt[] = [];
    for (let x = -600; x <= 600; x += 25) line.push({ x, z: Math.sin(x / 60) * 4 });
    const probe = straightRoad(0, 10.5);
    const out = deconflictRailway(line, probe, { ...RAIL_DECONFLICT_DEFAULTS, endTaper: 0 });
    const required = RAIL_DECONFLICT_DEFAULTS.corridorHalf + RAIL_DECONFLICT_DEFAULTS.clearance;
    expect(worstClearance(out.points, probe)).toBeGreaterThanOrEqual(required - 0.01);
    const sides = new Set(out.points.map((point) => Math.sign(point.z)));
    expect(sides.size, 'the line ends up wholly on one side of the road').toBe(1);
  });

  it('leaves a genuine crossing alone and records it', () => {
    // Perpendicular: the line has to get to the other side, so nothing may move.
    const line: RailPt[] = [{ x: 0, z: -400 }, { x: 0, z: 400 }];
    const probe = straightRoad(0, 10.5);
    const out = deconflictRailway(line, probe, { ...RAIL_DECONFLICT_DEFAULTS, endTaper: 0 });
    expect(out.maxShift).toBeCloseTo(0, 6);
    expect(out.crossings.length).toBeGreaterThan(0);
    for (const crossing of out.crossings) {
      expect(Math.abs(crossing.roadDirX * crossing.dirX + crossing.roadDirZ * crossing.dirZ))
        .toBeLessThan(RAIL_DECONFLICT_DEFAULTS.parallelCos);
      expect(crossing.roadHalf).toBeCloseTo(10.5, 6);
    }
  });

  it('pins both ends so a grafted endpoint (the airport spur halt) cannot drift', () => {
    const line: RailPt[] = [{ x: -600, z: 2 }, { x: 600, z: 2 }];
    const out = deconflictRailway(line, straightRoad(0, 10.5));
    expect(out.points[0]!.x).toBeCloseTo(-600, 6);
    expect(out.points[0]!.z).toBeCloseTo(2, 6);
    expect(out.points[out.points.length - 1]!.x).toBeCloseTo(600, 6);
    expect(out.points[out.points.length - 1]!.z).toBeCloseTo(2, 6);
  });

  it('never moves a line that is already clear', () => {
    const line: RailPt[] = [{ x: -300, z: 60 }, { x: 300, z: 60 }];
    const out = deconflictRailway(line, straightRoad(0, 10.5));
    expect(out.maxShift).toBeCloseTo(0, 6);
    expect(out.shiftedLength).toBeCloseTo(0, 6);
  });

  it('caps an unsolvable push rather than flinging the line across the city', () => {
    // Sandwiched: whichever way it goes there is another road. It must stay put-ish, not run away.
    const both: RailRoadProbeFn = (_x, z) => {
      const options: RailRoadProbe[] = [
        { clearance: Math.abs(z - 0) - 10.5, awayX: 0, awayZ: z >= 0 ? 1 : -1, dirX: 1, dirZ: 0, half: 10.5 },
        { clearance: Math.abs(z - 24) - 10.5, awayX: 0, awayZ: z >= 24 ? 1 : -1, dirX: 1, dirZ: 0, half: 10.5 },
      ];
      return options.reduce((best, option) => (option.clearance < best.clearance ? option : best));
    };
    const line: RailPt[] = [{ x: -600, z: 12 }, { x: 600, z: 12 }];
    const out = deconflictRailway(line, both, { ...RAIL_DECONFLICT_DEFAULTS, endTaper: 0 });
    expect(out.maxShift).toBeLessThanOrEqual(RAIL_DECONFLICT_DEFAULTS.maxShift + 1e-6);
  });

  it('is deterministic: the same input gives byte-identical output', () => {
    const line: RailPt[] = [];
    for (let x = -600; x <= 600; x += 25) line.push({ x, z: Math.sin(x / 60) * 4 });
    const first = deconflictRailway(line, straightRoad(0, 10.5));
    const second = deconflictRailway(line, straightRoad(0, 10.5));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
