/**
 * Interior LAYOUT audit — measures, over every door the interiors feature actually offers,
 * where the stair / lift / corridor / entry actually land, so "always in the same place" is a
 * measured claim with a stated denominator rather than an impression.
 *
 *   npx tsx tools/qa/interior-layout-audit.ts
 */
import { allScatteredModels } from '../../src/world/ModelScatter';
import { CELL_SIZE } from '../../src/world/CityGen';
import { doorsNear } from '../../src/features/interiors/doors';
import {
  buildCore, CORRIDOR, MIN_ROOM, LIFT_FROM_STOREYS, rectMaxZ,
  type BuildingCore,
} from '../../src/features/interiors/core';
import type { InteriorDoor } from '../../src/features/interiors.state';

// ---- gather every door, citywide, deduped by id ------------------------------------------------
const cells = new Set<string>();
for (const model of allScatteredModels()) {
  cells.add(`${Math.floor(model.x / CELL_SIZE)},${Math.floor(model.z / CELL_SIZE)}`);
}
const doors = new Map<string, InteriorDoor>();
for (const key of cells) {
  const [cx, cz] = key.split(',').map(Number) as [number, number];
  for (const door of doorsNear((cx + 0.5) * CELL_SIZE, (cz + 0.5) * CELL_SIZE, CELL_SIZE * 0.75)) {
    doors.set(door.id, door);
  }
}
const all = [...doors.values()];
const parcelDoors = all.filter((d) => !d.id.startsWith('s'));
const scatterDoors = all.filter((d) => d.id.startsWith('s'));
console.log(`DENOMINATOR: ${all.length} unique enterable doors (${parcelDoors.length} parcel + ${scatterDoors.length} scattered), from ${cells.size} chunk cells`);

// ---- per-building core measurements ------------------------------------------------------------
interface Row { door: InteriorDoor; core: BuildingCore; tagLx: number }
const rows: Row[] = [];
const seeds = new Set<number>();
let seedDupes = 0;
for (const door of all) {
  const core = buildCore(door.facts);
  if (seeds.has(core.seed)) seedDupes++;
  seeds.add(core.seed);
  // The tagged leaf position in BUILDING-local x, recovered from the world-space face point.
  const c = Math.cos(door.facts.heading); const s = Math.sin(door.facts.heading);
  const dx = door.faceX - door.facts.x; const dz = door.faceZ - door.facts.z;
  const tagLx = dx * c - dz * s; // building-local x of the tagged opening
  rows.push({ door, core, tagLx });
}

const hist = (values: number[], lo: number, hi: number, bins: number): string => {
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const b = Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins)));
    counts[b]!++;
  }
  return counts.map((n, i) => `${(lo + (i + 0.5) * (hi - lo) / bins).toFixed(2)}:${n}`).join('  ');
};
const stats = (values: number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `min ${sorted[0]!.toFixed(2)} p10 ${at(0.1).toFixed(2)} med ${at(0.5).toFixed(2)} p90 ${at(0.9).toFixed(2)} max ${sorted[sorted.length - 1]!.toFixed(2)} mean ${mean.toFixed(2)}`;
};

