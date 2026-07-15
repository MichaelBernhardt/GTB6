import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL = resolve(process.argv[2] ?? 'public/models/foliage/joburg-trees.glb');
const MAX_BYTES = 1024 * 1024;
const TRIANGLE_BUDGET = {
  jacaranda: 300,
  'shade-tree': 340,
  gum: 300,
  pine: 240,
  acacia: 300,
  palm: 260,
  'landmark-tree': 500,
};

function invariant(value, message) { if (!value) throw new Error(message); }
function triangles(object) {
  let count = 0;
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    count += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3;
  });
  return count;
}

const file = await readFile(MODEL);
invariant(file.byteLength <= MAX_BYTES, `Tree GLB is ${(file.byteLength / 1024 / 1024).toFixed(2)} MiB; limit is 1 MiB`);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const gltf = await new GLTFLoader().parseAsync(buffer, '/models/foliage/');
invariant(gltf.animations.length === 0, 'Tree library must not contain animations');
const recipe = JSON.parse(await readFile(resolve('art/foliage/recipe.json'), 'utf8'));
const root = gltf.scene.getObjectByName(recipe.library);
invariant(root, `Missing ${recipe.library} root`);
const contract = root.userData.treeContract;
invariant(contract?.version === 1 && contract.units === 'metres' && contract.upAxis === '+Y' && contract.grounded === true,
  'Tree library metadata contract is invalid');

const expected = new Set(recipe.variants.map(({ species, variant }) => `${species}__${variant}`));
const actual = new Set(root.children.map((child) => child.name));
invariant(actual.size === expected.size && [...expected].every((name) => actual.has(name)),
  `Tree roots must be exactly: ${[...expected].join(', ')}`);

let totalTriangles = 0;
for (const spec of recipe.variants) {
  const name = `${spec.species}__${spec.variant}`;
  const model = root.getObjectByName(name);
  invariant(model, `Missing tree variant: ${name}`);
  const metadata = model.userData.treeAsset;
  invariant(metadata?.species === spec.species && metadata.variant === spec.variant, `${name} metadata identity is invalid`);
  invariant(JSON.stringify(metadata.maxFootprint) === JSON.stringify(spec.maxFootprint), `${name} footprint metadata drifted`);
  invariant(JSON.stringify(metadata.trunkCollider) === JSON.stringify(spec.trunkCollider), `${name} collider metadata drifted`);
  let meshCount = 0;
  model.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    meshCount++;
    invariant(node.geometry.getAttribute('position') && node.geometry.getAttribute('normal'), `${name} needs positions and normals`);
    invariant(node.geometry.getAttribute('position').count > 0, `${name} contains an empty mesh`);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      invariant(material instanceof THREE.MeshStandardMaterial, `${name} contains a non-PBR material`);
      invariant(!material.map && !material.normalMap, `${name} unexpectedly depends on a texture`);
      invariant(!material.transparent && material.opacity === 1, `${name} must stay in the opaque render path`);
    }
  });
  invariant(meshCount >= 1 && meshCount <= 4, `${name} has ${meshCount} meshes; expected 1–4`);
  const count = triangles(model);
  invariant(Number.isInteger(count) && count >= 120, `${name} has an implausible ${count} triangles`);
  invariant(count <= TRIANGLE_BUDGET[spec.species], `${name} has ${count} triangles; budget is ${TRIANGLE_BUDGET[spec.species]}`);
  totalTriangles += count;

  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  invariant(Math.abs(bounds.min.x + bounds.max.x) < 0.08, `${name} is not centred on X`);
  invariant(Math.abs(bounds.min.z + bounds.max.z) < 0.08, `${name} is not centred on Z`);
  invariant(bounds.min.y >= -0.02 && bounds.min.y <= 0.08, `${name} is not grounded (min Y ${bounds.min.y})`);
  invariant(size.y >= 4 && size.y <= 16, `${name} height ${size.y} is outside the tree range`);
  invariant(size.x <= spec.maxFootprint[0] && size.z <= spec.maxFootprint[1], `${name} exceeds its catalog footprint`);
  const [colliderW, colliderD, colliderH] = spec.trunkCollider;
  invariant(colliderW <= 3 && colliderD <= 3 && colliderH > 0 && colliderH <= size.y, `${name} trunk collider is invalid`);
}

if (MODEL === resolve('public/models/foliage/joburg-trees.glb')) {
  const lock = JSON.parse(await readFile(resolve('art/foliage/sources.lock.json'), 'utf8'));
  for (const artifact of lock.committedArtifacts) {
    const digest = createHash('sha256').update(await readFile(resolve(artifact.path))).digest('hex');
    invariant(digest === artifact.sha256, `Checksum mismatch: ${artifact.path}`);
  }
}
console.log(`Tree library valid: ${(file.byteLength / 1024).toFixed(1)} KiB, ${recipe.variants.length} assets, ${totalTriangles} triangles.`);
