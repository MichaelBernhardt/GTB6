/**
 * TRAVEL STUTTER — the periodic spike while covering linear ground, measured.
 *
 * The owner's report: a large frame spike roughly every two seconds while running or driving in a
 * straight line, nothing at all standing still, and nothing shuffling back and forth in one spot.
 * That shape rules out every wall-clock timer in the loop and points at something gated on NET
 * DISPLACEMENT from an anchor.
 *
 * The interiors doorway streamer is exactly that: it re-streams once the player is STREAM_SLACK
 * (28 u) from where it last built — 28 / 13 u·s⁻¹ sprint = 2.15 s, the owner's "approx every two
 * seconds" — and it runs inside FeatureHost.update, which the frame profiler bills to the `combat`
 * bucket (the owner read the spike as "traffic or combat"). Each re-stream disposes and rebuilds
 * every marker, and each door it has not seen before pays one FULL-SCENE downward raycast against
 * the merged per-cell city geometry.
 *
 * This harness runs the real derivations and the real geometry builders and prices the three costs
 * a re-stream can pay:
 *
 *   cells    — per-cell bake/merge cost of the building streamer (the other displacement-gated path)
 *   doors    — doorsNear()/doorsInCell() memoisation cost on first visit to a cell
 *   probe    — one markerSurface() ray against a REAL merged cell, the per-new-door cost
 *   churn    — how many NEW doors a 28 u step brings into the nearest-32 set, i.e. probes per spike
 *
 *   npx tsx tools/qa/travel-stutter.ts [cellSamples]
 */
import * as THREE from 'three';
import { performance } from 'node:perf_hooks';
import { allBuildings, CELL_SIZE, type GeneratedBuilding } from '../../src/world/CityGen';
import { allScatteredModels, type ScatteredModel } from '../../src/world/ModelScatter';
import { BuildingArchitecture } from '../../src/world/BuildingArchitecture';
import { planParcelFence } from '../../src/world/ParcelFences';
import { buildModel } from '../../src/world/models/catalog';
import { GeometryBaker } from '../../src/world/StaticGeometry';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { districtAt as generatedDistrictAt } from '../../src/world/mapData';
import { terrainHeightAt } from '../../src/world/City';
import { doorsNear } from '../../src/features/interiors/doors';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';

