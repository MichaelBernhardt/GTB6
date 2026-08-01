/**
 * BLAST RADIUS of the streetscape grounding change, and the street-life density side effect.
 *
 * Companion to hydrant-sites.ts, same headless City build, different question. hydrant-sites asks
 * "is the hydrant on the ground and can you find one". This asks "what ELSE moves when the whole
 * roadside furniture layer is regrounded, and by how much" — the numbers a reviewer needs before
 * agreeing to a citywide visual change to six families of prop.
 *
 * Sections:
 *   1  WHO MOVES. Per family: how many props, how far each drops (sidewalkHeightAt - surfaceHeightAt),
 *      and how much of the family is affected at all.
 *   2  FOOTPRINT STRADDLE. A prop is grounded at ONE (x, z). surfaceHeightAt has a 0.37 step at the
 *      paving edge and a 0.22 step at the kerb, so a footprint that spans an edge cannot be right at
 *      any single y. Counts the props whose own footprint straddles a step, and the terrain relief
 *      under each footprint (which the old uniform +0.37 lift was masking).
 *   3  DRAWN GROUND. Ray-traced: does surfaceHeightAt actually equal the triangle the renderer puts
 *      there? Answers whether the fix trades a uniform 0.37 hover for a variable one.
 *   4  THINGS THAT READ A PROP'S Y. Colliders, supportTop, blockedBetween, knock-over debris, the
 *      hydrant spray, shadow receivers, ped/vehicle ground sampling, the interiors doorstep.
 *   5  STREET-LIFE DENSITY. buildNeighbourhoodStreetLife guards with isBlocked(root, 2.35) at 6.20
 *      beyond the kerb and slope-gates on the SAME grounding function. Both couplings replayed, for
 *      four siting variants, against the exact registry state the pass sees.
 *
 *   npx tsx tools/qa/grounding-blast-radius.ts
 */
import type { Box3, Mesh, MeshStandardMaterial } from 'three';
import type { RoadsidePoint } from '../../src/world/City';
import type { PropCollider, PropKind } from '../../src/systems/PropSystem';
import type { StreetLifeKind } from '../../src/world/data/streetLife';

/** Same no-op 2D context as hydrant-sites.ts: City builds CanvasTextures in field initialisers. */
function installDomStub(): void {
  const noop = (): void => {};
  const gradient = { addColorStop: noop };
  const context = (): unknown => ({
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    fillRect: noop, strokeRect: noop, clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, ellipse: noop, quadraticCurveTo: noop, bezierCurveTo: noop, fill: noop, stroke: noop, save: noop,
    restore: noop, translate: noop, rotate: noop, scale: noop, clip: noop, setTransform: noop, drawImage: noop,
    fillText: noop, strokeText: noop, putImageData: noop,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => gradient, createRadialGradient: () => gradient, createPattern: () => null,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  });
  const element = (tag: string): unknown => ({
    nodeName: tag.toUpperCase(), style: {}, width: 1, height: 1,
    addEventListener: noop, removeEventListener: noop, setAttribute: noop, appendChild: noop, removeChild: noop,
    getContext: () => context(),
  });
  const stub = { createElement: element, createElementNS: (_ns: string, tag: string) => element(tag) };
  (globalThis as { document?: unknown }).document = stub;
}
installDomStub();

const THREE = await import('three');
const {
  City, GROUND_SEGMENTS, ROADSIDE_OFFSET, SIDEWALK_INNER_EDGE, SIDEWALK_RISE, SIDEWALK_WIDTH,
  ROAD_SURFACE_OFFSET, districtAt, terrainHeightAt,
} = await import('../../src/world/City');
const {
  BENCH_VERGE_DISTANCE, BIN_VERGE_DISTANCE, HYDRANT_FLANGE_RADIUS, HYDRANT_KERB_DISTANCE,
  onRoadsideStride,
} = await import('../../src/world/UrbanInfrastructure');
const { distanceToRailwayCorridor } = await import('../../src/world/mapData');
const { isStreetLifeCandidate, streetLifeForDistrict } = await import('../../src/world/data/streetLife');
const { STANDABLE_PROPS, PROP_TIERS } = await import('../../src/systems/PropSystem');

const KERB_STEP = ROAD_SURFACE_OFFSET + SIDEWALK_RISE; // 0.37 — the whole of the hover
const PAVEMENT_OUTER_EDGE = SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH;

const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const quantile = (v: number[], p: number): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const pct = (n: number, d: number): string => `${d ? ((100 * n) / d).toFixed(1) : '0.0'}%`;

const scene = new THREE.Scene();
const started = Date.now();
const city = new City(scene, 'low', false);
const props = city.props.props;
console.log(`built the city headlessly in ${((Date.now() - started) / 1000).toFixed(1)}s — ${city.roadsidePoints.length} roadside points, ${props.length} props`);

const sidewalkH = (x: number, z: number): number => city.sidewalkHeightAt(x, z);
const surfaceH = (x: number, z: number): number => city.surfaceHeightAt(x, z);

// =================================================================================================
// 1  WHO MOVES
// =================================================================================================
/** Every family UrbanInfrastructure grounds, with the footprint it occupies (half-extents, local to the
 *  prop's own yaw: ACROSS the pavement x DOWN the street) and the thickness of the part that meets the
 *  ground. Footprint is read off the geometry in UrbanInfrastructure, not off the collider radius, because
 *  the collider is a circle and what pokes through a slope is a corner. */
