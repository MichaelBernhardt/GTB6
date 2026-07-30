import { describe, expect, it } from 'vitest';
import {
  buildHydrantStations, buildStreetlampPoints, hydrantStationCandidates, hydrantStationPoint,
  HYDRANT_STATION_PHASE, HYDRANT_STATION_SPACING, ROAD_NETWORK, ROAD_SAMPLE_SPACING, ROADSIDE_OFFSET,
  sampleRoadPath, STREETLAMP_MIN_WIDTH, STREETLAMP_SPACING, type RoadDefinition,
} from './City';
import { METRES_PER_UNIT } from './mapData';

const straightRoad = (width: number, length: number): RoadDefinition => ({
  name: 'Test Straight', width, points: [{ x: 0, z: 0 }, { x: length, z: 0 }],
});

/**
 * Fire-hydrant COVERAGE. The owner's report was "I can't find any hydrants", and the first attempt at it
 * tightened a modulus over a global index into City.roadsidePoints — which is not a coverage rule at all.
 * Measured on that attempt: nearly triple the hydrants, and yet 25% of the pavement ended up FARTHER from
 * one, with a Melrose pavement that had a hydrant underfoot left 303u from the nearest.
 *
 * These are the properties that make the arc-length model a bound rather than a lottery, asserted without
 * constructing a City (which needs THREE + textures): a station per pitch of every street, a station on
 * every street however short, a bounded slide that cannot leave its own kerb, and a pitch that stays a
 * pitch when it is retuned.
 */
describe('fire-hydrant stations (buildHydrantStations)', () => {
  it('spaces stations by arc length along the street, alternating kerbs, on a fixed phase', () => {
    const width = 11; const length = 600;
    const stations = buildHydrantStations([straightRoad(width, length)]);
    expect(stations.length).toBe(Math.floor((length - HYDRANT_STATION_PHASE) / HYDRANT_STATION_SPACING) + 1);
    const offset = width / 2 + ROADSIDE_OFFSET;
    stations.forEach((station, index) => {
      expect(station.arc).toBeCloseTo(HYDRANT_STATION_PHASE + index * HYDRANT_STATION_SPACING, 6);
      expect(station.side).toBe(index % 2 === 0 ? 1 : -1);
      const point = hydrantStationPoint(station)!;
      expect(point.x).toBeCloseTo(station.arc, 6);
      expect(Math.abs(point.z)).toBeCloseTo(offset, 6);
      expect(Math.sign(point.inwardZ)).toBe(-Math.sign(point.z)); // inward faces back over the carriageway
      expect(point.inwardX).toBeCloseTo(0, 9);
      expect(point.width).toBe(width);
    });
  });

  it('never stands a hydrant in front of a lamp post', () => {
    // Both passes walk the same sampled centreline, so a shared phase would put a hydrant 2.12u in front of
    // a lamp on every single station, forever. HYDRANT_STATION_PHASE is a whole lamp span against the lamps'
    // half span, which is the maximum separation available: half a lamp span at every station.
    const road = straightRoad(11, 600);
    const lamps = buildStreetlampPoints([road]);
    const stations = buildHydrantStations([road]);
    for (const station of stations) {
      const point = hydrantStationPoint(station)!;
      const nearest = Math.min(...lamps.map((lamp) => Math.abs(lamp.x - point.x)));
      expect(nearest).toBeCloseTo(STREETLAMP_SPACING / 2, 6);
    }
  });

  it('bounds the walk along any street: a station every pitch, first one within the phase', () => {
    for (const length of [40, 90, 260, 1000, 4000]) {
      const stations = buildHydrantStations([straightRoad(9, length)]);
      expect(stations.length).toBeGreaterThan(0);
      const arcs = stations.map((station) => station.arc).sort((a, b) => a - b);
      expect(arcs[0]!).toBeLessThanOrEqual(HYDRANT_STATION_PHASE);
      for (let index = 1; index < arcs.length; index++) {
        expect(arcs[index]! - arcs[index - 1]!).toBeCloseTo(HYDRANT_STATION_SPACING, 6);
      }
      expect(length - arcs[arcs.length - 1]!).toBeLessThan(HYDRANT_STATION_SPACING);
    }
  });

  it('gives even a stub shorter than the phase its own station, at its midpoint', () => {
    // A global stride skipped whole short streets by luck; this is the guarantee that replaces that luck.
    const stub = buildHydrantStations([straightRoad(6, 12)]);
    expect(stub).toHaveLength(1);
    expect(stub[0]!.arc).toBeCloseTo(6, 6);
  });

  it('keeps the same width floor as the lamps and no other road-class gate', () => {
    // The old pass inherited the bench's `width >= 9`, which excluded 22.6% of the network — the 6-8u
    // residential streets, which is exactly where SANS 10090 category D puts hydrants.
    expect(buildHydrantStations([straightRoad(STREETLAMP_MIN_WIDTH - 1, 400)])).toHaveLength(0);
    expect(buildHydrantStations([straightRoad(STREETLAMP_MIN_WIDTH, 400)]).length).toBeGreaterThan(0);
    const narrow = ROAD_NETWORK.filter((road) => road.width < 9);
    expect(narrow.length).toBeGreaterThan(100); // the generated map really is mostly narrow streets
    expect(buildHydrantStations(narrow).length).toBeGreaterThan(500);
  });

  it('covers the whole generated network at the real-world pitch it claims', () => {
    const stations = buildHydrantStations(ROAD_NETWORK);
    let eligible = 0;
    for (const road of ROAD_NETWORK) {
      if (road.width < STREETLAMP_MIN_WIDTH) continue;
      for (let index = 0; index < road.points.length - 1; index++) {
        eligible += Math.hypot(road.points[index + 1]!.x - road.points[index]!.x, road.points[index + 1]!.z - road.points[index]!.z);
      }
    }
    // Predict PER ROAD, including the floor. `eligible / pitch` alone is wrong, and wrong in a way that
    // depends on the pitch: every eligible road is guaranteed its own station however short it is, so the
    // floor does not shrink when the pitch widens. Measured, going 78 u -> 130 u removed only 31% of the
    // hydrants rather than 40%. A single global ratio therefore has to be re-tuned on every pitch change,
    // which is exactly what it failed to do — it passed at 1.35 for 78 u and needed 1.42 for 130 u. Summing
    // max(1, length/pitch) models the floor directly, so the bound below is TIGHTER than the old one at any
    // pitch, not looser, and it will not need touching next time the pitch moves.
    let predicted = 0;
    for (const road of ROAD_NETWORK) {
      if (road.width < STREETLAMP_MIN_WIDTH) continue;
      let length = 0;
      for (let index = 0; index < road.points.length - 1; index++) {
        length += Math.hypot(road.points[index + 1]!.x - road.points[index]!.x, road.points[index + 1]!.z - road.points[index]!.z);
      }
      predicted += Math.max(1, length / HYDRANT_STATION_SPACING);
    }
    expect(predicted).toBeGreaterThan(eligible / HYDRANT_STATION_SPACING); // the floor really is what dominates
    expect(stations.length).toBeGreaterThan(predicted * 0.95);
    expect(stations.length).toBeLessThan(predicted * 1.1);
    // SANS 10090 table 9 allows 85 m (category A) to 300 m (category D1) between hydrants; Joburg's own
    // Emergency Services by-laws restate 120/180 m. The station pitch must land inside that bracket.
    expect(HYDRANT_STATION_SPACING * METRES_PER_UNIT).toBeGreaterThan(85);
    expect(HYDRANT_STATION_SPACING * METRES_PER_UNIT).toBeLessThan(200);
  });

  it('is deterministic — same network in, identical stations out', () => {
    const a = buildHydrantStations(ROAD_NETWORK);
    const b = buildHydrantStations(ROAD_NETWORK);
    expect(b.length).toBe(a.length);
    const flatten = (stations: typeof a): string => JSON.stringify(stations.slice(0, 400)
      .map((station) => [station.road.name, station.arc, station.side, hydrantStationPoint(station)]));
    expect(flatten(b)).toBe(flatten(a));
  });
});

