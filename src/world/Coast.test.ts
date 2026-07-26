import { describe, expect, it } from 'vitest';
import { BEACH_POLYGONS, COAST_CORRIDOR, COASTLINE, HARBOUR_POINT, MAP_WORLD_SIZE, OCEAN_POLYGON } from './mapData';
import { beachBands, buildShoreRibbon, farWaterOutline, isSandZ, OCEAN_Y, SEABED_Y, SHORE_LAND_WIDTH, SHORE_SEA_WIDTH, SHORE_Y, WATER_HORIZON_BLEND, WATER_HORIZON_CLEARANCE } from './coast';

/** Game.ts's perspective camera far plane: beyond it the frustum cuts and the fog is 98% opaque. */
const CAMERA_FAR_PLANE = 8000;

describe('coast map data', () => {
  it('exposes the ocean as one large closed polygon west of the city', () => {
    expect(OCEAN_POLYGON).toBeDefined();
    const ocean = OCEAN_POLYGON!;
    expect(ocean.points.length).toBeGreaterThan(10);
    expect(ocean.area).toBeGreaterThan(1_000_000); // "plenty of water": millions of units²
    // Sits west of the rural corridor and nowhere near the city block to its east.
    expect(COAST_CORRIDOR).toBeDefined();
    expect(ocean.cx).toBeLessThan(COAST_CORRIDOR!.westX);
    expect(ocean.maxX).toBeLessThan(COAST_CORRIDOR!.eastX);
    // Extends past the world edge so the far edge is lost in fog, never a visible seam.
    expect(ocean.minX).toBeLessThan(-MAP_WORLD_SIZE / 2);
  });

  it('keeps the water inside the old ocean\'s measured budget', () => {
    // The Atlantic seaboard nobody complained about, measured: 20.7% of the world wide with 9.4% of
    // it west of the square. The rejected wholesale-adjacent build ran 56.9% wide with a 43.0%
    // overhang — the "speaker cone". The SHAPE is no longer graded here (a reservoir edge is
    // dendritic on purpose); the footprint is.
    expect(COASTLINE.length).toBeGreaterThan(20);
    const ocean = OCEAN_POLYGON!;
    const xs = ocean.points.map((p) => p.x);
    const width = Math.max(...xs) - Math.min(...xs);
    const half = MAP_WORLD_SIZE / 2;
    expect(width / MAP_WORLD_SIZE).toBeLessThan(0.26);
    expect((-half - Math.min(...xs)) / MAP_WORLD_SIZE).toBeLessThan(0.095);
    expect(Math.min(...xs)).toBeLessThan(-half); // it must leave the square, or its own edge shows
    // Nothing east of the farm corridor is water.
    expect(Math.max(...xs)).toBeLessThan(-MAP_WORLD_SIZE * 0.22);
  });

  it('names the water body as a dam rather than an ocean', () => {
    expect(OCEAN_POLYGON!.name).toMatch(/dam/i);
  });

  it('keeps the named beaches and the harbour anchor', () => {
    expect(BEACH_POLYGONS.length).toBeGreaterThanOrEqual(1);
    expect(BEACH_POLYGONS.every((beach) => beach.kind === 'beach' && beach.points.length >= 3)).toBe(true);
    expect(HARBOUR_POINT).toBeDefined();
  });

  it('orders the water surfaces so the ocean laps over the seabed and shore lip', () => {
    expect(SEABED_Y).toBeLessThan(SHORE_Y); // seabed under the sand
    expect(SHORE_Y).toBeLessThan(OCEAN_Y); // the ocean sits above the shore's seaward lip: no gap, no z-fight
  });
});

describe('beach z-bands', () => {
  it('turns each beach polygon into a padded z-span for golden sand', () => {
    const bands = beachBands(BEACH_POLYGONS, 20);
    expect(bands.length).toBe(BEACH_POLYGONS.length);
    for (let i = 0; i < bands.length; i++) {
      expect(bands[i]!.minZ).toBe(BEACH_POLYGONS[i]!.minZ - 20);
      expect(bands[i]!.maxZ).toBe(BEACH_POLYGONS[i]!.maxZ + 20);
    }
  });

  it('reports sand only inside a band', () => {
    const bands = [{ minZ: -100, maxZ: 100 }, { minZ: 500, maxZ: 560 }];
    expect(isSandZ(0, bands)).toBe(true);
    expect(isSandZ(530, bands)).toBe(true);
    expect(isSandZ(300, bands)).toBe(false);
    expect(isSandZ(-200, bands)).toBe(false);
    expect(isSandZ(0, [])).toBe(false);
  });
});

