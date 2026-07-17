import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const manifestPath = resolve(process.argv[2] ?? 'art/npcs/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const selectedCharacters = process.env.NPC_ID
  ? manifest.characters.filter((character) => character.id === process.env.NPC_ID)
  : manifest.characters;
if (!selectedCharacters.length) throw new Error(`Unknown NPC_ID: ${process.env.NPC_ID}`);
const requiredBones = ['Hips', 'Spine', 'Chest', 'Head', 'UpperArm_L', 'LowerArm_L', 'Hand_L', 'UpperArm_R', 'LowerArm_R', 'Hand_R', 'UpperLeg_L', 'LowerLeg_L', 'Foot_L', 'UpperLeg_R', 'LowerLeg_R', 'Foot_R'];
const requiredClips = manifest.contract.clips;
const requiredMaterials = ['Skin', 'Eyes', 'Outfit', 'HairShoes'];
const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const typeSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function invariant(value, message) { if (!value) throw new Error(message); }
function parseGlb(data) {
  invariant(data.readUInt32LE(0) === 0x46546c67 && data.readUInt32LE(4) === 2, 'Asset is not a glTF 2.0 binary');
  invariant(data.readUInt32LE(8) === data.length, 'GLB header byte length is incorrect');
  const jsonLength = data.readUInt32LE(12); invariant(data.readUInt32LE(16) === 0x4e4f534a, 'GLB has no JSON chunk');
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binStart = 20 + jsonLength; invariant(data.readUInt32LE(binStart + 4) === 0x004e4942, 'GLB has no binary chunk');
  return { json, bin: data.subarray(binStart + 8, binStart + 8 + data.readUInt32LE(binStart)) };
}
function accessorValues(json, bin, index) {
  const accessor = json.accessors[index]; const view = json.bufferViews[accessor.bufferView];
  const width = typeSize[accessor.type]; const bytes = componentBytes[accessor.componentType];
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
      const marker = data[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5)];
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  throw new Error('Unsupported texture format');
}

