/**
 * Boot-derivation profiler: times each pure city-derivation pass in Node (same modules the game
 * runs at boot) and reports wall-clock + heap. Run: npx tsx tools/bake/profile.ts
 */
import { performance } from 'node:perf_hooks';

const fmt = (ms: number): string => `${ms.toFixed(0)}ms`;
const heapMB = (): number => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

async function main(): Promise<void> {
  const rows: Array<{ pass: string; ms: number; heapAfterMB: number }> = [];
  const time = async (pass: string, run: () => Promise<unknown> | unknown): Promise<void> => {
    const start = performance.now();
    await run();
    rows.push({ pass, ms: performance.now() - start, heapAfterMB: heapMB() });
  };

  await time('mapData module init (JSON parse + edge grids + signals)', () => import('../../src/world/mapData'));
  await time('zoning module init', () => import('../../src/world/data/zoning'));

  const cityGen = await import('../../src/world/CityGen');
  await time('parcel pass (CityGen.ensureParcels)', () => cityGen.ensureParcels());

  const scatter = await import('../../src/world/ModelScatter');
  await time('scatter pass (ModelScatter.ensureScatter)', () => scatter.ensureScatter());

  let city!: typeof import('../../src/world/City');
  await time('City module init', async () => { city = await import('../../src/world/City'); });

  const nav = await import('../../src/systems/NavGraph');
  await time('streetlamp points', () => city.buildStreetlampPoints(city.ROAD_NETWORK));
  let navPaths!: ReturnType<typeof city.buildCityNavPaths>;
  await time('nav source paths (buildCityNavPaths)', () => { navPaths = city.buildCityNavPaths(city.ROAD_NETWORK); });
  await time('vehicle nav graph (directed)', () => city.buildVehicleNav(city.ROAD_NETWORK));
  await time('ped nav graph', () => nav.bridgeIslands(nav.buildNavGraph(navPaths.walks, city.PED_NAV_JOIN)));

  await time('UrbanInfrastructure module init (CITY_JUNCTIONS)', () => import('../../src/world/UrbanInfrastructure'));

  console.log('\npass                                                        ms      heapAfter');
  for (const row of rows) console.log(`${row.pass.padEnd(58)} ${fmt(row.ms).padStart(8)} ${String(row.heapAfterMB).padStart(6)}MB`);
  const total = rows.reduce((sum, row) => sum + row.ms, 0);
  console.log(`${'TOTAL'.padEnd(58)} ${fmt(total).padStart(8)}`);
  const stats = cityGen.buildingStats();
  const sstats = scatter.scatterStats();
  console.log(`\nbuildings: ${stats.total} in ${stats.cells} cells; scatter: ${sstats.total} in ${sstats.cells} cells`);
}

void main();
