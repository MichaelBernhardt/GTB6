import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const MODEL = resolve(process.argv[2] ?? 'public/models/characters/protagonist.glb');
const MAX_BYTES = 10 * 1024 * 1024;
const REQUIRED_BONES = ['Hips', 'Spine', 'Chest', 'Head', 'UpperArm_L', 'LowerArm_L', 'Hand_L', 'UpperArm_R', 'LowerArm_R', 'Hand_R', 'UpperLeg_L', 'LowerLeg_L', 'Foot_L', 'UpperLeg_R', 'LowerLeg_R', 'Foot_R'];
const REQUIRED_CLIPS = ['idle', 'walk', 'sprint', 'aim', 'aim_forward', 'aim_back', 'aim_left', 'aim_right', 'fire', 'punch_left', 'punch_right', 'jump', 'fall', 'land', 'tumble', 'death', 'cover_idle', 'cover_move', 'cover_aim', 'ride_bicycle', 'ride_motorbike', 'ride_superbike', 'freefall', 'parachute'];
const MATERIALS = ['SkinEyes', 'TealTechnicalJacket', 'CharcoalJeans', 'HairShoes'];
const BASE_TEXTURES = ['protagonist-skin-basecolor.jpg', 'protagonist-jacket-basecolor.jpg', 'protagonist-denim-basecolor.jpg', 'protagonist-hair-shoes-basecolor.jpg'];
const PACKED_TEXTURES = ['skin-normal-roughness.png', 'jacket-normal-roughness.png', 'denim-normal-roughness.png', 'hair-shoes-normal-roughness.png'];

function invariant(value, message) { if (!value) throw new Error(message); }
function parseGlb(data) {
  invariant(data.readUInt32LE(0) === 0x46546c67 && data.readUInt32LE(4) === 2, 'Asset is not a glTF 2.0 binary');
  invariant(data.readUInt32LE(8) === data.length, 'GLB header byte length is incorrect');
  const jsonLength = data.readUInt32LE(12); invariant(data.readUInt32LE(16) === 0x4e4f534a, 'GLB has no JSON chunk');
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binStart = 20 + jsonLength; invariant(data.readUInt32LE(binStart + 4) === 0x004e4942, 'GLB has no binary chunk');
  return { json, bin: data.subarray(binStart + 8, binStart + 8 + data.readUInt32LE(binStart)) };
}
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessorValues(json, bin, index) {
  const accessor = json.accessors[index]; const view = json.bufferViews[accessor.bufferView];
  const width = TYPE_SIZE[accessor.type]; const bytes = COMPONENT_BYTES[accessor.componentType];
  const stride = view.byteStride ?? width * bytes; const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const values = [];
  const read = accessor.componentType === 5126 ? (offset) => bin.readFloatLE(offset)
    : accessor.componentType === 5123 ? (offset) => bin.readUInt16LE(offset)
      : accessor.componentType === 5125 ? (offset) => bin.readUInt32LE(offset)
        : accessor.componentType === 5121 ? (offset) => bin.readUInt8(offset)
          : accessor.componentType === 5122 ? (offset) => bin.readInt16LE(offset) : (offset) => bin.readInt8(offset);
  for (let row = 0; row < accessor.count; row++) for (let column = 0; column < width; column++) values.push(read(start + row * stride + column * bytes));
  return values;
}
function dimensions(data) {
  if (data.subarray(1, 4).toString() === 'PNG') return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset < data.length) {
      if (data[offset] !== 0xff) { offset++; continue; }
      const marker = data[offset + 1]; if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5)];
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  throw new Error('Unsupported texture format');
}

const file = await readFile(MODEL); invariant(file.byteLength < MAX_BYTES, `GLB is ${(file.byteLength / 1024 / 1024).toFixed(2)} MiB; limit is 10 MiB`);
const { json, bin } = parseGlb(file); const root = json.nodes.find((node) => node.name === 'JohannesburgProtagonist');
invariant(root, 'Missing JohannesburgProtagonist root'); const contract = root.extras?.characterContract;
invariant(contract?.version === 1 && contract.forwardAxis === '+Z' && contract.feetAtOrigin === true && contract.fps === 30, 'Character metadata contract is invalid');
const nodeByName = new Map(json.nodes.map((node, index) => [node.name, index]));
for (const name of REQUIRED_BONES) invariant(nodeByName.has(name), `Missing humanoid bone: ${name}`);
for (const skin of json.skins ?? []) for (const name of REQUIRED_BONES) invariant(skin.joints.includes(nodeByName.get(name)), `Skin does not use required bone: ${name}`);
invariant(json.skins?.length === 4, `Expected four skinned material meshes, found ${json.skins?.length ?? 0}`);