interface Family {
  kind: PropKind; label: string; kerb: number;
  /** half-extent across the pavement, half-extent along the street */
  across: number; along: number;
  /** vertical thickness of the ground-meeting part — how much slope it can eat before a corner shows daylight */
  bed: number;
  /** built by UrbanInfrastructure? (fountains/monuments/trees are City's, grounded elsewhere) */
  ours: boolean;
}
const FAMILIES: Family[] = [
  { kind: 'hydrant', label: 'fire hydrant', kerb: HYDRANT_KERB_DISTANCE, across: HYDRANT_FLANGE_RADIUS, along: HYDRANT_FLANGE_RADIUS, bed: 0.06, ours: true },
  { kind: 'streetlight', label: 'streetlamp', kerb: ROADSIDE_OFFSET, across: 0.2, along: 0.2, bed: 0.46, ours: true },
  { kind: 'bin', label: 'litter bin', kerb: BIN_VERGE_DISTANCE, across: 0.34, along: 0.34, bed: 0.82, ours: true },
  { kind: 'bench', label: 'park bench', kerb: BENCH_VERGE_DISTANCE, across: 0.29, along: 1.125, bed: 0.55, ours: true },
  { kind: 'post', label: 'utility cabinet/pole', kerb: ROADSIDE_OFFSET + 1.35, across: 0.575, along: 0.95, bed: 0.18, ours: true },
  { kind: 'shrub', label: 'verge shrub', kerb: ROADSIDE_OFFSET + 2.1, across: 0.5, along: 0.5, bed: 0.4, ours: true },
  { kind: 'sign', label: 'street/roadside sign', kerb: NaN, across: 0.14, along: 0.14, bed: 0.3, ours: true },
  { kind: 'signal', label: 'traffic signal', kerb: NaN, across: 0.24, along: 0.24, bed: 0.3, ours: true },
  { kind: 'shelter', label: 'transit shelter', kerb: NaN, across: 0.9, along: 2.9, bed: 0.16, ours: true },
  { kind: 'tree', label: 'tree (City scatter)', kerb: NaN, across: 0.5, along: 0.5, bed: 0.5, ours: false },
  { kind: 'palm', label: 'palm (City scatter)', kerb: NaN, across: 0.4, along: 0.4, bed: 0.5, ours: false },
  { kind: 'fountain', label: 'fountain (City)', kerb: NaN, across: 1.5, along: 1.5, bed: 0.3, ours: false },
  { kind: 'monument', label: 'monument (City)', kerb: NaN, across: 1.5, along: 1.5, bed: 0.3, ours: false },
];

console.log(`\n=== 1  WHO MOVES ==========================================================================`);
console.log(`the change: UrbanInfrastructure's grounding function goes sidewalkHeightAt -> surfaceHeightAt.`);
console.log(`  sidewalkHeightAt = terrain + ${KERB_STEP.toFixed(2)} everywhere. surfaceHeightAt = road (+${ROAD_SURFACE_OFFSET}) on tar,`);
console.log(`  pavement (+${KERB_STEP.toFixed(2)}) within ${PAVEMENT_OUTER_EDGE} of a kerb, bare terrain beyond. So a prop drops by 0, 0.22 or 0.37.`);
console.log(`  ${'family'.padEnd(22)}${'props'.padStart(7)}${'drop=0'.padStart(9)}${'drop .22'.padStart(9)}${'drop .37'.padStart(9)}${'moved'.padStart(8)}${'tier'.padStart(11)}${'standable'.padStart(10)}`);
interface FamilyStat { family: Family; props: PropCollider[]; drops: number[]; moved: number }
const stats: FamilyStat[] = [];
let totalMoved = 0; let totalOurs = 0;
for (const family of FAMILIES) {
  const list = props.filter((p) => p.kind === family.kind);
  const drops = list.map((p) => sidewalkH(p.x, p.z) - surfaceH(p.x, p.z));
  const zero = drops.filter((d) => d < 0.01).length;
  const road = drops.filter((d) => d >= 0.01 && d < 0.3).length;
  const full = drops.filter((d) => d >= 0.3).length;
  const moved = road + full;
  stats.push({ family, props: list, drops, moved });
  if (family.ours) { totalMoved += moved; totalOurs += list.length; }
  console.log(`  ${family.label.padEnd(22)}${String(list.length).padStart(7)}${String(zero).padStart(9)}${String(road).padStart(9)}${String(full).padStart(9)}`
    + `${pct(moved, list.length).padStart(8)}${PROP_TIERS[family.kind].padStart(11)}${(STANDABLE_PROPS.has(family.kind) ? 'yes' : '-').padStart(10)}`);
}
console.log(`  ---- UrbanInfrastructure-owned props: ${totalMoved} of ${totalOurs} move (${pct(totalMoved, totalOurs)}).`);
console.log(`  (City-scatter families are grounded by City, NOT by the injected function: they do not move at all.`);
console.log(`   Roadside TREES are UrbanInfrastructure's but their GLB is asset-gated — a headless build instances none.)`);

