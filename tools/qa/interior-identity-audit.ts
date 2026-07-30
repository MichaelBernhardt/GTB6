/**
 * Interior IDENTITY audit — the evidence behind "exit name doesn't match entry name".
 *
 * A building in this city can carry TWO names at once:
 *   1. The name PAINTED ON ITS FACADE by the geometry pass — City.addStreetLevelDetail /
 *      addIndustrialDetail on parcels (STOREFRONT_SIGNS / INDUSTRIAL_SIGNS by variant), and each
 *      scattered model's own kit.sign() calls (SHOP_NAMES, 'PROTEA MANSIONS', 'SANLAMB', ...).
 *   2. The name the interiors feature puts on the E prompt, the entry toast and the HUD chip —
 *      doors.ts nameFor()/scatterName(), drawn from its OWN pools off stablePositionRandom(x, z, 94/95).
 *
 * This script walks every door the interiors feature will offer, derives both names from source, and
 * reports how often they disagree — with the denominator split into "building paints a name" vs not.
 * It also re-derives every door name after resetDoorCache() to prove in-session determinism, and
 * round-trips doorNear() on every doorstep to prove the prompt on a step belongs to that step.
 *
 *   npx tsx tools/qa/interior-identity-audit.ts
 */
import * as THREE from 'three';
import { doorsNear, doorNear, resetDoorCache } from '../../src/features/interiors/doors';
import type { InteriorDoor } from '../../src/features/interiors.state';
import { CELL_SIZE, generateCell } from '../../src/world/CityGen';
import { MAP_WORLD_SIZE, nearestDistrict } from '../../src/world/mapData';
import { industrialSignLabel, storefrontSignLabel } from '../../src/world/City';
import { BuildingArchitecture, frontFacadeZAt, widestFrontFacadeSpanAt } from '../../src/world/BuildingArchitecture';
import { neighbourhoodBuildingVariant } from '../../src/world/data/neighbourhoods';
import { scatterCell } from '../../src/world/ModelScatter';
import { buildModel } from '../../src/world/models/catalog';
import { Kit } from '../../src/world/models/kit';

// ---- collect every door, the same way the feature does ------------------------------------------

const half = MAP_WORLD_SIZE / 2 + CELL_SIZE;
const doors = new Map<string, InteriorDoor>();
for (let x = -half; x <= half; x += CELL_SIZE) {
  for (let z = -half; z <= half; z += CELL_SIZE) {
    for (const door of doorsNear(x, z, CELL_SIZE * 0.75)) doors.set(door.id, door);
  }
}
console.log(`doors offered citywide: ${doors.size} (parcel ${[...doors.keys()].filter((id) => !id.startsWith('s')).length}, scatter ${[...doors.keys()].filter((id) => id.startsWith('s')).length})`);

// ---- 1. determinism: same names after a cold cache -----------------------------------------------

const before = new Map([...doors.values()].map((door) => [door.id, door.name]));
resetDoorCache();
let renamed = 0;
for (let x = -half; x <= half; x += CELL_SIZE) {
  for (let z = -half; z <= half; z += CELL_SIZE) {
    for (const door of doorsNear(x, z, CELL_SIZE * 0.75)) {
      const was = before.get(door.id);
      if (was !== undefined && was !== door.name) { renamed++; if (renamed < 6) console.log(`  RENAMED across cache reset: ${door.id} '${was}' -> '${door.name}'`); }
    }
  }
}
console.log(`determinism: ${renamed} of ${before.size} doors changed name across a cache reset`);

// ---- 2. doorNear round-trip: the prompt on a step names that step --------------------------------

let wrongStep = 0;
for (const door of doors.values()) {
  const found = doorNear(door.x, door.z);
  if (found?.id !== door.id) { wrongStep++; if (wrongStep < 6) console.log(`  STEP CLASH: standing on ${door.id} '${door.name}' prompts ${found?.id ?? 'nothing'} '${found?.name ?? ''}'`); }
}
console.log(`doorNear round-trip: ${wrongStep} of ${doors.size} doorsteps prompt a different door`);

// ---- 3. facade name vs prompt name ---------------------------------------------------------------

const normalise = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const agree = (prompt: string, painted: string): boolean => {
  const a = normalise(prompt); const b = normalise(painted);
  return a === b || a.includes(b) || b.includes(a);
};

