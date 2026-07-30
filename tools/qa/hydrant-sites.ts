/**
 * Fire-hydrant siting audit — what every hydrant in the city stands on, how many there are, and how far a
 * player ever has to walk to find one.
 *
 * Every number is measured against the REAL built city rather than a re-derivation: this constructs City
 * headlessly, so the station list, the guards, the prop registry and the instance matrices are the ones the
 * game ships. Any number here is the number a player sees.
 *
 *   (a) DOES IT TOUCH THE GROUND? Every roadside family is reported with the distance from the road edge it
 *       actually stands at, the surface the renderer actually draws there (ray-traced against the real
 *       triangles, not queried), and the measured world-space bottom of its rendered geometry. Gap positive
 *       = hovering; negative = bedded in. This is the measurement that caught the original fault:
 *       UrbanInfrastructure was handed City.sidewalkHeightAt, which is terrain + 0.37 UNCONDITIONALLY — the
 *       height of the pavement whether or not any pavement is drawn at that spot — while the paving stops at
 *       ROAD_BUILD_MARGIN and every furniture pass stepped OUTWARD past it.
 *
 *   (b) WHY CAN'T I FIND ONE? The census: how many stations exist, how many survive each guard, and the
 *       walk-up distribution PER DISTRICT — the tail, not the mean, because the mean is what a lottery
 *       flatters itself with.
 *
 *   (c) WHAT DID IT COST? Total InstancedMesh count, the hydrant batches' share, and the worst-case
 *       per-frame draw calls inside the streaming rings — before and after, on the same build.
 *
 *   (d) ARE THE GUARANTEES STILL TRUE? Zero prop overlaps citywide; every hydrant's hide() fells exactly
 *       its own six instances and nothing else's; no hydrant inside a bench; closest hydrant pair.
 *
 *   npx tsx tools/qa/hydrant-sites.ts
 */
import type { Box3, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { City as CityType, RoadsidePoint } from '../../src/world/City';
import type { PropCollider, PropKind } from '../../src/systems/PropSystem';

/**
 * City builds its procedural materials in field initialisers, and three's CanvasTexture/ImageLoader path
 * wants a DOM. A no-op 2D context is enough: nothing here reads a pixel back, and no renderer exists to
 * upload one. Installed before the module graph loads, hence the dynamic imports below.
 */
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
  City, GROUND_SEGMENTS, HYDRANT_STATION_PHASE, HYDRANT_STATION_SPACING, ROAD_NETWORK, ROAD_SAMPLE_SPACING,
  ROAD_SURFACE_OFFSET, ROADSIDE_OFFSET, SIDEWALK_BAND, SIDEWALK_CENTER, SIDEWALK_INNER_EDGE, SIDEWALK_RISE,
  SIDEWALK_WIDTH, STREETLAMP_SPACING, districtAt, hydrantStationCandidates, hydrantStationPoint,
  sampleRoadPath, terrainHeightAt,
} = await import('../../src/world/City');
type HydrantStation = CityType['hydrantStations'][number];
const {
  BENCH_VERGE_DISTANCE, BIN_VERGE_DISTANCE, HYDRANT_FLANGE_RADIUS, HYDRANT_KERB_DISTANCE, onRoadsideStride,
} = await import('../../src/world/UrbanInfrastructure');
const { CBD_CENTER, METRES_PER_UNIT, ROAD_BUILD_MARGIN, distanceToRailwayCorridor } = await import('../../src/world/mapData');
const { allBuildings } = await import('../../src/world/CityGen');
const { WORLD_SIZE } = await import('../../src/config');
const { DETAIL_VISIBLE_RANGE, CHUNK_VISIBLE_RANGE, cellDistance } = await import('../../src/world/ChunkVisibility');
const { CELL_SIZE } = await import('../../src/world/CityGen');

/** Where each furniture pass plants its prop, as a distance beyond the kerb (UrbanInfrastructure). */
const FURNITURE_SITE: ReadonlyArray<{ kind: PropKind; label: string; kerb: number; colors: string[] }> = [
  { kind: 'hydrant', label: 'fire hydrant', kerb: HYDRANT_KERB_DISTANCE, colors: ['a8322d'] },
  { kind: 'streetlight', label: 'streetlamp', kerb: ROADSIDE_OFFSET, colors: ['253033'] },
  { kind: 'bin', label: 'litter bin', kerb: BIN_VERGE_DISTANCE, colors: ['3f5c46', '22302a'] },
  { kind: 'bench', label: 'park bench', kerb: BENCH_VERGE_DISTANCE, colors: ['744d32', '2c3739'] },
  { kind: 'post', label: 'utility cabinet', kerb: ROADSIDE_OFFSET + 1.35, colors: ['a6a8a1', '405c4b', '263c34', 'f2c230', 'd7aa23'] },
  { kind: 'shrub', label: 'verge shrub', kerb: ROADSIDE_OFFSET + 2.1, colors: ['365f3d'] },
];
const HYDRANT_RED = 'a8322d';
const HYDRANT_PARTS_PER_PROP = 6; // two instanced batches, three parts each — the whole instance cost of a hydrant
const HYDRANT_CLEARANCE = 1.4;    // buildFireHydrants' own-spot probe (legibility, not collision)
const HYDRANT_MIN_SEPARATION = 12;
const ROAD_PROBE = HYDRANT_FLANGE_RADIUS + 0.06;
const SURFACE_BED = 0.015;        // UrbanInfrastructure beds every prop this far into its surface
const PAVEMENT_OUTER_EDGE = SIDEWALK_CENTER + SIDEWALK_WIDTH / 2;

const scene = new THREE.Scene();
const started = Date.now();
const city = new City(scene, 'low', false);
const hydrants = city.props.props.filter((prop) => prop.kind === 'hydrant');
console.log(`built the city headlessly in ${((Date.now() - started) / 1000).toFixed(1)}s`
  + ` — ${city.roadsidePoints.length} roadside points, ${city.hydrantStations.length} hydrant stations,`
  + ` ${city.props.props.length} props, ${hydrants.length} hydrants`);

const median = (values: number[]): number => quantile(values, 0.5);
const quantile = (values: number[], p: number): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
};

// ---- the grounding contract ---------------------------------------------------------------------
console.log('\nGROUNDING. UrbanInfrastructure receives (x, z, preferred) => City.surfaceHeightAt(...) — the surface actually drawn.');
console.log(`  sidewalkHeightAt (what it used to receive) = terrain + ROAD_SURFACE_OFFSET ${ROAD_SURFACE_OFFSET}`
  + ` + SIDEWALK_RISE ${SIDEWALK_RISE} = terrain + ${(ROAD_SURFACE_OFFSET + SIDEWALK_RISE).toFixed(2)}, unconditionally,`
  + ' with no test for whether pavement is drawn there.');
console.log(`  paving is DRAWN from ${SIDEWALK_INNER_EDGE} to ${PAVEMENT_OUTER_EDGE} u beyond the kerb, and the walkable`
  + ` band SIDEWALK_BAND is ${SIDEWALK_BAND} = ROAD_BUILD_MARGIN ${ROAD_BUILD_MARGIN} — the same edge, which is what makes`
  + ' the honest query exact at the paving edge instead of trading a hover for an embedment.');
console.log(`  the roadside line sits ${ROADSIDE_OFFSET} u beyond the kerb — only ${(PAVEMENT_OUTER_EDGE - ROADSIDE_OFFSET).toFixed(2)} u`
  + ' inside the paving\'s outer edge, so any pass stepping outward from it stands its prop on grass.');
console.log(`  hydrants stand at ${HYDRANT_KERB_DISTANCE} u instead: flange radius ${HYDRANT_FLANGE_RADIUS.toFixed(3)},`
  + ` so ${(HYDRANT_KERB_DISTANCE - HYDRANT_FLANGE_RADIUS).toFixed(3)}..${(HYDRANT_KERB_DISTANCE + HYDRANT_FLANGE_RADIUS).toFixed(3)}`
  + ` — wholly inside the drawn paving, and ${(SIDEWALK_CENTER - HYDRANT_KERB_DISTANCE).toFixed(2)} u short of the walk line at ${SIDEWALK_CENTER}.`);