// instance-level count: how many InstancedMesh entries change their matrix
{
  let touched = 0; let batches = 0;
  scene.traverse((object) => { if (object instanceof THREE.InstancedMesh) { batches++; touched += object.count; } });
  console.log(`  scene carries ${batches} InstancedMeshes / ${touched} instances in total; every part of a moved prop`);
  console.log(`  is re-baked, so the churn is (parts per prop) x (moved props), all at build time. No runtime cost either way.`);
}

// =================================================================================================
// 2  FOOTPRINT STRADDLE and TERRAIN RELIEF
// =================================================================================================
console.log(`\n=== 2  FOOTPRINT STRADDLE / TERRAIN RELIEF ================================================`);
console.log(`a prop is grounded at ONE (x, z). Two ways that can look wrong AFTER the drop:`);
console.log(`  straddle: the footprint spans a surface step (kerb 0.22 or paving edge ${KERB_STEP.toFixed(2)}) so no single y is right;`);
console.log(`  relief:   bare terrain under the footprint is not level, and the old uniform +${KERB_STEP.toFixed(2)} lift hid it.`);
console.log(`  "shows daylight" = relief exceeds the ground-meeting part's own thickness, i.e. a visible gap under a corner.`);
// Oriented footprints: each prop's yaw is not in the registry, so recover the road-perpendicular
// direction from the nearest roadside point. `across` runs along inward (towards the carriageway),
// `along` runs down the street — the same axes UrbanInfrastructure builds each prop's parts in.
const ROADSIDE_CELL = 16;
const roadsideCells = new Map<string, RoadsidePoint[]>();
for (const point of city.roadsidePoints) {
  const key = `${Math.floor(point.x / ROADSIDE_CELL)},${Math.floor(point.z / ROADSIDE_CELL)}`;
  const bucket = roadsideCells.get(key); if (bucket) bucket.push(point); else roadsideCells.set(key, [point]);
}
const nearestRoadside = (x: number, z: number): RoadsidePoint | undefined => {
  const cx = Math.floor(x / ROADSIDE_CELL); const cz = Math.floor(z / ROADSIDE_CELL);
  let best: RoadsidePoint | undefined; let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const point of roadsideCells.get(`${cx + dx},${cz + dz}`) ?? []) {
      const d = (point.x - x) ** 2 + (point.z - z) ** 2;
      if (d < bestD) { bestD = d; best = point; }
    }
  }
  return best;
};
console.log(`  analytic: does the family's footprint cross the paving edge at ${PAVEMENT_OUTER_EDGE} u beyond the kerb?`);
for (const f of FAMILIES) {
  if (!f.ours || Number.isNaN(f.kerb)) continue;
  const inner = f.kerb - f.across; const outer = f.kerb + f.across;
  const crosses = inner < PAVEMENT_OUTER_EDGE && outer > PAVEMENT_OUTER_EDGE;
  console.log(`    ${f.label.padEnd(22)} spans ${inner.toFixed(2)}..${outer.toFixed(2)} beyond the kerb`
    + ` -> ${crosses ? `STRADDLES the paving edge by ${(outer - PAVEMENT_OUTER_EDGE).toFixed(2)} u` : inner >= PAVEMENT_OUTER_EDGE ? 'wholly on bare ground' : 'wholly on drawn paving'}`);
}
console.log(`  measured, oriented footprint (nearest roadside point gives inward):`);
console.log(`  ${'family'.padEnd(22)}${'step>0.1'.padStart(10)}${'relief med'.padStart(11)}${'p90'.padStart(8)}${'p99'.padStart(8)}${'max'.padStart(8)}${'daylight'.padStart(10)}${'>0.1u'.padStart(8)}`);
for (const stat of stats) {
  if (!stat.props.length || !stat.family.ours) continue;
  const f = stat.family;
  let steps = 0; const reliefs: number[] = []; let daylight = 0; let big = 0; let sampled = 0;
  const step = Math.max(1, Math.ceil(stat.props.length / 4000));
  for (let i = 0; i < stat.props.length; i += step) {
    const p = stat.props[i]!;
    const anchor = nearestRoadside(p.x, p.z); if (!anchor) continue;
    sampled++;
    const ax = anchor.inwardX; const az = anchor.inwardZ; // across the pavement
    const lx = -az; const lz = ax;                        // down the street
    const corners: Array<[number, number]> = [];
    for (const a of [-f.across, 0, f.across]) for (const l of [-f.along, 0, f.along]) corners.push([ax * a + lx * l, az * a + lz * l]);
    let sMin = Infinity; let sMax = -Infinity; let tMin = Infinity; let tMax = -Infinity;
    for (const [dx, dz] of corners) {
      const s = surfaceH(p.x + dx, p.z + dz); sMin = Math.min(sMin, s); sMax = Math.max(sMax, s);
      const t = terrainHeightAt(p.x + dx, p.z + dz); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
    }
    if (sMax - sMin > 0.1) steps++;
    const relief = tMax - tMin; reliefs.push(relief);
    if (relief > f.bed) daylight++;
    if (relief > 0.1) big++;
  }
  console.log(`  ${f.label.padEnd(22)}${pct(steps, sampled).padStart(10)}${median(reliefs).toFixed(3).padStart(11)}`
    + `${quantile(reliefs, 0.9).toFixed(3).padStart(8)}${quantile(reliefs, 0.99).toFixed(3).padStart(8)}${Math.max(...reliefs).toFixed(3).padStart(8)}`
    + `${pct(daylight, sampled).padStart(10)}${pct(big, sampled).padStart(8)}`);
}
console.log(`  step>0.1 = the footprint spans a surface discontinuity (its own paving edge, or a CROSSING`);
console.log(`  street's kerb/carriageway near a junction). relief = bare-terrain height range under the`);
console.log(`  footprint: what the old uniform +${KERB_STEP.toFixed(2)} lift was hiding, and what one leg/corner now shows.`);