let triangles = 0; let minY = Infinity; let maxY = -Infinity; let maxZ = -Infinity;
for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives) {
  const position = json.accessors[primitive.attributes.POSITION]; triangles += (primitive.indices === undefined ? position.count : json.accessors[primitive.indices].count) / 3;
  minY = Math.min(minY, position.min[1]); maxY = Math.max(maxY, position.max[1]); maxZ = Math.max(maxZ, position.max[2]);
  const weights = json.accessors[primitive.attributes.WEIGHTS_0]; const joints = json.accessors[primitive.attributes.JOINTS_0];
  invariant(weights?.type === 'VEC4' && joints?.type === 'VEC4', 'Every vertex must provide no more than four bone influences');
  const values = accessorValues(json, bin, primitive.attributes.WEIGHTS_0);
  for (let i = 0; i < values.length; i += 4) invariant(Math.abs(values[i] + values[i + 1] + values[i + 2] + values[i + 3] - 1) < 0.001, `Vertex ${i / 4} has unnormalised bone weights`);
}
invariant(triangles >= 45_000 && triangles <= 60_000, `Triangle count ${triangles} is outside 45–60k`);
const scaleY = root.scale?.[1] ?? 1; const height = (maxY - minY) * scaleY;
invariant(Math.abs(height - 1.8) < 0.005, `Bind-pose height is ${height.toFixed(4)} m instead of 1.8 m`);
invariant(Math.abs(minY * scaleY) < 0.015, `Feet are ${(minY * scaleY).toFixed(4)} m from the origin`);
invariant(maxZ > 0.25 && contract.forwardAxis === '+Z', 'Positive-Z facing contract is not satisfied');

const materialNames = (json.materials ?? []).map((material) => material.name).sort();
invariant(JSON.stringify(materialNames) === JSON.stringify([...MATERIALS].sort()), `Materials must be exactly ${MATERIALS.join(', ')}`);
for (const material of json.materials) invariant((material.alphaMode ?? 'OPAQUE') === 'OPAQUE', `${material.name} is not opaque`);
invariant(json.images?.length === 4, `Expected four base-colour textures, found ${json.images?.length ?? 0}`);
let externalTextureBytes = 0;
for (const [index, name] of BASE_TEXTURES.entries()) {
  const image = json.images[index]; let imageData;
  if (image.uri) { invariant(image.uri.endsWith(name), `Material texture ${index} must be ${name}`); imageData = await readFile(resolve(dirname(MODEL), image.uri)); externalTextureBytes += imageData.byteLength; }
  else {
    const view = json.bufferViews[image.bufferView]; invariant(view, `Embedded material texture ${index} has no buffer view`);
    imageData = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  const [width, heightPx] = dimensions(imageData);
  invariant(width === 2048 && heightPx === 2048, `${name} must be a 2048×2048 base-colour map`);
}
const transferBytes = file.byteLength + externalTextureBytes;
invariant(transferBytes < MAX_BYTES, `Combined GLB and base-colour transfer is ${(transferBytes / 1024 / 1024).toFixed(2)} MiB; limit is 10 MiB`);
for (const name of PACKED_TEXTURES) {
  const path = resolve('art/character/materials', name); const [width, heightPx] = dimensions(await readFile(path));
  invariant(width === 2048 && heightPx === 2048, `${name} must be a 2048×2048 packed normal/roughness source`);
}

const clipNames = (json.animations ?? []).map((clip) => clip.name).sort();
invariant(JSON.stringify(clipNames) === JSON.stringify([...REQUIRED_CLIPS].sort()), 'Animation clip set is not exact');
for (const animation of json.animations) for (const [channelIndex, channel] of animation.channels.entries()) {
  invariant(channel.target.path !== 'translation', `${animation.name} contains root translation`);
  const times = accessorValues(json, bin, animation.samplers[channel.sampler].input);
  for (let i = 1; i < times.length; i++) invariant(Math.abs((times[i] - times[i - 1]) - 1 / 30) < 0.00001, `${animation.name} track ${channelIndex} is not baked at 30 fps`);
}
await stat(MODEL);
if (MODEL === resolve('public/models/characters/protagonist.glb')) {
  const lock = JSON.parse(await readFile(resolve('art/character/sources.lock.json'), 'utf8'));
  for (const artifact of lock.committedArtifacts) {
    const digest = createHash('sha256').update(await readFile(resolve(artifact.path))).digest('hex');
    invariant(digest === artifact.sha256, `Checksum mismatch: ${artifact.path}`);
  }
}
console.log(`Character valid: ${(file.byteLength / 1024 / 1024).toFixed(2)} MiB GLB / ${(transferBytes / 1024 / 1024).toFixed(2)} MiB transfer, ${triangles} triangles, 4 materials, ${REQUIRED_BONES.length} bones, ${REQUIRED_CLIPS.length} clips.`);
