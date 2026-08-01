/**
 * Street grime / graffiti census — the regression meter for the dirt pass.
 *
 * Re-derives every parcel's decal plan through the SAME pure pipeline the chunk builder draws
 * from (plan() massing -> planEntrance tag -> planShopBays -> planGrimeDecals), so the counts
 * here are exactly what the renderer hangs on the walls. Denominators are whole families of the
 * baked parcel set, never just the decorated subset.
 *
 *   npx tsx tools/qa/grime-census.ts
 */
import * as THREE from 'three';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, GRIME_DECAL_CHANCE, planGrimeDecals, planShopBays, type BuildingSpec, type BuildingStyle } from '../../src/world/BuildingArchitecture';
import { GRIME_ATLAS_CELLS } from '../../src/world/ProceduralMaterials';
import { allBuildings } from '../../src/world/CityGen';
import { districtAt } from '../../src/world/mapData';
import { HIGHRISE_DISTRICTS } from '../../src/world/data/zoning';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial(); const roof = new THREE.MeshBasicMaterial();

interface Tally { parcels: number; decorated: number; tags: number; grime: number; upper: number; }
const perStyle = new Map<string, Tally>();
const cellUse = new Array(GRIME_ATLAS_CELLS.length).fill(0) as number[];
let cbdParcels = 0; let cbdDecorated = 0; let cbdDecals = 0;

for (const building of allBuildings()) {
  const style = building.style as BuildingStyle;
  const district = districtAt(building.x, building.z);
  const variant = neighbourhoodBuildingVariant(district, building.variant);
  const spec: BuildingSpec = {
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style, variant, facade, roof,
    facadeTile: facadeWorldTile(neighbourhoodFacadeIndex(district, style, building.variant)),
  };
  const profile = architecture.plan(spec);
  const bays = style === 'downtown'
    ? planShopBays(profile.tiers, building.width, building.height, variant % ARCHITECTURE_VARIANTS.downtown, variant, profile.entrance)
    : [];
  const decals = planGrimeDecals(profile.tiers, style, building.width, building.height, building.x, building.z, profile.entrance, bays);
  let tally = perStyle.get(style);
  if (!tally) { tally = { parcels: 0, decorated: 0, tags: 0, grime: 0, upper: 0 }; perStyle.set(style, tally); }
  tally.parcels++;
  if (decals.length > 0) tally.decorated++;
  for (const decal of decals) {
    cellUse[decal.cell] = (cellUse[decal.cell] ?? 0) + 1;
    if (GRIME_ATLAS_CELLS[decal.cell]!.kind === 'tag') tally.tags++;
    else if (decal.y > 4) tally.upper++;
    else tally.grime++;
  }
  if (HIGHRISE_DISTRICTS.has(district)) {
    cbdParcels++;
    if (decals.length > 0) cbdDecorated++;
    cbdDecals += decals.length;
  }
}

let parcels = 0; let decorated = 0; let quads = 0;
console.log('street grime/graffiti census (denominator: every baked parcel of the family):');
for (const [style, tally] of [...perStyle].sort((a, b) => b[1].parcels - a[1].parcels)) {
  parcels += tally.parcels; decorated += tally.decorated; quads += tally.tags + tally.grime + tally.upper;
  const chance = GRIME_DECAL_CHANCE[style as BuildingStyle];
  console.log(`  ${style.padEnd(18)} ${String(tally.decorated).padStart(5)}/${String(tally.parcels).padEnd(5)} decorated (${(100 * tally.decorated / tally.parcels).toFixed(1).padStart(5)}%${chance !== undefined ? ` of an authored ${Math.round(chance * 100)}%` : ' — authored 0%'})   tags ${String(tally.tags).padStart(5)}   base grime ${String(tally.grime).padStart(4)}   upper wash ${String(tally.upper).padStart(4)}`);
}
console.log(`  ${'TOTAL'.padEnd(18)} ${decorated}/${parcels} buildings carry ${quads} decal quads`);
console.log(`\nCBD (the ${HIGHRISE_DISTRICTS.size} highrise districts): ${cbdDecorated}/${cbdParcels} parcels decorated (${(100 * cbdDecorated / Math.max(1, cbdParcels)).toFixed(1)}%), ${cbdDecals} decals`);
console.log(`atlas cell usage (12 cells, 8 tag + 4 grime): [${cellUse.join(', ')}]`);