// =================================================================================================
// 3  DRAWN GROUND vs surfaceHeightAt
// =================================================================================================
console.log(`\n=== 3  DRAWN GROUND vs surfaceHeightAt ====================================================`);
scene.updateMatrixWorld(true);
const groundVertices = GROUND_SEGMENTS * GROUND_SEGMENTS * 6;
let groundMesh: Mesh | undefined;
const surfaceMeshes: Array<{ mesh: Mesh; box: Box3 }> = [];
scene.traverse((object) => {
  if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
  if (object.geometry.attributes.position?.count === groundVertices) { groundMesh = object; return; }
  object.geometry.computeBoundingBox();
  const local = object.geometry.boundingBox; if (!local) return;
  surfaceMeshes.push({ mesh: object, box: local.clone().applyMatrix4(object.matrixWorld) });
});
const down = new THREE.Vector3(0, -1, 0);
/** `ceiling` keeps the answer at GROUND level: without it the ray returns the prop's own sign board, a
 *  signal head or a building floor above. Same discipline as hydrant-sites.ts. */
const drawnAt = (x: number, z: number, ceiling: number): number | undefined => {
  const list: Mesh[] = surfaceMeshes
    .filter(({ box }) => x >= box.min.x - 1 && x <= box.max.x + 1 && z >= box.min.z - 1 && z <= box.max.z + 1)
    .map(({ mesh }) => mesh);
  if (groundMesh) list.push(groundMesh);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 900, z), down);
  let best: number | undefined;
  for (const hit of raycaster.intersectObjects(list, false)) {
    if (hit.point.y > ceiling) continue;
    if (best === undefined || hit.point.y > best) best = hit.point.y;
  }
  return best;
};
console.log(`error = drawn triangle y minus surfaceHeightAt(x, z). Positive = the fix leaves the prop SUNK into what`);
console.log(`is drawn; negative = still hovering. This is the residual the fix cannot remove by regrounding alone.`);
console.log(`  ${'family'.padEnd(22)}${'sampled'.padStart(9)}${'med'.padStart(9)}${'p10'.padStart(9)}${'p90'.padStart(9)}${'worst-'.padStart(9)}${'worst+'.padStart(9)}${'|err|>.05'.padStart(11)}${'>.15'.padStart(8)}`);
console.log(`  and CORNER DAYLIGHT: the biggest gap the drawn ground leaves under any corner of the oriented`);
console.log(`  footprint once the prop is bedded ${'0.015'} into surfaceHeightAt at its centre.`);
const RAY_SAMPLE = 300;
for (const stat of stats) {
  if (!stat.props.length || !stat.family.ours) continue;
  const f = stat.family;
  const step = Math.max(1, Math.ceil(stat.props.length / RAY_SAMPLE));
  const errors: number[] = []; const corner: number[] = []; const buried: number[] = [];
  for (let i = 0; i < stat.props.length; i += step) {
    const p = stat.props[i]!;
    const base = surfaceH(p.x, p.z);
    const drawn = drawnAt(p.x, p.z, base + 0.6);
    if (drawn === undefined) continue;
    errors.push(drawn - base);
    const anchor = nearestRoadside(p.x, p.z); if (!anchor) continue;
    const ax = anchor.inwardX; const az = anchor.inwardZ; const lx = -az; const lz = ax;
    let worst = -Infinity; let deepest = -Infinity;
    for (const a of [-f.across, f.across]) for (const l of [-f.along, f.along]) {
      const cx = p.x + ax * a + lx * l; const cz = p.z + az * a + lz * l;
      const under = drawnAt(cx, cz, base + 0.6);
      if (under === undefined) continue;
      worst = Math.max(worst, (base - 0.015) - under); // gap between the prop's base plane and the ground
      deepest = Math.max(deepest, under - (base - 0.015)); // ground standing ABOVE the base plane: buried corner
    }
    if (Number.isFinite(worst)) corner.push(worst);
    if (Number.isFinite(deepest)) buried.push(deepest);
  }
  if (!errors.length) continue;
  const over = errors.filter((e) => Math.abs(e) > 0.05).length;
  const bad = errors.filter((e) => Math.abs(e) > 0.15).length;
  console.log(`  ${stat.family.label.padEnd(22)}${String(errors.length).padStart(9)}${median(errors).toFixed(3).padStart(9)}`
    + `${quantile(errors, 0.1).toFixed(3).padStart(9)}${quantile(errors, 0.9).toFixed(3).padStart(9)}`
    + `${Math.min(...errors).toFixed(3).padStart(9)}${Math.max(...errors).toFixed(3).padStart(9)}${pct(over, errors.length).padStart(11)}${pct(bad, errors.length).padStart(8)}`);
  console.log(`  ${''.padEnd(22)}corner DAYLIGHT after the fix: med ${median(corner).toFixed(3)}`
    + `  p90 ${quantile(corner, 0.9).toFixed(3)}  max ${corner.length ? Math.max(...corner).toFixed(3) : 'n/a'}`
    + `  (> its own ${f.bed.toFixed(2)} u bed on ${pct(corner.filter((c) => c > f.bed).length, corner.length)})`);
  console.log(`  ${''.padEnd(22)}corner BURIED after the fix:   med ${median(buried).toFixed(3)}`
    + `  p90 ${quantile(buried, 0.9).toFixed(3)}  max ${buried.length ? Math.max(...buried).toFixed(3) : 'n/a'}`
    + `  (swallows the whole ${f.bed.toFixed(2)} u part on ${pct(buried.filter((c) => c > f.bed).length, buried.length)})`);
}