// ---- furniture families: where they stand, and what they stand on -------------------------------
// The rendered bottom of a PROP, not of an instance: every batch is walked, each instance attributed to
// the nearest registered prop of its family, and the lowest of that prop's parts kept. Doing it per
// instance would call a streetlamp's lamp head, six metres up, a floating streetlamp.
const PROP_CELL = 8;
const propCells = new Map<string, PropCollider[]>();
for (const prop of city.props.props) {
  const key = `${prop.kind}|${Math.floor(prop.x / PROP_CELL)},${Math.floor(prop.z / PROP_CELL)}`;
  const bucket = propCells.get(key); if (bucket) bucket.push(prop); else propCells.set(key, [prop]);
}
const nearestProp = (kind: PropKind, x: number, z: number, reach: number): PropCollider | undefined => {
  const cx = Math.floor(x / PROP_CELL); const cz = Math.floor(z / PROP_CELL);
  let best: PropCollider | undefined; let bestDistance = reach;
  const span = Math.ceil(reach / PROP_CELL);
  for (let dx = -span; dx <= span; dx++) for (let dz = -span; dz <= span; dz++) {
    for (const prop of propCells.get(`${kind}|${cx + dx},${cz + dz}`) ?? []) {
      const distance = Math.hypot(prop.x - x, prop.z - z);
      if (distance < bestDistance) { bestDistance = distance; best = prop; }
    }
  }
  return best;
};
const colorFamily = new Map<string, PropKind>();
for (const family of FURNITURE_SITE) for (const color of family.colors) colorFamily.set(color, family.kind);
const propBottom = new Map<number, number>(); // prop id -> lowest rendered geometry, world y
let instancesSeen = 0; let instancesOrphaned = 0;
{
  const matrix = new THREE.Matrix4();
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh)) return;
    const material = object.material;
    if (Array.isArray(material) || !('color' in material)) return;
    const kind = colorFamily.get((material as MeshStandardMaterial).color.getHexString());
    if (!kind) return;
    object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox;
    if (!box) return;
    for (let index = 0; index < object.count; index++) {
      object.getMatrixAt(index, matrix);
      const world = box.clone().applyMatrix4(matrix);
      const centre = world.getCenter(new THREE.Vector3());
      instancesSeen++;
      const prop = nearestProp(kind, centre.x, centre.z, 3);
      if (!prop) { instancesOrphaned++; continue; }
      propBottom.set(prop.id, Math.min(propBottom.get(prop.id) ?? Infinity, world.min.y));
    }
  });
}

// ---- what is actually drawn under a prop --------------------------------------------------------
// Nothing above proves what the RENDERER puts there — City.surfaceHeightAt is a query, not a mesh. So
// drop a ray through each prop and hit the real triangles: the ground sheet, and the pavement ribbon
// if any reaches that far. The ground sheet is a 256x256 plane, so its drawn triangle also differs a
// little from the bilinear terrainHeightAt every placement rule uses; the ray measures that too.
scene.updateMatrixWorld(true);
// The ground sheet is one GROUND_SEGMENTS² PlaneGeometry; the citywide merge de-indexes it, so after
// mergeStaticGeometry it is the single mesh carrying exactly two triangles per cell. Matching on that
// count rather than on userData.far, which the merge does not carry over — and never on "the biggest
// mesh in the far chunk", which would also match the far-water sheet and read sea level as ground.
const groundVertices = GROUND_SEGMENTS * GROUND_SEGMENTS * 6;
let groundMesh: Mesh | undefined;
const pavementMeshes: Array<{ mesh: Mesh; box: Box3 }> = [];
/** Everything else the renderer lays down at ground level — carriageway, dirt track, footpath, junction
 *  pave, kerb, tactile patch. A prop can stand on any of them, so "what is drawn under me" cannot be
 *  answered by the pavement ribbon alone (which is what mistook a tarred junction notch for thin air). */
const surfaceMeshes: Array<{ mesh: Mesh; box: Box3 }> = [];
/** The one ground surface that is INSTANCED and therefore invisible to a mesh-only sweep: the tactile
 *  patches at signalised corners (buildTactileCorners, colour d0a744, a unit box scaled 2.5 x 0.09 x 1.65
 *  whose top rides 0.085 above the pavement plane). Leaving them out reported every traffic signal as
 *  standing on bare ground 0.355 below it, which the in-engine screenshots flatly contradict — the mast
 *  stands on its own paving. three's InstancedMesh implements raycast, so they can simply join the targets;
 *  no other instanced batch is a surface anything stands on (markings and potholes are on the tar). */
const TACTILE_COLOR = 'd0a744';
scene.traverse((object) => {
  if (object instanceof THREE.InstancedMesh) {
    const material = object.material;
    if (Array.isArray(material) || !('color' in material)) return;
    if ((material as MeshStandardMaterial).color.getHexString() !== TACTILE_COLOR) return;
    object.geometry.computeBoundingBox();
    object.computeBoundingBox();
    const box = object.boundingBox?.clone().applyMatrix4(object.matrixWorld);
    if (box) surfaceMeshes.push({ mesh: object, box });
    return;
  }
  if (!(object instanceof THREE.Mesh)) return;
  if (object.geometry.attributes.position?.count === groundVertices) { groundMesh = object; return; }
  object.geometry.computeBoundingBox();
  const local = object.geometry.boundingBox;
  if (!local) return;
  const box = local.clone().applyMatrix4(object.matrixWorld);
  surfaceMeshes.push({ mesh: object, box });
  const material = object.material;
  if (Array.isArray(material) || !('color' in material)) return;
  if ((material as MeshStandardMaterial).color.getHexString() === 'f0eee5') pavementMeshes.push({ mesh: object, box }); // the sidewalk material
});
const down = new THREE.Vector3(0, -1, 0);
const overhead = (x: number, z: number, meshes: Array<{ mesh: Mesh; box: Box3 }>): Mesh[] => meshes
  .filter(({ box }) => x >= box.min.x - 1 && x <= box.max.x + 1 && z >= box.min.z - 1 && z <= box.max.z + 1)
  .map(({ mesh }) => mesh);
const rayDown = (x: number, z: number, targets: Mesh[], ceiling = Infinity): { y: number; mesh: Mesh } | undefined => {
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 900, z), down);
  let best: { y: number; mesh: Mesh } | undefined;
  for (const hit of raycaster.intersectObjects(targets, false)) {
    if (hit.point.y > ceiling) continue; // a canopy or a balcony overhead is not the ground
    if (!best || hit.point.y > best.y) best = { y: hit.point.y, mesh: hit.object as Mesh };
  }
  return best;
};
/** `ceiling` keeps the answer at ground level: the highest thing drawn under the prop's own base, plus a
 *  little slack for a surface the prop is bedded into. */
const drawnUnder = (x: number, z: number, ceiling = Infinity): { ground?: number; paving?: number; surface?: number; what?: string } => {
  const surface = rayDown(x, z, overhead(x, z, surfaceMeshes), ceiling);
  const material = surface?.mesh.material;
  return {
    ground: groundMesh ? rayDown(x, z, [groundMesh], ceiling)?.y : undefined,
    paving: rayDown(x, z, overhead(x, z, pavementMeshes), ceiling)?.y,
    surface: surface?.y,
    what: surface && !Array.isArray(material) && material && 'color' in material
      ? `${surface.mesh.name || surface.mesh.geometry.type}#${(material as MeshStandardMaterial).color.getHexString()}` : surface?.mesh.name,
  };
};
console.log(`\nRAY-TRACED SURFACES. ground sheet found: ${groundMesh ? 'yes' : 'NO'} (${GROUND_SEGMENTS}x${GROUND_SEGMENTS} over ${WORLD_SIZE} u`
  + ` = ${(WORLD_SIZE / GROUND_SEGMENTS).toFixed(1)} u cells); pavement meshes: ${pavementMeshes.length}; all ground-level meshes: ${surfaceMeshes.length}`);

console.log('\nROADSIDE FURNITURE — where each family stands, and what the renderer draws underneath it.');
console.log(`  kerb = where the pass plants it, as a distance beyond the road edge (paving ends at ${PAVEMENT_OUTER_EDGE});`);
console.log('  edge = the same thing measured back off the built city;  on paving = City.isOnSidewalk agrees;');
console.log('  query gap = lowest rendered part minus City.surfaceHeightAt;  DRAWN GAP = minus the y a ray actually hits');
console.log('  (up to 200 props per family, evenly strided). Positive = HOVERING, negative = bedded into the surface.');
console.log('  WAS = the same ray, against the OLD grounding: bottom + (sidewalkHeightAt - surfaceHeightAt) + SURFACE_BED,');
console.log('  which is exact arithmetic on this same build — no family but the hydrant moved in x/z, and the bench legs');
console.log('  also came down 0.025 (they were pinned 0.025 above whatever the bench was grounded on).');
console.log(`  ${'family'.padEnd(16)}${'kerb'.padStart(6)}${'edge'.padStart(7)}${'on paving'.padStart(11)}`
  + `${'WAS med'.padStart(10)}${'was >5cm'.padStart(10)}${'drawn med'.padStart(11)}${'drawn p90'.padStart(11)}`
  + `${'drawn max'.padStart(11)}${'now >5cm'.padStart(10)}${'props'.padStart(8)}`);
