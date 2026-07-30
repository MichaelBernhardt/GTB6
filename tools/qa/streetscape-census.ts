/**
 * Streetscape census — the small set of citywide totals a streetscape change must state, and the ONLY
 * tool here that compiles against any revision of City/UrbanInfrastructure (it imports no constant that
 * any branch added, and identifies the hydrant batches by their material colour). Run it on the revision
 * you are comparing against and diff the two outputs: that is the before/after table for any claim about
 * draw calls, instance counts or street-life density.
 *
 * Compare in a SCRATCH WORKTREE rather than by checking files out over your own work
 * (`git checkout <rev> -- src/world` in a dirty tree will happily eat it):
 *
 *   git worktree add --detach /tmp/census-base origin/main
 *   ln -s "$(pwd)/node_modules" /tmp/census-base/node_modules
 *   cp tools/qa/streetscape-census.ts /tmp/census-base/tools/qa/
 *   (cd /tmp/census-base && npx tsx tools/qa/streetscape-census.ts)
 *   npx tsx tools/qa/streetscape-census.ts        # and the same thing here
 */
import type { InstancedMesh, MeshStandardMaterial, Object3D } from 'three'; // types only: the runtime import is dynamic, below

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
  (globalThis as { document?: unknown }).document = { createElement: element, createElementNS: (_ns: string, tag: string) => element(tag) };
}
installDomStub();

const THREE = await import('three');
const { City } = await import('../../src/world/City');
const { CELL_SIZE } = await import('../../src/world/CityGen');
const { CHUNK_VISIBLE_RANGE, DETAIL_VISIBLE_RANGE, cellDistance } = await import('../../src/world/ChunkVisibility');

const HYDRANT_RED = 'a8322d'; // the hydrant material, identifiable on every revision

const scene = new THREE.Scene();
const city = new City(scene, 'low', false);

let meshes = 0; let instances = 0; let streetLife = 0; let streetLifeMeshes = 0;
let hydrantMeshes = 0; let hydrantInstances = 0;
const hydrantCells = new Set<string>();
/** addInstancedChunks emits one InstancedMesh PER OCCUPIED CHUNK CELL, so the TOTAL count moves when a prop
 *  reaches more cells even at identical geometry and material. What the GPU submits per frame is the count
 *  inside the streaming rings, so both are reported: total = scene weight, ring = frame cost. */
const cellOf = new Map<InstancedMesh, { cellX: number; cellZ: number }>();
scene.traverse((object) => {
  if (!(object instanceof THREE.InstancedMesh)) return;
  meshes++; instances += object.count;
  let chunk: Object3D | null = object.parent;
  while (chunk && !chunk.userData.chunk) chunk = chunk.parent;
  if (chunk && typeof chunk.userData.cellX === 'number') {
    cellOf.set(object, { cellX: chunk.userData.cellX as number, cellZ: chunk.userData.cellZ as number });
  }
  const material = object.material;
  if (Array.isArray(material)) return;
  if ((material as MeshStandardMaterial).color?.getHexString?.() === HYDRANT_RED) {
    hydrantMeshes++; hydrantInstances += object.count;
    const cell = cellOf.get(object); if (cell) hydrantCells.add(`${cell.cellX},${cell.cellZ}`);
  }
  if (material.name.startsWith('Neighbourhood street life')) { streetLifeMeshes++; streetLife += object.count; }
});

/** Worst case over a sample of standable focus points: the most instanced meshes whose cell is inside a ring. */
const worstInRing = (range: number): { count: number; hydrant: number; at: string } => {
  let best = { count: 0, hydrant: 0, at: '' };
  for (const focus of city.roadsidePoints.filter((_, index) => index % 37 === 0)) {
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
const detailRing = worstInRing(DETAIL_VISIBLE_RANGE);
const worldRing = worstInRing(CHUNK_VISIBLE_RANGE);

const byKind = new Map<string, number>();
for (const prop of city.props.props) byKind.set(prop.kind, (byKind.get(prop.kind) ?? 0) + 1);

console.log('STREETSCAPE CENSUS');
console.log(`  roadside points        ${city.roadsidePoints.length}`);
console.log(`  streetlamp anchors     ${city.streetlampPoints.length}`);
console.log(`  props (registry)       ${city.props.props.length}`);
console.log(`  InstancedMesh total    ${meshes}`);
console.log(`  instances total        ${instances}`);
console.log(`  street-life meshes     ${streetLifeMeshes}`);
console.log(`  street-life instances  ${streetLife}`);
console.log(`  hydrant meshes         ${hydrantMeshes}   (2 batches over ${hydrantCells.size} occupied ${CELL_SIZE} u cells)`);
console.log(`  hydrant instances      ${hydrantInstances}`);
console.log(`  worst detail ring      ${detailRing.count} instanced draw calls within ${DETAIL_VISIBLE_RANGE} u, ${detailRing.hydrant} of them hydrant, at ${detailRing.at}`);
console.log(`  worst world ring       ${worldRing.count} instanced draw calls within ${CHUNK_VISIBLE_RANGE} u, ${worldRing.hydrant} of them hydrant, at ${worldRing.at}`);
console.log('  props by kind:');
for (const kind of [...byKind.keys()].sort()) console.log(`    ${kind.padEnd(14)}${String(byKind.get(kind)).padStart(7)}`);