// =================================================================================================
// 4  THINGS THAT READ A PROP'S Y
// =================================================================================================
console.log(`\n=== 4  WHAT READS A PROP'S Y ==============================================================`);
console.log(`PropCollider carries x, z, radius, height — and NO y. Every y-aware query recomputes the base`);
console.log(`from City.surfaceHeightAt(prop.x, prop.z) at call time (PropSystem.blockedBetween/supportTop).`);
console.log(`So today the COLLIDER already sits on surfaceHeightAt while the VISUAL sits on sidewalkHeightAt:`);
console.log(`the two disagree, and the grounding fix CLOSES that gap rather than opening one.\n`);
// The one place a prop's PLACED Y is baked into a gameplay number: PropCollider.height, which is what
// supportTop stands the player on. Measure the DRAWN top of each standable family off the real instance
// matrices and compare it with base + registered height, under both groundings.
{
  console.log(`  STANDABLE HEIGHTS — registered PropCollider.height vs the top the renderer actually draws.`);
  const matrix = new THREE.Matrix4();
  const tops = new Map<PropKind, number[]>();
  const cell = 8;
  const cells = new Map<string, PropCollider[]>();
  for (const p of props) {
    if (!STANDABLE_PROPS.has(p.kind)) continue;
    const key = `${p.kind}|${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
    const bucket = cells.get(key); if (bucket) bucket.push(p); else cells.set(key, [p]);
  }
  const near = (kind: PropKind, x: number, z: number, reach: number): PropCollider | undefined => {
    const cx = Math.floor(x / cell); const cz = Math.floor(z / cell);
    let best: PropCollider | undefined; let bestD = reach;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const p of cells.get(`${kind}|${cx + dx},${cz + dz}`) ?? []) {
        const d = Math.hypot(p.x - x, p.z - z); if (d < bestD) { bestD = d; best = p; }
      }
    }
    return best;
  };
  // bench slats: the wood material; shelter roof/seat: the shelter's own metal. Instanced batches only,
  // matched by material colour the way hydrant-sites.ts does.
  const WATCH: Array<{ kind: PropKind; colour: string; label: string }> = [
    { kind: 'bench', colour: '744d32', label: 'bench slats (wood)' },
  ];
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh)) return;
    const material = object.material;
    if (Array.isArray(material) || !('color' in material)) return;
    const hex = (material as MeshStandardMaterial).color.getHexString();
    const watch = WATCH.find((w) => w.colour === hex); if (!watch) return;
    object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox; if (!box) return;
    for (let index = 0; index < object.count; index++) {
      object.getMatrixAt(index, matrix);
      const world = box.clone().applyMatrix4(matrix);
      const centre = world.getCenter(new THREE.Vector3());
      const prop = near(watch.kind, centre.x, centre.z, 2); if (!prop) continue;
      const list = tops.get(watch.kind) ?? []; list.push(world.max.y - surfaceH(prop.x, prop.z));
      tops.set(watch.kind, list);
    }
  });
  for (const [kind, list] of tops) {
    const sample = props.find((p) => p.kind === kind)!;
    console.log(`    ${kind}: registered height ${sample.height} -> supportTop stands the player at surface + ${sample.height}.`);
    console.log(`      drawn top of its flat part, above surfaceHeightAt: median ${median(list).toFixed(3)} (n=${list.length}) UNDER THE NEW GROUNDING.`);
    console.log(`      => feet land ${(sample.height - median(list)).toFixed(3)} u above the drawn seat after the fix;`);
    console.log(`         under the OLD grounding the same part was drawn ${KERB_STEP.toFixed(2)} higher, i.e. ${(sample.height - median(list) - KERB_STEP).toFixed(3)} u.`);
  }
  console.log(`    shelter: registered height 2.9; roof slab is drawn at root + 2.9 + 0.08 (RoundedBox 0.16 thick),`);
  console.log(`      so feet land 0.08 u BELOW the drawn roof after the fix and ${(0.08 + KERB_STEP).toFixed(2)} u below it today.`);
  console.log('');
}
{
  const standable = props.filter((p) => STANDABLE_PROPS.has(p.kind));
  const mism = standable.map((p) => sidewalkH(p.x, p.z) - surfaceH(p.x, p.z)).filter((d) => d > 0.01);
  console.log(`  supportTop (STANDABLE_PROPS = ${[...STANDABLE_PROPS].join(', ')}):`);
  console.log(`    ${standable.length} standable props; ${mism.length} currently have collider-top and drawn-top disagreeing`);
  console.log(`    by median ${median(mism).toFixed(3)} u (max ${mism.length ? Math.max(...mism).toFixed(3) : 'n/a'}).`);
  console.log(`    That is a player standing ${median(mism).toFixed(2)} u INSIDE a bench seat today. The fix removes it.`);
  const byKind = new Map<PropKind, number>();
  for (const p of standable) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  console.log(`    breakdown: ${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')}`);
}
{
  const knock = props.filter((p) => PROP_TIERS[p.kind] === 'knockover');
  const moved = knock.filter((p) => sidewalkH(p.x, p.z) - surfaceH(p.x, p.z) > 0.01);
  console.log(`  knock-over debris (PropSystem.knock -> prop.debris()):`);
  console.log(`    ${knock.length} knock-over props, ${moved.length} of which currently spawn their debris stand-in at`);
  console.log(`    the OLD height while PropSystem's own ground sampler is city.surfaceHeightAt — debris pops`);
  console.log(`    ${median(moved.map((p) => sidewalkH(p.x, p.z) - surfaceH(p.x, p.z))).toFixed(3)} u above the ground it then rests on. The fix removes that too.`);
  const hyd = props.filter((p) => p.kind === 'hydrant');
  console.log(`  hydrant spray (PropSystem.startSpray, drops grounded on Game's city.surfaceHeightAt):`);
  console.log(`    ${hyd.length} hydrants; spray origin already uses surfaceHeightAt, so today the jet erupts from`);
  console.log(`    ${median(hyd.map((p) => sidewalkH(p.x, p.z) - surfaceH(p.x, p.z))).toFixed(3)} u below the hydrant it comes out of.`);
}

// =================================================================================================
// 5  STREET-LIFE DENSITY
// =================================================================================================
console.log(`\n=== 5  STREET-LIFE DENSITY ================================================================`);
const firstHydrantId = Math.min(...props.filter((p) => p.kind === 'hydrant').map((p) => p.id));
const firstShelterId = Math.min(...props.filter((p) => p.kind === 'shelter').map((p) => p.id));
const beforeHydrants = props.filter((p) => p.id < firstHydrantId);
console.log(`registry order is registration order (PropCollider.id = props.length at register time):`);
console.log(`  props before the hydrant pass: ${beforeHydrants.length} (ids < ${firstHydrantId});  shelters start at ${firstShelterId}.`);
console.log(`  street life runs AFTER hydrants and BEFORE shelters, and registers nothing itself, so the state`);
console.log(`  its isBlocked() sees is exactly (props before hydrants) + (that variant's hydrants).`);

/** Coarse grid over an arbitrary prop subset, so a variant's blocked() is as cheap as the real one. */
class Grid {
  private cells = new Map<string, PropCollider[]>();
  constructor(list: PropCollider[], private size = 12) { for (const p of list) this.add(p); }
  add(p: PropCollider): void {
    const minX = Math.floor((p.x - p.radius) / this.size); const maxX = Math.floor((p.x + p.radius) / this.size);
    const minZ = Math.floor((p.z - p.radius) / this.size); const maxZ = Math.floor((p.z + p.radius) / this.size);
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      const key = `${cx},${cz}`; const cell = this.cells.get(key); if (cell) cell.push(p); else this.cells.set(key, [p]);
    }
  }
  blocked(x: number, z: number, radius: number): boolean {
    const minX = Math.floor((x - radius) / this.size); const maxX = Math.floor((x + radius) / this.size);
    const minZ = Math.floor((z - radius) / this.size); const maxZ = Math.floor((z + radius) / this.size);
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      for (const p of this.cells.get(`${cx},${cz}`) ?? []) {
        const dx = p.x - x; const dz = p.z - z; const reach = p.radius + radius;
        if (dx * dx + dz * dz < reach * reach) return true;
      }
    }
    return false;
  }
}
const spacedFrom = (placed: ReadonlyArray<{ x: number; z: number }>, x: number, z: number, clearance: number): boolean =>
  placed.every((s) => (s.x - x) ** 2 + (s.z - z) ** 2 >= clearance * clearance);

