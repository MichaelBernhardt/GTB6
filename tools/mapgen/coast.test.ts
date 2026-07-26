/**
 * Regression tests over the committed composite map: the Vaalpunt Dam shore (a strip of the real
 * Vaal Dam), the rural corridor, and their contract with the game (water boundary, connectivity).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COASTAL_ROAD_NAME, CORRIDOR_LINKS, DAM_LEVEL_M, DAM_REACH_EAST_M, FRONTAGE_ROAD_NAME } from './config';
import { RIDGE_ZERO_Z } from './ridge';
import type { JoburgMap } from './types';

const mapPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/world/generated/joburg-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8')) as JoburgMap;
const coast = map.coast!;
const rural = map.rural!;

function pointInPolygon(polygon: [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!; const b = polygon[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

describe('Vaalpunt Dam shore', () => {
  it('ships coastline, ocean, beaches, harbour and corridor extents', () => {
    expect(coast).toBeDefined();
    expect(coast.coastline.length).toBeGreaterThan(30);
    expect(coast.ocean.length).toBeGreaterThan(coast.coastline.length);
    expect(coast.beaches.length).toBeGreaterThanOrEqual(1);
    expect(coast.corridor.westX).toBeLessThan(coast.corridor.eastX);
    expect(coast.harbour.x).toBeLessThan(coast.corridor.westX); // the quay is on the coast strip
  });

  it('is a LOBE pushing in from the west, with land in both west corners (D1)', () => {
    // The owner: "like the lake is pushing in from the left side, but never covers the full left
    // extent". So the band must END inside the world square in z — the inverse of the old rule,
    // which required it to run off the top and bottom — while the SHORE at those ends has already
    // run west past the world edge, so the two closing caps are never in frame.
    const half = map.stats.targetSize / 2;
    const shoreZs = coast.coastline.map((point) => point[1]);
    const northZ = Math.min(...shoreZs); const southZ = Math.max(...shoreZs);
    expect(northZ).toBeGreaterThan(-half + 700); // dry land in the top-left corner
    expect(southZ).toBeLessThan(half - 700); // dry land in the bottom-left corner
    // Both corners are outside the water polygon, tested where the map actually is.
    for (const cornerZ of [-half + 60, half - 60]) {
      expect(pointInPolygon(coast.ocean, -half + 60, cornerZ)).toBe(false);
    }
    // The shore leaves the frame at both ends rather than stopping in it.
    const ends = [coast.coastline[0]!, coast.coastline[coast.coastline.length - 1]!];
    for (const end of ends) expect(end[0]).toBeLessThan(-half);
  });

  it('shows no ruler-straight run anywhere the player can see it', () => {
    // METHOD — this is the point of the test, because the previous version could not fail.
    //
    // The defect: the water polygon closed with two 2,029-unit caps at EXACTLY 0.0 degrees off
    // east-west whose nearest ends sat 321 units (425 m) OUTSIDE the world square. That is real
    // rendered mesh (City pushes the whole polygon as one water site; Water turns it into a
    // ShapeGeometry) with void above it, and FogExp2 at 0.00025 takes about 1% at that range. The
    // old test only scored runs whose MIDPOINT was inside the square, which structurally cannot see
    // a cap just outside it, and the pass that shipped it asserted "never in frame" without ever
    // measuring the distance.
    //
    // So: (1) a "run" is a maximal span every interior vertex of which is within 2 units of its own
    // chord — curvature-aware, so subdividing a cap into forty short segments does not hide it, the
    // way a per-segment or heading-chaining test would; (2) each run is scored by its CLOSEST
    // APPROACH to the square, not by its midpoint; (3) the SHORELINE and the CLOSURE are judged
    // separately, because a straight stretch of shoreline is real coast (the raw OSM Vaal ring
    // behind the longest one here is straight to within 8 m over 1,284 m of real shoreline) while a
    // straight stretch of closure is the synthetic thing that was wrong.
    const half = map.stats.targetSize / 2;
    const runsOf = (poly: Array<[number, number]>): Array<[[number, number], [number, number]]> => {
      const out: Array<[[number, number], [number, number]]> = [];
      let i = 0;
      while (i < poly.length - 1) {
        let j = i + 1; let last = j;
        while (j < poly.length) {
          const a = poly[i]!; const b = poly[j]!;
          const dx = b[0] - a[0]; const dz = b[1] - a[1]; const len = Math.hypot(dx, dz) || 1;
          let bulge = 0;
          for (let k = i + 1; k < j; k++) bulge = Math.max(bulge, Math.abs((poly[k]![0] - a[0]) * dz - (poly[k]![1] - a[1]) * dx) / len);
          if (bulge > 2) break;
          last = j; j++;
        }
        out.push([poly[i]!, poly[last]!]);
        i = Math.max(last, i + 1);
      }
      return out;
    };
    const approach = (a: [number, number], b: [number, number]): number => {
      let best = Infinity;
      for (let t = 0; t <= 256; t++) {
        const x = a[0] + (b[0] - a[0]) * (t / 256); const z = a[1] + (b[1] - a[1]) * (t / 256);
        best = Math.min(best, Math.hypot(Math.max(Math.abs(x) - half, 0), Math.max(Math.abs(z) - half, 0)));
      }
      return best;
    };
    const visible = 3000 / map.stats.metresPerUnit; // 3 km: far past anything the fog leaves legible

    // THE CLOSURE — the synthetic part. Nothing long, and nothing anywhere near the square.
    const closure = [...coast.ocean.slice(coast.coastline.length - 1), coast.ocean[0]!];
    let closestClosure = Infinity; let worstNearClosure = 0;
    for (const [a, b] of runsOf(closure)) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 120) continue;
      const d = approach(a, b);
      closestClosure = Math.min(closestClosure, d);
      if (d <= visible) worstNearClosure = Math.max(worstNearClosure, len);
    }
    expect(closestClosure).toBeGreaterThan(1500); // the defect stood 321 units off
    expect(worstNearClosure).toBeLessThan(500); // the defect ran 2,029 units

    // THE SHORELINE — real coast, judged on its own. A drowned valley wall is straight; a ruler is
    // not. 900 units is 1.2 km, and the current worst is a 752-unit stretch 9.3 degrees off axis.
    let worstShore = 0;
    for (const [a, b] of runsOf(coast.coastline)) worstShore = Math.max(worstShore, Math.hypot(b[0] - a[0], b[1] - a[1]));
    expect(worstShore).toBeLessThan(900);
  });

  it('coastline forms a continuous south-to-north boundary along the west edge', () => {
    // Scale-invariant: the shoreline resample step is DAM_SHORE_STEP_M, so cap the gap in metres
    // (keeps passing across TARGET_SIZE tweaks instead of a hard-coded unit threshold).
    let previous = coast.coastline[0]!;
    for (const point of coast.coastline.slice(1)) {
      const gapM = Math.hypot(point[0] - previous[0], point[1] - previous[1]) * map.stats.metresPerUnit;
      expect(gapM).toBeLessThan(620);
      previous = point;
    }
    // Monotone in z: every runtime consumer models the shore as x = f(z) (dam.ts rule 1).
    for (let i = 1; i < coast.coastline.length; i++) {
      expect(coast.coastline[i]![1]).toBeLessThan(coast.coastline[i - 1]![1]);
    }
    const zs = coast.coastline.map((point) => point[1]);
    const span = Math.max(...zs) - Math.min(...zs);
    // A LOBE, NOT A BAND — but measured on the thing the owner actually reacted to, which is how
    // much of the west edge is WATER, not how tall the shore polyline happens to be. Under the
    // uniform fit the shore dips west of the world edge INSIDE the band as well as at its ends, so
    // a 72%-tall band leaves 59% of the edge wet and still wraps land over both corners; the old
    // band-height proxy would have failed a lobe that is in fact drier than the one it guarded.
    expect(span).toBeGreaterThan(map.stats.targetSize * 0.4);
    expect(span).toBeLessThan(map.stats.targetSize * 0.78);
    const half = map.stats.targetSize / 2;
    const byZ = [...coast.coastline].sort((a, b) => a[1] - b[1]);
    const shoreXAt = (z: number): number => {
      if (z <= byZ[0]![1] || z >= byZ[byZ.length - 1]![1]) return -Infinity;
      let lo = 0; let hi = byZ.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (byZ[mid]![1] <= z) lo = mid; else hi = mid; }
      const a = byZ[lo]!; const b = byZ[hi]!;
      return b[1] === a[1] ? a[0] : a[0] + (b[0] - a[0]) * ((z - a[1]) / (b[1] - a[1]));
    };
    let wet = 0;
    for (let i = 0; i <= 400; i++) if (shoreXAt(-half + (map.stats.targetSize * i) / 400) > -half) wet++;
    expect(wet / 401).toBeGreaterThan(0.30); // still a dam, not a pond
    expect(wet / 401).toBeLessThan(0.66);    // still a lobe: the owner rejected the 64%+ sea
    // The real dam's northern arm cuts EAST into the corridor by design, bounded by the tanh
    // soft-clip (DAM_REACH_EAST_M), so the tolerance is that budget in units — not a fixed wobble.
    const reachUnits = DAM_REACH_EAST_M / map.stats.metresPerUnit;
    expect(Math.max(...coast.coastline.map((point) => point[0]))).toBeLessThan(coast.corridor.westX + reachUnits + 60);
  });

  it('puts both resort beaches on LAND at the waterline', () => {
    // The previous pass shipped Three Anchor Bay with all 24 vertices inside the water polygon,
    // which mapRender.ts drew as a sand sliver in open water.
    expect(coast.beaches.length).toBe(2);
    for (const beach of coast.beaches) {
      const wet = beach.points.filter((p) => pointInPolygon(coast.ocean, p[0], p[1]));
      expect(wet, `${beach.name} vertices in the water`).toEqual([]);
    }
  });

  it('no road crosses into the ocean (quays excepted — they end at the water)', () => {
    const offenders: string[] = [];
    for (const road of map.roads) {
      if (road.name === 'Deneys Quay') continue; // the quay is supposed to reach the water
      for (let index = 0; index < road.points.length; index += 2) {
        const point = road.points[index]!;
        if (pointInPolygon(coast.ocean, point[0], point[1])) { offenders.push(`${road.name}@${point[0]},${point[1]}`); break; }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the coastal highway exists and joins the network (single component is proved elsewhere)', () => {
    const highway = map.roads.filter((road) => road.name === COASTAL_ROAD_NAME);
    expect(highway.length).toBeGreaterThanOrEqual(1);
    const key = (point: [number, number]): string => `${point[0]},${point[1]}`;
    const highwayKeys = new Set(highway.flatMap((road) => road.points.map(key)));
    const otherKeys = new Set(map.roads.filter((road) => road.name !== COASTAL_ROAD_NAME).flatMap((road) => road.points.map(key)));
    let shared = 0;
    for (const k of highwayKeys) if (otherKeys.has(k)) shared++;
    expect(shared).toBeGreaterThanOrEqual(4); // both corridor links, the quay, and the orbital ends
  });

  it('registers the ocean and premium dams for the tiered water system', () => {
    expect(map.stats.oceanKm2).toBeGreaterThan(5);
    expect(map.stats.landKm2).toBeGreaterThan(100);
  });
});

describe('rural corridor', () => {
  it('is a real drive: within the owner range, crossed by both creative links', () => {
    // Corridor width is metre-denominated (CORRIDOR_WIDTH_M), so in units it scales with the
    // footprint: ~0.15 of targetSize (≈918u at 6000, ≈5512u at 36000) — "a little drive" that grows
    // proportionally with the map.
    expect(map.stats.corridorWidthUnits).toBeGreaterThanOrEqual(map.stats.targetSize * 0.1);
    expect(map.stats.corridorWidthUnits).toBeLessThanOrEqual(map.stats.targetSize * 0.2);
    const names = new Set(map.roads.map((road) => road.name));
    for (const link of CORRIDOR_LINKS) expect(names.has(link.name), link.name).toBe(true);
    expect(names.has(FRONTAGE_ROAD_NAME)).toBe(true);
  });

  it('has farmland fields, farm buildings and dirt tracks inside the corridor band', () => {
    const fields = map.landuse.filter((area) => area.kind === 'farmland');
    expect(fields.length).toBeGreaterThanOrEqual(6);
    for (const field of fields) {
      for (const point of field.points) {
        expect(point[0]).toBeGreaterThan(coast.corridor.westX - 120 * (map.stats.targetSize / 6000));
        expect(point[0]).toBeLessThan(coast.corridor.eastX + 120 * (map.stats.targetSize / 6000));
      }
    }
    expect(rural.farms.length).toBeGreaterThanOrEqual(6);
    expect(rural.farms.every((farm) => farm.x > coast.corridor.westX && farm.x < coast.corridor.eastX)).toBe(true);
    const plaasTracks = map.tracks.filter((track) => track.name === 'Plaas track');
    expect(plaasTracks.length).toBeGreaterThanOrEqual(3);
  });

  it('serves boerewors rolls at Ouma se Padstal (names-overrides applied)', () => {
    expect(rural.padstal.name).toBe('Ouma se Padstal');
    expect(map.landmarks.some((landmark) => landmark.name === 'Ouma se Padstal' && landmark.kind === 'padstal')).toBe(true);
  });

  it('bakes gentle corridor hills and sea level into the composite height grid', () => {
    const e = map.elevation;
    expect(e.data).toHaveLength(e.cols * e.rows);
    expect(map.stats.minElevation).toBe(DAM_LEVEL_M); // the reservoir surface, not sea level
    expect(map.stats.maxElevation).toBeGreaterThan(1500); // the Rand
    // Sample the corridor band: it must sit between sea level and the city plateau.
    const corridorMidX = (coast.corridor.eastX + coast.corridor.westX) / 2;
    const col = Math.round((corridorMidX - e.x0) / e.dx);
    let corridorMax = 0;
    for (let row = 10; row < e.rows - 10; row++) corridorMax = Math.max(corridorMax, e.data[row * e.cols + col]!);
    expect(corridorMax).toBeGreaterThan(DAM_LEVEL_M);
    expect(corridorMax).toBeLessThan(1900);
  });

  it('raises a tall fractal range along the top edge, tapered off the CBD, corridor and ocean', () => {
    const e = map.elevation;
    const ridge = e.ridge!;
    expect(ridge).toHaveLength(e.data.length);
    const at = (col: number, row: number): number => ridge[row * e.cols + col]!;
    const colOf = (x: number): number => Math.round((x - e.x0) / e.dx);
    const rowOf = (z: number): number => Math.round((z - e.z0) / e.dz);
    expect(Math.max(...ridge)).toBeGreaterThan(1000); // the crest genuinely towers over the ~1750 m plateau
    // Everything south of the CBD guard carries EXACTLY zero mountain. The guard is authored in
    // PROJECTED metres (RIDGE_ZERO_Z), so derive its game-unit row from the shipped fit instead
    // of hard-coding a z that only meant something at the old footprint.
    const { scale, cz } = map.stats.fit!;
    const guardZ = (RIDGE_ZERO_Z - cz) * scale;
    for (let row = rowOf(guardZ) + 1; row < e.rows; row++) for (let col = 0; col < e.cols; col++) expect(at(col, row)).toBe(0);
    const cbd = { x: -map.stats.fit!.cx * scale, z: -cz * scale };
    expect(at(colOf(cbd.x), rowOf(cbd.z))).toBe(0); // Joburg CBD
    // The ocean/coast columns and the rural corridor carry none either.
    for (let row = 0; row < e.rows; row++) {
      expect(at(2, row)).toBe(0);
      expect(at(colOf((coast.corridor.westX + coast.corridor.eastX) / 2), row)).toBe(0);
    }
  });
});
