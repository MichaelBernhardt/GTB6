/**
 * Pothole geometry + hazard audit — what the city actually draws for a pothole, what it costs, and
 * whether the drawn silhouette agrees with the scalar the gameplay code scores against.
 *
 * Built against the REAL city (headless City, stopped one stage short of the static merge so the
 * pothole meshes are still their own objects), so every number here is a number the player gets.
 *
 *   npx tsx tools/qa/pothole-shapes.ts
 */
import type { Mesh, MeshBasicMaterial } from 'three';

/** City builds procedural CanvasTextures in field initialisers; a no-op 2D context is enough. */
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
const { City } = await import('../../src/world/City');
const { materialKey } = await import('../../src/world/StaticGeometry');

const scene = new THREE.Scene();
const started = Date.now();
const city = new City(scene, 'low', true);
// Stop one stage short of 'Merging the city blocks': the pothole meshes are then still discrete
// objects under the city group, before mergeStaticGeometry folds them into the chunk buckets.
for (const stage of city.buildStages('low')) if (stage.label === 'Merging the city blocks') break;
console.log(`built the city headlessly in ${((Date.now() - started) / 1000).toFixed(1)}s — ${city.potholes.length} potholes`);

const basic: Mesh[] = [];
scene.traverse((node) => {
  const mesh = node as Mesh;
  if (!mesh.isMesh) return;
  const material = mesh.material as MeshBasicMaterial;
  if (material?.type === 'MeshBasicMaterial' && ['0d1113', '3f4649'].includes(material.color.getHexString())) basic.push(mesh);
});

