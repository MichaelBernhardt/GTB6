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
import { fetchBuildingCounts, fetchCape, fetchOsm, fetchStations, fetchVaal, fetchVaalShore } from './overpass';
import { buildPreviewHtml } from './preview';
import { extractDistrictNodes, inBbox as inCropBbox, processOsm } from './process';
import { parseVaal } from './vaal';
import { parseVaalShore } from './vaalshore';

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

  // The real Vaal Dam shoreline, ~70 km south of the city box. Cached and committed: this fetch
  // must never run on a re-build (see overpass.ts fetchVaal).
  const vaalExtract = await fetchVaal({ refresh });
  console.log(`[mapgen] Vaal Dam extract: ${vaalExtract.data.elements.length} elements${vaalExtract.fromCache ? ' (from cache)' : ''}`);
  const vaal = parseVaal(vaalExtract.data);
  for (const line of vaal.log) console.log(`[mapgen] ${line}`);

  // The real north-shore infrastructure: Deneysville, Refengkgotso, Misty Bay, Vaal Marina and the
  // marinas. Second one-off cached-and-committed query; like fetchVaal it must never run on rebuild.
  const shoreExtract = await fetchVaalShore({ refresh });
  console.log(`[mapgen] Vaal north-shore extract: ${shoreExtract.data.elements.length} elements${shoreExtract.fromCache ? ' (from cache)' : ''}`);
  const vaalShore = parseVaalShore(shoreExtract.data);
  for (const line of vaalShore.log) console.log(`[mapgen] ${line}`);

  const osmStations = await fetchStations({ refresh });
  console.log(osmStations
    ? `[mapgen] rail stations: ${osmStations.nodes.length} nodes${osmStations.fromCache ? ' (from cache)' : ''}`
    : '[mapgen] rail stations: OSM fetch unavailable — synthesizing every stop');

  // Building counts are cached under a key that embeds EVERY district's lat/lon in order, so
  // the query must keep seeing the FULL district list or it misses the cache and re-queries.
  // Crop the returned counts instead, with the same predicate process.ts uses — a silent
  // misalignment here attaches the wrong building density to every district and is invisible
  // in the JSON.
  const allDistrictNodes = extractDistrictNodes(data);
  const [elevation, allBuildingCounts] = [
    await fetchElevationGrid(),
    await fetchBuildingCounts(allDistrictNodes, DISTRICT_RADIUS_M),
  ];
  const keepDistrict = allDistrictNodes.map((d) => inCropBbox(d.lat, d.lon));
  const buildingCounts = allBuildingCounts ? allBuildingCounts.filter((_, i) => keepDistrict[i]) : null;
  const keptDistricts = keepDistrict.filter(Boolean).length;
  if (buildingCounts && buildingCounts.length !== keptDistricts) {
    throw new Error(`building-count crop misaligned: ${buildingCounts.length} counts for ${keptDistricts} districts`);
  }
  console.log(`[mapgen] crop: ${keptDistricts}/${allDistrictNodes.length} place nodes inside CROP_BBOX`);

  const overrides = loadNameOverrides();
  const { map, log } = processOsm(data, { elevation, buildingCounts, protectedNames: Object.keys(overrides), cape: cape.data, vaal, vaalShore, stations: osmStations?.nodes ?? null });
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
      `${s.districtCount} districts, ${s.waterCount} water bodies, ${s.landmarkCount} landmarks, ${s.stationCount} rail stations, ` +
      `elevation ${s.minElevation}-${s.maxElevation} m; bridged ${s.bridgedIslands} island joins, ` +
      `dropped ${s.droppedIslands} islands (${s.droppedIslandKm} km); 1 unit = ${s.metresPerUnit} m` +
      (s.oceanKm2 !== undefined ? `; ocean ${s.oceanKm2} km2 / land ${s.landKm2} km2, corridor ${s.corridorWidthUnits}u wide` : ''),
  );
}

main().catch((error) => {
  console.error(`[mapgen] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