let castTransfer = 0; const reports = [];
for (const character of selectedCharacters) {
  const model = resolve(`public/models/npcs/${character.id}.glb`); const file = await readFile(model);
  const { json, bin } = parseGlb(file); const root = json.nodes.find((node) => node.name === `Npc_${character.id}`);
  invariant(root, `${character.id}: missing NPC root`); const contract = root.extras?.npcContract;
  invariant(contract?.version === 1 && contract.characterId === character.id && contract.forwardAxis === '+Z' && contract.feetAtOrigin === true && contract.fps === 30, `${character.id}: metadata contract is invalid`);
  const nodeByName = new Map(json.nodes.map((node, index) => [node.name, index]));
  for (const name of requiredBones) invariant(nodeByName.has(name), `${character.id}: missing humanoid bone ${name}`);
  invariant(json.skins?.length >= 1 && json.skins.length <= manifest.contract.maxSkinnedMaterials, `${character.id}: invalid skinned mesh count`);
  for (const skin of json.skins) for (const name of requiredBones) invariant(skin.joints.includes(nodeByName.get(name)), `${character.id}: skin does not use ${name}`);

  let triangles = 0; let minY = Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives) {
    const position = json.accessors[primitive.attributes.POSITION];
    triangles += (primitive.indices === undefined ? position.count : json.accessors[primitive.indices].count) / 3;
    minY = Math.min(minY, position.min[1]); maxY = Math.max(maxY, position.max[1]); maxZ = Math.max(maxZ, position.max[2]);
    const weights = json.accessors[primitive.attributes.WEIGHTS_0]; const joints = json.accessors[primitive.attributes.JOINTS_0];
    invariant(weights?.type === 'VEC4' && joints?.type === 'VEC4', `${character.id}: every vertex must provide four influence attributes`);
    const values = accessorValues(json, bin, primitive.attributes.WEIGHTS_0);
    for (let index = 0; index < values.length; index += 4) invariant(Math.abs(values[index] + values[index + 1] + values[index + 2] + values[index + 3] - 1) < 0.001, `${character.id}: vertex ${index / 4} has unnormalised weights`);
  }
  invariant(triangles >= manifest.contract.triangleRange[0] && triangles <= manifest.contract.triangleRange[1], `${character.id}: ${triangles} triangles is outside the contract`);
  const height = maxY - minY;
  invariant(Math.abs(height - character.heightMetres) < 0.02, `${character.id}: bind-pose height is ${height.toFixed(4)} m`);
  invariant(Math.abs(minY) < 0.02, `${character.id}: feet are ${minY.toFixed(4)} m from the origin`);
  invariant(maxZ > 0.2, `${character.id}: positive-Z facing check failed`);

  const materialNames = (json.materials ?? []).map((material) => material.name).sort();
  invariant(JSON.stringify(materialNames) === JSON.stringify([...requiredMaterials].sort()), `${character.id}: material set is invalid`);
  for (const material of json.materials) invariant((material.alphaMode ?? 'OPAQUE') === 'OPAQUE', `${character.id}: ${material.name} is not opaque`);
  invariant(json.images?.length === 4, `${character.id}: expected four base-colour textures`);
  let externalTextureBytes = 0;
  for (const image of json.images) {
    invariant(image.uri && !image.uri.startsWith('data:'), `${character.id}: texture must be external`);
    const imageData = await readFile(resolve(dirname(model), image.uri)); externalTextureBytes += imageData.byteLength;
    const [width, heightPx] = dimensions(imageData);
    invariant(width === manifest.contract.textureSize && heightPx === manifest.contract.textureSize, `${character.id}: ${image.uri} must be ${manifest.contract.textureSize}×${manifest.contract.textureSize}`);
  }
  const transfer = file.byteLength + externalTextureBytes; castTransfer += transfer;
  invariant(transfer <= manifest.contract.perCharacterTransferBytes, `${character.id}: transfer is ${(transfer / 1024 / 1024).toFixed(2)} MiB`);

  const clipNames = (json.animations ?? []).map((clip) => clip.name).sort();
  invariant(JSON.stringify(clipNames) === JSON.stringify([...requiredClips].sort()), `${character.id}: animation clip set is not exact`);
  for (const animation of json.animations) for (const [channelIndex, channel] of animation.channels.entries()) {
    if (channel.target.path === 'translation') {
      // Locomotion may carry a zero-mean pelvis bob/sway; the root must stay in place.
      invariant(json.nodes[channel.target.node]?.name === 'Hips', `${character.id}: ${animation.name} contains root translation`);
      const rest = json.nodes[channel.target.node].translation ?? [0, 0, 0];
      const values = accessorValues(json, bin, animation.samplers[channel.sampler].output);
      const mean = [0, 0, 0]; const count = values.length / 3;
      for (let i = 0; i < values.length; i += 3) for (let axis = 0; axis < 3; axis++) mean[axis] += (values[i + axis] - rest[axis]) / count;
      for (let i = 0; i < values.length; i += 3) for (let axis = 0; axis < 3; axis++) {
        invariant(Math.abs(values[i + axis] - rest[axis]) < 0.09, `${character.id}: ${animation.name} pelvis offset exceeds the in-place bound`);
      }
      for (let axis = 0; axis < 3; axis++) invariant(Math.abs(mean[axis]) < 0.01, `${character.id}: ${animation.name} pelvis translation drifts off centre`);
      const closure = Math.hypot(values[0] - values[values.length - 3], values[1] - values[values.length - 2], values[2] - values[values.length - 1]);
      invariant(closure < 0.002, `${character.id}: ${animation.name} pelvis translation does not close its loop`);
    }
    const times = accessorValues(json, bin, animation.samplers[channel.sampler].input);
    for (let index = 1; index < times.length; index++) invariant(Math.abs((times[index] - times[index - 1]) - 1 / 30) < 0.00002, `${character.id}: ${animation.name} track ${channelIndex} is not baked at 30 fps`);
    if (channel.target.path === 'rotation' && (animation.name === 'walk' || animation.name === 'sprint')) {
      // No bone may snap between consecutive frames — that is a seam defect, not motion.
      const values = accessorValues(json, bin, animation.samplers[channel.sampler].output);
      for (let index = 4; index < values.length; index += 4) {
        const dot = Math.abs(values[index] * values[index - 4] + values[index + 1] * values[index - 3] + values[index + 2] * values[index - 2] + values[index + 3] * values[index - 1]);
        const step = 2 * Math.acos(Math.min(1, dot));
        invariant(step < 0.5, `${character.id}: ${animation.name} ${json.nodes[channel.target.node].name} snaps ${step.toFixed(2)} rad at frame ${index / 4}`);
      }
    }
  }
  reports.push(`${character.id}: ${(transfer / 1024 / 1024).toFixed(2)} MiB, ${triangles} triangles`);
}
invariant(castTransfer <= manifest.contract.castTransferBytes, `NPC cast transfer is ${(castTransfer / 1024 / 1024).toFixed(2)} MiB`);

const lockPath = resolve('art/npcs/sources.lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  for (const artifact of lock.committedArtifacts) {
    const digest = createHash('sha256').update(await readFile(resolve(artifact.path))).digest('hex');
    invariant(digest === artifact.sha256, `Checksum mismatch: ${artifact.path}`);
  }
}
console.log(`NPC cast valid (${(castTransfer / 1024 / 1024).toFixed(2)} MiB transfer):\n- ${reports.join('\n- ')}`);
