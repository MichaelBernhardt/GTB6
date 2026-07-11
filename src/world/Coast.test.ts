import { describe, expect, it } from 'vitest';
import { BEACH_POLYGONS, COAST_CORRIDOR, COASTLINE, HARBOUR_POINT, MAP_WORLD_SIZE, OCEAN_POLYGON } from './mapData';
import { beachBands, buildShoreRibbon, isSandZ, OCEAN_Y, SEABED_Y, SHORE_LAND_WIDTH, SHORE_SEA_WIDTH, SHORE_Y } from './coast';

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

  it('carries a shoreline polyline spanning the full north-south extent', () => {
    expect(COASTLINE.length).toBeGreaterThan(20);
    const zs = COASTLINE.map((point) => point.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(MAP_WORLD_SIZE * 0.9);
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