const cellKey = (x: number, z: number): string => `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;

const buildings = allBuildings();
const models = allScatteredModels();

const byCell = new Map<string, { specs: GeneratedBuilding[]; models: ScatteredModel[] }>();
const bucket = (key: string): { specs: GeneratedBuilding[]; models: ScatteredModel[] } => {
  let cell = byCell.get(key);
  if (!cell) { cell = { specs: [], models: [] }; byCell.set(key, cell); }
  return cell;
};
for (const building of buildings) bucket(cellKey(building.x, building.z)).specs.push(building);
for (const model of models) bucket(cellKey(model.x, model.z)).models.push(model);

const cells = [...byCell.entries()].map(([key, cell]) => ({ key, ...cell, items: cell.specs.length + cell.models.length }));
cells.sort((a, b) => b.items - a.items);

const total = cells.reduce((sum, cell) => sum + cell.items, 0);
console.log(`cells=${cells.length} buildings=${buildings.length} models=${models.length} items=${total}`);
console.log(`items/cell: max=${cells[0]!.items} p90=${cells[Math.floor(cells.length * 0.1)]!.items} median=${cells[Math.floor(cells.length / 2)]!.items}`);

// Materials: distinct instances per facade index/style, so GeometryBaker buckets split exactly as
// they do in the game (materialKey folds colour/roughness/metalness, not the texture content).
const materials = new Map<string, THREE.MeshStandardMaterial>();
const material = (key: string, color = 0x9aa4a8): THREE.MeshStandardMaterial => {
  let found = materials.get(key);
  if (!found) { found = new THREE.MeshStandardMaterial({ color, roughness: 0.72 }); materials.set(key, found); }
  return found;
};

let skippedTotal = 0;
const root = new THREE.Group();
const architecture = new BuildingArchitecture(root);

interface CellCost { key: string; items: number; bakeMs: number; finalizeMs: number; merged: THREE.Group; triangles: number; }

function measureCell(cell: { key: string; specs: GeneratedBuilding[]; models: ScatteredModel[] }): CellCost {
  const [cx, cz] = cell.key.split(',').map(Number) as [number, number];
  const neighbours = [...cell.specs];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue;
    neighbours.push(...(byCell.get(`${cx + dx},${cz + dz}`)?.specs ?? []));
  }
  const baker = new GeometryBaker();
  const group = new THREE.Group();
  const bakeStart = performance.now();
  for (const spec of cell.specs) {
    const one = new THREE.Group();
    architecture.retarget(one);
    const district = generatedDistrictAt(spec.x, spec.z);
    const variant = neighbourhoodBuildingVariant(district, spec.variant);
    const facadeIndex = neighbourhoodFacadeIndex(district, spec.style, spec.variant);
    const profile = architecture.build({
      x: 0, z: 0, width: spec.width, depth: spec.depth, height: spec.height, style: spec.style, variant,
      facade: material(`${spec.style}-${facadeIndex}`), roof: material('roof', 0x4a4f52), facadeTile: facadeWorldTile(facadeIndex),
    });
    if (spec.zone === 'residential') {
      const fence = planParcelFence(spec, { massing: profile.massing, entranceX: profile.entrance?.x, neighbours });
      // Fence panels are the cheap boxes City draws per segment/post — same count, same buckets.
      if (fence) {
        for (const segment of fence.segments) {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(segment.length, fence.height, 0.26), material(`fence-${fence.kind}`));
          mesh.position.set(segment.lx, 0, segment.lz);
          if (segment.along === 'z') mesh.rotation.y = Math.PI / 2;
          one.add(mesh);
        }
        for (const post of fence.posts) {
          const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.42, fence.height + 1, 0.42), material(`fence-post-${fence.kind}`));
          pillar.position.set(post.lx, 0, post.lz); one.add(pillar);
        }
      }
    }
    one.position.set(spec.x, 0, spec.z); one.rotation.y = spec.heading;
    baker.addObject(one);
    one.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  }
  let skipped = 0;
  for (const spec of cell.models) {
    let built;
    // Blender-authored trees need the runtime GLB library; headless they are simply absent, which
    // makes every number below an UNDERSTATEMENT of the real per-cell cost.
    try { built = buildModel(spec.name, spec.seed, { variant: spec.variant }); } catch { skipped++; continue; }
    built.group.position.set(spec.x, 0, spec.z); built.group.rotation.y = spec.heading;
    baker.addObject(built.group);
    built.group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  }
  skippedTotal += skipped;
  const bakeMs = performance.now() - bakeStart;
  const finalizeStart = performance.now();
  baker.finalize(group);
  const finalizeMs = performance.now() - finalizeStart;
  let triangles = 0;
  group.traverse((object) => { if (object instanceof THREE.Mesh) triangles += object.geometry.getAttribute('position').count / 3; });
  architecture.retarget(root);
  return { key: cell.key, items: cell.specs.length + cell.models.length, bakeMs, finalizeMs, merged: group, triangles };
}

const sampleCount = Number(process.argv[2] ?? 6);
const step = Math.max(1, Math.floor(cells.length / sampleCount));
const sample = [cells[0]!, ...cells.filter((_, index) => index > 0 && index % step === 0).slice(0, sampleCount - 1)];

console.log('\n=== A. building streamer: per-cell bake + the ONE unbudgeted merge ===');
console.log('cell         items    bake ms   finalize ms   drip frames @2ms   cadence @60fps');
const results: CellCost[] = [];
for (const cell of sample) {
  const cost = measureCell(cell);
  results.push(cost);
  const frames = Math.ceil(cost.bakeMs / 2);
  console.log(`${cost.key.padEnd(10)} ${String(cost.items).padStart(6)} ${cost.bakeMs.toFixed(0).padStart(9)} ${cost.finalizeMs.toFixed(1).padStart(13)} ${String(frames).padStart(18)} ${(frames / 60).toFixed(1).padStart(15)}s`);
}
console.log(`(skipped ${skippedTotal} asset-backed models: no GLB library headless — every cost here is an understatement)`);

// ---- B. the doorway streamer -------------------------------------------------------------------

/** A busy on-foot spot inside the densest sampled cell — where the owner would be running. */
const densest = results[0]!;
const [dcx, dcz] = densest.key.split(',').map(Number) as [number, number];
const spotX = dcx * CELL_SIZE + CELL_SIZE / 2;
const spotZ = dcz * CELL_SIZE + CELL_SIZE / 2;

console.log('\n=== B. doorway streamer: doorsNear() first-visit derivation ===');
const doorsStart = performance.now();
const firstDoors = doorsNear(spotX, spotZ, 190);
const doorsMs = performance.now() - doorsStart;
const warmStart = performance.now();
doorsNear(spotX, spotZ, 190);
const warmMs = performance.now() - warmStart;
console.log(`doorsNear(${spotX}, ${spotZ}, 190): cold ${doorsMs.toFixed(1)} ms -> ${firstDoors.length} doors; warm ${warmMs.toFixed(2)} ms`);

console.log('\n=== C. markerSurface(): ONE full-scene downward ray vs a real merged cell ===');
const scene = new THREE.Scene();
scene.add(densest.merged);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000, 64, 64), material('ground', 0x6d7a5a));
ground.rotation.x = -Math.PI / 2; scene.add(ground);
console.log(`scene: ${densest.triangles.toLocaleString()} merged triangles in cell ${densest.key} + a ground plane`);
const ray = new THREE.Raycaster();
ray.camera = new THREE.PerspectiveCamera();
const DOWN = new THREE.Vector3(0, -1, 0);
const probeAt = firstDoors.slice(0, 32);
let probeMs = 0;
const each: number[] = [];
const deltas: number[] = [];
for (const door of probeAt) {
  ray.set(new THREE.Vector3(door.x, 60, door.z), DOWN);
  const start = performance.now();
  const hits = ray.intersectObjects(scene.children, true);
  const took = performance.now() - start;
  each.push(took); probeMs += took;
  // What the ray BUYS over the analytic surface: the merged cell sits on terrainHeightAt-derived
  // bases here, so a hit far above terrain is the plinth/paving case the ray was written for.
  const top = hits.find((hit) => (hit.object as THREE.Mesh).isMesh && hit.point.y <= terrainHeightAt(door.x, door.z) + 1.2);
  if (top) deltas.push(top.point.y - terrainHeightAt(door.x, door.z));
}
deltas.sort((a, b) => a - b);
console.log(`ray-vs-terrain delta over ${deltas.length} doorsteps: min=${(deltas[0] ?? 0).toFixed(3)} median=${(deltas[Math.floor(deltas.length / 2)] ?? 0).toFixed(3)} max=${(deltas[deltas.length - 1] ?? 0).toFixed(3)}`);
console.log(`${probeAt.length} probes: ${probeMs.toFixed(1)} ms total, ${(probeMs / Math.max(1, probeAt.length)).toFixed(2)} ms each`);
console.log(`first=${each[0]!.toFixed(1)} ms, steady-state (probes 2..n) mean=${(each.slice(1).reduce((s, v) => s + v, 0) / Math.max(1, each.length - 1)).toFixed(2)} ms, max=${Math.max(...each.slice(1)).toFixed(1)} ms`);
const steady = each.slice(1).reduce((s, v) => s + v, 0) / Math.max(1, each.length - 1);

console.log('\n=== D. churn: NEW doors entering the nearest-32 set per 28 u sprint step ===');
const nearest32 = (x: number, z: number): string[] => doorsNear(x, z, 190)
  .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))
  .slice(0, 32).map((door) => door.id);
let previous = new Set(nearest32(spotX, spotZ));
const fresh: number[] = [];
for (let stepIndex = 1; stepIndex <= 12; stepIndex++) {
  const ids = nearest32(spotX + stepIndex * 28, spotZ);
  const set = new Set(ids);
  fresh.push(ids.filter((id) => !previous.has(id)).length);
  previous = set;
}
const meanFresh = fresh.reduce((sum, value) => sum + value, 0) / fresh.length;
console.log(`new doors per 28 u step: ${fresh.join(' ')}  (mean ${meanFresh.toFixed(1)}, max ${Math.max(...fresh)})`);
console.log(`=> a sprinting player pays ~${(meanFresh * steady).toFixed(0)} ms of probes every ${(28 / 13).toFixed(2)} s, plus a full 32-marker teardown/rebuild`);

// ---- E. before/after frame trace ---------------------------------------------------------------
//
// The same sprint down the same street under the two scheduling policies. Every door's probe is
// measured ONCE against the real merged geometry and reused, so both policies pay identical
// per-door costs and the ONLY difference is which frame pays them.

const SPRINT = 13; const FRAME = 1 / 60; const RUN_METRES = 400;
const SLACK = 28; const CAP = 32; const RANGE = 190; const FADE_FAR = 26;
const PROBE_RANGE = FADE_FAR + SLACK; const PROBE_BUDGET = 1;

const probeCost = new Map<string, number>();
const costOf = (door: { id: string; x: number; z: number }): number => {
  const known = probeCost.get(door.id);
  if (known !== undefined) return known;
  ray.set(new THREE.Vector3(door.x, 60, door.z), DOWN);
  const start = performance.now();
  ray.intersectObjects(scene.children, true);
  // Doors outside the one merged cell we hold in memory would price at ~0 and flatter both
  // policies equally; charge them the measured steady-state instead, which is what the game pays.
  const measured = Math.max(performance.now() - start, steady);
  probeCost.set(door.id, measured);
  return measured;
};

const nearestSet = (x: number, z: number): Array<{ id: string; x: number; z: number }> => doorsNear(x, z, RANGE)
  .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))
  .slice(0, CAP).map((door) => ({ id: door.id, x: door.x, z: door.z }));

interface Trace { frames: number[]; probes: number; }

function run(budgeted: boolean): Trace {
  const seated = new Set<string>(); // doors whose height is cached for the session
  let built: Array<{ id: string; x: number; z: number }> = [];
  let builtAt: { x: number; z: number } | undefined;
  const frames: number[] = [];
  let probes = 0;
  const total = Math.round(RUN_METRES / (SPRINT * FRAME));
  for (let frame = 0; frame < total; frame++) {
    const x = spotX + frame * SPRINT * FRAME; const z = spotZ;
    let budget = PROBE_BUDGET;
    let ms = 0;
    if (!builtAt || Math.hypot(x - builtAt.x, z - builtAt.z) > SLACK) {
      built = nearestSet(x, z); builtAt = { x, z };
      for (const door of built) {
        if (seated.has(door.id)) continue;
        if (budgeted && (budget <= 0 || Math.hypot(door.x - x, door.z - z) > PROBE_RANGE)) continue;
        if (budgeted) budget -= 1;
        ms += costOf(door); seated.add(door.id); probes++;
      }
    } else if (budgeted) {
      for (const door of built) {
        if (seated.has(door.id) || Math.hypot(door.x - x, door.z - z) > PROBE_RANGE) continue;
        if (budget <= 0) break;
        budget -= 1;
        ms += costOf(door); seated.add(door.id); probes++;
      }
    }
    frames.push(ms);
  }
  return { frames, probes };
}

const report = (label: string, trace: Trace): void => {
  const busy = trace.frames.filter((ms) => ms > 0);
  const over = (limit: number): number => trace.frames.filter((ms) => ms > limit).length;
  console.log(`${label.padEnd(9)} max=${Math.max(...trace.frames).toFixed(0).padStart(4)} ms  frames>30ms=${String(over(30)).padStart(3)}  frames>100ms=${String(over(100)).padStart(3)}  probes=${String(trace.probes).padStart(3)}  probing frames=${String(busy.length).padStart(3)}`);
};

console.log(`\n=== E. before/after: ${RUN_METRES} u straight sprint (${Math.round(RUN_METRES / (SPRINT * FRAME))} frames at 60fps) ===`);
const before = run(false);
const after = run(true);
report('BEFORE', before);
report('AFTER', after);
console.log(`worst frame: ${Math.max(...before.frames).toFixed(0)} ms -> ${Math.max(...after.frames).toFixed(0)} ms`);
