import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';

const MODEL = resolve(process.argv[2] ?? 'public/models/vehicles/quantum-express.glb');
const RECIPE = JSON.parse(await readFile(resolve('art/vehicles/recipe.json'), 'utf8'));

function invariant(value, message) { if (!value) throw new Error(message); }
function parseGlb(data) {
  invariant(data.readUInt32LE(0) === 0x46546c67 && data.readUInt32LE(4) === 2, 'Asset is not a glTF 2.0 binary');
  invariant(data.readUInt32LE(8) === data.length, 'GLB header byte length is incorrect');
  const jsonLength = data.readUInt32LE(12); invariant(data.readUInt32LE(16) === 0x4e4f534a, 'GLB has no JSON chunk');
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binStart = 20 + jsonLength; invariant(data.readUInt32LE(binStart + 4) === 0x004e4942, 'GLB has no binary chunk');
  return { json, bin: data.subarray(binStart + 8, binStart + 8 + data.readUInt32LE(binStart)) };
}
function dimensions(data) {
  if (data.subarray(1, 4).toString() === 'PNG') return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset < data.length) {
      if (data[offset] !== 0xff) { offset++; continue; }
      const marker = data[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5)];
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  throw new Error('Unsupported texture format');
}
function localMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
    new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
    new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]),
  );
}

const file = await readFile(MODEL);
invariant(file.byteLength <= RECIPE.maxTransferBytes, `Taxi GLB is ${(file.byteLength / 1024 / 1024).toFixed(2)} MiB; limit is ${(RECIPE.maxTransferBytes / 1024 / 1024).toFixed(0)} MiB`);
const { json, bin } = parseGlb(file);
invariant(!(JSON.stringify(json).toLowerCase().includes('toyota')), 'Taxi asset must not contain Toyota trademarks');
invariant((json.animations ?? []).length === 0 && (json.skins ?? []).length === 0, 'Taxi must be a static unskinned asset');

const nodeByName = new Map(json.nodes.map((node, index) => [node.name, { node, index }]));
const rootRecord = nodeByName.get(RECIPE.assetName);
invariant(rootRecord, `Missing ${RECIPE.assetName} root`);
const contract = rootRecord.node.extras?.taxiContract;
invariant(contract?.version === 1 && contract.units === 'metres' && contract.forwardAxis === '+Z' && contract.upAxis === '+Y' && contract.grounded === true,
  'Taxi metadata contract is invalid');
invariant(contract.textureSize === 2048 && contract.sharedGeometry === true && contract.mutableMaterialsPerInstance === true, 'Taxi sharing/texture contract is invalid');
invariant(JSON.stringify(contract.boundsMetres) === JSON.stringify(RECIPE.dimensionsMetres), 'Taxi bounds metadata drifted');
for (const name of RECIPE.requiredNodes) invariant(nodeByName.has(name), `Missing required taxi node: ${name}`);
invariant(JSON.stringify(contract.firstPersonHiddenNodes) === JSON.stringify(RECIPE.firstPersonHiddenNodes), 'First-person hidden-node contract drifted');

const parent = new Map();
for (const [index, node] of json.nodes.entries()) for (const child of node.children ?? []) parent.set(child, index);
const cabinIndex = nodeByName.get('cabin').index;
for (const name of ['glass', 'roof', 'mirror_left', 'mirror_right']) {
  let index = nodeByName.get(name).index; let insideCabin = index === cabinIndex;
  while (parent.has(index) && !insideCabin) { index = parent.get(index); insideCabin = index === cabinIndex; }
  invariant(insideCabin, `${name} must be inside the first-person-hidden cabin hierarchy`);
}

const materialNames = (json.materials ?? []).map((material) => material.name).sort();
invariant(JSON.stringify(materialNames) === JSON.stringify([...RECIPE.materials].sort()), `Materials must be exactly ${RECIPE.materials.join(', ')}`);
for (const material of json.materials) {
  invariant((material.alphaMode ?? 'OPAQUE') === 'OPAQUE' && material.pbrMetallicRoughness, `${material.name} must be opaque PBR`);
  invariant(!material.extensions?.KHR_materials_transmission && !material.extensions?.KHR_materials_volume, `${material.name} uses a transparent render extension`);
}
invariant(json.images?.length === 1, `Expected one base-colour image, found ${json.images?.length ?? 0}`);
const image = json.images[0];
invariant(image.bufferView !== undefined, 'Taxi base-colour texture must be embedded in the cached GLB');
const imageView = json.bufferViews[image.bufferView];
const embeddedImage = bin.subarray(imageView.byteOffset ?? 0, (imageView.byteOffset ?? 0) + imageView.byteLength);
const [embeddedWidth, embeddedHeight] = dimensions(embeddedImage);
invariant(embeddedWidth === RECIPE.textureSize && embeddedHeight === RECIPE.textureSize, `Embedded taxi texture must be ${RECIPE.textureSize}x${RECIPE.textureSize}`);
const [sourceWidth, sourceHeight] = dimensions(await readFile(resolve('public/textures/vehicles/quantum-express-basecolor.jpg')));
invariant(sourceWidth === RECIPE.textureSize && sourceHeight === RECIPE.textureSize, `Committed taxi texture must be ${RECIPE.textureSize}x${RECIPE.textureSize}`);