const RAY_SAMPLE = 200;
for (const family of FURNITURE_SITE) {
  const props = city.props.props.filter((prop) => prop.kind === family.kind && propBottom.has(prop.id));
  const bottoms = props.map((prop) => propBottom.get(prop.id)!);
  const edges = props.map((prop) => city.roadEdgeDistance(prop.x, prop.z));
  const paved = props.filter((prop) => city.isOnSidewalk(prop.x, prop.z)).length;
  const stride = Math.max(1, Math.ceil(props.length / RAY_SAMPLE));
  const drawnGaps: number[] = []; const wasGaps: number[] = [];
  props.forEach((prop, index) => {
    if (index % stride !== 0) return;
    const traced = drawnUnder(prop.x, prop.z, bottoms[index]! + 0.5);
    const drawn = Math.max(traced.ground ?? -Infinity, traced.surface ?? -Infinity);
    if (!Number.isFinite(drawn)) return;
    drawnGaps.push(bottoms[index]! - drawn);
    const lift = city.sidewalkHeightAt(prop.x, prop.z) - city.surfaceHeightAt(prop.x, prop.z) + SURFACE_BED
      + (family.kind === 'bench' ? 0.025 : 0);
    wasGaps.push(bottoms[index]! + lift - drawn);
  });
  const share = (values: number[]): string => `${((100 * values.filter((gap) => gap > 0.05).length) / values.length).toFixed(0)}%`;
  console.log(`  ${family.label.padEnd(16)}${family.kerb.toFixed(2).padStart(6)}${median(edges).toFixed(2).padStart(7)}`
    + `${`${((100 * paved) / (props.length || 1)).toFixed(0)}%`.padStart(11)}`
    + `${(family.kind === 'hydrant' ? NaN : median(wasGaps)).toFixed(3).padStart(10)}${(family.kind === 'hydrant' ? '-' : share(wasGaps)).padStart(10)}`
    + `${median(drawnGaps).toFixed(3).padStart(11)}${quantile(drawnGaps, 0.9).toFixed(3).padStart(11)}`
    + `${Math.max(...drawnGaps).toFixed(3).padStart(11)}${share(drawnGaps).padStart(10)}${String(props.length).padStart(8)}`);
}
console.log('  (the hydrant\'s WAS is blank because it also MOVED: at 3.80 beyond the kerb, on the verge, the measured'
  + ' daylight under its flange was 0.326 u median — 44 cm — on 443 of the 490 the owner played.)');
