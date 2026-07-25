/**
 * The northern mountain range's runtime contract: mapData ships the range's metres separately
 * (elevation.ridge) so the detrend split can't flatten it — these tests pin that the mountains
 * read TALL through terrainHeightAt, that the CBD/coast feel nothing, and that the in-game
 * snowline agrees with the raw-metres snowline the shared map renderer paints.
 */
import { describe, expect, it } from 'vitest';
import { CBD_CENTER, elevationMetresAt, MAP_WORLD_SIZE, ridgeMetresAt } from './mapData';
import { SNOW_Y, SNOWLINE_METRES, TERRAIN_LOCAL_CAP, TERRAIN_LOCAL_SCALE, TERRAIN_RIDGE_SCALE, terrainHeightAt } from './City';
import { MAP_SNOWLINE_METRES } from '../ui/mapRender';

/**
 * The tallest analytic terrain point over the range, by coarse grid scan of the northern half
 * OF THE ACTUAL WORLD SQUARE. This used to scan a hard-coded z -9500..-3000 / x -4600..9500 box
 * from the 19,200-unit footprint; at 9,900 units that box misses the summit entirely and finds
 * a shoulder, so the test measured the wrong hill and still "passed" until the range moved.
 */
const HALF = MAP_WORLD_SIZE / 2;
function tallestNorthern(): { x: number; z: number; y: number } {
  let best = { x: 0, z: 0, y: -Infinity };
  for (let z = -HALF; z < 0; z += 60) {
    for (let x = -HALF; x < HALF; x += 60) {
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
    // The owner asked for the range pulled DOWN toward the CBD and onto the koppie tracks, so
    // the summit is now a bit over half a world-width out, not hugging the top edge.
    // Relative to the CBD, never to absolute game coordinates: those mean a different place in
    // every crop, which is exactly how the previous scan window ended up measuring a shoulder.
    expect(peak.z).toBeLessThan(CBD_CENTER.z - MAP_WORLD_SIZE * 0.2); // well north of the city
    expect(Math.hypot(peak.x - CBD_CENTER.x, peak.z - CBD_CENTER.z)).toBeLessThan(MAP_WORLD_SIZE * 0.62);
    // The height is the ridge riding at its own scale (± the capped local residual).
    const expected = ridgeMetresAt(peak.x, peak.z) * TERRAIN_RIDGE_SCALE;
    expect(Math.abs(peak.y - expected)).toBeLessThanOrEqual(TERRAIN_LOCAL_CAP * TERRAIN_LOCAL_SCALE + 1);
  });

  it('leaves the CBD (and the whole southern half) untouched', () => {
    // Probes placed relative to the CBD (see above): the range's guard is authored in projected
    // metres, so "the southern half" is only meaningful measured from the city.
    const S = MAP_WORLD_SIZE * 0.15;
    for (const [x, z] of [
      [CBD_CENTER.x, CBD_CENTER.z], [CBD_CENTER.x, CBD_CENTER.z + S], [CBD_CENTER.x - S, CBD_CENTER.z + S],
      [CBD_CENTER.x + S, CBD_CENTER.z + 2 * S], [CBD_CENTER.x - 2 * S, CBD_CENTER.z + 2 * S],
    ] as const) {
      expect(ridgeMetresAt(x, z)).toBe(0);
      expect(Math.abs(terrainHeightAt(x, z))).toBeLessThanOrEqual(TERRAIN_LOCAL_CAP * TERRAIN_LOCAL_SCALE);
    }
  });

  it('keeps one snowline: the in-game SNOW_Y sits where the map paints MAP_SNOWLINE_METRES', () => {
    expect(SNOWLINE_METRES).toBe(MAP_SNOWLINE_METRES);
    // Wherever the raw composite crosses the snowline on the range, the in-game ground sits
    // near SNOW_Y — so the whitened map contour and the 3D snow band are the same mountainside.
    let checked = 0;
    for (let z = -HALF; z < 0; z += 45) {
      for (let x = -HALF; x < HALF; x += 45) {
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
    for (let z = -HALF; z < 0; z += 50) for (let x = -HALF; x < HALF; x += 50) if (elevationMetresAt(x, z) > SNOWLINE_METRES + 100) above++;
    expect(above).toBeGreaterThan(80);
  });
});
