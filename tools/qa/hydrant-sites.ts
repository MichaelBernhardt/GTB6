/**
 * Fire-hydrant siting audit — what every hydrant in the city stands on, and how many there are.
 *
 * Two separate questions, both answered against the REAL built city rather than a re-derivation: this
 * constructs City headlessly, so the site list, the guards, the prop registry and the instance matrices
 * are the ones the game ships. Any number here is the number a player sees.
 *
 *   (a) DOES IT TOUCH THE GROUND? Every roadside family is reported with the distance from the road edge
 *       it actually stands at, the surface the renderer actually draws there (ray-traced against the real
 *       triangles, not queried), and the measured world-space bottom of its rendered geometry. Gap
 *       positive = hovering; negative = bedded in. This is the measurement that caught the original
 *       fault: UrbanInfrastructure was handed City.sidewalkHeightAt, which is terrain + 0.37
 *       UNCONDITIONALLY — the height of the pavement whether or not any pavement is drawn at that spot —
 *       while the paving stops at ROAD_BUILD_MARGIN and every furniture pass stepped OUTWARD past it.
 *
 *   (b) WHY CAN'T I FIND ONE? The census: how many roadside points exist, how many survive each guard,
 *       and the walk-up distribution — how far a typical point on the pavement network is from its nearest
 *       hydrant, and how many hydrants stand on a street with buildings on it.
 *
 *   npx tsx tools/qa/hydrant-sites.ts
 */
import type { Box3, Mesh, MeshStandardMaterial } from 'three';
import type { RoadsidePoint } from '../../src/world/City';
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
  City, GROUND_SEGMENTS, ROAD_NETWORK, ROAD_SAMPLE_SPACING, ROAD_SURFACE_OFFSET, ROADSIDE_OFFSET,
  SIDEWALK_CENTER, SIDEWALK_INNER_EDGE, SIDEWALK_RISE, SIDEWALK_WIDTH,
  districtAt, offsetRoadPath, sampleRoadPath, terrainHeightAt,
} = await import('../../src/world/City');
const {
  BENCH_SITE_STRIDE, BENCH_VERGE_DISTANCE, BIN_SITE_STRIDE, BIN_VERGE_DISTANCE, HYDRANT_FLANGE_RADIUS,
  HYDRANT_KERB_DISTANCE, HYDRANT_SITE_STRIDE, UTILITY_SITE_STRIDE, isHydrantSite, onRoadsideStride,
} = await import('../../src/world/UrbanInfrastructure');
const { CBD_CENTER, METRES_PER_UNIT, ROAD_BUILD_MARGIN, distanceToRailwayCorridor } = await import('../../src/world/mapData');
const { allBuildings } = await import('../../src/world/CityGen');
const { WORLD_SIZE } = await import('../../src/config');

/** Where each furniture pass plants its prop, as a distance beyond the kerb (UrbanInfrastructure). */
const FURNITURE_SITE: ReadonlyArray<{ kind: PropKind; label: string; kerb: number; colors: string[] }> = [
  { kind: 'hydrant', label: 'fire hydrant', kerb: HYDRANT_KERB_DISTANCE, colors: ['a8322d'] },
  { kind: 'streetlight', label: 'streetlamp', kerb: ROADSIDE_OFFSET, colors: ['253033'] },
  { kind: 'bin', label: 'litter bin', kerb: BIN_VERGE_DISTANCE, colors: ['3f5c46', '22302a'] },
  { kind: 'bench', label: 'park bench', kerb: BENCH_VERGE_DISTANCE, colors: ['744d32', '2c3739'] },
  { kind: 'post', label: 'utility cabinet', kerb: ROADSIDE_OFFSET + 1.35, colors: ['a6a8a1', '405c4b', '263c34', 'f2c230', 'd7aa23'] },
  { kind: 'shrub', label: 'verge shrub', kerb: ROADSIDE_OFFSET + 2.1, colors: ['365f3d'] },
];
const HYDRANT_SPACING = 1.2;
const HYDRANT_PARTS_PER_PROP = 6; // two instanced batches, three parts each — the whole instance cost of a hydrant
const PAVEMENT_OUTER_EDGE = SIDEWALK_CENTER + SIDEWALK_WIDTH / 2;