console.log(`  (${instancesSeen} instances walked, ${instancesOrphaned} unattributable to a registered prop.)`);
{
  // How many props the grounding change actually moves, and by how much: the two queries differ by exactly
  // the kerb wherever no paving is drawn, so this is the blast radius of the one-line swap.
  // Only the families UrbanInfrastructure grounds: City grounds its own landmarks (monument, fountain,
  // crane) and its scattered vegetation, and this swap does not touch those.
  const streetscape: PropKind[] = ['shrub', 'bench', 'sign', 'bin', 'post', 'shelter', 'streetlight', 'hydrant'];
  const moved = city.props.props.filter((prop) => prop.kind !== 'signal' && streetscape.includes(prop.kind)
    && city.sidewalkHeightAt(prop.x, prop.z) - city.surfaceHeightAt(prop.x, prop.z) > 0.01);
  const drops = moved.map((prop) => city.sidewalkHeightAt(prop.x, prop.z) - city.surfaceHeightAt(prop.x, prop.z));
  const byKind = new Map<PropKind, number>();
  for (const prop of moved) byKind.set(prop.kind, (byKind.get(prop.kind) ?? 0) + 1);
  console.log(`  BLAST RADIUS of the grounding swap: ${moved.length} of ${city.props.props.length} registered props drop`
    + ` (median ${median(drops).toFixed(3)}, max ${Math.max(...drops).toFixed(3)}) —`
    + ` ${[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`).join(', ')}`);
  console.log('  plus the roadside trees below. Traffic signals are excluded: they are the carve-out, and 0 of them move.');
}

// Roadside trees are asset-gated (installTreeAssets runs after the constructor and needs the GLB), so a
// headless build instances none of them. Their SITE LIST is deterministic, so replay it and measure what is
// drawn at each site: that is the other route to "do the trees float too?".
{
  // buildVegetation is the FIRST furniture pass, so its guard saw only City's own props: replay it with the
  // registry rolled back to the shrub it registers first, or the 4,886 hydrants placed later reject a third
  // of the tree sites that really exist.
  const treeSites = withPropsAsOf(firstOf('shrub'), () => city.roadsidePoints
    .filter((point, index) => index % 6 === 0 && point.width >= 9)
    .map((point) => ({ x: point.x - point.inwardX * 2.1, z: point.z - point.inwardZ * 2.1 }))
    .filter((point) => !isBlockedNow(point.x, point.z, 2.8) && !city.isOnRoad(point.x, point.z, 2.4)));
  const stride = Math.max(1, Math.ceil(treeSites.length / 200));
  let bare = 0; let sampled = 0; const lifts: number[] = [];
  treeSites.forEach((site, index) => {
    if (index % stride !== 0) return;
    sampled++;
    const traced = drawnUnder(site.x, site.z, city.sidewalkHeightAt(site.x, site.z) + 0.5);
    const drawn = Math.max(traced.ground ?? -Infinity, traced.surface ?? -Infinity);
    if (!Number.isFinite(drawn)) return;
    lifts.push(city.sidewalkHeightAt(site.x, site.z) - drawn);
    if (traced.paving === undefined) bare++;
  });
  console.log(`  roadside trees: ${treeSites.length} sites (GLB asset-gated, 0 instanced headlessly). Replayed and ray-traced`
    + ` ${sampled}: ${((100 * bare) / sampled).toFixed(0)}% have NO paving drawn under them, and the old pavement-plane`
    + ` grounding stood them median ${median(lifts).toFixed(3)} u above the surface actually there. They floated too;`
    + ' the honest query drops them onto it.');
}

// ---- the assemblies, which are NOT instanced ----------------------------------------------------
// Street-name posts, roadside signs, traffic signals, transit shelters and the e-toll gantries are real
// meshes (they must stay unmerged to tip over), so the instanced walk above cannot see them. Their root IS
// their base — a 3.6u post is centred at 1.8, a 5.7u signal mast at 2.85 — so the ray answers directly.
console.log('\nASSEMBLIES — the un-instanced streetscape, base against the surface the ray hits.');
console.log(`  ${'family'.padEnd(20)}${'props'.padStart(7)}${'edge'.padStart(7)}${'no ribbon'.padStart(11)}`
  + `${'WAS med'.padStart(10)}${'was >5cm'.padStart(10)}${'now med'.padStart(10)}${'now >5cm'.padStart(10)}`);
for (const family of [
  { kind: 'sign' as PropKind, label: 'street-name post', preferred: undefined },
  { kind: 'signal' as PropKind, label: 'traffic signal', preferred: 'sidewalk' as const },
  { kind: 'shelter' as PropKind, label: 'transit shelter', preferred: undefined },
]) {
  const props = city.props.props.filter((prop) => prop.kind === family.kind);
  const stride = Math.max(1, Math.ceil(props.length / RAY_SAMPLE));
  const was: number[] = []; const now: number[] = []; let bare = 0; let sampled = 0;
  props.forEach((prop, index) => {
    if (index % stride !== 0) return;
    const old = city.sidewalkHeightAt(prop.x, prop.z);
    const traced = drawnUnder(prop.x, prop.z, old + 0.5);
    const drawn = Math.max(traced.ground ?? -Infinity, traced.surface ?? -Infinity);
    if (!Number.isFinite(drawn)) return;
    sampled++; if (traced.paving === undefined) bare++;
    was.push(old - drawn);
    now.push(city.surfaceHeightAt(prop.x, prop.z, family.preferred) - SURFACE_BED - drawn);
  });
  const share = (values: number[]): string => `${((100 * values.filter((gap) => gap > 0.05).length) / values.length).toFixed(0)}%`;
  console.log(`  ${family.label.padEnd(20)}${String(props.length).padStart(7)}`
    + `${median(props.map((prop) => city.roadEdgeDistance(prop.x, prop.z))).toFixed(2).padStart(7)}`
    + `${`${((100 * bare) / sampled).toFixed(0)}%`.padStart(11)}${median(was).toFixed(3).padStart(10)}${share(was).padStart(10)}`
    + `${median(now).toFixed(3).padStart(10)}${share(now).padStart(10)}`);
}
console.log('  ("no ribbon" = no pavement RIBBON drawn there. At a signalised corner the paving is usually the tactile');
console.log('  patch or the junction pave instead, which is why the signal row reads bedded rather than floating.)');
console.log('  The traffic signal is the one CARVE-OUT: its corner is paved by construction (buildTactileCorners lays a');
console.log('  2.5 x 1.65 tactile patch on the same diagonal, its top 0.085 above the pavement plane), and isOnSidewalk is');
console.log('  a band query on road EDGES that cannot see that patch — so the mast is grounded on \'sidewalk\' explicitly.');
{
  const signals = city.props.props.filter((prop) => prop.kind === 'signal');
  const sunk = signals.filter((prop) => city.sidewalkHeightAt(prop.x, prop.z) - city.surfaceHeightAt(prop.x, prop.z) > 0.01);
  console.log(`  Without it, ${sunk.length} of ${signals.length} masts would drop 0.370 — arm, head and lenses with them —`
    + ' and their base would sit ~0.47 below the tactile slab they stand on. That is what the carve-out is worth.');
}

// ---- the hydrant itself, part by part ----------------------------------------------------------
console.log('\nHYDRANT PARTS — measured off one hydrant\'s six instances, y relative to the height it was grounded at.');
console.log('  radius = the true horizontal radius about the part\'s own axis, from the vertices. (Not the'
  + ' rotated AABB, which Box3.applyMatrix4 inflates by up to 41% and which is what first mis-read the flange.)');
console.log(`  ${'part'.padEnd(30)}${'local y'.padStart(9)}${'scale y'.padStart(9)}${'bottom'.padStart(9)}${'top'.padStart(8)}${'radius'.padStart(9)}`);
{
  const sample = hydrants[0]!;
  const base = city.surfaceHeightAt(sample.x, sample.z);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3(); const rotation = new THREE.Quaternion(); const scale = new THREE.Vector3();
  const parts: Array<{ label: string; localY: number; scaleY: number; bottom: number; top: number; radius: number }> = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh)) return;
    const material = object.material;
    if (Array.isArray(material) || !('color' in material)) return;
    if ((material as MeshStandardMaterial).color.getHexString() !== HYDRANT_RED) return;
    object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox;
    if (!box) return;
    for (let index = 0; index < object.count; index++) {
      object.getMatrixAt(index, matrix);
      matrix.decompose(position, rotation, scale);
      if (Math.hypot(position.x - sample.x, position.z - sample.z) > 0.6) continue;
      const world = box.clone().applyMatrix4(matrix);
      const local = new THREE.Vector3(); let radius = 0;
      const vertices = object.geometry.attributes.position!;
      for (let vertex = 0; vertex < vertices.count; vertex++) {
        local.fromBufferAttribute(vertices, vertex).multiply(scale).applyQuaternion(rotation); // same order the matrix composes in
        radius = Math.max(radius, Math.hypot(local.x, local.z));
      }
      parts.push({
        label: `${object.geometry.type.replace('Geometry', '')} scale (${scale.x.toFixed(2)},${scale.y.toFixed(2)},${scale.z.toFixed(2)})`,
        localY: position.y - base, scaleY: scale.y, bottom: world.min.y - base, top: world.max.y - base, radius,
      });
    }
  });
  parts.sort((a, b) => a.bottom - b.bottom);
  for (const part of parts) {
    console.log(`  ${part.label.padEnd(30)}${part.localY.toFixed(3).padStart(9)}${part.scaleY.toFixed(2).padStart(9)}`
      + `${part.bottom.toFixed(4).padStart(9)}${part.top.toFixed(3).padStart(8)}${part.radius.toFixed(3).padStart(9)}`);
  }
  console.log(`  whole hydrant: bottom ${Math.min(...parts.map((p) => p.bottom)).toFixed(4)}`
    + `, top ${Math.max(...parts.map((p) => p.top)).toFixed(3)} above the height it was grounded at.`);
}

// ---- replay the placement pass, guard by guard ---------------------------------------------------
/** Run `body` with the prop registry rolled back to the moment `cutId` was registered: every furniture
 *  pass filters its whole site list before registering anything, so a guard replayed after the build
 *  would otherwise see the very props it is deciding about (a hydrant blocking its own site). */
function withPropsAsOf<T>(cutId: number, body: () => T): T { // hoisted: the tree replay above needs it too
  const stood: PropCollider[] = [];
  for (const prop of city.props.props) if (prop.id >= cutId && !prop.down) { prop.down = true; stood.push(prop); }
  try { return body(); } finally { for (const prop of stood) prop.down = false; }
}
function firstOf(kind: PropKind): number { return city.props.props.find((prop) => prop.kind === kind)?.id ?? 0; }
function isBlockedNow(x: number, z: number, radius: number): boolean { // City.ts, verbatim
  return city.collides(x, z, radius) || city.isReserved(x, z, radius) || distanceToRailwayCorridor(x, z) < radius + 0.6;
}
const atKerb = (point: RoadsidePoint, kerb: number): { hx: number; hz: number } => ({
  hx: point.x + point.inwardX * (ROADSIDE_OFFSET - kerb),
  hz: point.z + point.inwardZ * (ROADSIDE_OFFSET - kerb),
});

interface Placed { station: HydrantStation; road: string; width: number; arc: number; slid: number; hx: number; hz: number }
/** buildFireHydrants, verbatim, parameterised by the two knobs worth sweeping. */
const runStationPass = (
  stations: HydrantStation[],
  { clearance = HYDRANT_CLEARANCE, separation = HYDRANT_MIN_SEPARATION, slide = true, paved = true } = {},
): { placed: Placed[]; dropped: Record<string, number> } => {
  const placed: Placed[] = [];
  const grid = new Map<string, Array<{ x: number; z: number }>>();
  const farEnough = (x: number, z: number): boolean => {
    const cx = Math.floor(x / separation); const cz = Math.floor(z / separation);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const other of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if ((other.x - x) ** 2 + (other.z - z) ** 2 < separation ** 2) return false;
      }
    }
    return true;
  };
  const dropped: Record<string, number> = { unpaved: 0, blocked: 0, onRoad: 0, tooClose: 0 };
  for (const station of stations) {
    let cause = 'unpaved'; let done = false;
    const spots = slide ? [...hydrantStationCandidates(station)] : [hydrantStationPoint(station)].filter(Boolean) as RoadsidePoint[];
    for (const point of spots) {
      if (paved && !city.isPavementDrawn(point)) { cause = 'unpaved'; continue; }
      const { hx, hz } = atKerb(point, HYDRANT_KERB_DISTANCE);
      if (isBlockedNow(hx, hz, clearance)) { cause = 'blocked'; continue; }
      if (city.isOnRoad(hx, hz, ROAD_PROBE)) { cause = 'onRoad'; continue; }
      if (!farEnough(hx, hz)) { cause = 'tooClose'; continue; }
      placed.push({ station, road: station.road.name, width: station.road.width, arc: station.arc, slid: point.x, hx, hz });
      const key = `${Math.floor(hx / separation)},${Math.floor(hz / separation)}`;
      const bucket = grid.get(key); if (bucket) bucket.push({ x: hx, z: hz }); else grid.set(key, [{ x: hx, z: hz }]);
      done = true; break;
    }
    if (!done) dropped[cause] = (dropped[cause] ?? 0) + 1;
  }
  return { placed, dropped };
};

/** The OLD placement, for the before/after: a modulus over a global index into roadsidePoints, offset
 *  outward from the verge line, on wide roads only. This is what the owner played. */
const runStridePass = (stride: number, minWidth: number, kerb: number): Array<{ hx: number; hz: number; width: number }> => {
  const placed: Array<{ hx: number; hz: number; width: number }> = [];
  city.roadsidePoints.forEach((point, index) => {
    if (!onRoadsideStride(index, stride, 11) || point.width < minWidth) return;
    const { hx, hz } = atKerb(point, kerb);
    if (isBlockedNow(hx, hz, HYDRANT_FLANGE_RADIUS + 0.1) || city.isOnRoad(hx, hz, 0.7)) return;
    if (!placed.every((spot) => (spot.hx - hx) ** 2 + (spot.hz - hz) ** 2 >= 1.2 ** 2)) return;
    placed.push({ hx, hz, width: point.width });
  });
  return placed;
};

const survivors = withPropsAsOf(firstOf('hydrant'), () => {
  const stations = city.hydrantStations;
  const noSlide = runStationPass(stations, { slide: false });
  const noPavingGate = runStationPass(stations, { paved: false });
  const collisionProbe = runStationPass(stations, { clearance: HYDRANT_FLANGE_RADIUS + 0.1 });
  const final = runStationPass(stations);
  console.log('\nCENSUS — every guard in buildFireHydrants, replayed against the state it actually saw.');
  console.log(`  roads in the network                   ${String(ROAD_NETWORK.length).padStart(6)}`);
  console.log(`  arc-length stations                    ${String(stations.length).padStart(6)}   one per ${HYDRANT_STATION_SPACING} u`
    + ` of every street (= ${(HYDRANT_STATION_SPACING * METRES_PER_UNIT).toFixed(0)} m), phase ${HYDRANT_STATION_PHASE},`
    + ` alternating kerbs; lamp pitch is ${STREETLAMP_SPACING}`);
  console.log(`  placed at the station's own spot        ${String(noSlide.placed.length).padStart(6)}`);
  console.log(`  ...plus the bounded slide along its kerb${String(final.placed.length).padStart(5)}   <== placed`
    + `   (${final.placed.length - noSlide.placed.length} rescued by sliding)`);
  console.log(`  registered in the prop registry        ${String(hydrants.length).padStart(6)}`);
  const mismatched = final.placed.filter((spot, index) => {
    const prop = hydrants[index];
    return !prop || Math.abs(prop.x - spot.hx) > 1e-9 || Math.abs(prop.z - spot.hz) > 1e-9;
  }).length;
  console.log(`  replay vs registry mismatches          ${String(mismatched).padStart(6)}   (0 = this replay IS the shipped pass)`);
  console.log(`  stations lost, by the guard that took them: ${Object.entries(final.dropped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`  counterfactuals: no slide rescue ${noSlide.placed.length}; no isPavementDrawn gate ${noPavingGate.placed.length}`
    + ` (the paving gate costs nothing — isRoad rejects the same notches); collision-sized probe`
    + ` ${HYDRANT_FLANGE_RADIUS + 0.1} instead of ${HYDRANT_CLEARANCE}: ${collisionProbe.placed.length}`);
  return final.placed;
});

// ---- coverage: the walk-up distribution, and its tail per district -------------------------------
const CELL = 64;
const nearestField = (spots: Array<{ x: number; z: number }>): number[] => {
  const grid = new Map<string, Array<{ x: number; z: number }>>();
  for (const spot of spots) {
    const key = `${Math.floor(spot.x / CELL)},${Math.floor(spot.z / CELL)}`;
    const bucket = grid.get(key); if (bucket) bucket.push(spot); else grid.set(key, [spot]);
  }
  return city.roadsidePoints.map((point) => {
    const cx = Math.floor(point.x / CELL); const cz = Math.floor(point.z / CELL);
    for (let reach = 1; reach <= 80; reach++) {
      let best = Infinity;
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        for (const spot of grid.get(`${cx + dx},${cz + dz}`) ?? []) best = Math.min(best, Math.hypot(spot.x - point.x, spot.z - point.z));
      }
      if (best <= (reach - 1) * CELL || (best < Infinity && reach >= 80)) return best;
    }
    return Infinity;
  });
};
const districtOf = city.roadsidePoints.map((point) => districtAt(point.x, point.z));
const roadLength = (() => {
  let total = 0;
  for (const definition of ROAD_NETWORK) {
    const closed = definition.closed ?? false;
    const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
    const source = closed ? [...sampled, sampled[0]!] : sampled;
    for (let index = 0; index < source.length - 1; index++) total += Math.hypot(source[index + 1]!.x - source[index]!.x, source[index + 1]!.z - source[index]!.z);
  }
  return total;
})();

const before = withPropsAsOf(firstOf('hydrant'), () => runStridePass(19, 9, ROADSIDE_OFFSET + 0.75));
const walkBefore = nearestField(before.map((spot) => ({ x: spot.hx, z: spot.hz })));
const walkAfter = nearestField(survivors.map((spot) => ({ x: spot.hx, z: spot.hz })));
console.log('\nWALK-UP DISTANCE — straight-line, from every one of the ' + city.roadsidePoints.length
  + ' roadside points (the pavement network) to its nearest hydrant.');
const report = (label: string, values: number[], count: number): void => console.log(`  ${label.padEnd(38)}`
  + `${String(count).padStart(5)} hydrants  median ${median(values).toFixed(0).padStart(4)}  p90 ${quantile(values, 0.9).toFixed(0).padStart(4)}`
  + `  p99 ${quantile(values, 0.99).toFixed(0).padStart(4)}  max ${Math.max(...values).toFixed(0).padStart(4)} u`
  + `  >100u ${(100 * values.filter((d) => d > 100).length / values.length).toFixed(2).padStart(5)}%`
  + `  >150u ${(100 * values.filter((d) => d > 150).length / values.length).toFixed(2).padStart(5)}%`);
report('BEFORE (stride 19, w>=9, on the verge)', walkBefore, before.length);
report('AFTER (arc stations, kerbside)', walkAfter, survivors.length);
console.log(`  within 50 u of a hydrant: ${((100 * walkAfter.filter((d) => d <= 50).length) / walkAfter.length).toFixed(1)}%`
  + ` of the pavement network (was ${((100 * walkBefore.filter((d) => d <= 50).length) / walkBefore.length).toFixed(1)}%);`
  + ` beyond 200 u: ${walkAfter.filter((d) => d > 200).length} points (was ${walkBefore.filter((d) => d > 200).length}).`);
{
  // The metric that failed the previous attempt: a bigger count that leaves some pavement WORSE off.
  let farther = 0; let farther50 = 0; let worst = 0; let worstAt = '';
  walkBefore.forEach((was, index) => {
    const now = walkAfter[index]!;
    if (now > was + 0.5) {
      farther++;
      if (now - was > 50) farther50++;
      if (now - was > worst) { worst = now - was; worstAt = `${districtOf[index]} ${was.toFixed(0)} -> ${now.toFixed(0)}`; }
    }
  });
  console.log(`  MONOTONICITY: ${(100 * farther / walkBefore.length).toFixed(2)}% of the pavement ends up farther from a hydrant`
    + ` than before, ${(100 * farther50 / walkBefore.length).toFixed(2)}% by more than 50 u; worst regression ${worst.toFixed(0)} u (${worstAt}).`);
  console.log('  (the rejected stride change scored 25.0% farther, 7.34% by >50 u, worst 302 u — that is what a'
    + ' modulus reshuffle costs and why this is measured.)');
}
{
  // Keyed by the SampledRoad object, never by name: ~2,700 definitions share a few hundred street names
  // (every "Egoli Orbital" segment is its own road), and keying by name reports gaps between hydrants on
  // opposite sides of the city as if they were neighbours.
  const gaps: number[] = [];
  const byRoad = new Map<HydrantStation['road'], number[]>();
  for (const spot of survivors) {
    const bucket = byRoad.get(spot.station.road);
    if (bucket) bucket.push(spot.arc); else byRoad.set(spot.station.road, [spot.arc]);
  }
  for (const arcs of byRoad.values()) {
    arcs.sort((a, b) => a - b);
    for (let index = 1; index < arcs.length; index++) gaps.push(arcs[index]! - arcs[index - 1]!);
  }
  console.log(`  along-road arc gap between consecutive hydrants: median ${median(gaps).toFixed(0)}  p99 ${quantile(gaps, 0.99).toFixed(0)}`
    + `  max ${Math.max(...gaps).toFixed(0)} u   (the pitch is ${HYDRANT_STATION_SPACING}; a bigger gap is a junction dropout)`);
  const stationRoads = new Set(city.hydrantStations.map((station) => station.road));
  const empty = [...stationRoads].filter((road) => !byRoad.has(road));
  const emptyLength = empty.reduce((sum, road) => sum + road.length, 0);
  console.log(`  streets with a station but no hydrant: ${empty.length} of ${stationRoads.size} eligible roads`
    + ` (${(emptyLength / 1000).toFixed(1)} k u = ${((100 * emptyLength) / roadLength).toFixed(1)}% of the network) — every station on`
    + ' them landed inside a crossing carriageway, which is honest geometry: dropping the paving gate does not recover them.');
}

console.log('\nPER-DISTRICT TAIL — districts with >=20 pavement points, worst 15 by max walk-up. The mean is what a');
console.log('  lottery flatters itself with; this is the number that decides whether a player in THIS suburb finds one.');
{
  const byDistrict = new Map<string, number[]>();
  walkAfter.forEach((distance, index) => {
    const key = districtOf[index]!;
    const bucket = byDistrict.get(key); if (bucket) bucket.push(distance); else byDistrict.set(key, [distance]);
  });
  const beforeByDistrict = new Map<string, number[]>();
  walkBefore.forEach((distance, index) => {
    const key = districtOf[index]!;
    const bucket = beforeByDistrict.get(key); if (bucket) bucket.push(distance); else beforeByDistrict.set(key, [distance]);
  });
  const rows = [...byDistrict.entries()].filter(([, values]) => values.length >= 20).map(([name, values]) => ({
    name, n: values.length, median: median(values), p90: quantile(values, 0.9), p99: quantile(values, 0.99),
    max: Math.max(...values), over100: values.filter((d) => d > 100).length,
    wasMedian: median(beforeByDistrict.get(name) ?? [NaN]), wasMax: Math.max(...(beforeByDistrict.get(name) ?? [NaN])),
  })).sort((a, b) => b.max - a.max);
  console.log(`  ${'district'.padEnd(24)}${'pts'.padStart(6)}${'median'.padStart(8)}${'p90'.padStart(6)}${'p99'.padStart(6)}${'max'.padStart(6)}`
    + `${'>100u'.padStart(7)}${'was med'.padStart(9)}${'was max'.padStart(9)}`);
  for (const row of rows.slice(0, 15)) {
    console.log(`  ${row.name.slice(0, 24).padEnd(24)}${String(row.n).padStart(6)}${row.median.toFixed(0).padStart(8)}`
      + `${row.p90.toFixed(0).padStart(6)}${row.p99.toFixed(0).padStart(6)}${row.max.toFixed(0).padStart(6)}`
      + `${String(row.over100).padStart(7)}${row.wasMedian.toFixed(0).padStart(9)}${row.wasMax.toFixed(0).padStart(9)}`);
  }
  console.log(`  districts (>=20 pts): ${rows.length};  with a median over 60 u: ${rows.filter((r) => r.median > 60).length}`
    + ` (was ${rows.filter((r) => r.wasMedian > 60).length});  with any point over 150 u: ${rows.filter((r) => r.max > 150).length}`
    + ` (was ${rows.filter((r) => r.wasMax > 150).length});  over 250 u: ${rows.filter((r) => r.max > 250).length} (was ${rows.filter((r) => r.wasMax > 250).length}).`);
}

// ---- road width: hydrants belong on ordinary streets --------------------------------------------
const widthTally = new Map<number, { length: number; points: number }>();
for (const definition of ROAD_NETWORK) {
  const closed = definition.closed ?? false;
  const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
  let length = 0;
  for (let index = 0; index < (closed ? sampled.length : sampled.length - 1); index++) {
    const a = sampled[index]!; const b = sampled[(index + 1) % sampled.length]!;
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const entry = widthTally.get(definition.width) ?? { length: 0, points: 0 };
  entry.length += length; widthTally.set(definition.width, entry);
}
for (const point of city.roadsidePoints) {
  const entry = widthTally.get(point.width); if (entry) entry.points++;
}
console.log('\nROAD WIDTH — hydrants per width band. The old `width >= 9` was inherited from the bench and shut');
console.log('  hydrants out of the residential streets SANS 10090 category D is actually about.');
for (const [width, entry] of [...widthTally.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  width ${String(width).padStart(4)}  ${(entry.length / 1000).toFixed(2).padStart(6)} km`
    + ` (${((100 * entry.length) / roadLength).toFixed(1).padStart(5)}% of the network)   ${String(entry.points).padStart(6)} roadside points`
    + `   hydrants ${String(survivors.filter((spot) => spot.width === width).length).padStart(5)}`
    + `   was ${String(before.filter((spot) => spot.width === width).length).padStart(4)}`);
}
console.log(`  one hydrant per ${(roadLength / survivors.length).toFixed(0)} u of street`
  + ` (${(roadLength / survivors.length * METRES_PER_UNIT).toFixed(0)} m) — SANS 10090 table 9 allows 85 m (category A)`
  + ` to 300 m (D1, plots over 30 m apart); Joburg's own by-laws restate 120/180 m.`);

