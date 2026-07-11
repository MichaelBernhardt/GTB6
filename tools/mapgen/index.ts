/**
 * Groot Theft Bakkie — Johannesburg map pipeline (Phase 1, offline tool).
 *
 * Fetches real OSM data for the CBD->Sandton box via Overpass (cached),
 * repairs road topology into a single connected network, fetches an SRTM
 * height grid, and emits:
 *   - src/world/generated/joburg-map.json  (committed, consumed by the game later)
 *   - tools/mapgen/preview.html            (standalone review artifact)
 *
 * Usage: npm run map:build [-- --refresh]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISTRICT_RADIUS_M } from './config';
import { fetchElevationGrid } from './elevation';
import { applyNameOverrides, loadNameOverrides } from './emit';
import { fetchBuildingCounts, fetchCape, fetchOsm } from './overpass';
import { buildPreviewHtml } from './preview';
import { extractDistrictNodes, processOsm } from './process';

const HERE = dirname(fileURLToPath(import.meta.url));
// Output paths default to the committed map + preview; MAPGEN_OUT / MAPGEN_PREVIEW_OUT let a
// determinism harness (or a dry run) emit elsewhere without clobbering the approved map.
const OUTPUT_JSON = process.env.MAPGEN_OUT ?? resolve(HERE, '../../src/world/generated/joburg-map.json');
const OUTPUT_PREVIEW = process.env.MAPGEN_PREVIEW_OUT ?? join(HERE, 'preview.html');

async function main(): Promise<void> {
  const refresh = process.argv.includes('--refresh');

  const { data, fromCache } = await fetchOsm({ refresh });
  console.log(`[mapgen] OSM extract: ${data.elements.length} elements${fromCache ? ' (from cache)' : ''}`);

  const cape = await fetchCape({ refresh });
  console.log(`[mapgen] Cape seaboard extract: ${cape.data.elements.length} elements${cape.fromCache ? ' (from cache)' : ''}`);

  const districtNodes = extractDistrictNodes(data);
  const [elevation, buildingCounts] = [
    await fetchElevationGrid(),
    await fetchBuildingCounts(districtNodes, DISTRICT_RADIUS_M),
  ];

  const overrides = loadNameOverrides();
  const { map, log } = processOsm(data, { elevation, buildingCounts, protectedNames: Object.keys(overrides), cape: cape.data });
  for (const line of log) console.log(`[process] ${line}`);

  const finalMap = applyNameOverrides(map, overrides);
  console.log(`[emit] applied ${Object.keys(overrides).length} name overrides`);

  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(finalMap));
  console.log(`[emit] wrote ${OUTPUT_JSON}`);

  writeFileSync(OUTPUT_PREVIEW, buildPreviewHtml(finalMap));
  console.log(`[emit] wrote ${OUTPUT_PREVIEW}`);

  const s = finalMap.stats;
  console.log(
    `[stats] ${s.totalRoadKm} km of road in ${s.roadCount} polylines, ${s.junctionCount} junctions, ` +
      `${s.trackCount} off-road tracks (${s.trackKm} km), ${s.landuseCount} landuse polygons, ` +
      `${s.districtCount} districts, ${s.waterCount} water bodies, ${s.landmarkCount} landmarks, ` +
      `elevation ${s.minElevation}-${s.maxElevation} m; bridged ${s.bridgedIslands} island joins, ` +
      `dropped ${s.droppedIslands} islands (${s.droppedIslandKm} km); 1 unit = ${s.metresPerUnit} m` +
      (s.oceanKm2 !== undefined ? `; ocean ${s.oceanKm2} km2 / land ${s.landKm2} km2, corridor ${s.corridorWidthUnits}u wide` : ''),
  );
}

main().catch((error) => {
  console.error(`[mapgen] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
