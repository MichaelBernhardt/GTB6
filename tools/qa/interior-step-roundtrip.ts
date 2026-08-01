/**
 * Classify the doorsteps whose own step does not prompt their own door.
 *
 * Shapes seen: (a) doorNear returns NOTHING — hypothesis: the door is stored under its BUILDING
 * centre's chunk cell, but the STEP sits across a cell line more than DOOR_RADIUS inside the next
 * cell, so the 4.2 u prompt search never opens the cell that holds it; (b) doorNear returns a
 * DIFFERENT door — two steps 2.6..8.4 u apart resolving by nearest.
 *
 *   npx tsx tools/qa/interior-step-roundtrip.ts
 */
import { doorsNear, doorNear } from '../../src/features/interiors/doors';
import type { InteriorDoor } from '../../src/features/interiors.state';
import { DOOR_RADIUS } from '../../src/features/interiors.state';
import { CELL_SIZE } from '../../src/world/CityGen';
import { MAP_WORLD_SIZE } from '../../src/world/mapData';

const half = MAP_WORLD_SIZE / 2 + CELL_SIZE;
const doors = new Map<string, InteriorDoor>();
for (let x = -half; x <= half; x += CELL_SIZE) {
  for (let z = -half; z <= half; z += CELL_SIZE) {
    for (const door of doorsNear(x, z, CELL_SIZE * 0.75)) doors.set(door.id, door);
  }
}

const cellOf = (x: number, z: number): string => `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
let nothing = 0; let other = 0; let cellMiss = 0; let scatterTileMiss = 0;
const nothingExamples: string[] = [];
const otherExamples: string[] = [];
for (const door of doors.values()) {
  const found = doorNear(door.x, door.z);
  if (found?.id === door.id) continue;
  const buildingCell = cellOf(door.facts.x, door.facts.z);
  const stepCell = cellOf(door.x, door.z);
  const tileMiss = door.id.startsWith('s')
    && (Math.floor(door.facts.x / (CELL_SIZE / 4)) !== Math.floor(door.x / (CELL_SIZE / 4))
      || Math.floor(door.facts.z / (CELL_SIZE / 4)) !== Math.floor(door.z / (CELL_SIZE / 4)));
  if (found === undefined) {
    nothing++;
    if (buildingCell !== stepCell) cellMiss++;
    if (tileMiss) scatterTileMiss++;
    if (nothingExamples.length < 8) {
      nothingExamples.push(`  ${door.id} '${door.name}' step ${door.x.toFixed(0)},${door.z.toFixed(0)} cell ${stepCell} — building ${door.facts.x.toFixed(0)},${door.facts.z.toFixed(0)} cell ${buildingCell}${tileMiss ? ' (scatter tile differs too)' : ''}`);
    }
  } else {
    other++;
    const gap = Math.hypot(found.x - door.x, found.z - door.z);
    if (otherExamples.length < 8) otherExamples.push(`  ${door.id} '${door.name}' loses its step to ${found.id} '${found.name}' ${gap.toFixed(1)}u away`);
  }
}
console.log(`doors: ${doors.size}; own step prompts nothing: ${nothing} (building/step in different cells: ${cellMiss}, scatter tile differs: ${scatterTileMiss}); prompts another door: ${other}; DOOR_RADIUS ${DOOR_RADIUS}`);
console.log('prompts NOTHING:');
for (const line of nothingExamples) console.log(line);
console.log('prompts ANOTHER door:');
for (const line of otherExamples) console.log(line);
