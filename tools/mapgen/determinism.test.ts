/**
 * Rule A guard: the map pipeline must regenerate the SAME city every time, so "edit source →
 * rebuild" never loses or reshuffles prior work. This runs the emit path (processOsm →
 * applyNameOverrides → JSON) twice over identical cached inputs and asserts a byte-identical
 * result, then pins that result against the committed joburg-map.json — i.e. the map the game
 * ships is exactly what the current source reproduces. Offline-safe: all fetches hit the
 * committed tools/mapgen/cache/*.json.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISTRICT_RADIUS_M } from './config';
import { fetchElevationGrid } from './elevation';
import { applyNameOverrides, loadNameOverrides } from './emit';
import { fetchBuildingCounts, fetchCape, fetchOsm } from './overpass';
import { extractDistrictNodes, processOsm } from './process';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

async function emitOnce(): Promise<string> {
  const { data } = await fetchOsm();
  const cape = await fetchCape();
  const districtNodes = extractDistrictNodes(data);
  const [elevation, buildingCounts] = [await fetchElevationGrid(), await fetchBuildingCounts(districtNodes, DISTRICT_RADIUS_M)];
  const overrides = loadNameOverrides();
  const { map } = processOsm(data, { elevation, buildingCounts, protectedNames: Object.keys(overrides), cape: cape.data });
  return JSON.stringify(applyNameOverrides(map, overrides));
}

// Heavy: regenerates the whole 1:1 Joburg map TWICE, and (without a warm cache) fetches the rate-limited
// elevation grid — well over a minute. Skipped in the normal suite / CI deploy path; run it deliberately with
// `MAPGEN_HEAVY=1 npm test` (a warm tools/mapgen/cache makes it quick) when touching the map pipeline.
describe.skipIf(!process.env.MAPGEN_HEAVY)('map pipeline determinism (rule A: source → destination)', () => {
  it('reproduces a byte-identical map across two independent builds, matching the committed map', async () => {
    const first = await emitOnce();
    const second = await emitOnce();
    expect(sha(first)).toBe(sha(second)); // build twice → identical hash

    const committedPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/world/generated/joburg-map.json');
    const committed = readFileSync(committedPath, 'utf8');
    expect(sha(first)).toBe(sha(committed)); // the shipped map is exactly what source regenerates
  }, 600_000); // regenerates the whole 1:1 Joburg map from cache TWICE — ~100s+ locally, and a cold/slow CI runner needs generous headroom over the old 120s (which flaked the deploy)

});
