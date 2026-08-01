/**
 * Interior LAYOUT audit — measures, over every door the interiors feature actually offers,
 * where the stair / lift / corridor / entry actually land, so "always in the same place" is a
 * measured claim with a stated denominator rather than an impression.
 *
 * The BEFORE numbers (commit a7a653b) it exists to compare against:
 *   - stair rear edge 0.30 off the back wall on ALL 7,415 buildings (zero variance)
 *   - shaft 4.30 x 5.40 on all 7,415; lift exactly +1.5 off the stair's right edge on all 1,151
 *   - stair x == corridor x == entry x, one seeded draw, entire distribution inside |x/halfW| < 0.4
 *   - 2,766 single-storey buildings all carrying a full dead shaft
 *   - entry ignored the model's tagged door: median 1.55u off, p90 5.45u, max 53.3u
 *
 *   npx tsx tools/qa/interior-layout-audit.ts
 */
import { allScatteredModels } from '../../src/world/ModelScatter';
import { CELL_SIZE } from '../../src/world/CityGen';
import { doorsNear } from '../../src/features/interiors/doors';
import {
  buildCore, coreBackZ, CORRIDOR, MIN_ROOM, LIFT_FROM_STOREYS, hasRoofAccess, rectMaxZ, TARDIS_MAX,
  type BuildingCore,
} from '../../src/features/interiors/core';
import { lockedClass } from '../../src/features/interiors/lock';
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
interface Row { door: InteriorDoor; core: BuildingCore }
const rows: Row[] = [];
const seeds = new Set<number>();
let seedDupes = 0;
for (const door of all) {
  const core = buildCore(door.facts);
  if (seeds.has(core.seed)) seedDupes++;
  seeds.add(core.seed);
  rows.push({ door, core });
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
  if (values.length === 0) return '(none)';
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `min ${sorted[0]!.toFixed(2)} p10 ${at(0.1).toFixed(2)} med ${at(0.5).toFixed(2)} p90 ${at(0.9).toFixed(2)} max ${sorted[sorted.length - 1]!.toFixed(2)} mean ${mean.toFixed(2)}`;
};

