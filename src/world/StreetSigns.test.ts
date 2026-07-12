import { describe, expect, it } from 'vitest';
import {
  computeStreetSignJunctions,
  GENERATED_ROADS,
  SIGNAL_JUNCTIONS,
  STREET_SIGN_JUNCTIONS,
} from './mapData';

/** Unit road directions meeting exactly at (x, z), rebuilt from the road polylines (mirrors the
 *  internal junction accumulator) so the tests can check angle/label derivation from real road data. */
function incidentDirsAt(x: number, z: number): Array<{ name: string; width: number; dirX: number; dirZ: number }> {
  const dirs: Array<{ name: string; width: number; dirX: number; dirZ: number }> = [];
  for (const road of GENERATED_ROADS) {
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!;
      if (point.x !== x || point.z !== z) continue;
      const previous = road.points[Math.max(0, index - 1)] ?? point;
      const next = road.points[Math.min(road.points.length - 1, index + 1)] ?? point;
      const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
      dirs.push({ name: road.name, width: road.width, dirX: dx / length, dirZ: dz / length });
    }
  }
  return dirs;
}

const ROAD_NAMES = new Set(GENERATED_ROADS.map((road) => road.name.toUpperCase()));

describe('street-name sign junctions (BUG: signs only on the ~64 robots, not the whole map)', () => {
  it('places plenty of signs — far more than the signalised set, but not every micro-junction', () => {
    // The whole map has thousands of junctions; signalised ones number ~64. Street signs must read as
    // "plenty" across the city, yet stay a selected subset of real NAMED crossings (not every stub).
    expect(STREET_SIGN_JUNCTIONS.length).toBeGreaterThan(400);
    expect(STREET_SIGN_JUNCTIONS.length).toBeLessThan(1200);
    expect(STREET_SIGN_JUNCTIONS.length).toBeGreaterThan(SIGNAL_JUNCTIONS.length * 5);
  });

  it('is deterministic — same selection every rebuild', () => {
    expect(JSON.stringify(computeStreetSignJunctions())).toBe(JSON.stringify(computeStreetSignJunctions()));
    expect(JSON.stringify(computeStreetSignJunctions())).toBe(JSON.stringify(STREET_SIGN_JUNCTIONS));
  });

  it('labels every board with two DISTINCT, real, named roads (no "Unnamed"/"Water"/blank placeholders)', () => {
    for (const junction of STREET_SIGN_JUNCTIONS) {
      expect(junction.roadA).not.toBe(junction.roadB); // two distinct street names, one per board
      for (const label of [junction.roadA, junction.roadB]) {
        expect(label.trim().length).toBeGreaterThan(0);
        expect(label).toBe(label.toUpperCase()); // boards render upper-case
        expect(/^UNNAMED\b/.test(label)).toBe(false);
        expect(label).not.toBe('WATER');
        expect(ROAD_NAMES.has(label)).toBe(true); // the name is a real generated road, not invented
      }
    }
  });

  it('derives the sign angle from the widest incident road so roadA aligns to its street', () => {
    let checked = 0;
    for (const junction of STREET_SIGN_JUNCTIONS) {
      const dirs = incidentDirsAt(junction.x, junction.z);
      expect(dirs.length).toBeGreaterThanOrEqual(2); // a real crossing sits on >= 2 road vertices
      // The board angle must run parallel to some incident carriageway (dot ~= +/-1), not point off into a verge.
      const facing = { x: Math.sin(junction.angle), z: Math.cos(junction.angle) };
      const alignedToARoad = dirs.some((dir) => Math.abs(dir.dirX * facing.x + dir.dirZ * facing.z) > 0.999);
      expect(alignedToARoad).toBe(true);
      // roadA is the widest named road at the node, and widest tracks its width.
      const widestNamed = dirs
        .filter((dir) => dir.name.toUpperCase() === junction.roadA)
        .reduce((max, dir) => Math.max(max, dir.width), 0);
      expect(widestNamed).toBeCloseTo(junction.widest);
      checked++;
    }
    expect(checked).toBe(STREET_SIGN_JUNCTIONS.length);
  });

  it('honours the width floor and tightens as thresholds rise (tunable, monotone)', () => {
    expect(STREET_SIGN_JUNCTIONS.every((junction) => junction.widest >= 7)).toBe(true);
    const wide = computeStreetSignJunctions({ minWidestWidth: 12, minSecondWidth: 10 });
    expect(wide.length).toBeLessThan(STREET_SIGN_JUNCTIONS.length);
    expect(wide.every((junction) => junction.widest >= 12)).toBe(true);
    const capped = computeStreetSignJunctions({ budget: 50 });
    expect(capped.length).toBe(50); // budget caps the count
  });

  it('spreads the boards out — no two selected corners share a spot', () => {
    const keys = new Set(STREET_SIGN_JUNCTIONS.map((junction) => `${junction.x}|${junction.z}`));
    expect(keys.size).toBe(STREET_SIGN_JUNCTIONS.length); // every junction is a distinct node
  });
});
