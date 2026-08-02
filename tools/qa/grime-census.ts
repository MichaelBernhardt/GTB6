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
import { GRIME_ATLAS_CELLS, GRIME_TAG_CLASSES, type GrimeTagClass } from '../../src/world/ProceduralMaterials';
import { allBuildings } from '../../src/world/CityGen';
import { districtAt } from '../../src/world/mapData';
import { HIGHRISE_DISTRICTS } from '../../src/world/data/zoning';
import { districtAffluence, districtGrimeScale, neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial(); const roof = new THREE.MeshBasicMaterial();

interface Tally { parcels: number; decorated: number; tags: number; grime: number; upper: number; }
const perStyle = new Map<string, Tally>();
const cellUse = new Array(GRIME_ATLAS_CELLS.length).fill(0) as number[];
let cbdParcels = 0; let cbdDecorated = 0; let cbdDecals = 0;
// THE OWNER'S UNIT: "I only saw one [tag]" is a statement about walking a block face, so the
// headline number is tags per 100 u of the frontage he walks past — the summed street-facing
// width of every downtown building in the CBD districts, which is what the front decals hang on.
let cbdFrontage = 0; let cbdTags = 0; let cbdStreetTags = 0;
/** Decals above this are read off the fascia/shaft rather than from the pavement. */
const STREET_LEVEL_Y = 4.5;
// THE SECOND UNIT: "the one I saw was all white." Count is only half the complaint — a wall reads
// alive because of COLOUR, so the mix is metered too, per class and per band, alongside the painted
// AREA each class puts on the street. Area is the honest measure of whether a piece reads: a piece
// tier that is 10% of the quads but a third of the paint is doing its job.
const CLASSES: GrimeTagClass[] = ['mono', 'colour', 'piece'];
const zeroed = (): Record<GrimeTagClass, number> => ({ mono: 0, colour: 0, piece: 0 });
const cbdClassTags = zeroed(); const cbdClassStreet = zeroed(); const cbdClassArea = zeroed();
/** A CBD block face — the run of frontage the player walks past between two corners. */
const BLOCK_FACE_U = 60;

/**
 * THE THIRD UNIT: WEALTH. Tagging is a poverty-and-inner-city fact, so the per-style chance is
 * scaled by a per-district term off districtAffluence, and the meter has to be legible on that axis.
 *
 * Two frontage denominators, deliberately, because the structural pass is concurrently moving which
 * STYLE lands where and one of them would otherwise absorb the other's change:
 *   - ALL frontage is the honest player-facing rate — what a walk down a ridge street looks like,
 *     including all the clean suburban houses that can never carry a decal.
 *   - DIRTY-FAMILY frontage (the four styles GRIME_DECAL_CHANCE authors at all) isolates the
 *     multiplier itself: it is the rate on the walls that could have been painted, so it moves only
 *     when this pass moves it, not when the generator rezones a district.
 */
const WEALTH_BANDS: ReadonlyArray<{ label: string; max: number }> = [
  { label: 'poor     a<=0.20', max: 0.2 },
  { label: 'working  0.20-0.45', max: 0.45 },
  { label: 'middle   0.45-0.70', max: 0.7 },
  { label: 'ridge     a>0.70', max: Infinity },
];
interface BandTally { parcels: number; dirtyParcels: number; decorated: number; frontage: number; dirtyFrontage: number; tags: number; grime: number; scaleByFrontage: number; }
const byBand: BandTally[] = WEALTH_BANDS.map(() => ({ parcels: 0, dirtyParcels: 0, decorated: 0, frontage: 0, dirtyFrontage: 0, tags: 0, grime: 0, scaleByFrontage: 0 }));
const bandOf = (affluence: number): number => WEALTH_BANDS.findIndex((band) => affluence <= band.max);

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
  const decals = planGrimeDecals(profile.tiers, style, building.width, building.height, building.x, building.z, profile.entrance, bays, districtGrimeScale(district));
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
  const band = byBand[bandOf(districtAffluence(district))]!;
  band.parcels++; band.frontage += building.width;
  if (GRIME_DECAL_CHANCE[style] !== undefined) {
    band.dirtyParcels++; band.dirtyFrontage += building.width;
    // Frontage-weighted, because that is what makes a flat band aggregate readable: a band whose
    // paintable wall all sits at one affluence reads as one scale however wide the band's edges are.
    band.scaleByFrontage += districtGrimeScale(district) * building.width;
  }
  if (decals.length > 0) band.decorated++;
  for (const decal of decals) {
    if (GRIME_ATLAS_CELLS[decal.cell]!.kind === 'tag') band.tags++; else band.grime++;
  }
  if (HIGHRISE_DISTRICTS.has(district)) {
    cbdParcels++;
    if (decals.length > 0) cbdDecorated++;
    cbdDecals += decals.length;
    if (style === 'downtown') {
      cbdFrontage += building.width;
      for (const decal of decals) {
        if (GRIME_ATLAS_CELLS[decal.cell]!.kind !== 'tag') continue;
        cbdTags++;
        const cls = GRIME_TAG_CLASSES[decal.cell]!;
        cbdClassTags[cls]++;
        cbdClassArea[cls] += decal.width * decal.height;
        if (decal.y <= STREET_LEVEL_Y) { cbdStreetTags++; cbdClassStreet[cls]++; }
      }
    }
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
console.log('\nby wealth band (districtAffluence — the axis the per-district grime multiplier is cut on):');
console.log(`  ${'band'.padEnd(18)} ${'parcels'.padStart(7)} ${'paintable'.padStart(9)} ${'decorated'.padStart(9)} ${'scale'.padStart(5)}   ${'tags/100u'.padStart(9)} ${'/100u paintable'.padStart(15)}   ${'grime/100u'.padStart(10)}`);
for (const [index, band] of WEALTH_BANDS.entries()) {
  const row = byBand[index]!;
  console.log(`  ${band.label.padEnd(18)} ${String(row.parcels).padStart(7)} ${String(row.dirtyParcels).padStart(9)}`
    + ` ${(100 * row.decorated / Math.max(1, row.dirtyParcels)).toFixed(1).padStart(8)}%`
    + ` ${(row.scaleByFrontage / Math.max(1, row.dirtyFrontage)).toFixed(2).padStart(5)}`
    + `   ${(100 * row.tags / Math.max(1, row.frontage)).toFixed(2).padStart(9)}`
    + ` ${(100 * row.tags / Math.max(1, row.dirtyFrontage)).toFixed(2).padStart(15)}`
    + `   ${(100 * row.grime / Math.max(1, row.frontage)).toFixed(2).padStart(10)}`
    + `   (frontage ${Math.round(row.frontage).toLocaleString()} u, of it paintable ${Math.round(row.dirtyFrontage).toLocaleString()} u)`);
}
console.log(`\nCBD (the ${HIGHRISE_DISTRICTS.size} highrise districts): ${cbdDecorated}/${cbdParcels} parcels decorated (${(100 * cbdDecorated / Math.max(1, cbdParcels)).toFixed(1)}%), ${cbdDecals} decals`);
console.log(`CBD graffiti rate: ${cbdTags} tags over ${cbdFrontage.toFixed(0)} u of downtown street frontage`
  + ` = ${(100 * cbdTags / Math.max(1, cbdFrontage)).toFixed(2)} tags / 100 u`
  + ` (${(100 * cbdStreetTags / Math.max(1, cbdFrontage)).toFixed(2)} of them at street level, y <= ${STREET_LEVEL_Y})`);
const per100 = (n: number): number => 100 * n / Math.max(1, cbdFrontage);
console.log(`\nCBD colour mix (target 60% mono handstyles / 30% colour throw-ups / 10% pieces):`);
for (const cls of CLASSES) {
  const share = 100 * cbdClassTags[cls] / Math.max(1, cbdTags);
  const areaShare = 100 * cbdClassArea[cls] / Math.max(1, CLASSES.reduce((sum, c) => sum + cbdClassArea[c], 0));
  console.log(`  ${cls.padEnd(7)} ${String(cbdClassTags[cls]).padStart(5)} tags  ${share.toFixed(1).padStart(5)}% of tags`
    + `   ${per100(cbdClassTags[cls]).toFixed(2).padStart(5)} / 100 u`
    + `   ${(100 * cbdClassStreet[cls] / Math.max(1, cbdClassTags[cls])).toFixed(0).padStart(3)}% at street level`
    + `   ${cbdClassArea[cls].toFixed(0).padStart(6)} m² painted (${areaShare.toFixed(1).padStart(4)}% of paint)`);
}
const colourTags = cbdClassTags.colour + cbdClassTags.piece;
console.log(`  colour of any kind: ${per100(colourTags).toFixed(2)} / 100 u`
  + ` = ${(BLOCK_FACE_U * colourTags / Math.max(1, cbdFrontage)).toFixed(2)} per ${BLOCK_FACE_U} u block face`);
console.log(`  pieces:             ${per100(cbdClassTags.piece).toFixed(2)} / 100 u`
  + ` = ${(BLOCK_FACE_U * cbdClassTags.piece / Math.max(1, cbdFrontage)).toFixed(2)} per ${BLOCK_FACE_U} u block face`
  + ` (one every ${(cbdFrontage / Math.max(1, cbdClassTags.piece) / BLOCK_FACE_U).toFixed(2)} block faces)`);
console.log(`atlas cell usage (12 cells, 8 tag + 4 grime): [${cellUse.join(', ')}]`);
console.log(`  by class: ${CLASSES.map((c) => `${c} [${GRIME_TAG_CLASSES.flatMap((k, i) => (k === c ? [i] : [])).join(',')}]`).join('  ')}`);