// ---- storeys and the single-storey stair rule --------------------------------------------------
const storeyCounts = new Map<number, number>();
for (const { core } of rows) storeyCounts.set(core.storeys, (storeyCounts.get(core.storeys) ?? 0) + 1);
console.log('\nSTOREYS distribution (storeys: buildings):');
console.log('  ' + [...storeyCounts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  '));
const single = rows.filter((r) => r.core.storeys === 1);
const deadShafts = single.filter((r) => r.core.stair).length;
console.log(`  single-storey buildings: ${single.length} of ${rows.length} (${(100 * single.length / rows.length).toFixed(1)}%)`);
console.log(`  single-storey buildings carrying a stair shaft (must be 0): ${deadShafts}`);
const lifted = rows.filter((r) => r.core.lift);
console.log(`  buildings with a lift (storeys >= ${LIFT_FROM_STOREYS}): ${lifted.length}`);

const stairs = rows.filter((r) => r.core.stair);
console.log(`\nSTAIRED buildings (storeys >= 2): ${stairs.length} of ${rows.length}`);

// ---- the plate against the building that wears it (round-3: plate = footprint x bounded tardis) --
console.log('\nPLATE vs FOOTPRINT (round-2 before: width ratio p50 0.96 p90 1.32 max 2.58; depth p50 1.12 p90 1.97 max 4.48):');
console.log('  plate width / footprint width:  ' + stats(rows.map((r) => r.core.width / Math.max(1, r.door.facts.width))));
console.log('  plate depth / footprint depth:  ' + stats(rows.map((r) => r.core.depth / Math.max(1, r.door.facts.depth))));
const overBound = rows.filter((r) => r.core.width / Math.max(1, r.door.facts.width - 0.9) > TARDIS_MAX + 1e-6
  || r.core.depth / Math.max(1, r.door.facts.depth - 0.9) > TARDIS_MAX + 1e-6);
const overSingle = overBound.filter((r) => r.core.storeys === 1);
console.log(`  beyond the ${TARDIS_MAX}x tardis bound (vs bare footprint): ${overBound.length} of ${rows.length}`
  + ` — ${overSingle.length} single-storey (small-layout camera floor), ${overBound.length - overSingle.length} multi-storey (stair+corridor hard floor)`);
const smalls = rows.filter((r) => r.core.layout === 'small');
console.log(`  SMALL layouts (one room, door straight in): ${smalls.length} of ${rows.length}`);
console.log('  small plate sizes, width: ' + stats(smalls.map((r) => r.core.width)) + '\n                     depth: ' + stats(smalls.map((r) => r.core.depth)));
const aspects = rows.filter((r) => r.core.layout === 'full').map((r) =>
  (r.core.width / r.core.depth) / ((r.door.facts.width - 0.9) / Math.max(1, r.door.facts.depth - 0.9)));
console.log('  aspect fidelity, full layouts (plate w/d over footprint w/d — 1.00 = aspect preserved): ' + stats(aspects));

// ---- the stair position CLASS (round-3: the first thing the seed buys) ---------------------------
const classCounts = new Map<string, number>();
for (const r of stairs) classCounts.set(r.core.stairClass ?? '??', (classCounts.get(r.core.stairClass ?? '??') ?? 0) + 1);
console.log('\nSTAIR POSITION CLASS (was: 100% back-band, x within ±2.8 of the corridor):');
console.log('  ' + [...classCounts.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}: ${v} (${(100 * v / stairs.length).toFixed(1)}%)`).join('  '));
const withRoomsBehind = stairs.filter((r) => coreBackZ(r.core) !== undefined);
console.log(`  island cores with a room band BEHIND the stair: ${withRoomsBehind.length} of ${stairs.length}`);
console.log('  stair z centre normalised to half-depth [-1 front .. +1 back], histogram:');
console.log('  ' + hist(stairs.map((r) => r.core.stair!.z / (r.core.depth / 2)), -1, 1, 10));

// ---- corridor x: anchored on the tagged door ---------------------------------------------------
console.log('\nCORRIDOR X (== entry x, anchored on the model-tagged door):');
const corridorX = rows.map((r) => r.core.corridorX);
console.log('  absolute units: ' + stats(corridorX));
const slacks = rows.map((r) => Math.max(0, r.core.width / 2 - CORRIDOR / 2 - MIN_ROOM));
console.log('  available slack (width/2 - CORRIDOR/2 - MIN_ROOM): ' + stats(slacks));
const normCorr = rows.map((r) => r.core.corridorX / (r.core.width / 2));
console.log('  corridor x normalised to half-width [-1..1], histogram:');
console.log('  ' + hist(normCorr, -1, 1, 10));

// ---- entry vs the model's tagged door ----------------------------------------------------------
console.log('\nENTRY vs the MODEL-TAGGED door position (owner step 2 — the interior frame is the');
console.log('building frame rotated a half turn, so the wanted entry is -doorX, proportionally scaled):');
const mapped = rows.map((r) => {
  const scale = r.core.width / Math.max(1, r.door.facts.width);
  return -r.door.facts.doorX * scale;
});
const inSlack = rows.filter((_r, i) => Math.abs(mapped[i]!) <= slacks[i]! + 1e-9);
const misses = inSlack.map((r) => Math.abs(r.core.entryX - (-r.door.facts.doorX * (r.core.width / Math.max(1, r.door.facts.width)))));
console.log(`  doors whose mapped position fits inside the corridor band: ${inSlack.length} of ${rows.length}`);
console.log('  for those, |entry - mapped door|: ' + stats(misses));
const offCentreTags = rows.filter((r) => Math.abs(r.door.facts.doorX) > 0.5);
const followed = offCentreTags.filter((r) => Math.sign(r.core.corridorX) === Math.sign(-r.door.facts.doorX) && Math.abs(r.core.corridorX) > 0.05);
console.log(`  off-centre tagged doors (|tag.x| > 0.5): ${offCentreTags.length}; corridor visibly follows the tag on ${followed.length}`);

// ---- the stair, relative to spine and back wall ------------------------------------------------
console.log('\nSTAIR X offset from the corridor (was: identically 0 on all buildings):');
const stairOffsets = stairs.map((r) => r.core.stair!.x - r.core.corridorX);
console.log('  ' + stats(stairOffsets));
console.log('  histogram: ' + hist(stairOffsets, -3, 3, 10));
const normX = stairs.map((r) => r.core.stair!.x / (r.core.width / 2));
console.log('  stair x normalised to half-width [-1..1], histogram:');
console.log('  ' + hist(normX, -1, 1, 10));

console.log('\nSTAIR Z (distance from BACK wall to shaft rear edge — was: 0.30 on ALL buildings):');
const backGap = stairs.map((r) => r.core.depth / 2 - rectMaxZ(r.core.stair!));
console.log('  ' + stats(backGap));
console.log('  histogram: ' + hist(backGap, 0, 1.6, 8));

const turns = new Map<number, number>();
for (const r of stairs) turns.set(r.core.stairDir, (turns.get(r.core.stairDir) ?? 0) + 1);
console.log('\nSWITCHBACK TURN direction (was: one way on all buildings): '
  + [...turns.entries()].map(([k, v]) => `${k > 0 ? '+x' : '-x'} first: ${v}`).join('  '));

// ---- the lift, relative to the stair -----------------------------------------------------------
if (lifted.length > 0) {
  const rel = lifted.map((r) => r.core.lift!.x - r.core.stair!.x);
  const left = rel.filter((v) => v < 0).length;
  console.log(`\nLIFT position relative to stair centre (n=${lifted.length}; was: one constant on all of them):`);
  console.log('  x offset: ' + stats(rel));
  console.log(`  side: left ${left} / right ${rel.length - left}`);
}

// ---- stair shaft size --------------------------------------------------------------------------
console.log('\nSTAIR SHAFT dimensions:');
console.log('  width: ' + stats(stairs.map((r) => r.core.stair!.w)));
console.log('  depth: ' + stats(stairs.map((r) => r.core.stair!.d)));

// ---- seeds -------------------------------------------------------------------------------------
console.log(`\nSEEDS: ${seeds.size} distinct over ${rows.length} buildings (${seedDupes} duplicate draws)`);

// ---- roof-access population --------------------------------------------------------------------
const roofy = rows.filter((r) => hasRoofAccess(r.core));
const roofUsable = roofy.filter((r) => r.door.roof);
console.log(`\nROOF-ACCESS candidates (commercial/industrial family, storeys > 2): ${roofy.length} of ${rows.length}`);
const roofFam = new Map<string, number>();
for (const r of roofy) roofFam.set(r.core.family, (roofFam.get(r.core.family) ?? 0) + 1);
console.log('  by family: ' + [...roofFam.entries()].map(([k, v]) => `${k}:${v}`).join('  '));
console.log(`  with a standable top tier recorded on the door (hatch actually usable): ${roofUsable.length} of ${roofy.length}`);

// ---- lock classification (gate is OFF until the locks pass; the line is settled here) ----------
const locked = rows.filter((r) => lockedClass(r.door.facts));
console.log(`\nLOCK LINE D (LIVE since the locks pass; day figure — the night fork adds the works): ${locked.length} of ${rows.length} doors locked (${(100 * locked.length / rows.length).toFixed(1)}%)`);
