/**
 * Regression tests over the committed composite map: the Vaalpunt Dam shore (a strip of the real
 * Vaal Dam), the rural corridor, and their contract with the game (water boundary, connectivity).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COASTAL_ROAD_NAME, CORRIDOR_LINKS, DAM_LEVEL_M, FRONTAGE_ROAD_NAME } from './config';
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

  it('sits inside the OLD OCEAN\'s measured budget, with no closing edge in frame', () => {
    // The old Atlantic seaboard nobody complained about, measured: 20.7% of the world wide, 9.4%
    // of it hanging west of the square. The rejected build ran 56.9% wide with a 43.0% overhang:
    // the "speaker cone".
    //
    // THE WIDTH CEILING WAS RAISED FROM 0.26 TO 0.36, AND THAT IS A REAL LOOSENING — read this
    // before you accept it. Width here is a BOUNDING BOX: overhang + the deepest single arm. The
    // owner then required, by name, that Grooteiland be circumnavigable (a channel on BOTH sides,
    // so ~1,900 u of water before the island's east shore) and that Misty Bay sit properly inland.
    // tools/mapgen/search-placement.mjs was re-run with a hard cap of 2,150 u on the deepest arm
    // (MAX_REACH_U=2150) over every scale, every 6 degrees of rotation and a 700 m translation
    // grid: the best placement that satisfies both named places still measures 2,864 u wide
    // (29.2%), and it costs a fifth of the island's size, 4.5 points of wet west edge and a fifth
    // of the water area — a drier map than the one already rejected for being dry. So the ceiling
    // is the one the geometry actually allows, and the numbers that matter for the "speaker cone"
    // complaint — the OVERHANG and the MEAN reach — are both well inside the old ocean's.
    const size = map.stats.targetSize; const half = size / 2;
    const xs = coast.ocean.map((p) => p[0]);
    const width = Math.max(...xs) - Math.min(...xs);
    const overhang = -half - Math.min(...xs);
    expect(width / size).toBeLessThan(0.36);
    expect(overhang / size).toBeLessThan(0.095);
    expect(overhang).toBeGreaterThan(180); // the polygon must still leave the square, or its edge shows

    // D2 is asserted structurally by the "no ruler-straight run" test below: the closure is a clip
    // box whose three walls all lie outside the square, so a long straight run in frame is
    // impossible unless the construction breaks.
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

    // THE CLOSURE — the synthetic part. It is now the clip box: three walls, all outside the
    // square. Long straight runs are expected there and are harmless BY CONSTRUCTION, so what this
    // asserts is the construction: every long straight run in the polygon lies outside the square.
    let worstInFrame = 0;
    for (const [a, b] of runsOf([...coast.ocean, coast.ocean[0]!])) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 120) continue;
      if (approach(a, b) <= 0) worstInFrame = Math.max(worstInFrame, len);
    }
    expect(worstInFrame).toBeLessThan(500); // the defect ran 2,029 units

    // THE SHORELINE — real coast, judged on its own, and judged on the POLYGON rather than on the
    // per-z envelope (the envelope jumps 1.1 km across a bay mouth by design; the water does not).
    // Only segments whose whole length is inside the square count: a drowned-valley wall is
    // straight, a ruler is not, and 900 units is 1.2 km of it.
    let worstShore = 0;
    for (const [a, b] of runsOf([...coast.ocean, coast.ocean[0]!])) {
      if (approach(a, b) > 0) continue;
      worstShore = Math.max(worstShore, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    expect(worstShore).toBeLessThan(900);
  });

  it('wets most of the west edge, and only the west edge', () => {
    const size = map.stats.targetSize; const half = size / 2;
    const inRing = (ring: Array<[number, number]>, x: number, z: number): boolean => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!; const b = ring[j]!;
        if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
      }
      return c;
    };
    const islands = coast.islands ?? [];
    const wet = (x: number, z: number): boolean => inRing(coast.ocean, x, z) && !islands.some((r) => inRing(r, x, z));
    let wetRows = 0; let maxReach = 0; let wetCells = 0;
    const N = 200;
    for (let r = 0; r < N; r++) {
      const z = -half + (size * (r + 0.5)) / N;
      let row = false;
      for (let c = 0; c < N; c++) {
        const x = -half + (size * (c + 0.5)) / N;
        if (!wet(x, z)) continue;
        row = true; wetCells++;
        maxReach = Math.max(maxReach, x + half);
      }
      if (row) wetRows++;
    }
    expect(wetRows / N).toBeGreaterThan(0.55);           // it is a dam down the west edge, not a pond
    // The DEEPEST arm may run to 27% (see the budget test above: this is what Grooteiland's channel
    // costs), but the MEAN band must stay a band — that is the number the "57% wide" complaint was
    // really about, and it is 1,030 u here against the old ocean's ~1,100.
    expect(maxReach).toBeLessThan(size * 0.27);
    let reachSum = 0; let reachRows = 0;
    for (let r = 0; r < N; r++) {
      const z = -half + (size * (r + 0.5)) / N;
      let east = -Infinity;
      for (let c = 0; c < N; c++) { const x = -half + (size * (c + 0.5)) / N; if (wet(x, z)) east = x; }
      if (east > -Infinity) { reachSum += east + half; reachRows++; }
    }
    expect(reachSum / Math.max(1, reachRows)).toBeLessThan(size * 0.135);
    expect(wetCells / (N * N)).toBeGreaterThan(0.02);    // the old ocean wet 7.9% of the square
    expect(wetCells / (N * N)).toBeLessThan(0.12);
    // ...and nothing east of the corridor is wet at all.
    for (let r = 0; r < N; r++) {
      const z = -half + (size * (r + 0.5)) / N;
      expect(wet(0, z)).toBe(false);
    }
  });

  it('brings Grooteiland and the other real islands in as land in the water', () => {
    const half = map.stats.targetSize / 2;
    const islands = coast.islands ?? [];
    expect(islands.length).toBeGreaterThanOrEqual(2);
    const sizes = islands.map((ring) => {
      const xs = ring.map((p) => p[0]); const zs = ring.map((p) => p[1]);
      return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...zs) - Math.min(...zs),
        cx: (Math.max(...xs) + Math.min(...xs)) / 2, cz: (Math.max(...zs) + Math.min(...zs)) / 2 };
    }).sort((a, b) => b.w * b.h - a.w * a.h);
    const groot = sizes[0]!;
    expect(Math.max(groot.w, groot.h)).toBeGreaterThan(300); // reads as an island at map zoom
    expect(Math.abs(groot.cx)).toBeLessThan(half);           // and it is IN the world square
    expect(Math.abs(groot.cz)).toBeLessThan(half);
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

  it('has farmland fields, farm buildings and dirt tracks between the dam and the city', () => {
    const fields = map.landuse.filter((area) => area.kind === 'farmland');
    expect(fields.length).toBeGreaterThanOrEqual(6);
    const half = map.stats.targetSize / 2;
    const islands = coast.islands ?? [];
    const ringHas = (ring: Array<[number, number]>, x: number, z: number): boolean => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!; const b = ring[j]!;
        if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
      }
      return c;
    };
    const wet = (x: number, z: number): boolean =>
      ringHas(coast.ocean, x, z) && !islands.some((r) => ringHas(r, x, z));
    for (const field of fields) {
      for (const point of field.points) {
        // The lanes now run WEST of the corridor into the dam's own hinterland — the strip between
        // the corridor and the water was 2 km of empty dark veld otherwise. Two things still hold,
        // and they are the ones that matter: a field is ON THE MAP, and a field is NOT IN THE DAM.
        expect(point[0]).toBeGreaterThan(-half);
        expect(point[0]).toBeLessThan(coast.corridor.eastX + 120 * (map.stats.targetSize / 6000));
        expect(wet(point[0], point[1]), `field vertex in the water at ${point[0]},${point[1]}`).toBe(false);
      }
    }
    expect(rural.farms.length).toBeGreaterThanOrEqual(6);
    expect(rural.farms.every((farm) => farm.x > -map.stats.targetSize / 2 && farm.x < coast.corridor.eastX)).toBe(true);
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