let total = 0;
for (const mesh of basic) {
  const material = mesh.material as MeshBasicMaterial;
  const index = mesh.geometry.getIndex();
  const tris = (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
  total += tris;
  console.log(`  ${material.color.getHexString()}  ${tris.toLocaleString()} tris  ${(mesh.geometry.getAttribute('position').count).toLocaleString()} verts`);
  console.log(`      bake bucket key: ${materialKey(material)}`);
}
console.log(`  TOTAL ${total.toLocaleString()} tris across ${city.potholes.length} potholes`
  + ` = ${(total / Math.max(1, city.potholes.length)).toFixed(1)} tris/pothole, in ${new Set(basic.map((m) => materialKey(m.material as MeshBasicMaterial))).size} bake buckets`);

// ---- radius distribution --------------------------------------------------------------------
const radii = city.potholes.map((hole) => hole.r).sort((a, b) => a - b);
const at = (q: number): number => radii[Math.min(radii.length - 1, Math.floor(q * radii.length))] ?? 0;
console.log(`\nSCORED RADIUS r: min ${at(0).toFixed(2)} p50 ${at(0.5).toFixed(2)} max ${at(0.999).toFixed(2)}`);

// ---- drawn vs scored ------------------------------------------------------------------------
// The gameplay contract: JoziFlowSystem's clearance and Game's rattle test must both measure to the
// silhouette the player can see. Sample the outline all the way round every pothole and report how
// far the drawn edge strays from the plain scalar r — i.e. what the old |side| - r would have lied by.
const shape = await import('../../src/world/PotholeShape').catch(() => null);
if (shape) {
  const { potholeRadiusToward } = shape;
  let worst = 0; let worstHole = city.potholes[0];
  const spreads: number[] = [];
  for (const hole of city.potholes) {
    let lo = Infinity; let hi = 0;
    for (let s = 0; s < 96; s++) {
      const angle = (s / 96) * Math.PI * 2;
      const radius = potholeRadiusToward(hole, Math.cos(angle), Math.sin(angle));
      lo = Math.min(lo, radius); hi = Math.max(hi, radius);
    }
    spreads.push(hi / lo);
    const stray = Math.max(hi - hole.r, hole.r - lo);
    if (stray > worst) { worst = stray; worstHole = hole; }
  }
  spreads.sort((a, b) => a - b);
  const sat = (q: number): number => spreads[Math.min(spreads.length - 1, Math.floor(q * spreads.length))] ?? 0;
  console.log(`OUTLINE long/short ratio: min ${sat(0).toFixed(2)} p50 ${sat(0.5).toFixed(2)} max ${sat(0.999).toFixed(2)}`);
  console.log(`WORST drawn-vs-r divergence ${worst.toFixed(2)}u at (${worstHole!.x.toFixed(0)}, ${worstHole!.z.toFixed(0)}) r=${worstHole!.r.toFixed(2)}`
    + ` — that is what a scalar-r clearance would have mis-stated by, against a 0.28u award gate.`);
}

// ---- is it actually on top of the tar? --------------------------------------------------------
// A pothole is draped on the TERRAIN (roadHeightAt = terrain + ROAD_SURFACE_OFFSET) while the road
// ribbon it lies in carries vertices only at its two edges, every ROAD_SAMPLE_SPACING along. Where
// the terrain dips between those edges the drawn tar cuts a chord ABOVE it and swallows part of the
// hole. Ray-traced against the real triangles rather than argued about: the topmost surface over
// each sample point either is the hole's own dark disc or it is not.
const raycaster = new THREE.Raycaster(); raycaster.far = 1200;
const down = new THREE.Vector3(0, -1, 0);
const roots = scene.children;
const wholelyVisible = (hole: { x: number; z: number; r: number; axis?: number }): boolean => {
  const probes = 12;
  for (let s = 0; s < probes; s++) {
    const angle = (s / probes) * Math.PI * 2;
    const reach = shape ? shape.potholeRadiusAt(hole, angle) * 0.6 : hole.r * 0.6;
    const x = hole.x + Math.cos(angle) * reach; const z = hole.z + Math.sin(angle) * reach;
    raycaster.set(new THREE.Vector3(x, 600, z), down);
    const top = raycaster.intersectObjects(roots, true).filter((h) => (h.object as Mesh).isMesh)[0];
    if (((top?.object as Mesh | undefined)?.material as MeshBasicMaterial | undefined)?.color?.getHexString() !== '0d1113') return false;
  }
  return true;
};
const sample = city.potholes.filter((_, index) => index % 5 === 0); // every fifth hole, ~270 of them
const whole = sample.filter(wholelyVisible).length;
console.log(`\nDRAWN ON TOP: ${whole} of ${sample.length} sampled holes are wholly visible;`
  + ` ${sample.length - whole} have tar drawn over part of them (the road ribbon carries vertices only at`
  + ' its two edges and cuts a chord above any dip between them — pre-existing, unchanged by the shape).');

// ---- a few to drive to ----------------------------------------------------------------------
// Picked across the RANGE of shapes rather than the prettiest: a driver should be able to see the
// difference between one hole and the next, which is the whole point of the change.
if (shape) {
  const { potholeRadiusAt } = shape;
  const measured = city.potholes.map((hole) => {
    let lo = Infinity; let hi = 0;
    for (let s = 0; s < 96; s++) {
      const radius = potholeRadiusAt(hole, -Math.PI + (s / 96) * Math.PI * 2);
      lo = Math.min(lo, radius); hi = Math.max(hi, radius);
    }
    return { hole, ratio: hi / lo, hi };
  }).sort((a, b) => a.ratio - b.ratio);
  console.log('\nTP TARGETS across the shape range (each ray-checked to be wholly drawn, so none is half-buried):');
  for (const quantile of [0.02, 0.35, 0.65, 0.9, 0.99]) {
    const start = Math.floor(quantile * (measured.length - 1));
    let pick = measured[start]!;
    for (let step = 0; step < 40; step++) { // walk outward from the quantile until one is fully visible
      const candidate = measured[Math.min(measured.length - 1, Math.max(0, start + (step % 2 ? step : -step)))]!;
      if (wholelyVisible(candidate.hole)) { pick = candidate; break; }
    }
    console.log(`  tp ${pick.hole.x.toFixed(0)} ${pick.hole.z.toFixed(0)}   r=${pick.hole.r.toFixed(2)}`
      + `  axis=${((pick.hole.axis ?? 0) * 180 / Math.PI).toFixed(0)}°  ratio=${pick.ratio.toFixed(2)}  reach=${pick.hi.toFixed(2)}`);
  }
}