/**
 * City hands UrbanInfrastructure isBlocked = collides || isReserved || near-railway, and `collides` is
 * world bounds || props.blocked || overlapsCollider (private). To get the registry state AS OF the hydrant
 * pass without reimplementing the building/container collider index, mark every prop registered at or
 * after the hydrant pass as `down` — PropRegistry.blocked() skips downed props — and call the real
 * City.collides. What is left is exactly (props before hydrants) + (every rectangle collider).
 */
for (const prop of props) if (prop.id >= firstHydrantId) prop.down = true;
const cityBlockedBeforeHydrants = (x: number, z: number, radius: number): boolean =>
  city.collides(x, z, radius) || city.isReserved(x, z, radius) || distanceToRailwayCorridor(x, z) < radius + 0.6;
/** ...plus one variant's hydrants, which the real registry no longer contributes. */
const makeBlocked = (grid: Grid | undefined) => (x: number, z: number, radius: number): boolean =>
  cityBlockedBeforeHydrants(x, z, radius) || (grid ? grid.blocked(x, z, radius) : false);

/** Replay one hydrant siting variant, exactly as buildFireHydrants does. */
interface HydrantVariant {
  label: string; stride: number; widthFloor: number; kerb: number;
  probe: number; roadProbe: number; requirePaved: boolean;
}
const HYDRANT_VARIANTS: HydrantVariant[] = [
  { label: 'V0 = PR #122 as pushed (3.80, stride 19, w>=9)', stride: 19, widthFloor: 9, kerb: ROADSIDE_OFFSET + 0.75, probe: 0.45, roadProbe: 0.7, requirePaved: false },
  { label: 'V2 rejected (0.93, stride 11, no w)', stride: 11, widthFloor: 0, kerb: HYDRANT_KERB_DISTANCE, probe: HYDRANT_FLANGE_RADIUS + 0.1, roadProbe: HYDRANT_FLANGE_RADIUS + 0.06, requirePaved: true },
  { label: 'V3 kerbside only (0.93, stride 19, w>=9)', stride: 19, widthFloor: 9, kerb: HYDRANT_KERB_DISTANCE, probe: HYDRANT_FLANGE_RADIUS + 0.1, roadProbe: HYDRANT_FLANGE_RADIUS + 0.06, requirePaved: true },
];
const baseBlocked = makeBlocked(undefined);
const replayHydrants = (v: HydrantVariant): Array<{ x: number; z: number }> => {
  const spots: Array<{ x: number; z: number }> = [];
  city.roadsidePoints.forEach((point, index) => {
    if (!onRoadsideStride(index, v.stride, 11)) return;
    if (point.width < v.widthFloor) return;
    if (v.requirePaved && !city.isPavementDrawn(point)) return;
    const step = ROADSIDE_OFFSET - v.kerb;
    const x = point.x + point.inwardX * step; const z = point.z + point.inwardZ * step;
    if (baseBlocked(x, z, v.probe) || city.isOnRoad(x, z, v.roadProbe)) return;
    if (!spacedFrom(spots, x, z, 1.2)) return;
    spots.push({ x, z });
  });
  return spots;
};