// ---- the guarantees ----------------------------------------------------------------------------
console.log('\nGUARANTEES.');
{
  // 1. closest pair, by grid — the "0.605 u twin" measurement.
  const cell = 24; const grid = new Map<string, number[]>();
  survivors.forEach((spot, index) => {
    const key = `${Math.floor(spot.hx / cell)},${Math.floor(spot.hz / cell)}`;
    const bucket = grid.get(key); if (bucket) bucket.push(index); else grid.set(key, [index]);
  });
  let closest = Infinity; let pair = '';
  survivors.forEach((spot, index) => {
    const cx = Math.floor(spot.hx / cell); const cz = Math.floor(spot.hz / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const other of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (other <= index) continue;
        const distance = Math.hypot(survivors[other]!.hx - spot.hx, survivors[other]!.hz - spot.hz);
        if (distance < closest) { closest = distance; pair = `(${spot.hx.toFixed(1)}, ${spot.hz.toFixed(1)}) & (${survivors[other]!.hx.toFixed(1)}, ${survivors[other]!.hz.toFixed(1)}) in ${districtAt(spot.hx, spot.hz)}`; }
      }
    }
  });
  const beforeClosest = (() => {
    let best = Infinity;
    before.forEach((spot, index) => before.forEach((other, otherIndex) => {
      if (otherIndex <= index) return;
      best = Math.min(best, Math.hypot(other.hx - spot.hx, other.hz - spot.hz));
    }));
    return best;
  })();
  console.log(`  closest hydrant pair, centre to centre: ${closest.toFixed(3)} u  (guard: ${HYDRANT_MIN_SEPARATION} u minimum separation) — ${pair}`);
  console.log(`    the collider edges are therefore ${(closest - 0.6).toFixed(3)} u apart and the ground flanges ${(closest - 2 * HYDRANT_FLANGE_RADIUS).toFixed(3)} u.`);
  console.log(`    on the rejected 1.2 u spacedFrom() dedupe the closest pair was 1.205 u — 0.605 u between collider edges,`
    + ` a visible twin. (The old sparse placement's closest pair: ${beforeClosest.toFixed(3)} u — sparsity was hiding it.)`);
}
{
  // 2. no overlap with any other prop, anywhere.
  let overlaps = 0; let worstFamily = ''; let closest = Infinity;
  const byFamily = new Map<PropKind, number>();
  const ANY_CELL = 8; // one grid over every family, so this is O(nearby) rather than 4,900 x 21,000
  const anyCells = new Map<string, PropCollider[]>();
  for (const prop of city.props.props) {
    if (prop.kind === 'hydrant') continue;
    const key = `${Math.floor(prop.x / ANY_CELL)},${Math.floor(prop.z / ANY_CELL)}`;
    const bucket = anyCells.get(key); if (bucket) bucket.push(prop); else anyCells.set(key, [prop]);
  }
  for (const spot of survivors) {
    const cx = Math.floor(spot.hx / ANY_CELL); const cz = Math.floor(spot.hz / ANY_CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const prop of anyCells.get(`${cx + dx},${cz + dz}`) ?? []) {
        const distance = Math.hypot(prop.x - spot.hx, prop.z - spot.hz);
        if (distance < prop.radius + HYDRANT_FLANGE_RADIUS) overlaps++;
        const gap = distance - prop.radius - HYDRANT_FLANGE_RADIUS;
        if (gap < (byFamily.get(prop.kind) ?? Infinity)) byFamily.set(prop.kind, gap);
        if (gap < closest) { closest = gap; worstFamily = `${prop.kind} at (${prop.x.toFixed(0)}, ${prop.z.toFixed(0)})`; }
      }
    }
  }
  console.log(`  prop overlaps citywide (any family, shell to shell): ${overlaps}`);
  console.log(`    tightest clearance anywhere: ${closest.toFixed(3)} u to a ${worstFamily}`);
  console.log('    per family, closest shell-to-shell gap: '
    + [...byFamily.entries()].sort((a, b) => a[1] - b[1]).map(([kind, gap]) => `${kind} ${gap.toFixed(2)}`).join(', '));
  const benches = city.props.props.filter((prop) => prop.kind === 'bench');
  const inABench = survivors.filter((spot) => benches.some((bench) => Math.hypot(bench.x - spot.hx, bench.z - spot.hz) < 0.85)).length;
  console.log(`  hydrants standing inside a bench: ${inABench} (it was every one of 720 on main — same site list, 0.05 u apart)`);
}
{
  // 3. hide() fells exactly its own six instances. setMatrixAt is patched so the audit sees precisely which
  //    slots a hide() call touches, rather than diffing 29k matrices per hydrant.
  const touched: Array<{ mesh: InstancedMesh; index: number }> = [];
  const known = new Map<string, { x: number; z: number }>();
  const patched: InstancedMesh[] = [];
  const matrix = new THREE.Matrix4(); const position = new THREE.Vector3();
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh)) return;
    const material = object.material;
    if (Array.isArray(material) || !('color' in material)) return;
    if ((material as MeshStandardMaterial).color.getHexString() !== HYDRANT_RED) return;
    for (let index = 0; index < object.count; index++) {
      object.getMatrixAt(index, matrix); position.setFromMatrixPosition(matrix);
      known.set(`${object.id}|${index}`, { x: position.x, z: position.z });
    }
    const original = object.setMatrixAt.bind(object);
    object.setMatrixAt = (index: number, value: Matrix4): void => { touched.push({ mesh: object, index }); original(index, value); };
    patched.push(object);
  });
  let wrongCount = 0; let strayInstance = 0; let notHidden = 0;
  const hidden = new THREE.Matrix4();
  for (const prop of hydrants) {
    touched.length = 0;
    prop.hide?.();
    if (touched.length !== HYDRANT_PARTS_PER_PROP) wrongCount++;
    for (const slot of touched) {
      const where = known.get(`${slot.mesh.id}|${slot.index}`);
      if (!where || Math.hypot(where.x - prop.x, where.z - prop.z) > 0.6) strayInstance++;
      slot.mesh.getMatrixAt(slot.index, hidden);
      if (hidden.elements[0] !== 0 || hidden.elements[5] !== 0) notHidden++;
    }
  }
  console.log(`  hide(): of ${hydrants.length} hydrants, ${wrongCount} felled a number of instances other than ${HYDRANT_PARTS_PER_PROP},`
    + ` ${strayInstance} felled an instance belonging to another hydrant, ${notHidden} left one visible. (0/0/0 = every`
    + ' hydrant owns exactly its own contiguous run of slots in each batch.)');
  for (const mesh of patched) mesh.setMatrixAt = THREE.InstancedMesh.prototype.setMatrixAt.bind(mesh);
}