// Parcel side: reproduce exactly the two name-board branches of City.buildOneBuilding.
const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial();
const roofMaterial = new THREE.MeshBasicMaterial();
function parcelPaintedNames(id: string): string[] | undefined {
  const [bx, bz] = id.split(':').map(Number);
  if (bx === undefined || bz === undefined) return undefined;
  const cell = generateCell(Math.floor(bx / CELL_SIZE), Math.floor(bz / CELL_SIZE));
  const building = cell.find((candidate) => Math.round(candidate.x) === bx && Math.round(candidate.z) === bz);
  if (!building) return undefined;
  const district = nearestDistrict(building.x, building.z).name;
  const variant = neighbourhoodBuildingVariant(district, building.variant);
  const { width: w, depth: d, height: h, style } = building;
  const profile = architecture.plan({ x: 0, z: 0, width: w, depth: d, height: h, style, variant, facade, roof: roofMaterial });
  const painted: string[] = [];
  if (style === 'industrial') {
    // City.addIndustrialDetail: board drawn whenever the shutter span exists.
    const shutterH = Math.min(5, h * 0.48);
    if (widestFrontFacadeSpanAt(profile.tiers, shutterH / 2 + 0.2, -w / 2, w / 2, 3.2)) painted.push(industrialSignLabel(variant));
  }
  const detailed = style === 'downtown' || style === 'mixed-use' || style === 'dense-residential' || variant % 2 === 0;
  if (detailed && (style === 'downtown' || style === 'mixed-use')) {
    // City.addStreetLevelDetail: storefront board when the facade holds it.
    const signX = -w * 0.2; const signW = Math.min(6.4, w * 0.34);
    if (frontFacadeZAt(profile.tiers, signX, 3.82, signW / 2) !== undefined) painted.push(storefrontSignLabel(variant));
  }
  return painted;
}

// Scatter side: rebuild the model with Kit.sign intercepted, so the audit reads exactly the boards
// the street pass paints — whatever the builder names them.
const captured: string[] = [];
const realSign = Kit.prototype.sign;
Kit.prototype.sign = function patched(text: string, ...rest: never[]) {
  captured.push(text);
  return (realSign as (...args: unknown[]) => THREE.Mesh).call(this, text, ...rest);
};
function scatterPaintedNames(door: InteriorDoor): string[] | undefined {
  const bx = Math.round(door.facts.x); const bz = Math.round(door.facts.z);
  const model = scatterCell(Math.floor(door.facts.x / CELL_SIZE), Math.floor(door.facts.z / CELL_SIZE))
    .find((candidate) => Math.round(candidate.x) === bx && Math.round(candidate.z) === bz);
  if (!model) return undefined;
  captured.length = 0;
  buildModel(model.name, model.seed, { variant: model.variant });
  return [...captured];
}

let painted = 0; let matches = 0; let unpainted = 0; let unresolved = 0;
const examples: string[] = [];
const paintedByStyle = new Map<string, { painted: number; matched: number }>();
for (const door of doors.values()) {
  const boards = door.id.startsWith('s') ? scatterPaintedNames(door) : parcelPaintedNames(door.id);
  if (boards === undefined) { unresolved++; continue; }
  if (boards.length === 0) { unpainted++; continue; }
  painted++;
  const style = door.facts.style;
  const bucket = paintedByStyle.get(style) ?? { painted: 0, matched: 0 };
  bucket.painted++;
  const hit = boards.some((board) => agree(door.name, board));
  if (hit) { matches++; bucket.matched++; }
  else if (examples.length < 12) examples.push(`  ${door.id} @ ${door.x.toFixed(0)},${door.z.toFixed(0)} [${style}]: prompt '${door.name}' vs painted [${boards.map((board) => `'${board}'`).join(', ')}]`);
  paintedByStyle.set(style, bucket);
}
console.log('\nfacade board vs prompt name:');
console.log(`  denominator: ${doors.size} doors; ${painted} on buildings that paint a name board, ${unpainted} unpainted, ${unresolved} unresolved`);
console.log(`  agreement: ${matches} of ${painted} painted buildings have a prompt name matching any painted board (${(100 * matches / Math.max(1, painted)).toFixed(1)}%)`);
for (const [style, bucket] of [...paintedByStyle.entries()].sort((a, b) => b[1].painted - a[1].painted)) {
  console.log(`    ${style}: ${bucket.matched}/${bucket.painted} agree`);
}
console.log('sample disagreements:');
for (const line of examples) console.log(line);
