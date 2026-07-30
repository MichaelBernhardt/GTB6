/**
 * Interior SCALE audit — measures, over every door the interiors feature actually offers, how the
 * interior's dimensions compare with (a) the exterior massing of the same building and (b) human
 * scale, so "our interiors are a Tardis" is a measured claim with a stated denominator.
 *
 *   npx tsx tools/qa/interior-scale-audit.ts
 */
import { allScatteredModels } from '../../src/world/ModelScatter';
import { CELL_SIZE } from '../../src/world/CityGen';
import { doorsNear } from '../../src/features/interiors/doors';
import {
  buildCore, CEILING, CORRIDOR, FACADE_STOREY, MIN_PLATE, STOREY_HEIGHT,
  type BuildingCore,
} from '../../src/features/interiors/core';
import { MAP_STATS } from '../../src/world/mapData';
import { PLAYER } from '../../src/config';
import type { InteriorDoor } from '../../src/features/interiors.state';

// ---- gather every door, citywide, deduped by id (same recipe as interior-layout-audit) ----------
const cellKeys = new Set<string>();
for (const model of allScatteredModels()) {
  cellKeys.add(`${Math.floor(model.x / CELL_SIZE)},${Math.floor(model.z / CELL_SIZE)}`);
}
const doors = new Map<string, InteriorDoor>();
for (const key of cellKeys) {
  const [cx, cz] = key.split(',').map(Number) as [number, number];
  for (const door of doorsNear((cx + 0.5) * CELL_SIZE, (cz + 0.5) * CELL_SIZE, CELL_SIZE * 0.75)) {
    doors.set(door.id, door);
  }
}
const all = [...doors.values()];
const parcelDoors = all.filter((d) => !d.id.startsWith('s'));
const scatterDoors = all.filter((d) => d.id.startsWith('s'));

const M = MAP_STATS.metresPerUnit; // exterior: real-world metres per game unit, from the shipped fit
console.log(`DENOMINATOR: ${all.length} unique enterable doors (${parcelDoors.length} parcel + ${scatterDoors.length} scattered), from ${cellKeys.size} chunk cells`);
console.log(`EXTERIOR SCALE: stats.fit.scale=${MAP_STATS.fit?.scale} u/projected-metre -> ${M} m/unit; player ${PLAYER.height}u tall, r=${PLAYER.radius}u`);
console.log(`INTERIOR CONSTANTS: storey ${STOREY_HEIGHT}u (clear ${CEILING}u), facade storey ${FACADE_STOREY}u, corridor ${CORRIDOR}u, partition doorway 2.0u, exit door 2.2u, min plate ${MIN_PLATE[0]}x${MIN_PLATE[1]}u`);
console.log('');

interface Row { door: InteriorDoor; core: BuildingCore }
const rows: Row[] = all.map((door) => ({ door, core: buildCore(door.facts) }));

const stats = (values: number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `min=${sorted[0]!.toFixed(2)} p10=${at(0.1).toFixed(2)} p50=${at(0.5).toFixed(2)} p90=${at(0.9).toFixed(2)} max=${sorted[sorted.length - 1]!.toFixed(2)} mean=${mean.toFixed(2)}`;
};
const pct = (n: number, d: number): string => `${n}/${d} (${(100 * n / d).toFixed(1)}%)`;

// ---- 1. footprint: interior plate vs exterior massing ------------------------------------------
const plateWRatio = rows.map((r) => r.core.width / r.door.facts.width);
const plateDRatio = rows.map((r) => r.core.depth / r.door.facts.depth);
const wideExcess = rows.filter((r) => r.core.width > r.door.facts.width + 1e-6);
const deepExcess = rows.filter((r) => r.core.depth > r.door.facts.depth + 1e-6);
const anyExcess = rows.filter((r) => r.core.width > r.door.facts.width + 1e-6 || r.core.depth > r.door.facts.depth + 1e-6);
const overhangW = wideExcess.map((r) => (r.core.width - r.door.facts.width) / 2);
const overhangD = deepExcess.map((r) => (r.core.depth - r.door.facts.depth) / 2);
console.log('--- FOOTPRINT: interior plate vs exterior massing (ratio, 1.00 = flush) ---');
console.log(`plate width / exterior width:  ${stats(plateWRatio)}`);
console.log(`plate depth / exterior depth:  ${stats(plateDRatio)}`);
console.log(`interior WIDER than its own building:  ${pct(wideExcess.length, rows.length)}${overhangW.length ? `  overhang/side u: ${stats(overhangW)}` : ''}`);
console.log(`interior DEEPER than its own building: ${pct(deepExcess.length, rows.length)}${overhangD.length ? `  overhang/side u: ${stats(overhangD)}` : ''}`);
console.log(`interior exceeds massing on EITHER axis: ${pct(anyExcess.length, rows.length)}`);
const byFamily = new Map<string, number[]>();
for (const r of anyExcess) {
  const list = byFamily.get(r.door.facts.style) ?? [];
  list.push(1); byFamily.set(r.door.facts.style, list);
}
const familyTotals = new Map<string, number>();
for (const r of rows) familyTotals.set(r.door.facts.style, (familyTotals.get(r.door.facts.style) ?? 0) + 1);
console.log('excess by family: ' + [...familyTotals.entries()].map(([f, total]) => `${f} ${pct(byFamily.get(f)?.length ?? 0, total)}`).join('  '));
console.log('');