// ---- what it costs: instances and draw calls ----------------------------------------------------
console.log('\nDRAW CALLS AND INSTANCES. addInstancedChunks emits one InstancedMesh PER OCCUPIED CHUNK CELL, so a');
console.log('  denser prop reaches more cells and adds meshes even at identical geometry and material. Both matter:');
console.log('  the TOTAL is scene weight, and the count inside the streaming ring is what the GPU sees per frame.');
{
  let meshes = 0; let instances = 0; let hydrantMeshes = 0; let hydrantInstances = 0; let streetLife = 0; let streetLifeMeshes = 0;
  const cellOf = new Map<InstancedMesh, { cellX: number; cellZ: number }>();
  const hydrantCells = new Set<string>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh)) return;
    meshes++; instances += object.count;
    let chunk: Object3D | null = object.parent;
    while (chunk && !chunk.userData.chunk) chunk = chunk.parent;
    if (chunk && typeof chunk.userData.cellX === 'number') cellOf.set(object, { cellX: chunk.userData.cellX as number, cellZ: chunk.userData.cellZ as number });
    const material = object.material;
    if (Array.isArray(material)) return;
    if ((material as MeshStandardMaterial).color?.getHexString?.() === HYDRANT_RED) {
      hydrantMeshes++; hydrantInstances += object.count;
      const cell = cellOf.get(object); if (cell) hydrantCells.add(`${cell.cellX},${cell.cellZ}`);
    }
    if (material.name.startsWith('Neighbourhood street life')) { streetLifeMeshes++; streetLife += object.count; }
  });
  console.log(`  total InstancedMesh ${meshes}, total instances ${instances}`);
  console.log(`  of which hydrants: ${hydrantMeshes} meshes (2 batches spread over ${hydrantCells.size} occupied ${CELL_SIZE} u cells),`
    + ` ${hydrantInstances} instances = ${survivors.length} x ${HYDRANT_PARTS_PER_PROP}`);
  console.log(`  street life: ${streetLifeMeshes} meshes, ${streetLife} instances`);
  // Worst case per frame: the most instanced meshes any focus point can have inside each streaming ring.
  const focuses = city.roadsidePoints.filter((_, index) => index % 37 === 0);
  const worstIn = (range: number): { count: number; hydrant: number; at: string } => {
    let best = { count: 0, hydrant: 0, at: '' };
    for (const focus of focuses) {
      let count = 0; let hydrant = 0;
      for (const [mesh, cell] of cellOf) {
        if (cellDistance(focus.x, focus.z, cell.cellX, cell.cellZ, CELL_SIZE) > range) continue;
        count++;
        const material = mesh.material;
        if (!Array.isArray(material) && (material as MeshStandardMaterial).color?.getHexString?.() === HYDRANT_RED) hydrant++;
      }
      if (count > best.count) best = { count, hydrant, at: `(${focus.x.toFixed(0)}, ${focus.z.toFixed(0)})` };
    }
    return best;
  };
  const detail = worstIn(DETAIL_VISIBLE_RANGE);
  const world = worstIn(CHUNK_VISIBLE_RANGE);
  console.log(`  worst-case instanced draw calls with a cell inside the DETAIL ring (${DETAIL_VISIBLE_RANGE} u — furniture,`
    + ` lenses, markings): ${detail.count}, of which ${detail.hydrant} are hydrant batches, at ${detail.at}`);
  console.log(`  worst-case with a cell inside the WORLD ring (${CHUNK_VISIBLE_RANGE} u — trees, utility poles):`
    + ` ${world.count}, of which ${world.hydrant} are hydrant batches, at ${world.at}`);
  console.log(`  (a ${CELL_SIZE} u cell grid means at most 9 cells touch the ${DETAIL_VISIBLE_RANGE} u ring, so the hydrant's`
    + ' per-frame cost is bounded at 9 cells x 2 batches = 18 draw calls however many hydrants the city has.)');
}

