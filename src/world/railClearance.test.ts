import { describe, expect, it } from 'vitest';
import {
  GENERATED_RAILWAYS, GENERATED_ROADS, RAILWAY_CORRIDOR_HALF_WIDTH, RAILWAY_LEVEL_CROSSINGS,
  RAILWAY_STATION_SITES, ROAD_BUILD_MARGIN, STATION_PLATFORM_WIDTH,
  distanceToBuiltRoadEdge, distanceToRoadEdge, nearestBuiltRoad,
  platformSideClearance, stationPlatformLength,
} from './mapData';
import { RAIL_DECONFLICT_DEFAULTS } from './railAlignment';
import { SIDEWALK_INNER_EDGE, SIDEWALK_WIDTH } from './City';

/** Every sample along every line, at `step` units. */
function* railSamples(step = 4): Generator<{ x: number; z: number; dirX: number; dirZ: number; step: number }> {
  for (const line of GENERATED_RAILWAYS) {
    for (let index = 0; index < line.points.length - 1; index++) {
      const a = line.points[index]!; const b = line.points[index + 1]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const steps = Math.max(1, Math.round(length / step));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        yield {
          x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
          dirX: (b.x - a.x) / length, dirZ: (b.z - a.z) / length, step: length / steps,
        };
      }
    }
  }
}

describe('road width as declared vs as built', () => {
  it('measures a road at its BUILT width, kerb and pavement included', () => {
    // The whole bug in one assertion. `width` is the carriageway; the build lays ROAD_BUILD_MARGIN of
    // kerb and sidewalk outside it. A clearance query that reads the declared width under-reads the
    // real road by that much, which is how the main line ended up under Albertina Sisulu Road.
    const road = GENERATED_ROADS.find((entry) => entry.name === 'Albertina Sisulu Road');
    expect(road, 'Albertina Sisulu Road is in the map').toBeDefined();

    // The pavement is a band that the tar query says is clear and the built query says is not. Walk out
    // from the carriageway on an open stretch — a neighbouring road would answer for both queries at
    // once and prove nothing.
    let pavement: { tar: number; built: number } | undefined;
    let beyond: { tar: number; built: number } | undefined;
    for (const line of GENERATED_ROADS) {
      if (line.name !== road!.name) continue;
      for (let index = 0; index < line.points.length - 1 && !pavement; index++) {
        const a = line.points[index]!; const b = line.points[index + 1]!;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 60) continue;
        const nx = -(b.z - a.z) / length; const nz = (b.x - a.x) / length;
        for (const side of [1, -1]) {
          const at = (offset: number): { tar: number; built: number } => {
            const x = (a.x + b.x) / 2 + nx * side * offset; const z = (a.z + b.z) / 2 + nz * side * offset;
            return { tar: distanceToRoadEdge(x, z), built: distanceToBuiltRoadEdge(x, z) };
          };
          const inside = at(line.width / 2 + 0.5);
          const outside = at(line.width / 2 + ROAD_BUILD_MARGIN + 0.5);
          if (inside.tar > 0 && outside.tar > 0 && outside.built > 0) { pavement = inside; beyond = outside; break; }
        }
      }
    }
    expect(pavement, 'found an open stretch of the road to measure across').toBeDefined();
    expect(pavement!.tar, 'half a unit past the kerb: clear of the tar').toBeGreaterThan(0);
    expect(pavement!.built, 'half a unit past the kerb: still on the pavement').toBeLessThan(0);
    expect(beyond!.built, 'past the pavement: clear of the road as built').toBeGreaterThan(0);
  });

  it('never reports more room against the built road than against the tar', () => {
    for (const sample of railSamples(37)) {
      expect(distanceToBuiltRoadEdge(sample.x, sample.z))
        .toBeLessThanOrEqual(distanceToRoadEdge(sample.x, sample.z) + 1e-9);
    }
  });

  it('keeps the pavement the renderer lays and the footprint clearance measures in step', () => {
    // SIDEWALK_WIDTH is derived from ROAD_BUILD_MARGIN. If someone widens the pavement without moving
    // the margin, this fails rather than silently re-opening the bug on every clearance rule at once.
    expect(SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH).toBeCloseTo(ROAD_BUILD_MARGIN, 10);
  });

  it('reports which way is out, not just how far', () => {
    const road = GENERATED_ROADS.find((entry) => entry.name === 'Albertina Sisulu Road')!;
    const a = road.points[0]!; const b = road.points[1]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / length; const nz = (b.x - a.x) / length;
    const mid = { x: (a.x + b.x) / 2 + nx * 2, z: (a.z + b.z) / 2 + nz * 2 };
    const probe = nearestBuiltRoad(mid.x, mid.z);
    expect(probe).toBeDefined();
    expect(probe!.awayX * nx + probe!.awayZ * nz, 'away points off the road, not along it').toBeGreaterThan(0.9);
    expect(Math.abs(probe!.dirX * (b.x - a.x) / length + probe!.dirZ * (b.z - a.z) / length)).toBeCloseTo(1, 3);
  });
});

