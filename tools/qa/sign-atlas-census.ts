/**
 * Sign-atlas census — how many DISTINCT sign keys (text|accent|background) the whole map wants,
 * against the atlas's usable slots (capacity − 1; the last slot is the blank overflow board).
 * Before the identity round this measured 637 keys against 511 usable — the mechanism behind
 * boards changing text between entering and leaving a building. Reproduces the REAL painter
 * inputs: parcel boards wear the building's identity name, and every enterable scattered model is
 * built with the same signName the placement pass now passes.
 *
 *   npx tsx tools/qa/sign-atlas-census.ts
 */
import { GENERATED_ROADS, MAP_WORLD_SIZE } from '../../src/world/mapData';
import { CELL_SIZE, generateCell } from '../../src/world/CityGen';
import { industrialSignLabel, storefrontSignLabel } from '../../src/world/City';
import * as THREE from 'three';
import { BuildingArchitecture } from '../../src/world/BuildingArchitecture';
import { boardText, parcelBuildingName, scatterBuildingName } from '../../src/world/buildingIdentity';
import { signAtlasLayout } from '../../src/world/ProceduralMaterials';
import { neighbourhoodBuildingVariant } from '../../src/world/data/neighbourhoods';
import { nearestDistrict } from '../../src/world/mapData';
import { scatterCell } from '../../src/world/ModelScatter';
import { buildModel, MODEL_INDEX } from '../../src/world/models/catalog';
import { Kit } from '../../src/world/models/kit';

const keys = new Set<string>();
const add = (text: string, accent: string, background = '#10191c'): void => { keys.add(`${text}|${accent}|${background}`); };

// 1. Street-name blades: every junction blade is `label, '#f2f4e9', {background: '#176a5a'}`.
const roadNames = new Set<string>();
for (const road of GENERATED_ROADS) roadNames.add(road.name);
for (const name of roadNames) add(name, '#f2f4e9', '#176a5a');
console.log(`street names: ${roadNames.size}`);

// 2. Parcel boards: identity names where the building opens (City.buildOneBuilding passes them),
// the old generic labels where it does not. Accent still varies with variant.
const architecture = new BuildingArchitecture(new THREE.Group());
const planMaterial = new THREE.MeshBasicMaterial();
const half = MAP_WORLD_SIZE / 2 + CELL_SIZE;
const before = keys.size;
for (let x = -half; x <= half; x += CELL_SIZE) {
  for (let z = -half; z <= half; z += CELL_SIZE) {
    for (const building of generateCell(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE))) {
      const variant = neighbourhoodBuildingVariant(nearestDistrict(building.x, building.z).name, building.variant);
      if (building.style !== 'industrial' && building.style !== 'downtown' && building.style !== 'mixed-use') continue;
      const profile = architecture.plan({ x: 0, z: 0, width: building.width, depth: building.depth, height: building.height, style: building.style, variant, facade: planMaterial, roof: planMaterial });
      const name = profile.entrance ? boardText(parcelBuildingName(building.x, building.z, building.style, profile.entrance.kind)) : undefined;
      if (building.style === 'industrial') add(name ?? industrialSignLabel(variant), variant % 2 ? '#f0ae43' : '#72d8d2');
      else {
        const accents = ['#f0ae43', '#72d8d2', '#ef6556', '#74e392'];
        add(name ?? storefrontSignLabel(variant), accents[variant % accents.length] ?? '#f0ae43');
      }
    }
  }
}
console.log(`+ parcel boards: ${keys.size - before} distinct`);

// 3. Scattered model boards: intercept Kit.sign over every model that would ever build.
const captured = new Set<string>();
const realSign = Kit.prototype.sign;
(Kit.prototype as { sign: unknown }).sign = function patched(
  this: Kit, text: string, accent: string, w: number, h: number, x: number, y: number, z: number,
  options: { background?: string } = {},
) {
  captured.add(`${text}|${accent}|${options.background ?? '#10191c'}`);
  return (realSign as (...args: unknown[]) => unknown).call(this, text, accent, w, h, x, y, z, options);
};
const seen = new Set<string>();
for (let x = -half; x <= half; x += CELL_SIZE) {
  for (let z = -half; z <= half; z += CELL_SIZE) {
    for (const model of scatterCell(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE))) {
      const interior = MODEL_INDEX.get(model.name)?.interior;
      const signName = interior ? boardText(scatterBuildingName(model.x, model.z, interior.family, interior.kind, model.name)) : undefined;
      const identity = `${model.name}:${model.seed}:${model.variant}:${signName ?? ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try { buildModel(model.name, model.seed, { variant: model.variant, signName }); } catch { /* skip broken */ }
    }
  }
}
const scatterBefore = keys.size;
for (const key of captured) keys.add(key);
console.log(`+ scattered model boards: ${keys.size - scatterBefore} distinct (from ${seen.size} model builds)`);

// 4. Fixed one-offs that always draw (shops, safehouse, airport, rail, e-toll, bike, water tower...).
const FIXED: [string, string, string?][] = [
  ['JOZI ARMS', '#f0ae43'], ['NO EFT? EISH.', '#f0ae43'], ['PIK-N-SPRAY', '#72d8d2'], ['GARAGE', '#f0ae43'],
  ['BOERIE R25', '#e94d46'], ['MAIN MAIN', '#74e392'], ['NO LOAD? NO SHED.', '#74e392'],
  ['VODACOMB', '#e4372e'], ['TELKOM SORRY-4-LATE', '#8fd8e8'], ['JOBURG WATER', '#e5c15b'], ['(EMPTY)', '#e5c15b'],
  ['TOWER', '#8fd8e8'], ['LUGHAWE HALT', '#d9b23c'], ['KELVIN YARD', '#e8b23c'], ['RECORDS', '#c8cdd2'],
  ['E-TOLL · SANRAL', '#f2f4e9', '#4b2e83'], ['60-SEK', '#10220b', '#f4ffea'],
];
for (const [text, accent, bg] of FIXED) add(text, accent, bg);

// 5. Interior signs (EXIT + notices), allocated the first time a player enters a matching room.
const INTERIOR: [string, string, string][] = [
  ['EXIT', '#ffe08a', '#16211d'],
  ...['NO CREDIT', 'AIRTIME HERE', 'ICE COLD', 'HARD HATS', 'NO SMOKING', 'BAY CLEAR', 'LEVIES DUE'].map(
    (text): [string, string, string] => [text, '#f0d9a4', '#20262b']),
];
for (const [text, accent, bg] of INTERIOR) add(text, accent, bg);

const usable = signAtlasLayout().capacity - 1;
console.log(`\nDISTINCT SIGN KEYS CITYWIDE (before roadside/hangar/etc. extras): ${keys.size}`);
console.log(`atlas usable slots: ${usable} (${usable + 1} minus the blank overflow slot)`);
console.log(keys.size > usable
  ? `OVER CAPACITY by ${keys.size - usable}: every sign allocated after the ${usable}th draws as a blank board.`
  : `${usable - keys.size} slots of headroom left.`);
