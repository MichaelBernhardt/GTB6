/**
 * LOCK census — how many enterable doors fall each side of any commercial/non-commercial line,
 * so "lock every non-commercial building" is a measured friction budget, not a guess.
 *
 *   npx tsx tools/qa/interior-lock-census.ts
 */
import { allScatteredModels } from '../../src/world/ModelScatter';
import { CELL_SIZE } from '../../src/world/CityGen';
import { doorsNear } from '../../src/features/interiors/doors';
import { buildCore } from '../../src/features/interiors/core';
import type { InteriorDoor } from '../../src/features/interiors.state';

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
console.log(`DENOMINATOR: ${all.length} unique enterable doors`);

// style × entrance kind
const cross = new Map<string, number>();
for (const door of all) {
  const key = `${door.facts.style} × ${door.facts.entrance}`;
  cross.set(key, (cross.get(key) ?? 0) + 1);
}
console.log('\nSTYLE × ENTRANCE (count):');
for (const [key, n] of [...cross.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${key}: ${n}`);

// Candidate lines for "commercial".
const isShopfront = (d: InteriorDoor): boolean => d.facts.entrance === 'shopfront';
const commercialStyle = new Set(['downtown', 'mixed-use']);
const lines: [string, (d: InteriorDoor) => boolean][] = [
  ['A. unlocked = shopfront entrances only', (d) => isShopfront(d)],
  ['B. unlocked = shopfront OR lobby (any walk-in premises)', (d) => d.facts.entrance === 'shopfront' || d.facts.entrance === 'lobby'],
  ['C. unlocked = commercial styles (downtown/mixed-use), all entrances', (d) => commercialStyle.has(d.facts.style)],
  ['D. unlocked = shopfront + downtown/mixed-use lobby + industrial dock', (d) =>
    isShopfront(d) || (commercialStyle.has(d.facts.style) && d.facts.entrance === 'lobby') || (d.facts.style === 'industrial' && d.facts.entrance === 'dock')],
];
for (const [label, open] of lines) {
  const unlocked = all.filter(open).length;
  console.log(`\n${label}`);
  console.log(`  unlocked ${unlocked} (${(100 * unlocked / all.length).toFixed(1)}%)  LOCKED ${all.length - unlocked} (${(100 * (all.length - unlocked) / all.length).toFixed(1)}%)`);
}

// Roof-access population under the owner's rule, against each family label in facts.style.
const styles = new Map<string, number>();
for (const door of all) styles.set(door.facts.style, (styles.get(door.facts.style) ?? 0) + 1);
console.log('\nSTYLE totals: ' + [...styles.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));

const roofy = all.filter((d) => {
  const core = buildCore(d.facts);
  return core.storeys > 2 && (commercialStyle.has(d.facts.style) || d.facts.style === 'industrial');
});
console.log(`\nROOF candidates (downtown/mixed-use/industrial, storeys > 2): ${roofy.length} of ${all.length}`);