const worldMatrices = new Map();
function visit(index, parentMatrix = new THREE.Matrix4()) {
  const matrix = parentMatrix.clone().multiply(localMatrix(json.nodes[index]));
  worldMatrices.set(index, matrix);
  for (const child of json.nodes[index].children ?? []) visit(child, matrix);
}
for (const rootIndex of json.scenes[json.scene ?? 0].nodes) visit(rootIndex);

let triangles = 0; let meshCount = 0;
const bounds = new THREE.Box3();
for (const [index, node] of json.nodes.entries()) {
  if (node.mesh === undefined) continue;
  meshCount++;
  const matrix = worldMatrices.get(index); invariant(matrix, `Mesh ${node.name} is not in the active scene`);
  const mesh = json.meshes[node.mesh];
  for (const primitive of mesh.primitives) {
    invariant(primitive.mode === undefined || primitive.mode === 4, `${node.name} is not triangle geometry`);
    const position = json.accessors[primitive.attributes.POSITION]; const normal = json.accessors[primitive.attributes.NORMAL];
    invariant(position?.count > 0 && normal?.count === position.count, `${node.name} needs valid positions and normals`);
    if (['livery_left', 'livery_right', 'plate_front', 'plate_rear'].includes(node.name)) invariant(primitive.attributes.TEXCOORD_0 !== undefined, `${node.name} needs deterministic UVs`);
    triangles += (primitive.indices === undefined ? position.count : json.accessors[primitive.indices].count) / 3;
    const min = position.min; const max = position.max;
    invariant(min && max, `${node.name} position accessor needs bounds`);
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) bounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(matrix));
  }
}
invariant(Number.isInteger(triangles) && triangles >= RECIPE.triangleRange[0] && triangles <= RECIPE.triangleRange[1], `Taxi has ${triangles} triangles; expected ${RECIPE.triangleRange.join('–')}`);
invariant(meshCount >= 45 && meshCount <= 110, `Taxi has ${meshCount} mesh nodes; expected 45–110`);
const size = bounds.getSize(new THREE.Vector3()); const center = bounds.getCenter(new THREE.Vector3());
invariant(bounds.min.y >= -0.015 && bounds.min.y <= 0.025, `Taxi is not grounded (min Y ${bounds.min.y.toFixed(3)})`);
invariant(Math.abs(center.x) < 0.03 && Math.abs(center.z) < 0.08, `Taxi is not centred on X/Z (${center.x.toFixed(3)}, ${center.z.toFixed(3)})`);
invariant(size.x >= 2.0 && size.x <= 2.5 && size.y >= 2.2 && size.y <= 2.4 && size.z >= 5.0 && size.z <= 5.35,
  `Taxi bounds ${size.x.toFixed(3)}x${size.y.toFixed(3)}x${size.z.toFixed(3)} m are invalid`);

const translation = (name) => new THREE.Vector3().setFromMatrixPosition(worldMatrices.get(nodeByName.get(name).index));
for (const name of ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']) invariant((nodeByName.get(name).node.children ?? []).length >= 3, `${name} is not a wheel pivot hierarchy`);
const fl = translation('wheel_fl'); const fr = translation('wheel_fr'); const rl = translation('wheel_rl'); const rr = translation('wheel_rr');
invariant(fl.x < 0 && fr.x > 0 && rl.x < 0 && rr.x > 0, 'Wheel left/right placement is invalid');
invariant(fl.z > 0 && fr.z > 0 && rl.z < 0 && rr.z < 0, 'Wheel front/rear placement does not match +Z forward');
invariant([fl, fr, rl, rr].every((point) => Math.abs(point.y - RECIPE.wheelRadiusMetres) < 0.015), 'Wheel pivots are not centred at the contracted radius');
invariant(translation('headlight_left').z > 0 && translation('brakelight_left').z < 0, 'Lamp placement does not prove +Z-forward orientation');

const blend = await readFile(resolve('art/vehicles/work/quantum-express-source.blend'));
const blendHeader = blend.subarray(0, 7).toString();
const zstdHeader = blend.length >= 4 && blend.readUInt32BE(0) === 0x28b52ffd;
invariant(blendHeader === 'BLENDER' || zstdHeader, 'Committed editable Blender source is missing or invalid');
if (MODEL === resolve('public/models/vehicles/quantum-express.glb')) {
  const lock = JSON.parse(await readFile(resolve('art/vehicles/sources.lock.json'), 'utf8'));
  for (const artifact of lock.committedArtifacts) {
    const data = await readFile(resolve(artifact.path));
    invariant(data.byteLength === artifact.bytes, `Byte-size mismatch: ${artifact.path}`);
    invariant(createHash('sha256').update(data).digest('hex') === artifact.sha256, `Checksum mismatch: ${artifact.path}`);
  }
}
console.log(`Taxi valid: ${(file.byteLength / 1024 / 1024).toFixed(2)} MiB, ${triangles} triangles, ${meshCount} meshes, ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)} m, one ${embeddedWidth}px texture.`);