const scene = new THREE.Scene();
const started = Date.now();
const city = new City(scene, 'low', false);
const hydrants = city.props.props.filter((prop) => prop.kind === 'hydrant');
console.log(`built the city headlessly in ${((Date.now() - started) / 1000).toFixed(1)}s`
  + ` — ${city.roadsidePoints.length} roadside points, ${city.props.props.length} props, ${hydrants.length} hydrants`);

// ---- the grounding contract ---------------------------------------------------------------------
console.log('\nGROUNDING. UrbanInfrastructure receives (x, z) => City.surfaceHeightAt(x, z) — the surface actually drawn.');
console.log(`  sidewalkHeightAt (what it used to receive) = terrain + ROAD_SURFACE_OFFSET ${ROAD_SURFACE_OFFSET}`
  + ` + SIDEWALK_RISE ${SIDEWALK_RISE} = terrain + ${(ROAD_SURFACE_OFFSET + SIDEWALK_RISE).toFixed(2)}, unconditionally,`
  + ' with no test for whether pavement is drawn there.');
console.log(`  paving is DRAWN from ${SIDEWALK_INNER_EDGE} to ${PAVEMENT_OUTER_EDGE} u beyond the kerb`
  + ` (SIDEWALK_INNER_EDGE .. SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH ${SIDEWALK_WIDTH}; ROAD_BUILD_MARGIN ${ROAD_BUILD_MARGIN}).`);
console.log(`  the roadside line sits ${ROADSIDE_OFFSET} u beyond the kerb — only ${(PAVEMENT_OUTER_EDGE - ROADSIDE_OFFSET).toFixed(2)} u`
  + ` inside the paving's outer edge, so any pass stepping outward from it stands its prop on grass.`);
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
const median = (values: number[]): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const quantile = (values: number[], p: number): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