describe('shore ribbon geometry', () => {
  const sand: [number, number, number] = [0.8, 0.69, 0.42];
  const rock: [number, number, number] = [0.3, 0.3, 0.3];

  it('emits two rows of vertices and a quad per segment', () => {
    const line = [
      { x: -100, z: 0 }, { x: -101, z: 50 }, { x: -99, z: 100 }, { x: -100, z: 150 },
    ];
    const ribbon = buildShoreRibbon(line, { bands: [], sand, rock });
    expect(ribbon.positions.length).toBe(line.length * 2 * 3);
    expect(ribbon.colors.length).toBe(line.length * 2 * 3);
    expect(ribbon.uvs.length).toBe(line.length * 2 * 2);
    expect(ribbon.indices.length).toBe((line.length - 1) * 6);
    expect(Math.max(...ribbon.indices)).toBe(line.length * 2 - 1);
  });

  it('lays the inland edge east of the seaward edge (ocean stays west)', () => {
    const line = Array.from({ length: 8 }, (_, i) => ({ x: -200 + Math.sin(i) * 3, z: i * 40 }));
    const ribbon = buildShoreRibbon(line, { bands: [], sand, rock, seaWidth: SHORE_SEA_WIDTH, landWidth: SHORE_LAND_WIDTH });
    for (let i = 0; i < line.length; i++) {
      const seaX = ribbon.positions[i * 6]!;
      const landX = ribbon.positions[i * 6 + 3]!;
      expect(landX).toBeGreaterThan(seaX); // inland (east) beyond seaward (west)
      expect(landX - seaX).toBeGreaterThanOrEqual(SHORE_LAND_WIDTH + SHORE_SEA_WIDTH - 1); // spans the strip width
    }
  });

  it('paints golden sand only where a beach band covers the shore', () => {
    const line = [{ x: -100, z: 0 }, { x: -100, z: 100 }, { x: -100, z: 200 }];
    const ribbon = buildShoreRibbon(line, { bands: [{ minZ: -10, maxZ: 10 }], sand, rock });
    expect([ribbon.colors[0], ribbon.colors[1], ribbon.colors[2]]).toEqual(sand); // z=0 → sand
    expect([ribbon.colors[6], ribbon.colors[7], ribbon.colors[8]]).toEqual(rock); // z=100 → rock
  });

  it('returns empty data for a degenerate coastline', () => {
    expect(buildShoreRibbon([{ x: 0, z: 0 }], { bands: [], sand, rock }).positions).toEqual([]);
  });
});

describe('the rendered water horizon (D2)', () => {
  const HALF = MAP_WORLD_SIZE / 2;

  it('carries every closure edge past the camera far plane, or keeps it under drawn ground', () => {
    // The defect: mapgen closes the dam ~4.2 km past the west edge, inside both the fog and the
    // 8000-unit far plane, so from the shore it read as a dead-level water/sky line measured at
    // 142-166/255 of contrast in every column of the frame.
    //
    // A closure edge is harmless in exactly two cases, and this asserts every point falls in one:
    //   * it is at least a far plane away, where the frustum cuts it and the fog is 98% opaque; or
    //   * it never goes west of the shoreline's own envelope, which is the strip City.buildBeach
    //     draws the bed sheet over — so ground covers the edge instead of sky.
    const outline = farWaterOutline(COASTLINE, HALF);
    const shoreWestmost = Math.min(...COASTLINE.map((point) => point.x));
    const distanceToWorld = (x: number, z: number): number =>
      Math.hypot(Math.max(0, Math.abs(x) - HALF), Math.max(0, Math.abs(z) - HALF));
    for (let i = COASTLINE.length; i < outline.length; i++) {
      const a = outline[i]!; const b = outline[(i + 1) % outline.length]!;
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 50));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps; const x = a.x + (b.x - a.x) * t; const z = a.z + (b.z - a.z) * t;
        if (x >= shoreWestmost) continue; // inside the shore's own envelope: the bed sheet covers it
        expect(distanceToWorld(x, z)).toBeGreaterThanOrEqual(CAMERA_FAR_PLANE);
      }
    }
  });

  it('keeps the real shoreline verbatim and only replaces the closure', () => {
    const outline = farWaterOutline(COASTLINE, HALF);
    expect(outline.length).toBe(COASTLINE.length + 6);
    for (let i = 0; i < COASTLINE.length; i++) {
      expect(outline[i]!.x).toBeCloseTo(COASTLINE[i]!.x, 6);
      expect(outline[i]!.z).toBeCloseTo(COASTLINE[i]!.z, 6);
    }
  });

  it('offsets only the shoreline inland, never the run-outs', () => {
    const inland = 60;
    const outline = farWaterOutline(COASTLINE, HALF, WATER_HORIZON_CLEARANCE, WATER_HORIZON_BLEND, inland);
    expect(outline[0]!.x).toBeCloseTo(COASTLINE[0]!.x + inland, 6);
    // Run-outs sit exactly on the map edge: any further west would hang water over the empty space
    // beyond the drawn ground, any further east would show water standing on dry land.
    for (const point of outline.slice(COASTLINE.length)) {
      expect(point.x).toBeLessThanOrEqual(-HALF + 1e-6);
    }
  });

  it('clamps the run-outs to the map edge even when the shore itself is inland', () => {
    // Under the wholesale placement the shore's ends sit INSIDE the world square (the water simply
    // stops where the real reservoir stops), and the far sheet exists only to fill the horizon
    // beyond the drawn ground. Letting a run-out keep an inland x — which is what it used to do —
    // stood 1,667 units of horizon water on dry land. The bed no longer needs that crutch: it is
    // driven by signed distance to the real waterline, so it slopes away under the sheet anyway.
    const line = [{ x: -100, z: 500 }, { x: -120, z: 0 }, { x: -100, z: -500 }];
    const outline = farWaterOutline(line, HALF);
    for (const point of outline.slice(line.length)) {
      expect(point.x).toBeLessThanOrEqual(-HALF + 1e-6);
    }
  });

  it('returns nothing for a degenerate coastline', () => {
    expect(farWaterOutline([{ x: 0, z: 0 }], HALF)).toEqual([]);
  });
});