// ---- storeys -----------------------------------------------------------------------------------
const storeyCounts = new Map<number, number>();
for (const { core } of rows) storeyCounts.set(core.storeys, (storeyCounts.get(core.storeys) ?? 0) + 1);
console.log('\nSTOREYS distribution (storeys: buildings):');
console.log('  ' + [...storeyCounts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  '));
const single = rows.filter((r) => r.core.storeys === 1).length;
const lifted = rows.filter((r) => r.core.lift).length;
console.log(`  single-storey buildings (which STILL carry a full stair shaft in the core): ${single} of ${rows.length} (${(100 * single / rows.length).toFixed(1)}%)`);
console.log(`  buildings with a lift (storeys >= ${LIFT_FROM_STOREYS}): ${lifted}`);

// ---- the corridor / stair x position -----------------------------------------------------------
console.log('\nCORRIDOR X (== stair centre x == entry x, all three are the same number by construction):');
const corridorX = rows.map((r) => r.core.corridorX);
console.log('  absolute units: ' + stats(corridorX));
const slacks = rows.map((r) => Math.max(0, r.core.width / 2 - CORRIDOR / 2 - MIN_ROOM));
console.log('  available slack (width/2 - CORRIDOR/2 - MIN_ROOM): ' + stats(slacks));
const pinned = rows.filter((_row, i) => slacks[i]! < 0.75).length;
console.log(`  buildings where slack < 0.75u (corridor+stair+door effectively PINNED to centre): ${pinned} of ${rows.length} (${(100 * pinned / rows.length).toFixed(1)}%)`);
const normX = rows.map((r) => r.core.corridorX / (r.core.width / 2));
console.log('  stair x normalised to half-width [-1..1], histogram:');
console.log('  ' + hist(normX, -1, 1, 10));

// ---- the stair z position ----------------------------------------------------------------------
console.log('\nSTAIR Z (distance from BACK wall to shaft rear edge — variation would show here):');
const backGap = rows.map((r) => r.core.depth / 2 - rectMaxZ(r.core.stair));
console.log('  ' + stats(backGap));
const normZ = rows.map((r) => r.core.stair.z / (r.core.depth / 2));
console.log('  stair z normalised to half-depth [-1..1], histogram (1 = back wall):');
console.log('  ' + hist(normZ, -1, 1, 10));

// ---- the lift, relative to the stair -----------------------------------------------------------
const liftRows = rows.filter((r) => r.core.lift);
if (liftRows.length > 0) {
  const rel = liftRows.map((r) => r.core.lift!.x - (r.core.stair.x + r.core.stair.w / 2));
  const relZ = liftRows.map((r) => r.core.lift!.z - r.core.stair.z);
  console.log(`\nLIFT position relative to stair (n=${liftRows.length}):`);
  console.log('  x offset from stair right edge: ' + stats(rel));
  console.log('  z offset from stair centre:     ' + stats(relZ));
}

// ---- stair shaft size --------------------------------------------------------------------------
console.log('\nSTAIR SHAFT dimensions:');
console.log('  width: ' + stats(rows.map((r) => r.core.stair.w)));
console.log('  depth: ' + stats(rows.map((r) => r.core.stair.d)));

// ---- entry vs the model's tagged door ----------------------------------------------------------
// Interior local frame is the building frame rotated a half turn, so the tagged opening at
// building-local +x lands at interior-local -x. "Enter in the right relative place" would need
// entryX ~= -tagLx (scaled by plate/footprint if the plate is clamped).
console.log('\nENTRY vs the MODEL-TAGGED door position:');
const rawMismatch = rows.map((r) => r.core.entryX - (-r.tagLx));
console.log('  entryX - (-tag.x), raw units: ' + stats(rawMismatch));
const offCentreTags = rows.filter((r) => Math.abs(r.tagLx) > 0.5);
console.log(`  buildings whose tagged door is OFF the facade centre (|tag.x| > 0.5u): ${offCentreTags.length} of ${rows.length}`);
if (offCentreTags.length > 0) {
  const misses = offCentreTags.map((r) => Math.abs(r.core.entryX - (-r.tagLx)));
  console.log('  for those, |entry - door| mismatch: ' + stats(misses));
}

// ---- Tardis factor -----------------------------------------------------------------------------
console.log('\nPLATE vs FOOTPRINT (the Tardis question):');
const wRatio = rows.map((r) => r.core.width / r.door.facts.width);
const dRatio = rows.map((r) => r.core.depth / r.door.facts.depth);
console.log('  plate width / footprint width: ' + stats(wRatio));
console.log('  plate depth / footprint depth: ' + stats(dRatio));
const clampedWide = rows.filter((r) => Math.abs(r.core.width - (r.door.facts.width - 0.9)) > 0.01).length;
const clampedDeep = rows.filter((r) => Math.abs(r.core.depth - (r.door.facts.depth - 0.9)) > 0.01).length;
console.log(`  width clamped (plate != footprint-0.9): ${clampedWide} of ${rows.length}; depth clamped: ${clampedDeep}`);

// ---- seeds -------------------------------------------------------------------------------------
console.log(`\nSEEDS: ${seeds.size} distinct over ${rows.length} buildings (${seedDupes} duplicate draws)`);

// ---- roof-access candidate population ----------------------------------------------------------
const roofy = rows.filter((r) => (r.core.family === 'downtown' || r.core.family === 'industrial' || r.core.family === 'mixed-use') && r.core.storeys > 2);
console.log(`\nROOF-ACCESS candidates (commercial/industrial family, storeys > 2): ${roofy.length} of ${rows.length}`);
const roofFam = new Map<string, number>();
for (const r of roofy) roofFam.set(r.core.family, (roofFam.get(r.core.family) ?? 0) + 1);
console.log('  by family: ' + [...roofFam.entries()].map(([k, v]) => `${k}:${v}`).join('  '));