// ---- 2. vertical: interior stack vs exterior height --------------------------------------------
const storeys = rows.map((r) => r.core.storeys);
const stackRatio = rows.map((r) => (r.core.storeys * STOREY_HEIGHT) / r.door.facts.height);
const single = rows.filter((r) => r.core.storeys === 1);
console.log('--- VERTICAL: storeys and stack height ---');
console.log(`storeys: ${stats(storeys)}   single-storey: ${pct(single.length, rows.length)}`);
console.log(`interior stack (storeys x ${STOREY_HEIGHT}) / exterior height: ${stats(stackRatio)}`);
console.log(`one interior storey ${STOREY_HEIGHT}u = ${(STOREY_HEIGHT * M).toFixed(2)}m map-scale, ${(STOREY_HEIGHT / PLAYER.height * 1.75).toFixed(2)}m player-relative (1.75m human)`);
console.log(`exterior storey (facade bands) ~3.25-3.8u; interior/facade storey ratio = ${(STOREY_HEIGHT / FACADE_STOREY).toFixed(2)}`);
console.log('');

// ---- 3. openings and passages against human scale ----------------------------------------------
const openW = rows.map((r) => r.door.openWidth);
const openH = rows.map((r) => r.door.openHeight);
console.log('--- OPENINGS: the tagged exterior door vs the interior joinery ---');
console.log(`exterior tagged opening width u:  ${stats(openW)}  (= m player-relative x${(1.75 / PLAYER.height).toFixed(3)}, m map-scale x${M})`);
console.log(`exterior tagged opening height u: ${stats(openH)}`);
console.log(`interior partition doorway: 2.00u wide, head 2.25u; interior exit door 2.2u x 3.0u; corridor ${CORRIDOR}u`);
console.log(`at player-relative scale: doorway ${(2.0 / PLAYER.height * 1.75).toFixed(2)}m wide, head ${(2.25 / PLAYER.height * 1.75).toFixed(2)}m, corridor ${(CORRIDOR / PLAYER.height * 1.75).toFixed(2)}m, ceiling ${(CEILING / PLAYER.height * 1.75).toFixed(2)}m`);
console.log('');

// ---- 4. stairs ----------------------------------------------------------------------------------
// build.ts: 9 treads per half flight, 2 half flights per storey -> 18 risers per STOREY_HEIGHT.
const riser = STOREY_HEIGHT / 18;
const treads = rows.map((r) => r.core.stair.d / 9);
console.log('--- STAIRS: riser and tread (18 risers per storey, 9 treads per half flight) ---');
console.log(`riser: ${riser.toFixed(3)}u = ${(riser / PLAYER.height * 1.75).toFixed(2)}m player-relative (building code ~0.17-0.19m)`);
console.log(`tread depth u: ${stats(treads)} (player-relative m: x${(1.75 / PLAYER.height).toFixed(3)})`);
console.log(`shaft footprint u: w ${stats(rows.map((r) => r.core.stair.w))} d ${stats(rows.map((r) => r.core.stair.d))}`);
console.log('');

// ---- 5. the worst offenders, by name, so a human can walk to one -------------------------------
const worst = [...anyExcess]
  .sort((a, b) => (b.core.width / b.door.facts.width + b.core.depth / b.door.facts.depth)
    - (a.core.width / a.door.facts.width + a.core.depth / a.door.facts.depth))
  .slice(0, 8);
console.log('--- WORST TARDIS CASES (interior plate vs own massing) ---');
for (const r of worst) {
  console.log(`${r.door.name} @ ${r.door.x.toFixed(0)},${r.door.z.toFixed(0)} [${r.door.facts.style}]: exterior ${r.door.facts.width.toFixed(1)}x${r.door.facts.depth.toFixed(1)}u -> interior ${r.core.width.toFixed(1)}x${r.core.depth.toFixed(1)}u (${(r.core.width / r.door.facts.width).toFixed(2)}x, ${(r.core.depth / r.door.facts.depth).toFixed(2)}x)`);
}