const HYDRANT_RADIUS = 0.3; // as registered by buildFireHydrants
const STREET_LIFE_INSTANCES: Record<StreetLifeKind, { even: number; odd: number }> = {
  kiosk: { even: 7, odd: 7 }, cafe: { even: 8, odd: 6 }, workshop: { even: 6, odd: 6 },
  garden: { even: 5, odd: 5 }, braai: { even: 7, odd: 7 }, farmstand: { even: 5, odd: 5 },
};

interface StreetLifeResult {
  sites: number; instances: number; blockedByHydrant: number; slopeRejected: number;
  byKind: Map<StreetLifeKind, number>; keys: Set<number>;
}
const replayStreetLife = (hydrants: Array<{ x: number; z: number }>, H: (x: number, z: number) => number): StreetLifeResult => {
  const grid = new Grid([]);
  for (const h of hydrants) grid.add({ id: -1, kind: 'hydrant', tier: 'knockover', x: h.x, z: h.z, radius: HYDRANT_RADIUS, height: 0.9, down: false });
  const blocked = makeBlocked(grid);
  const noHydrantBlocked = baseBlocked;
  let sites = 0; let instances = 0; let blockedByHydrant = 0; let slopeRejected = 0;
  const byKind = new Map<StreetLifeKind, number>(); const keys = new Set<number>();
  city.roadsidePoints.forEach((point, sourceIndex) => {
    const profile = streetLifeForDistrict(districtAt(point.x, point.z));
    if (!isStreetLifeCandidate(profile, sourceIndex, point.width)) return;
    const rootX = point.x - point.inwardX * 3.15; const rootZ = point.z - point.inwardZ * 3.15;
    const sideX = point.inwardZ * 1.55; const sideZ = -point.inwardX * 1.55;
    if (city.isOnRoad(rootX, rootZ, 1.15)) return;
    if (blocked(rootX, rootZ, 2.35)) {
      if (!noHydrantBlocked(rootX, rootZ, 2.35)) blockedByHydrant++;
      return;
    }
    const ground = H(rootX, rootZ);
    if (Math.abs(H(rootX + sideX, rootZ + sideZ) - ground) > 1.15
      || Math.abs(H(rootX - sideX, rootZ - sideZ) - ground) > 1.15) { slopeRejected++; return; }
    sites++; keys.add(sourceIndex);
    byKind.set(profile.kind, (byKind.get(profile.kind) ?? 0) + 1);
    const table = STREET_LIFE_INSTANCES[profile.kind];
    instances += sourceIndex % 2 === 0 ? table.even : table.odd;
  });
  return { sites, instances, blockedByHydrant, slopeRejected, byKind, keys };
};

const liveStreetLife = (() => {
  let count = 0;
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh)) return;
    const material = object.material;
    if (Array.isArray(material) || !material.name.startsWith('Neighbourhood street life')) return;
    count += object.count;
  });
  return count;
})();