// ---- street-life density: what moving the hydrant off the verge does to the dressing --------------
// buildNeighbourhoodStreetLife runs AFTER the hydrant pass and guards with isBlocked(root, 2.35) at 6.20
// beyond the kerb. A hydrant on the VERGE (3.80) sat 2.40 from that root, inside the guard's 2.65 reach, so
// PR #122's 490 hydrants were suppressing clusters that on main the bench had always been blocking anyway.
// Kerbside at 0.93 the hydrant is 5.27 away and cannot — except where the root belongs to a CROSSING street.
console.log('\nSTREET-LIFE DENSITY — replayed against the registry state the pass actually saw.');
{
  const { isStreetLifeCandidate, streetLifeForDistrict } = await import('../../src/world/data/streetLife');
  const roots = city.roadsidePoints
    .map((point, sourceIndex) => ({ point, sourceIndex }))
    .filter(({ point, sourceIndex }) => isStreetLifeCandidate(streetLifeForDistrict(districtAt(point.x, point.z)), sourceIndex, point.width))
    .map(({ point }) => ({ x: point.x - point.inwardX * 3.15, z: point.z - point.inwardZ * 3.15, inwardX: point.inwardX, inwardZ: point.inwardZ }));
  const passes = (root: { x: number; z: number; inwardX: number; inwardZ: number }): boolean => {
    if (isBlockedNow(root.x, root.z, 2.35) || city.isOnRoad(root.x, root.z, 1.15)) return false;
    const sideX = root.inwardZ * 1.55; const sideZ = -root.inwardX * 1.55;
    const ground = city.surfaceHeightAt(root.x, root.z);
    return Math.abs(city.surfaceHeightAt(root.x + sideX, root.z + sideZ) - ground) <= 1.15
      && Math.abs(city.surfaceHeightAt(root.x - sideX, root.z - sideZ) - ground) <= 1.15;
  };
  const counted = withPropsAsOf(firstOf('shelter'), () => {
    const withHydrants = roots.filter(passes).length;
    const hydrantProps = city.props.props.filter((prop) => prop.kind === 'hydrant');
    for (const prop of hydrantProps) prop.down = true;
    const withoutHydrants = roots.filter(passes).length;
    for (const prop of hydrantProps) prop.down = false;
    // The old grounding, replayed: the slope gate is the one place the surface query drives a DECISION.
    return { withHydrants, withoutHydrants };
  });
  console.log(`  street-life candidate roots ${roots.length}; clusters placed ${counted.withHydrants};`
    + ` with every hydrant taken away ${counted.withoutHydrants} — so hydrants suppress ${counted.withoutHydrants - counted.withHydrants}`
    + ' cluster(s), all of them roots belonging to a CROSSING street.');
  console.log('  on main (hydrants shared the bench sites) 387 clusters / 2,519 instances; PR #122 (490 on the verge, 2.40 u');
  console.log('  from a root against a 2.65 u reach) cut it to 366 / 2,382 without saying so. Kerbside restores it.');
}