describe('rail is kept out of the roads it runs alongside', () => {
  it('leaves no long PARALLEL stretch of ballast inside a built road', () => {
    // Crossings are allowed and expected; running along inside a carriageway is not. Before the
    // deconfliction 4.90 km of the 22.5 km network was inside a built road, most of it parallel.
    let parallelInside = 0; let total = 0;
    for (const sample of railSamples()) {
      total += sample.step;
      const probe = nearestBuiltRoad(sample.x, sample.z);
      if (!probe || probe.clearance >= RAILWAY_CORRIDOR_HALF_WIDTH) continue;
      const alignment = Math.abs(sample.dirX * probe.dirX + sample.dirZ * probe.dirZ);
      if (alignment >= RAIL_DECONFLICT_DEFAULTS.parallelCos) parallelInside += sample.step;
    }
    expect(total).toBeGreaterThan(10_000);
    expect(parallelInside / total, 'share of rail running inside a road it parallels').toBeLessThan(0.03);
  });

  it('keeps the main line clear of Albertina Sisulu Road past Grosvenor', () => {
    // The owner's report: standing at (-449.1, 1543.2), the track ran inside the road and was buried.
    for (const sample of railSamples(3)) {
      if (sample.x < -700 || sample.x > 300 || sample.z < 1450 || sample.z > 1900) continue;
      const probe = nearestBuiltRoad(sample.x, sample.z);
      if (!probe) continue;
      const alignment = Math.abs(sample.dirX * probe.dirX + sample.dirZ * probe.dirZ);
      if (alignment < RAIL_DECONFLICT_DEFAULTS.parallelCos) continue; // a crossing, which is allowed
      expect(probe.clearance, `rail at (${sample.x.toFixed(0)}, ${sample.z.toFixed(0)})`)
        .toBeGreaterThanOrEqual(RAILWAY_CORRIDOR_HALF_WIDTH);
    }
  });

  it('puts every crossing ON the finished track, not where the track used to be', () => {
    // A crossing sample is not pushed on its own account, but the smoothing carries it with its
    // neighbours — so reading the crossing off the PRE-shift samples left markings up to 7.9 u to one
    // side of the rails they are meant to warn about.
    for (const crossing of RAILWAY_LEVEL_CROSSINGS) {
      let onLine = Infinity;
      for (const line of GENERATED_RAILWAYS) {
        for (let index = 0; index < line.points.length - 1; index++) {
          const a = line.points[index]!; const b = line.points[index + 1]!;
          const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((crossing.x - a.x) * dx + (crossing.z - a.z) * dz) / lengthSq));
          onLine = Math.min(onLine, Math.hypot(crossing.x - (a.x + dx * t), crossing.z - (a.z + dz * t)));
        }
      }
      expect(onLine, `crossing at (${crossing.x.toFixed(0)}, ${crossing.z.toFixed(0)})`)
        .toBeLessThan(RAILWAY_CORRIDOR_HALF_WIDTH);
    }
  });

  it('records real crossings only, never a parallel run dressed up as one', () => {
    expect(RAILWAY_LEVEL_CROSSINGS.length).toBeGreaterThan(0);
    for (const crossing of RAILWAY_LEVEL_CROSSINGS) {
      const alignment = Math.abs(crossing.dirX * crossing.roadDirX + crossing.dirZ * crossing.roadDirZ);
      expect(alignment, `crossing at (${crossing.x.toFixed(0)}, ${crossing.z.toFixed(0)})`)
        .toBeLessThan(RAIL_DECONFLICT_DEFAULTS.parallelCos);
      expect(crossing.roadHalf).toBeGreaterThan(0);
    }
  });

  it('still starts and ends every line where the pipeline put it', () => {
    // The Lughawe Spur's far end is grafted onto the airport halt; a drifting endpoint would strand it.
    expect(GENERATED_RAILWAYS.length).toBeGreaterThan(0);
    for (const line of GENERATED_RAILWAYS) {
      expect(line.points.length).toBeGreaterThanOrEqual(2);
      const span = Math.hypot(
        line.points[line.points.length - 1]!.x - line.points[0]!.x,
        line.points[line.points.length - 1]!.z - line.points[0]!.z,
      );
      expect(span, line.name).toBeGreaterThan(100);
    }
  });
});

describe('every station gets both its platforms', () => {
  it('never lays a platform slab on a carriageway', () => {
    // City.buildRailwayStation drops a side whose slab would land on the tar. Five of seventeen sites
    // did, which is what "one of the rail station sides is missing" was. Siting now slides the stop
    // along its own line until both sides fit, so nothing is dropped.
    const missing: string[] = [];
    for (const station of RAILWAY_STATION_SITES) {
      const length = stationPlatformLength(station.name);
      for (const side of [-1, 1] as const) {
        const clearance = platformSideClearance(station.x, station.z, station.dirX, station.dirZ, side, length);
        if (clearance.tar < STATION_PLATFORM_WIDTH / 2) missing.push(`${station.name} side ${side}`);
      }
    }
    expect(missing, 'stations that would render with a side missing').toEqual([]);
  });

  it('keeps every station on its own line, and does not slide two onto each other', () => {
    for (const station of RAILWAY_STATION_SITES) {
      let onLine = Infinity;
      const points = station.railway.points;
      for (let index = 0; index < points.length - 1; index++) {
        const a = points[index]!; const b = points[index + 1]!;
        const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((station.x - a.x) * dx + (station.z - a.z) * dz) / lengthSq));
        onLine = Math.min(onLine, Math.hypot(station.x - (a.x + dx * t), station.z - (a.z + dz * t)));
      }
      expect(onLine, `${station.name} sits on its line`).toBeLessThan(0.5);
    }
    for (let i = 0; i < RAILWAY_STATION_SITES.length; i++) {
      for (let j = i + 1; j < RAILWAY_STATION_SITES.length; j++) {
        const a = RAILWAY_STATION_SITES[i]!; const b = RAILWAY_STATION_SITES[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.name} vs ${b.name}`).toBeGreaterThanOrEqual(40);
      }
    }
  });
});
