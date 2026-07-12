import { describe, expect, it } from 'vitest';
import { buildStreetlampPoints, ROAD_NETWORK, STREETLAMP_MIN_WIDTH, STREETLAMP_SPACING, type RoadDefinition } from './City';

const straightRoad = (width: number, length: number): RoadDefinition => ({
  name: 'Test Straight', width, points: [{ x: 0, z: 0 }, { x: length, z: 0 }],
});

describe('streetlamp placement (buildStreetlampPoints)', () => {
  it('lines the whole generated map, far denser than the old wide-road-only selection', () => {
    const lamps = buildStreetlampPoints(ROAD_NETWORK);
    // The old rule (index % 7 === 1 && width >= 9) picked ~3.8k anchors and skipped every narrow road;
    // arc-length staggering across all 774km of road puts a lamp roughly every STREETLAMP_SPACING.
    expect(lamps.length).toBeGreaterThan(15000);
    expect(lamps.length).toBeLessThan(40000); // still a sane instance budget for the chunk system
  });

  it('is deterministic — same network in, byte-identical anchors out', () => {
    const a = buildStreetlampPoints(ROAD_NETWORK);
    const b = buildStreetlampPoints(ROAD_NETWORK);
    expect(b.length).toBe(a.length);
    expect(b[0]).toEqual(a[0]);
    expect(b.at(-1)).toEqual(a.at(-1));
    expect(JSON.stringify(b.slice(0, 200))).toBe(JSON.stringify(a.slice(0, 200)));
  });

  it('now lights the narrow residential streets the old width>=9 floor skipped', () => {
    const residential = ROAD_NETWORK.filter((road) => road.width < 9);
    expect(residential.length).toBeGreaterThan(100); // the generated map really does have many narrow roads
    const lit = buildStreetlampPoints(residential);
    expect(lit.length).toBeGreaterThan(1000); // and they get lamps now, not zero
    expect(lit.every((lamp) => lamp.width >= STREETLAMP_MIN_WIDTH)).toBe(true);
  });

  it('drops nothing below the width floor (sub-road dirt tracks stay dark)', () => {
    expect(buildStreetlampPoints([straightRoad(STREETLAMP_MIN_WIDTH - 1, 400)])).toHaveLength(0);
    expect(buildStreetlampPoints([straightRoad(STREETLAMP_MIN_WIDTH, 400)]).length).toBeGreaterThan(0);
  });

  it('spaces lamps one STREETLAMP_SPACING apart along the road, alternating kerbs', () => {
    const width = 11; const lamps = buildStreetlampPoints([straightRoad(width, 400)]);
    expect(lamps.length).toBeGreaterThanOrEqual(10);
    const offset = width / 2 + 3.05;
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i]!;
      // On a road running along +x, lamps step by STREETLAMP_SPACING in x and flip kerb (±offset in z).
      expect(lamp.x).toBeCloseTo(STREETLAMP_SPACING / 2 + i * STREETLAMP_SPACING, 4);
      expect(Math.abs(lamp.z)).toBeCloseTo(offset, 4);
      if (i > 0) {
        const previous = lamps[i - 1]!;
        expect(Math.sign(lamp.z)).toBe(-Math.sign(previous.z)); // alternating sides
        const centrelineStep = Math.abs(lamp.x - previous.x);
        expect(centrelineStep).toBeCloseTo(STREETLAMP_SPACING, 4);
      }
      // inward normal faces back over the carriageway (opposite the verge offset)
      expect(Math.sign(lamp.inwardZ)).toBe(-Math.sign(lamp.z));
      expect(lamp.inwardX).toBeCloseTo(0, 6);
    }
  });

  it('keeps consecutive lamps at a believable real-world pitch (~25–45u)', () => {
    const lamps = buildStreetlampPoints([straightRoad(11, 600)]);
    for (let i = 1; i < lamps.length; i++) {
      const a = lamps[i - 1]!; const b = lamps[i]!;
      const gap = Math.hypot(b.x - a.x, b.z - a.z);
      expect(gap).toBeGreaterThan(25);
      expect(gap).toBeLessThan(45);
    }
  });
});
