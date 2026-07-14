import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// GLTFExporter uses the browser FileReader API. This tiny Node adapter keeps the source asset reproducible.
globalThis.FileReader ??= class FileReader {
  result = null;
  onloadend = null;
  readAsArrayBuffer(blob) { void blob.arrayBuffer().then((value) => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob) { void blob.arrayBuffer().then((value) => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
};

const output = resolve('public/models/characters/player-placeholder.glb');
const root = new THREE.Group(); root.name = 'PlayerPlaceholder';

const bone = (name, parent, position) => {
  const item = new THREE.Bone(); item.name = name; item.position.set(...position); parent.add(item); return item;
};

const hips = bone('Hips', root, [0, 0.92, 0]);
const spine = bone('Spine', hips, [0, 0.18, 0]);
const chest = bone('Chest', spine, [0, 0.28, 0]);
const head = bone('Head', chest, [0, 0.3, 0]);
const upperArmL = bone('UpperArm_L', chest, [0.31, 0.08, 0]);
const lowerArmL = bone('LowerArm_L', upperArmL, [0, -0.28, 0]);
const handL = bone('Hand_L', lowerArmL, [0, -0.25, 0]);
const upperArmR = bone('UpperArm_R', chest, [-0.31, 0.08, 0]);
const lowerArmR = bone('LowerArm_R', upperArmR, [0, -0.28, 0]);
const handR = bone('Hand_R', lowerArmR, [0, -0.25, 0]);
const upperLegL = bone('UpperLeg_L', hips, [0.14, -0.08, 0]);
const lowerLegL = bone('LowerLeg_L', upperLegL, [0, -0.4, 0]);
const footL = bone('Foot_L', lowerLegL, [0, -0.36, 0.05]);
const upperLegR = bone('UpperLeg_R', hips, [-0.14, -0.08, 0]);
const lowerLegR = bone('LowerLeg_R', upperLegR, [0, -0.4, 0]);
const footR = bone('Foot_R', lowerLegR, [0, -0.36, 0.05]);

const materials = {
  skin: new THREE.MeshStandardMaterial({ name: 'Skin', color: 0x9f684b, roughness: 0.78 }),
  jacket: new THREE.MeshStandardMaterial({ name: 'TealJacket', color: 0x176c70, roughness: 0.68 }),
  denim: new THREE.MeshStandardMaterial({ name: 'CharcoalDenim', color: 0x252b32, roughness: 0.84 }),
  dark: new THREE.MeshStandardMaterial({ name: 'HairShoesAndEyes', color: 0x151615, roughness: 0.72 }),
};

const add = (parent, geometry, material, position = [0, 0, 0], scale = [1, 1, 1]) => {
  const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position); mesh.scale.set(...scale); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
};

add(chest, new RoundedBoxGeometry(0.5, 0.58, 0.3, 4, 0.08), materials.jacket, [0, -0.16, 0]);
add(head, new THREE.CylinderGeometry(0.085, 0.1, 0.14, 14), materials.skin, [0, -0.17, 0]);
add(head, new THREE.SphereGeometry(0.17, 20, 14), materials.skin, [0, 0, 0], [0.86, 1.08, 0.94]);
add(head, new THREE.SphereGeometry(0.168, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), materials.dark, [0, 0.045, 0], [0.88, 1, 0.95]);
for (const x of [-0.055, 0.055]) add(head, new THREE.SphereGeometry(0.012, 8, 6), materials.dark, [x, 0.025, 0.158], [1, 0.7, 0.5]);

for (const [upper, lower, hand] of [[upperArmL, lowerArmL, handL], [upperArmR, lowerArmR, handR]]) {
  add(upper, new THREE.CapsuleGeometry(0.068, 0.18, 5, 10), materials.jacket, [0, -0.14, 0]);
  add(lower, new THREE.CapsuleGeometry(0.06, 0.16, 5, 10), materials.jacket, [0, -0.125, 0]);
  add(hand, new THREE.SphereGeometry(0.06, 12, 8), materials.skin, [0, -0.02, 0], [0.82, 1.14, 0.75]);
}
for (const [upper, lower, foot] of [[upperLegL, lowerLegL, footL], [upperLegR, lowerLegR, footR]]) {
  add(upper, new THREE.CapsuleGeometry(0.095, 0.22, 6, 12), materials.denim, [0, -0.2, 0]);
  add(lower, new THREE.CapsuleGeometry(0.086, 0.19, 6, 12), materials.denim, [0, -0.18, 0]);
  add(foot, new RoundedBoxGeometry(0.19, 0.13, 0.34, 4, 0.05), materials.dark, [0, -0.03, 0.09]);
}

const quat = (x = 0, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();
const qtrack = (name, times, rotations) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, rotations.flatMap((value) => quat(...value)));
const cycle = [0, 0.25, 0.5, 0.75, 1];
const loop = (name, stride, arm = stride * 0.75) => new THREE.AnimationClip(name, 1, [
  qtrack('UpperLeg_L', cycle, [[0,0,0],[stride,0,0],[0,0,0],[-stride,0,0],[0,0,0]]),
  qtrack('UpperLeg_R', cycle, [[0,0,0],[-stride,0,0],[0,0,0],[stride,0,0],[0,0,0]]),
  qtrack('UpperArm_L', cycle, [[0,0,0],[-arm,0,0],[0,0,0],[arm,0,0],[0,0,0]]),
  qtrack('UpperArm_R', cycle, [[0,0,0],[arm,0,0],[0,0,0],[-arm,0,0],[0,0,0]]),
]);
const held = (name, rotations, duration = 1) => new THREE.AnimationClip(name, duration,
  Object.entries(rotations).map(([node, rotation]) => qtrack(node, [0, duration], [rotation, rotation])));
const strike = (name, side) => new THREE.AnimationClip(name, 0.3, [
  qtrack(`UpperArm_${side}`, [0, 0.13, 0.3], [[0,0,0],[-1.48,0,side === 'L' ? -0.18 : 0.18],[0,0,0]]),
  qtrack(`LowerArm_${side}`, [0, 0.13, 0.3], [[0,0,0],[-0.8,0,0],[-0.1,0,0]]),
]);

const aimPose = { UpperArm_L: [-1.22,0,-0.22], LowerArm_L: [-0.2,0,0], UpperArm_R: [-1.42,0,0.1], LowerArm_R: [-0.08,0,0] };
const clips = [
  held('idle', { Chest: [0,0,0] }), loop('walk', 0.58), loop('sprint', 0.82),
  held('aim', aimPose), held('aim_forward', aimPose), held('aim_back', aimPose), held('aim_left', aimPose), held('aim_right', aimPose),
  new THREE.AnimationClip('fire', 0.16, [qtrack('UpperArm_R', [0, 0.06, 0.16], [[-1.42,0,0.1],[-1.28,0,0.1],[-1.42,0,0.1]])]),
  strike('punch_left', 'L'), strike('punch_right', 'R'),
  held('jump', { UpperLeg_L: [-0.3,0,0], UpperLeg_R: [0.22,0,0], LowerLeg_L: [0.65,0,0], LowerLeg_R: [0.48,0,0] }, 0.45),
  held('fall', { UpperArm_L: [-0.5,0,1.05], UpperArm_R: [-0.5,0,-1.05], UpperLeg_L: [0.24,0,0.3], UpperLeg_R: [0.24,0,-0.3] }),
  held('land', { Spine: [0.25,0,0], UpperLeg_L: [-0.32,0,0], UpperLeg_R: [-0.32,0,0], LowerLeg_L: [0.62,0,0], LowerLeg_R: [0.62,0,0] }, 0.22),
  new THREE.AnimationClip('death', 0.65, [qtrack('Hips', [0, 0.65], [[0,0,0],[0,0,Math.PI / 2]])]),
  held('ride', { Spine: [0.2,0,0], UpperArm_L: [-1,0,-0.14], UpperArm_R: [-1,0,0.14], UpperLeg_L: [-1.2,0,-0.16], UpperLeg_R: [-1.2,0,0.16], LowerLeg_L: [1.3,0,0], LowerLeg_R: [1.3,0,0] }),
];

const exporter = new GLTFExporter();
const data = await new Promise((resolveExport, reject) => exporter.parse(root, resolveExport, reject, { binary: true, animations: clips, onlyVisible: false }));
if (!(data instanceof ArrayBuffer)) throw new Error('Expected binary GLB export');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, new Uint8Array(data));
console.log(`Wrote ${output} (${Math.ceil(data.byteLength / 1024)} KiB)`);