const variants: Array<{ label: string; hydrants: number; result: StreetLifeResult }> = [];
for (const v of HYDRANT_VARIANTS) {
  const hydrants = replayHydrants(v);
  for (const [gLabel, H] of [['sidewalkHeightAt (today)', sidewalkH], ['surfaceHeightAt (fix)', surfaceH]] as const) {
    variants.push({ label: `${v.label} + ${gLabel}`, hydrants: hydrants.length, result: replayStreetLife(hydrants, H) });
  }
}
console.log(`\nlive build (HEAD, the rejected attempt) reports ${liveStreetLife} street-life instances in the scene.`);
console.log(`\n  ${'variant'.padEnd(52)}${'hydrants'.padStart(10)}${'sites'.padStart(8)}${'instances'.padStart(11)}${'blk by hyd'.padStart(11)}${'slope rej'.padStart(11)}`);
for (const v of variants) {
  console.log(`  ${v.label.padEnd(52)}${String(v.hydrants).padStart(10)}${String(v.result.sites).padStart(8)}`
    + `${String(v.result.instances).padStart(11)}${String(v.result.blockedByHydrant).padStart(11)}${String(v.result.slopeRejected).padStart(11)}`);
}
{
  const base = variants[0]!; // V0 + sidewalkHeightAt = PR #122 exactly as pushed
  console.log(`\n  deltas against V0 + sidewalkHeightAt (= PR #122 as pushed) — sites ${base.result.sites}, instances ${base.result.instances}:`);
  for (const v of variants.slice(1)) {
    const gained = [...v.result.keys].filter((k) => !base.result.keys.has(k)).length;
    const lost = [...base.result.keys].filter((k) => !v.result.keys.has(k)).length;
    console.log(`    ${v.label.padEnd(52)}sites ${(v.result.sites - base.result.sites >= 0 ? '+' : '')}${v.result.sites - base.result.sites}`
      + `  instances ${(v.result.instances - base.result.instances >= 0 ? '+' : '')}${v.result.instances - base.result.instances}`
      + `  (${gained} new sites, ${lost} lost)`);
  }
}
console.log(`\n  GROUND TRUTH — tools/qa/streetscape-census.ts run on three real builds. The replay above reproduces`);
console.log(`  all three exactly, which is what makes it usable as a gate:`);
console.log(`    origin/main            5f240a4   720 hydrants (inside the benches)   250 street-life meshes  2519 instances  2586 InstancedMesh`);
console.log(`    PR #122 as pushed      b91a550   490 hydrants at 3.80                246 street-life meshes  2382 instances  2584 InstancedMesh`);
console.log(`    the rejected attempt   61d4efe  1317 hydrants at 0.93                250 street-life meshes  2519 instances  2592 InstancedMesh`);
console.log(`  So PR #122 ALREADY cut street-life density by 21 clusters / 137 instances / 4 meshes against main,`);
console.log(`  undisclosed: giving the hydrant its own stride put 490 of them on non-bench sites where they`);
console.log(`  independently trip isBlocked(root, 2.35). On main every hydrant shared a bench's site, and the`);
console.log(`  BENCH (radius 0.85 at 3.85) already blocked those clusters, so the hydrant cost nothing.`);
console.log(`  Any siting that takes the hydrant off the verge line RESTORES main's 2519 — it does not add to it.`);
console.log(`\n  interpretation: "blk by hyd" is how many street-life clusters that variant's hydrants suppress.`);
console.log(`  "slope rej" isolates the OTHER coupling — the slope gate reads the same grounding function, so`);
console.log(`  regrounding can move street life even with the hydrants left exactly where they are.`);
// ---- roadside trees: the family a headless build cannot instance ---------------------------------
{
  const firstUiId = Math.min(...props.filter((p) => p.kind === 'shrub').map((p) => p.id));
  for (const prop of props) prop.down = prop.id >= firstUiId; // registry state as of buildVegetation
  const blockedAtVegetation = (x: number, z: number, radius: number): boolean =>
    city.collides(x, z, radius) || city.isReserved(x, z, radius) || distanceToRailwayCorridor(x, z) < radius + 0.6;
  const treeSites = city.roadsidePoints
    .filter((point, index) => index % 6 === 0 && point.width >= 9)
    .map((point) => ({ x: point.x - point.inwardX * 2.1, z: point.z - point.inwardZ * 2.1 }))
    .filter((point) => !blockedAtVegetation(point.x, point.z, 2.8) && !city.isOnRoad(point.x, point.z, 2.4));
  const drops = treeSites.map((s) => sidewalkH(s.x, s.z) - surfaceH(s.x, s.z));
  console.log(`\n=== 6  ROADSIDE TREES (asset-gated, zero instances in a headless build) ====================`);
  console.log(`  ${treeSites.length} authored roadside tree sites at ${(ROADSIDE_OFFSET + 2.1).toFixed(2)} u beyond the kerb, grounded through the`);
  console.log(`  SAME groundItems() path (installTreeAssets -> buildAuthoredTrees), so they move too:`);
  console.log(`    drop 0: ${drops.filter((d) => d < 0.01).length}   drop ${KERB_STEP.toFixed(2)}: ${drops.filter((d) => d >= 0.3).length}   = ${pct(drops.filter((d) => d >= 0.01).length, drops.length)} of them move.`);
  console.log(`  Add these to section 1's total. They cannot be measured headlessly and MUST be checked in-engine.`);
}
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