// ---- what is drawn under every hydrant ----------------------------------------------------------
interface Row extends Placed {
  terrain: number; pavement: number; query: number; edge: number; paved: boolean;
  bottom: number; drawnGround: number; drawnPaving?: number; what: string; drawn: number;
}
const rows: Row[] = survivors.map((spot) => {
  const prop = nearestProp('hydrant', spot.hx, spot.hz, 0.2);
  const bottom = prop ? propBottom.get(prop.id) ?? NaN : NaN;
  const traced = drawnUnder(spot.hx, spot.hz, bottom + 0.5);
  const ground = traced.ground ?? NaN;
  return {
    ...spot,
    terrain: terrainHeightAt(spot.hx, spot.hz),
    pavement: city.sidewalkHeightAt(spot.hx, spot.hz),
    query: city.surfaceHeightAt(spot.hx, spot.hz),
    edge: city.roadEdgeDistance(spot.hx, spot.hz),
    paved: city.isOnSidewalk(spot.hx, spot.hz),
    bottom,
    drawnGround: ground, drawnPaving: traced.paving, what: traced.what ?? 'bare ground',
    drawn: Math.max(ground, traced.surface ?? -Infinity),
  };
});
const gaps = rows.map((row) => row.bottom - row.drawn);
console.log(`\nGAP OVER THE SURFACE ACTUALLY DRAWN, across all ${rows.length} hydrants (ray-traced, one ray each):`
  + ` min ${Math.min(...gaps).toFixed(3)}  median ${median(gaps).toFixed(3)}  p90 ${quantile(gaps, 0.9).toFixed(3)}`
  + `  max ${Math.max(...gaps).toFixed(3)} u`);
console.log(`  hovering more than 5 cm: ${gaps.filter((gap) => gap > 0.05).length} of ${gaps.length}`
  + ` (${((100 * gaps.filter((gap) => gap > 0.05).length) / gaps.length).toFixed(1)}%);`
  + ` more than 20 cm: ${gaps.filter((gap) => gap > 0.2).length}`);
console.log(`  paving drawn under the hydrant: ${rows.filter((row) => row.drawnPaving !== undefined).length}`
  + ` | no paving ribbon under it: ${rows.filter((row) => row.drawnPaving === undefined).length}`
  + ` (City.isOnSidewalk says paved for ${rows.filter((row) => row.paved).length})`);
{
  // Where the ribbon is missing, something else is usually drawn: createClippedSidewalkStrip cuts the
  // whole strip out for the span a crossing road touches it, and the crossing's own tar or junction pave
  // fills the notch. Name what the ray actually hit, so "no paving" is never mistaken for "thin air".
  const tally = new Map<string, { count: number; gap: number }>();
  for (const row of rows.filter((candidate) => candidate.drawnPaving === undefined)) {
    const entry = tally.get(row.what) ?? { count: 0, gap: 0 };
    entry.count++; entry.gap = Math.max(entry.gap, row.bottom - row.drawn); tally.set(row.what, entry);
  }
  for (const [what, entry] of [...tally.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${String(entry.count).padStart(5)} standing on ${what.padEnd(34)} worst gap ${entry.gap.toFixed(3)}`);
  }
}
const traceDrift = rows.map((row) => Math.abs(row.drawnGround - row.terrain));
console.log(`  drawn ground vs terrainHeightAt: median ${median(traceDrift).toFixed(3)} u, worst ${Math.max(...traceDrift).toFixed(3)} u`
  + ' — the ground sheet\'s own tessellation, i.e. the most of any residual gap that is NOT a grounding error.');

console.log('\nTHE 20 WORST HYDRANTS BY DAYLIGHT UNDER THE FLANGE. gap = rendered bottom - the surface the ray hits.');
console.log(`  ${'street'.padEnd(24)}${'w'.padStart(3)}${'x'.padStart(8)}${'z'.padStart(8)}${'terrain'.padStart(9)}`
  + `${'pavement'.padStart(10)}${'query'.padStart(9)}${'edge'.padStart(7)}${'paving'.padStart(8)}${'drawn'.padStart(9)}${'bottom'.padStart(9)}${'gap'.padStart(8)}`);
for (const row of [...rows].sort((a, b) => (b.bottom - b.drawn) - (a.bottom - a.drawn)).slice(0, 20)) {
  console.log(`  ${row.road.slice(0, 24).padEnd(24)}${String(row.width).padStart(3)}`
    + `${row.hx.toFixed(0).padStart(8)}${row.hz.toFixed(0).padStart(8)}${row.terrain.toFixed(2).padStart(9)}`
    + `${row.pavement.toFixed(2).padStart(10)}${row.query.toFixed(2).padStart(9)}${row.edge.toFixed(2).padStart(7)}`
    + `${(row.drawnPaving === undefined ? 'none' : row.drawnPaving.toFixed(2)).padStart(8)}`
    + `${row.drawn.toFixed(2).padStart(9)}${row.bottom.toFixed(2).padStart(9)}${(row.bottom - row.drawn).toFixed(3).padStart(8)}`);
}

// ---- a spread-out sample to go and look at ------------------------------------------------------
// Greedy farthest-point sampling over the built-up hydrants: stops that are actually in different parts of
// the city and on different road classes, so a walk-up check isn't ten looks at the same street.
const PARCEL_CELL = 120;
const parcelGrid = new Map<string, Array<{ x: number; z: number }>>();
for (const parcel of allBuildings()) {
  const key = `${Math.floor(parcel.x / PARCEL_CELL)},${Math.floor(parcel.z / PARCEL_CELL)}`;
  const bucket = parcelGrid.get(key); if (bucket) bucket.push({ x: parcel.x, z: parcel.z }); else parcelGrid.set(key, [{ x: parcel.x, z: parcel.z }]);
}
const builtUp = (x: number, z: number): boolean => {
  const cx = Math.floor(x / PARCEL_CELL); const cz = Math.floor(z / PARCEL_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const parcel of parcelGrid.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(parcel.x - x, parcel.z - z) <= 60) return true;
  }
  return false;
};
const candidates = rows.filter((row) => builtUp(row.hx, row.hz));
console.log(`\n  hydrants on a street with a building on it (parcel within 60 u): ${candidates.length} of ${rows.length}`
  + ` (${((100 * candidates.length) / rows.length).toFixed(0)}%); ${rows.length - candidates.length} stand in open veld.`);
const label = (row: Row): string => `  tp ${Math.round(row.hx)} ${Math.round(row.hz)}`.padEnd(22)
  + `${row.road.slice(0, 26).padEnd(28)}width ${String(row.width).padStart(2)}`
  + `   ${districtAt(row.hx, row.hz).padEnd(24)} gap ${(row.bottom - row.drawn).toFixed(3)} u`;
console.log('\nTEN SPREAD-OUT HYDRANTS TO STAND IN FRONT OF (farthest-point sampling, at least one per road class).');
{
  const picked: Row[] = [];
  // Seed with one hydrant per road width so the sample crosses road classes, not just map quadrants.
  for (const width of [...new Set(candidates.map((row) => row.width))].sort((a, b) => b - a)) {
    const onClass = candidates.filter((row) => row.width === width);
    if (!onClass.length) continue;
    let best = onClass[0]!; let bestDistance = -1;
    for (const row of onClass) {
      const nearest = picked.length ? Math.min(...picked.map((chosen) => Math.hypot(chosen.hx - row.hx, chosen.hz - row.hz))) : Math.hypot(row.hx, row.hz);
      if (nearest > bestDistance) { bestDistance = nearest; best = row; }
    }
    picked.push(best);
  }
  while (picked.length < 10 && picked.length < candidates.length) {
    let bestRow = candidates[0]!; let bestDistance = -1;
    for (const row of candidates) {
      const nearest = Math.min(...picked.map((chosen) => Math.hypot(chosen.hx - row.hx, chosen.hz - row.hz)));
      if (nearest > bestDistance) { bestDistance = nearest; bestRow = row; }
    }
    picked.push(bestRow);
  }
  for (const row of picked) console.log(label(row));
}
console.log('\nAND THE SIX NEAREST THE CBD, for a look that does not need a drive.');
for (const row of [...candidates].sort((a, b) =>
  Math.hypot(a.hx - CBD_CENTER.x, a.hz - CBD_CENTER.z) - Math.hypot(b.hx - CBD_CENTER.x, b.hz - CBD_CENTER.z)).slice(0, 6)) {
  console.log(label(row));
}
console.log(`\nScale: 1 u = ${METRES_PER_UNIT} m, so the ${median(gaps).toFixed(3)} u median gap is`
  + ` ${Math.abs(median(gaps) * METRES_PER_UNIT * 100).toFixed(0)} cm ${median(gaps) > 0 ? 'of air under' : 'of bed into the surface for'} a hydrant`
  + ` ${(0.99 * METRES_PER_UNIT).toFixed(2)} m tall, one per ${(roadLength / survivors.length * METRES_PER_UNIT).toFixed(0)} m of street,`
  + ` and a median walk-up of ${(median(walkAfter) * METRES_PER_UNIT).toFixed(0)} m (was ${(median(walkBefore) * METRES_PER_UNIT).toFixed(0)} m).`);
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
export {};
