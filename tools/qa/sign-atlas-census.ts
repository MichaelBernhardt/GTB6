/**
 * Sign-atlas census — how many DISTINCT sign keys (text|accent|background) the whole map wants,
 * against the atlas's 511 usable slots. Every key past 511 shares ONE slot that each newcomer
 * repaints, so any sign built after capacity shows whatever text was drawn last — the mechanism
 * behind boards changing text between entering and leaving a building.
 *
 *   npx tsx tools/qa/sign-atlas-census.ts
 */
import { GENERATED_ROADS, MAP_WORLD_SIZE } from '../../src/world/mapData';
import { CELL_SIZE, generateCell } from '../../src/world/CityGen';
import { industrialSignLabel, storefrontSignLabel } from '../../src/world/City';
import { neighbourhoodBuildingVariant } from '../../src/world/data/neighbourhoods';
import { nearestDistrict } from '../../src/world/mapData';
import { scatterCell } from '../../src/world/ModelScatter';
import { buildModel } from '../../src/world/models/catalog';
import { Kit } from '../../src/world/models/kit';

const keys = new Set<string>();
const add = (text: string, accent: string, background = '#10191c'): void => { keys.add(`${text}|${accent}|${background}`); };

// 1. Street-name blades: every junction blade is `label, '#f2f4e9', {background: '#176a5a'}`.
const roadNames = new Set<string>();
for (const road of GENERATED_ROADS) roadNames.add(road.name);
for (const name of roadNames) add(name, '#f2f4e9', '#176a5a');
console.log(`street names: ${roadNames.size}`);

// 2. Parcel boards: storefront (downtown/mixed-use) and industrial, accent varies with variant.
const half = MAP_WORLD_SIZE / 2 + CELL_SIZE;
const before = keys.size;
for (let x = -half; x <= half; x += CELL_SIZE) {
  for (let z = -half; z <= half; z += CELL_SIZE) {
    for (const building of generateCell(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE))) {
      const variant = neighbourhoodBuildingVariant(nearestDistrict(building.x, building.z).name, building.variant);
      if (building.style === 'industrial') add(industrialSignLabel(variant), variant % 2 ? '#f0ae43' : '#72d8d2');
      if (building.style === 'downtown' || building.style === 'mixed-use') {
        const accents = ['#f0ae43', '#72d8d2', '#ef6556', '#74e392'];
        add(storefrontSignLabel(variant), accents[variant % accents.length] ?? '#f0ae43');
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
      const identity = `${model.name}:${model.seed}:${model.variant}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try { buildModel(model.name, model.seed, { variant: model.variant }); } catch { /* skip broken */ }
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

console.log(`\nDISTINCT SIGN KEYS CITYWIDE (before roadside/hangar/etc. extras): ${keys.size}`);
console.log('atlas usable slots: 511 (512 minus the shared overflow slot)');
console.log(keys.size > 511
  ? `OVER CAPACITY by ${keys.size - 511}: every sign allocated after the 511th shares one slot and shows whatever was drawn last.`
  : `${511 - keys.size} slots of headroom left.`);
