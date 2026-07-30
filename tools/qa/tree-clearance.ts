/**
 * Tree-trunk collider audit — the evidence that solid trunks never wall off somewhere a player must walk.
 *
 * A trunk collider in a pavement, a carriageway or a doorway is worse than no trunk collider at all: it
 * is an invisible wall in a place the game tells you to go. So this reports, over the WHOLE scatter,
 * the closest any authored trunk comes to (a) the built road footprint — tar plus kerb plus sidewalk,
 * (b) the pedestrian walk lines the nav graph routes peds along, and (c) every doorstep the interiors
 * feature will offer. It also prints the census: how many trees are solid, and per species-variant what
 * the authored trunk diameter is against SOLID_TRUNK_MIN_DIAMETER.
 *
 *   npx tsx tools/qa/tree-clearance.ts
 */
import recipe from '../../art/foliage/recipe.json';
import { SOLID_TRUNK_MIN_DIAMETER, TREE_SPECIES, trunkIsSolid } from '../../src/world/FoliageAssets';
import { allScatteredModels } from '../../src/world/ModelScatter';
import { buildCityNavPaths, ROAD_NETWORK } from '../../src/world/City';
import { CELL_SIZE } from '../../src/world/CityGen';
import { distanceToBuiltRoadEdge, distanceToRoadEdge } from '../../src/world/mapData';
import { MODEL_INDEX } from '../../src/world/models/catalog';
import { DOOR_RADIUS } from '../../src/features/interiors.state';
import { doorsNear } from '../../src/features/interiors/doors';

interface Point { x: number; z: number }

/** Uniform-grid helper: bucket items by cell so the citywide sweeps stay O(nearby), not O(n·m). */
class Buckets<T extends Point> {
  private cells = new Map<string, T[]>();
  constructor(private size: number) {}
  add(item: T, at: Point = item): void {
    const key = `${Math.floor(at.x / this.size)},${Math.floor(at.z / this.size)}`;
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(item); else this.cells.set(key, [item]);
  }
  near(x: number, z: number, reach: number): T[] {
    const found: T[] = [];
    const cx = Math.floor(x / this.size); const cz = Math.floor(z / this.size);
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) found.push(...this.cells.get(`${cx + dx},${cz + dz}`) ?? []);
    return found;
  }
}

const species = new Set<string>(TREE_SPECIES);
const models = allScatteredModels();
const trees = models.filter((model) => species.has(model.name));
const foliage = models.filter((model) => MODEL_INDEX.get(model.name)?.category === 'foliage');

console.log(`scatter: ${models.length} models, ${foliage.length} foliage, ${trees.length} authored library trees`);
console.log(`solid trunk threshold: ${SOLID_TRUNK_MIN_DIAMETER} m authored diameter`);
for (const variant of recipe.variants) {
  const [w, d] = variant.trunkCollider as [number, number, number];
  console.log(`  ${variant.species} v${variant.variant}: ${w.toFixed(2)} m -> ${trunkIsSolid(w, d) ? 'SOLID' : 'passable'}`);
}
const perName: Record<string, number> = {};
for (const tree of trees) perName[tree.name] = (perName[tree.name] ?? 0) + 1;
console.log('  scattered per species:', perName);

// ---- (a) road + pavement -----------------------------------------------------------------------
let minBuilt = Infinity; let minTar = Infinity;
for (const tree of trees) {
  minBuilt = Math.min(minBuilt, distanceToBuiltRoadEdge(tree.x, tree.z));
  minTar = Math.min(minTar, distanceToRoadEdge(tree.x, tree.z));
}
console.log(`\nnearest trunk to the BUILT road edge (tar+kerb+sidewalk): ${minBuilt.toFixed(2)} u`);
console.log(`nearest trunk to the carriageway edge:                    ${minTar.toFixed(2)} u`);

// ---- (b) pedestrian walk lines -----------------------------------------------------------------
interface Segment extends Point { ax: number; az: number; bx: number; bz: number }
const walkSegments = new Buckets<Segment>(24);
for (const path of buildCityNavPaths(ROAD_NETWORK).walks) {
  for (let index = 0; index < path.points.length - 1; index++) {
    const a = path.points[index]!; const b = path.points[index + 1]!;
    const segment: Segment = { ax: a.x, az: a.z, bx: b.x, bz: b.z, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    walkSegments.add(segment);
  }
}
const distanceToSegment = (segment: Segment, x: number, z: number): number => {
  const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSquared));
  return Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t));
};
let minWalk = Infinity;
for (const tree of trees) {
  for (const segment of walkSegments.near(tree.x, tree.z, 2)) minWalk = Math.min(minWalk, distanceToSegment(segment, tree.x, tree.z));
}
console.log(`nearest trunk to a ped walk line:                         ${minWalk.toFixed(2)} u`);

// ---- (c) doorsteps -----------------------------------------------------------------------------
const trunkGrid = new Buckets<typeof trees[number]>(48);
for (const tree of trees) trunkGrid.add(tree);
const cells = new Set<string>();
for (const tree of trees) cells.add(`${Math.floor(tree.x / CELL_SIZE)},${Math.floor(tree.z / CELL_SIZE)}`);
let minDoor = Infinity; let doorstepCount = 0; let blockedDoors = 0; let worstDoor = '';
for (const key of cells) {
  const [cellX, cellZ] = key.split(',').map(Number) as [number, number];
  for (const door of doorsNear((cellX + 0.5) * CELL_SIZE, (cellZ + 0.5) * CELL_SIZE, CELL_SIZE * 0.7)) {
    doorstepCount++;
    let nearest = Infinity;
    for (const tree of trunkGrid.near(door.x, door.z, 1)) nearest = Math.min(nearest, Math.hypot(tree.x - door.x, tree.z - door.z));
    if (nearest < DOOR_RADIUS) blockedDoors++;
    if (nearest < minDoor) { minDoor = nearest; worstDoor = `${door.name ?? door.id} @ ${door.x.toFixed(0)},${door.z.toFixed(0)}`; }
  }
}
console.log(`nearest trunk to a doorstep (${doorstepCount} steps in ${cells.size} cells):        ${minDoor.toFixed(2)} u  (${worstDoor})`);
console.log(`doorsteps with a trunk inside the ${DOOR_RADIUS} u prompt ring:              ${blockedDoors}`);