describe('a station that cannot be used slides along its own kerb', () => {
  const road = straightRoad(11, 600);

  it('offers its own spot first, then alternating steps, and never more than half a pitch', () => {
    const station = buildHydrantStations([road])[3]!;
    const candidates = [...hydrantStationCandidates(station)];
    expect(candidates[0]!.x).toBeCloseTo(station.arc, 6);
    const deltas = candidates.map((point) => point.x - station.arc);
    expect(Math.max(...deltas.map(Math.abs))).toBeLessThanOrEqual(HYDRANT_STATION_SPACING / 2);
    // nearest-first: |delta| is non-decreasing, so a rescued hydrant moves as little as possible
    for (let index = 1; index < deltas.length; index++) {
      expect(Math.abs(deltas[index]!)).toBeGreaterThanOrEqual(Math.abs(deltas[index - 1]!) - 1e-9);
    }
    // Half a pitch is the widest slide that keeps stations ORDERED: two neighbours sliding towards each
    // other can meet but never swap, so a rescue can never reshuffle a street or hop to another road.
    for (const point of candidates) {
      expect(Math.abs(point.z)).toBeCloseTo(road.width / 2 + ROADSIDE_OFFSET, 6);
      expect(Math.sign(point.z)).toBe(Math.sign(hydrantStationPoint(station)!.z));
    }
  });

  it('runs out rather than off the end of its road', () => {
    const stations = buildHydrantStations([straightRoad(9, 100)]);
    const last = stations[stations.length - 1]!;
    expect(hydrantStationPoint(last, HYDRANT_STATION_SPACING)).toBeUndefined();
    expect(hydrantStationPoint(stations[0]!, -HYDRANT_STATION_SPACING)).toBeUndefined();
    for (const point of hydrantStationCandidates(last)) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it('stays one verge offset off the centreline it belongs to, round a bend as well as along a straight', () => {
    // The invariant that survives a corner: inward is the unit normal pointing at the carriageway, so
    // stepping one verge offset along it from any candidate must land back ON the sampled centreline. (Near
    // a vertex the kerb offset of the crossing leg does reach across the junction; the placement guards
    // reject those spots as road, which is what isRoad and isPavementDrawn are there for.)
    const bend: RoadDefinition = { name: 'Test Bend', width: 8, points: [{ x: 0, z: 0 }, { x: 200, z: 0 }, { x: 200, z: 200 }] };
    const stations = buildHydrantStations([bend]);
    expect(stations.length).toBeGreaterThan(2);
    const centreline = sampleRoadPath(bend.points, false, ROAD_SAMPLE_SPACING);
    const distanceToCentreline = (x: number, z: number): number => {
      let best = Infinity;
      for (let index = 0; index < centreline.length - 1; index++) {
        const a = centreline[index]!; const b = centreline[index + 1]!;
        const dx = b.x - a.x; const dz = b.z - a.z; const lengthSquared = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
        best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
      }
      return best;
    };
    const offset = bend.width / 2 + ROADSIDE_OFFSET;
    for (const station of stations) {
      for (const point of hydrantStationCandidates(station)) {
        expect(Math.hypot(point.inwardX, point.inwardZ)).toBeCloseTo(1, 9);
        expect(distanceToCentreline(point.x + point.inwardX * offset, point.z + point.inwardZ * offset)).toBeCloseTo(0, 6);
      }
    }
  });
});
