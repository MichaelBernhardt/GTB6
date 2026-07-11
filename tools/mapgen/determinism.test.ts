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

describe('map pipeline determinism (rule A: source → destination)', () => {
  it('reproduces a byte-identical map across two independent builds, matching the committed map', async () => {
    const first = await emitOnce();
    const second = await emitOnce();
    expect(sha(first)).toBe(sha(second)); // build twice → identical hash

    const committedPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/world/generated/joburg-map.json');
    const committed = readFileSync(committedPath, 'utf8');
    expect(sha(first)).toBe(sha(committed)); // the shipped map is exactly what source regenerates
  }, 120_000);
});