// ---- what is actually drawn under a hydrant ------------------------------------------------------
// Nothing above proves what the RENDERER puts there — City.surfaceHeightAt is a query, not a mesh. So
// drop a ray through each hydrant and hit the real triangles: the ground sheet, and the pavement ribbon
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
scene.traverse((object) => {
  if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
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
console.log('  (up to 200 props per family, evenly strided). Positive = hovering, negative = bedded into the surface.');
console.log(`  ${'family'.padEnd(16)}${'kerb'.padStart(6)}${'edge'.padStart(7)}${'on paving'.padStart(11)}`
  + `${'query gap'.padStart(11)}${'drawn med'.padStart(11)}${'drawn p90'.padStart(11)}${'drawn max'.padStart(11)}${'props'.padStart(8)}`);
const RAY_SAMPLE = 200;
for (const family of FURNITURE_SITE) {
  const props = city.props.props.filter((prop) => prop.kind === family.kind && propBottom.has(prop.id));
  const bottoms = props.map((prop) => propBottom.get(prop.id)!);
  const queryGaps = props.map((prop, index) => bottoms[index]! - city.surfaceHeightAt(prop.x, prop.z));
  const edges = props.map((prop) => city.roadEdgeDistance(prop.x, prop.z));
  const paved = props.filter((prop) => city.isOnSidewalk(prop.x, prop.z)).length;
  const stride = Math.max(1, Math.ceil(props.length / RAY_SAMPLE));
  const drawnGaps: number[] = [];
  props.forEach((prop, index) => {
    if (index % stride !== 0) return;
    const traced = drawnUnder(prop.x, prop.z, bottoms[index]! + 0.5);
    const drawn = Math.max(traced.ground ?? -Infinity, traced.surface ?? -Infinity);
    if (Number.isFinite(drawn)) drawnGaps.push(bottoms[index]! - drawn);
  });
  console.log(`  ${family.label.padEnd(16)}${family.kerb.toFixed(2).padStart(6)}${median(edges).toFixed(2).padStart(7)}`
    + `${`${((100 * paved) / (props.length || 1)).toFixed(0)}%`.padStart(11)}${median(queryGaps).toFixed(3).padStart(11)}`
    + `${median(drawnGaps).toFixed(3).padStart(11)}${quantile(drawnGaps, 0.9).toFixed(3).padStart(11)}`
    + `${Math.max(...drawnGaps).toFixed(3).padStart(11)}${String(props.length).padStart(8)}`);
}
console.log(`  (${instancesSeen} instances walked, ${instancesOrphaned} unattributable to a registered prop.`
  + ' Roadside trees take the shrub\'s 2.10 step and the same grounding, but their GLB is asset-gated: a headless'
  + ' build instances none of them, so they cannot be measured here.)');

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
    if ((material as MeshStandardMaterial).color.getHexString() !== 'a8322d') return;
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

// ---- reproduce the roadside list WITH road identity ---------------------------------------------
// City.addRoadsidePoints, verbatim, but tagged: the hydrant stride is an index into this exact array,
// so an approximation here would name the wrong street and hand the owner the wrong coordinates.
interface Site extends RoadsidePoint { road: string; side: number; index: number; surface: number }
const sites: Site[] = [];
const centrelines: Array<{ points: ReturnType<typeof sampleRoadPath>; width: number; closed: boolean }> = [];
for (const definition of ROAD_NETWORK) {
  const closed = definition.closed ?? false;
  const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
  const surface = centrelines.length;
  centrelines.push({ points: sampled, width: definition.width, closed });
  for (const side of [-1, 1] as const) {
    const path = offsetRoadPath(sampled, side * (definition.width / 2 + ROADSIDE_OFFSET), closed);
    path.forEach((point, index) => {
      if (index % 2 !== 0) return;
      const previous = sampled[index === 0 ? (closed ? sampled.length - 1 : 0) : index - 1] ?? sampled[index] ?? point;
      const next = sampled[index === sampled.length - 1 ? (closed ? 0 : sampled.length - 1) : index + 1] ?? sampled[index] ?? point;
      const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
      const normalX = -dz / length; const normalZ = dx / length;
      sites.push({
        x: point.x, z: point.z, inwardX: -normalX * side, inwardZ: -normalZ * side,
        width: definition.width, road: definition.name, side, index: sites.length, surface,
      });
    });
  }
}
const drift = sites.reduce((worst, site, index) => {
  const live = city.roadsidePoints[index];
  if (!live) return Infinity;
  return Math.max(worst, Math.abs(live.x - site.x) + Math.abs(live.z - site.z)
    + Math.abs(live.inwardX - site.inwardX) + Math.abs(live.width - site.width));
}, 0);
console.log(`\nroadside list reproduced: ${sites.length} of ${city.roadsidePoints.length} points, worst drift ${drift}`);

// ---- census ------------------------------------------------------------------------------------
/** Run `body` with the prop registry rolled back to the moment `cutId` was registered: every furniture
 *  pass filters its whole site list before registering anything, so a guard replayed after the build
 *  would otherwise see the very props it is deciding about (a hydrant blocking its own site). */
const withPropsAsOf = <T>(cutId: number, body: () => T): T => {
  const stood: PropCollider[] = [];
  for (const prop of city.props.props) if (prop.id >= cutId && !prop.down) { prop.down = true; stood.push(prop); }
  try { return body(); } finally { for (const prop of stood) prop.down = false; }
};
const firstOf = (kind: PropKind): number => city.props.props.find((prop) => prop.kind === kind)?.id ?? 0;
const isBlocked = (x: number, z: number, radius: number): boolean => // City.ts:907, verbatim
  city.collides(x, z, radius) || city.isReserved(x, z, radius) || distanceToRailwayCorridor(x, z) < radius + 0.6;

/** buildFireHydrants' guard radii, both derived from the flange (UrbanInfrastructure). */
const BLOCK_PROBE = HYDRANT_FLANGE_RADIUS + 0.1;
const ROAD_PROBE = HYDRANT_FLANGE_RADIUS + 0.06;
/** UrbanInfrastructure.atKerbDistance: inward points at the carriageway. */
const atKerb = (site: Site, kerb: number): { hx: number; hz: number } => ({
  hx: site.x + site.inwardX * (ROADSIDE_OFFSET - kerb),
  hz: site.z + site.inwardZ * (ROADSIDE_OFFSET - kerb),
});
interface Placed extends Site { hx: number; hz: number }
const runHydrantPass = (stride: number, offset: number, minWidth: number, kerb = HYDRANT_KERB_DISTANCE, paved = true): Placed[] => {
  const placed: Placed[] = [];
  for (const site of sites) {
    if (!onRoadsideStride(site.index, stride, offset) || site.width < minWidth) continue;
    if (paved && !city.isPavementDrawn(site)) continue;
    const { hx, hz } = atKerb(site, kerb);
    if (isBlocked(hx, hz, BLOCK_PROBE) || city.isOnRoad(hx, hz, ROAD_PROBE)) continue;
    if (!placed.every((spot) => (spot.hx - hx) ** 2 + (spot.hz - hz) ** 2 >= HYDRANT_SPACING ** 2)) continue;
    placed.push({ ...site, hx, hz });
  }
  return placed;
};
const onStride = sites.filter((site) => isHydrantSite(site.index));
/** Distance beyond the edge of the site's OWN carriageway — so an isRoad() rejection can be attributed
 *  to a crossing street rather than to the road the hydrant belongs to. */
const ownRoadEdgeDistance = (site: Site, x: number, z: number): number => {
  const road = centrelines[site.surface]!;
  const count = road.closed ? road.points.length : road.points.length - 1;
  let best = Infinity;
  for (let index = 0; index < count; index++) {
    const a = road.points[index]!; const b = road.points[(index + 1) % road.points.length]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const lengthSquared = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best - road.width / 2;
};
const survivors = withPropsAsOf(firstOf('hydrant'), () => {
  const paved = onStride.filter((site) => city.isPavementDrawn(site));
  const unblocked = paved.filter((site) => { const { hx, hz } = atKerb(site, HYDRANT_KERB_DISTANCE); return !isBlocked(hx, hz, BLOCK_PROBE); });
  const clear = unblocked.filter((site) => { const { hx, hz } = atKerb(site, HYDRANT_KERB_DISTANCE); return !city.isOnRoad(hx, hz, ROAD_PROBE); });
  const onOwnRoad = unblocked.filter((site) => {
    const { hx, hz } = atKerb(site, HYDRANT_KERB_DISTANCE);
    return city.isOnRoad(hx, hz, ROAD_PROBE) && ownRoadEdgeDistance(site, hx, hz) <= ROAD_PROBE;
  }).length;
  const final = runHydrantPass(HYDRANT_SITE_STRIDE, 11, 0);
  console.log('\nCENSUS — every guard in buildFireHydrants, replayed against the state it actually saw.');
  console.log(`  roadside points                        ${String(sites.length).padStart(6)}`);
  console.log(`  on the hydrant stride (${HYDRANT_SITE_STRIDE}, offset 11)      ${String(onStride.length).padStart(6)}`
    + `   (bench ${BENCH_SITE_STRIDE}, bin ${BIN_SITE_STRIDE}, cabinet ${UTILITY_SITE_STRIDE}; no width gate — every paved street)`);
  console.log(`  isPavementDrawn(point)                 ${String(paved.length).padStart(6)}   ${onStride.length - paved.length} sites beside a crossing, where the ribbon is clipped away`);
  console.log(`  not isBlocked(spot, ${BLOCK_PROBE.toFixed(3)})           ${String(unblocked.length).padStart(6)}`);
  console.log(`  not isRoad(spot, ${ROAD_PROBE.toFixed(3)})               ${String(clear.length).padStart(6)}   ${unblocked.length - clear.length} rejected for standing on tar:`
    + ` ${onOwnRoad} on their OWN carriageway (the kerb line folded inside a bend), ${unblocked.length - clear.length - onOwnRoad} on a crossing street or track`);
  console.log(`  spacedFrom(${HYDRANT_SPACING} u)                     ${String(final.length).padStart(6)}   <== placed`);
  console.log(`  registered in the prop registry        ${String(hydrants.length).padStart(6)}`);
  const mismatched = final.filter((spot, index) => {
    const prop = hydrants[index];
    return !prop || Math.abs(prop.x - spot.hx) > 1e-9 || Math.abs(prop.z - spot.hz) > 1e-9;
  }).length;
  console.log(`  replay vs registry mismatches          ${String(mismatched).padStart(6)}`);
  return final;
});

// ---- what the stride and the width gate cost ----------------------------------------------------
console.log('\nWHAT THE GATES COST — same pass, one knob changed at a time. Walk-up = median distance from a');
console.log('  roadside point to its nearest hydrant, the number that decides whether a player can find one.');
const variants: Array<{ label: string; stride: number; minWidth: number; kerb?: number; paved?: boolean }> = [
  { label: 'stride 19, width >= 9, verge (what the owner played)', stride: 19, minWidth: 9, kerb: ROADSIDE_OFFSET + 0.75, paved: false },
  { label: 'stride 19, width >= 9, kerbside', stride: 19, minWidth: 9 },
  { label: 'stride 19, kerbside, no width gate', stride: 19, minWidth: 0 },
  { label: `stride ${BENCH_SITE_STRIDE}, kerbside, no width gate`, stride: BENCH_SITE_STRIDE, minWidth: 0 },
  { label: 'stride 11, kerbside, width >= 9', stride: 11, minWidth: 9 },
  { label: 'stride 11, kerbside, no width gate (shipping)', stride: 11, minWidth: 0 },
  { label: 'stride 9, kerbside, no width gate', stride: 9, minWidth: 0 },
  { label: 'stride 7, kerbside, no width gate', stride: 7, minWidth: 0 },
];
const walkUpMedian = (placed: Placed[]): number => {
  const cell = 120;
  const buckets = new Map<string, Placed[]>();
  for (const spot of placed) {
    const key = `${Math.floor(spot.hx / cell)},${Math.floor(spot.hz / cell)}`;
    const bucket = buckets.get(key); if (bucket) bucket.push(spot); else buckets.set(key, [spot]);
  }
  const distances = sites.filter((_, index) => index % 7 === 0).map((site) => {
    const cx = Math.floor(site.x / cell); const cz = Math.floor(site.z / cell);
    for (let reach = 1; reach <= 40; reach++) {
      let best = Infinity;
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        for (const spot of buckets.get(`${cx + dx},${cz + dz}`) ?? []) best = Math.min(best, Math.hypot(spot.hx - site.x, spot.hz - site.z));
      }
      if (best <= (reach - 1) * cell) return best;
    }
    return Infinity;
  });
  return median(distances);
};
for (const variant of variants) {
  const placed = withPropsAsOf(firstOf('hydrant'), () => runHydrantPass(variant.stride, 11, variant.minWidth, variant.kerb, variant.paved ?? true));
  console.log(`  ${variant.label.padEnd(52)} ${String(placed.length).padStart(5)} hydrants`
    + `   ${placed.length * HYDRANT_PARTS_PER_PROP} instances   walk-up ${walkUpMedian(placed).toFixed(0).padStart(4)} u`);
}

// ---- road width: how much of the city is even eligible ------------------------------------------
const widthTally = new Map<number, { points: number; length: number }>();
for (const definition of ROAD_NETWORK) {
  const closed = definition.closed ?? false;
  const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
  let length = 0;
  for (let index = 0; index < (closed ? sampled.length : sampled.length - 1); index++) {
    const a = sampled[index]!; const b = sampled[(index + 1) % sampled.length]!;
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const entry = widthTally.get(definition.width) ?? { points: 0, length: 0 };
  entry.length += length; widthTally.set(definition.width, entry);
}
for (const site of sites) {
  const entry = widthTally.get(site.width);
  if (entry) entry.points++;
}
const totalLength = [...widthTally.values()].reduce((sum, entry) => sum + entry.length, 0);
console.log('\nROAD WIDTH — hydrants per width band, in street-kilometres and roadside points. The old width >= 9');
console.log('  gate emptied every band below it; a hydrant belongs on an ordinary street, so there is no gate now.');
for (const [width, entry] of [...widthTally.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  width ${String(width).padStart(4)}  ${(entry.length / 1000).toFixed(2).padStart(6)} km`
    + ` (${((100 * entry.length) / totalLength).toFixed(1).padStart(5)}% of the network)   ${String(entry.points).padStart(6)} roadside points`
    + `   hydrants ${String(survivors.filter((spot) => spot.width === width).length).padStart(4)}`);
}
const eligible = totalLength; // every paved street can carry one now
console.log(`  eligible: ${(eligible / 1000).toFixed(2)} km of ${(totalLength / 1000).toFixed(2)} km`
  + ` = ${((100 * eligible) / totalLength).toFixed(1)}% of the street network can carry a hydrant.`);
console.log(`  one hydrant per ${(totalLength / survivors.length).toFixed(0)} u of street`
  + ` (${(totalLength / survivors.length * METRES_PER_UNIT).toFixed(0)} m), on ${survivors.length * HYDRANT_PARTS_PER_PROP} instances across the two batches.`);

// ---- walk-up distribution ----------------------------------------------------------------------
const CELL = 120;
const grid = new Map<string, Placed[]>();
for (const spot of survivors) {
  const key = `${Math.floor(spot.hx / CELL)},${Math.floor(spot.hz / CELL)}`;
  const bucket = grid.get(key); if (bucket) bucket.push(spot); else grid.set(key, [spot]);
}
const nearestHydrant = (x: number, z: number): number => {
  const cx = Math.floor(x / CELL); const cz = Math.floor(z / CELL);
  for (let reach = 1; reach <= 40; reach++) {
    let best = Infinity;
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
      for (const spot of grid.get(`${cx + dx},${cz + dz}`) ?? []) best = Math.min(best, Math.hypot(spot.hx - x, spot.hz - z));
    }
    if (best <= (reach - 1) * CELL || (best < Infinity && reach >= 40)) return best;
  }
  return Infinity;
};
const walkDistances = sites.map((site) => nearestHydrant(site.x, site.z));
const wideWalk = sites.filter((site) => site.width >= 9).map((site) => nearestHydrant(site.x, site.z));
console.log('\nWALK-UP DISTANCE — from every roadside point (the pavement network) to its nearest hydrant.');
const report = (label: string, values: number[]): void => console.log(`  ${label.padEnd(34)}`
  + ` median ${median(values).toFixed(0).padStart(5)} u   p90 ${quantile(values, 0.9).toFixed(0).padStart(5)} u`
  + `   p99 ${quantile(values, 0.99).toFixed(0).padStart(5)} u   max ${Math.max(...values).toFixed(0).padStart(5)} u`);
report('every paved street', walkDistances);
report('the wide streets only (w>=9)', wideWalk);
console.log(`  within 50 u of a hydrant: ${((100 * walkDistances.filter((d) => d <= 50).length) / walkDistances.length).toFixed(1)}%`
  + ` of the pavement network | within 150 u: ${((100 * walkDistances.filter((d) => d <= 150).length) / walkDistances.length).toFixed(1)}%`
  + ` | beyond 300 u: ${((100 * walkDistances.filter((d) => d > 300).length) / walkDistances.length).toFixed(1)}%`);

// Built-up = a generated parcel within 60 u. A hydrant out in the veld is placed but never met.
const parcels = allBuildings();
const parcelGrid = new Map<string, Array<{ x: number; z: number }>>();
for (const parcel of parcels) {
  const key = `${Math.floor(parcel.x / CELL)},${Math.floor(parcel.z / CELL)}`;
  const bucket = parcelGrid.get(key); if (bucket) bucket.push(parcel); else parcelGrid.set(key, [{ x: parcel.x, z: parcel.z }]);
}
const builtUp = survivors.filter((spot) => {
  const cx = Math.floor(spot.hx / CELL); const cz = Math.floor(spot.hz / CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const parcel of parcelGrid.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(parcel.x - spot.hx, parcel.z - spot.hz) <= 60) return true;
  }
  return false;
}).length;
console.log(`  hydrants on a street with a building on it (parcel within 60 u): ${builtUp} of ${survivors.length}`
  + ` (${((100 * builtUp) / survivors.length).toFixed(0)}%); ${survivors.length - builtUp} stand in open veld.`);
const districts = new Map<string, number>();
for (const spot of survivors) {
  const district = districtAt(spot.hx, spot.hz);
  districts.set(district, (districts.get(district) ?? 0) + 1);
}
const ranked = [...districts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`  spread over ${ranked.length} districts; the busiest twelve: `
  + ranked.slice(0, 12).map(([name, count]) => `${name} ${count}`).join(', '));

// ---- every site, with what it stands on ---------------------------------------------------------
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
console.log(`\nGAP OVER THE SURFACE ACTUALLY DRAWN, across all ${rows.length} hydrants:`
  + ` min ${Math.min(...gaps).toFixed(3)}  median ${median(gaps).toFixed(3)}  max ${Math.max(...gaps).toFixed(3)} u`);
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
console.log(`  distinct gap values (2 dp): ${[...new Set(gaps.map((gap) => gap.toFixed(2)))].sort().join(', ')}`);
const traceDrift = rows.map((row) => Math.abs(row.drawnGround - row.terrain));
console.log(`  drawn ground vs terrainHeightAt: median ${median(traceDrift).toFixed(3)} u, worst ${Math.max(...traceDrift).toFixed(3)} u`
  + ' — the ground sheet\'s own tessellation, i.e. the most of the gap that is NOT the pavement lift.');

console.log('\nEVERY HYDRANT SITE. gap = rendered bottom - the surface the ray hits (positive = hovering).');
console.log(`  ${'#'.padStart(4)}  ${'street'.padEnd(24)}${'w'.padStart(3)}${'x'.padStart(8)}${'z'.padStart(8)}`
  + `${'terrain'.padStart(9)}${'pavement'.padStart(10)}${'query'.padStart(9)}${'edge'.padStart(7)}${'paving'.padStart(8)}`
  + `${'drawn'.padStart(9)}${'bottom'.padStart(9)}${'gap'.padStart(8)}`);
[...rows].sort((a, b) => a.road.localeCompare(b.road) || a.index - b.index).forEach((row, order) => {
  console.log(`  ${String(order + 1).padStart(4)}  ${row.road.slice(0, 24).padEnd(24)}${String(row.width).padStart(3)}`
    + `${row.hx.toFixed(0).padStart(8)}${row.hz.toFixed(0).padStart(8)}${row.terrain.toFixed(2).padStart(9)}`
    + `${row.pavement.toFixed(2).padStart(10)}${row.query.toFixed(2).padStart(9)}${row.edge.toFixed(2).padStart(7)}`
    + `${(row.drawnPaving === undefined ? 'none' : row.drawnPaving.toFixed(2)).padStart(8)}`
    + `${row.drawn.toFixed(2).padStart(9)}${row.bottom.toFixed(2).padStart(9)}${(row.bottom - row.drawn).toFixed(3).padStart(8)}`);
});

// ---- a spread-out sample to go and look at ------------------------------------------------------
// Greedy farthest-point sampling over the built-up hydrants: ten stops that are actually in different
// parts of the city, so a walk-up check isn't ten looks at the same street.
console.log('\nTEN SPREAD-OUT HYDRANTS TO STAND IN FRONT OF.');
const candidates = rows.filter((row) => {
  const cx = Math.floor(row.hx / CELL); const cz = Math.floor(row.hz / CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const parcel of parcelGrid.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(parcel.x - row.hx, parcel.z - row.hz) <= 60) return true;
  }
  return false;
});
const picked: Row[] = [];
if (candidates.length) {
  picked.push(candidates.reduce((best, row) => (Math.hypot(row.hx, row.hz) < Math.hypot(best.hx, best.hz) ? row : best), candidates[0]!));
  while (picked.length < 10 && picked.length < candidates.length) {
    let bestRow = candidates[0]!; let bestDistance = -1;
    for (const row of candidates) {
      const nearest = Math.min(...picked.map((chosen) => Math.hypot(chosen.hx - row.hx, chosen.hz - row.hz)));
      if (nearest > bestDistance) { bestDistance = nearest; bestRow = row; }
    }
    picked.push(bestRow);
  }
}
const label = (row: Row): string => `  tp ${Math.round(row.hx)} ${Math.round(row.hz)}`.padEnd(22)
  + `${row.road.slice(0, 26).padEnd(28)}width ${String(row.width).padStart(2)}`
  + `   ${districtAt(row.hx, row.hz).padEnd(24)} gap ${(row.bottom - row.drawn).toFixed(3)} u`;
for (const row of picked) console.log(label(row));
console.log('\nAND THE SIX NEAREST THE CBD, for a look that does not need a drive.');
for (const row of [...candidates].sort((a, b) =>
  Math.hypot(a.hx - CBD_CENTER.x, a.hz - CBD_CENTER.z) - Math.hypot(b.hx - CBD_CENTER.x, b.hz - CBD_CENTER.z)).slice(0, 6)) {
  console.log(label(row));
}
console.log(`\nScale: 1 u = ${METRES_PER_UNIT} m, so the ${median(gaps).toFixed(3)} u median gap is`
  + ` ${Math.abs(median(gaps) * METRES_PER_UNIT * 100).toFixed(0)} cm ${median(gaps) > 0 ? 'of air under' : 'of bed into the surface for'} a hydrant`
  + ` ${(0.99 * METRES_PER_UNIT).toFixed(2)} m tall, one per ${(totalLength / survivors.length * METRES_PER_UNIT).toFixed(0)} m of street,`
  + ` and a median walk-up of ${(median(walkDistances) * METRES_PER_UNIT).toFixed(0)} m.`);
