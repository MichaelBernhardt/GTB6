/**
 * The northern mountain range's runtime contract: mapData ships the range's metres separately
 * (elevation.ridge) so the detrend split can't flatten it — these tests pin that the mountains
 * read TALL through terrainHeightAt, that the CBD/coast feel nothing, and that the in-game
 * snowline agrees with the raw-metres snowline the shared map renderer paints.
 */
import { describe, expect, it } from 'vitest';
import { CBD_CENTER, elevationMetresAt, ridgeMetresAt } from './mapData';
import { SNOW_Y, SNOWLINE_METRES, TERRAIN_LOCAL_CAP, TERRAIN_LOCAL_SCALE, TERRAIN_RIDGE_SCALE, terrainHeightAt } from './City';
import { MAP_SNOWLINE_METRES } from '../ui/mapRender';

/** The tallest analytic terrain point over the range, by coarse grid scan of the northern half. */
function tallestNorthern(): { x: number; z: number; y: number } {
  let best = { x: 0, z: 0, y: -Infinity };
  for (let z = -9500; z < -3000; z += 120) {
    for (let x = -4600; x < 9500; x += 120) {
      const y = terrainHeightAt(x, z);
      if (y > best.y) best = { x, z, y };
    }
  }
  return best;
}

describe('northern mountain range in-game', () => {
  it('escapes the detrend split: the range reads genuinely TALL through terrainHeightAt', () => {
    const peak = tallestNorthern();
    expect(peak.y).toBeGreaterThan(250); // vs ±36 u of detrended local hills everywhere else
    expect(peak.z).toBeLessThan(-6500); // the tall core hugs the top edge
    // The height is the ridge riding at its own scale (± the capped local residual).
    const expected = ridgeMetresAt(peak.x, peak.z) * TERRAIN_RIDGE_SCALE;
    expect(Math.abs(peak.y - expected)).toBeLessThanOrEqual(TERRAIN_LOCAL_CAP * TERRAIN_LOCAL_SCALE + 1);
  });

  it('leaves the CBD (and the whole southern half) untouched', () => {
    for (const [x, z] of [[CBD_CENTER.x, CBD_CENTER.z], [0, 2000], [-3000, 5000], [6000, 8000], [2913, 0]] as const) {
      expect(ridgeMetresAt(x, z)).toBe(0);
      expect(Math.abs(terrainHeightAt(x, z))).toBeLessThanOrEqual(TERRAIN_LOCAL_CAP * TERRAIN_LOCAL_SCALE);
    }
  });

  it('keeps one snowline: the in-game SNOW_Y sits where the map paints MAP_SNOWLINE_METRES', () => {
    expect(SNOWLINE_METRES).toBe(MAP_SNOWLINE_METRES);
    // Wherever the raw composite crosses the snowline on the range, the in-game ground sits
    // near SNOW_Y — so the whitened map contour and the 3D snow band are the same mountainside.
    let checked = 0;
    for (let z = -9500; z < -6000; z += 90) {
      for (let x = -3000; x < 9500; x += 90) {
        const raw = elevationMetresAt(x, z);
        if (Math.abs(raw - SNOWLINE_METRES) > 15 || ridgeMetresAt(x, z) < 300) continue;
        expect(Math.abs(terrainHeightAt(x, z) - SNOW_Y)).toBeLessThan(95);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30); // the snowline actually crosses the range
  });

  it('tops of the range rise ABOVE the snowline so snow has somewhere to live', () => {
    let above = 0;
    for (let z = -9500; z < -7000; z += 100) for (let x = -3000; x < 9500; x += 100) if (elevationMetresAt(x, z) > SNOWLINE_METRES + 100) above++;
    expect(above).toBeGreaterThan(80);
  });
});
