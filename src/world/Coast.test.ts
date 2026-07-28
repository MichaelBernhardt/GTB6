import { describe, expect, it } from 'vitest';
import { BEACH_POLYGONS, COAST_CORRIDOR, COASTLINE, HARBOUR_POINT, MAP_WORLD_SIZE, OCEAN_POLYGON } from './mapData';
import { beachBands, buildShoreRibbon, DRAWDOWN_GRIT, farWaterOutline, HIGH_WATER_FADE, HIGH_WATER_MARK, HIGH_WATER_RISE, isSandZ, OCEAN_Y, RESORT_SAND, SEABED_Y, SHALLOW_BED, SHALLOW_BLEACH, shoreColourAt, SHORE_LAND_WIDTH, SHORE_SEA_WIDTH, SHORE_Y, VELD_TONE, WATER_HORIZON_BLEND, WATER_HORIZON_CLEARANCE, type Rgb } from './coast';
import { BEACH_INLAND, BEACH_TOP_Y, SHORE_VELD_BLEND, STRAND_PAINT_BLEND, STRAND_PAINT_INLAND } from './City';

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
    // 0.36, not 0.26 — see tools/mapgen/coast.test.ts for the measured reason: a bounding box that
    // has to contain a circumnavigable Grooteiland cannot be narrower without drying the map out.
    expect(width / MAP_WORLD_SIZE).toBeLessThan(0.36);
    expect((-half - Math.min(...xs)) / MAP_WORLD_SIZE).toBeLessThan(0.095);
    expect(Math.min(...xs)).toBeLessThan(-half); // it must leave the square, or its own edge shows
    // Nothing east of the farm corridor is water.
    expect(Math.max(...xs)).toBeLessThan(-MAP_WORLD_SIZE * 0.16);
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

/** HSV saturation of a colour, the number the "golden, not grey-brown" complaint is really about. */
const saturation = (c: Rgb): number => {
  const max = Math.max(...c); const min = Math.min(...c);
  return max === 0 ? 0 : (max - min) / max;
};

describe('shore palette (D3)', () => {
  const bands = [{ minZ: -100, maxZ: 100 }];
  const strand = (rise: number, z = 900): Rgb => shoreColourAt(OCEAN_Y + rise, z, OCEAN_Y, bands);

  it('keeps the natural strand far less saturated than the resort sand', () => {
    // The whole of D3: the two used to be the same golden, and one build inverted them so the natural
    // shore was MORE saturated than the beach. Measured in-engine the shipped values render the strand
    // at saturation 0.147 and the resort at 0.332.
    expect(saturation(strand(2))).toBeLessThan(saturation(RESORT_SAND) * 0.7);
    expect(saturation(strand(0.3))).toBeLessThan(saturation(RESORT_SAND) * 0.7);
    expect(saturation(shoreColourAt(OCEAN_Y + 0.2, 0, OCEAN_Y, bands))).toBeCloseTo(saturation(RESORT_SAND), 3);
  });

  it('keeps the natural strand darker than the bleached ring above the waterline', () => {
    const ring = strand(0.3); const grit = strand(3);
    expect(Math.max(...grit)).toBeLessThan(Math.max(...ring));
  });

  it('fades the inland edge all the way to the veld it abuts', () => {
    // Without this the clipped sheet ended on a straight north-south colour seam at the map edge.
    expect(shoreColourAt(OCEAN_Y + 3, 900, OCEAN_Y, bands, 1)).toEqual(VELD_TONE);
    const half = shoreColourAt(OCEAN_Y + 3, 900, OCEAN_Y, bands, 0.5);
    for (let i = 0; i < 3; i++) expect(half[i]!).toBeCloseTo((DRAWDOWN_GRIT[i]! + VELD_TONE[i]!) / 2, 6);
    expect(shoreColourAt(OCEAN_Y + 3, 900, OCEAN_Y, bands, -4)).toEqual(strand(3)); // clamped, no overshoot
  });

  it('leaves the submerged bed alone whatever the inland fade says', () => {
    expect(shoreColourAt(OCEAN_Y - 5, 900, OCEAN_Y, bands, 1)).toEqual(shoreColourAt(OCEAN_Y - 5, 900, OCEAN_Y, bands));
  });

  it('confines the bleached ring to a narrow band at the waterline', () => {
    // WHAT "THE SHORE IS STILL A PALE PAN" ACTUALLY WAS. HIGH_WATER_MARK is the palest tone on the
    // shore and it used to cover every rise up to 0.62; City's strand profile climbs 0.011 units per
    // unit of ground, so that was 56 units of bleached bone at the water's edge and 120 before the
    // grit was even reached. Measured in-engine it read rgb(155,147,133) — concrete. Keep it a ring.
    const RISE_PER_UNIT = (BEACH_TOP_Y - OCEAN_Y) / BEACH_INLAND;
    const ringWidth = HIGH_WATER_RISE / RISE_PER_UNIT;
    const gritWidth = (HIGH_WATER_RISE + HIGH_WATER_FADE) / RISE_PER_UNIT;
    expect(ringWidth).toBeLessThan(30);   // units of ground, not of height
    expect(gritWidth).toBeLessThan(60);
    expect(strand(HIGH_WATER_RISE + HIGH_WATER_FADE + 0.01)).toEqual(DRAWDOWN_GRIT);
  });

  it('paints the natural strand a fraction of the width the resorts get', () => {
    // BEACH_INLAND is the TERRAIN and it does not move. The PAINT does: 322 units of exposed lake bed
    // round every bay is a 430 m mud collar, and on a 600-unit island it is the whole island.
    expect(STRAND_PAINT_INLAND + STRAND_PAINT_BLEND).toBeLessThan((BEACH_INLAND + SHORE_VELD_BLEND) / 2);
    expect(STRAND_PAINT_INLAND).toBeGreaterThan(HIGH_WATER_RISE / ((BEACH_TOP_Y - OCEAN_Y) / BEACH_INLAND));
  });

  it('keeps the UNDERWATER bleach on its own constant, so darkening the ring cannot dull the shallows', () => {
    // The turquoise fringe is verified and was fought for; the above-water ring being too pale is a
    // different defect on a different surface. Two constants, and the shallow one is the paler.
    expect(Math.max(...SHALLOW_BLEACH)).toBeGreaterThan(Math.max(...HIGH_WATER_MARK));
    const justUnder = shoreColourAt(OCEAN_Y - 0.05, 900, OCEAN_Y, bands);
    // the lift target is SHALLOW_BLEACH: at the surface the bed is 60% of the way to it
    expect(justUnder[2]!).toBeGreaterThan(SHALLOW_BED[2]!);
    expect(justUnder[2]!).toBeLessThan(SHALLOW_BLEACH[2]!);
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
