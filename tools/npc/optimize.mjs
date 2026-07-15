import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const [inputArg, outputArg, id] = process.argv.slice(2);
if (!inputArg || !outputArg || !id) throw new Error('Usage: optimize.mjs <input.glb> <output.glb> <character-id>');
const input = resolve(inputArg); const output = resolve(outputArg);

globalThis.FileReader ??= class FileReader {
  result = null; onloadend = null;
  readAsArrayBuffer(blob) { void blob.arrayBuffer().then((value) => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob) { void blob.arrayBuffer().then((value) => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
};
class FakeImage {
  width = 1024; height = 1024; listeners = new Map();
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener() {}
  set src(_value) { queueMicrotask(() => this.listeners.get('load')?.call(this)); }
}
globalThis.self = globalThis;
globalThis.document = { createElementNS: () => new FakeImage() };

const source = await readFile(input); const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
const gltf = await new GLTFLoader().parseAsync(buffer, '/models/npcs/');
let before = 0; let after = 0;
gltf.scene.traverse((object) => {
  if (!(object instanceof THREE.SkinnedMesh)) return;
  before += object.geometry.getAttribute('position').count;
  object.geometry = mergeVertices(object.geometry, 1e-5);
  object.geometry.computeBoundingBox(); object.geometry.computeBoundingSphere();
  after += object.geometry.getAttribute('position').count;
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.map = null;
});

const exporter = new GLTFExporter();
const raw = await new Promise((accept, reject) => exporter.parse(gltf.scene, accept, reject, {
  binary: true, animations: gltf.animations, onlyVisible: false,
}));
if (!(raw instanceof ArrayBuffer)) throw new Error('Expected binary GLB export');

function withExternalTextures(arrayBuffer) {
  const data = Buffer.from(arrayBuffer); const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const textureByMaterial = {
    Skin: `${id}-skin-basecolor.jpg`, Eyes: `${id}-eyes-basecolor.jpg`, Outfit: `${id}-outfit-basecolor.jpg`,
    HairShoes: `${id}-hair-shoes-basecolor.jpg`,
  };
  const files = Object.values(textureByMaterial);
  json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  json.images = files.map((file) => ({ uri: `../../textures/npcs/${file}` }));
  json.textures = files.map((_, sourceIndex) => ({ sampler: 0, source: sourceIndex }));
  for (const material of json.materials) {
    const file = textureByMaterial[material.name];
    if (!file) throw new Error(`Unexpected material: ${material.name}`);
    material.pbrMetallicRoughness.baseColorTexture = { index: files.indexOf(file) };
  }
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const binStart = 20 + jsonLength; const binLength = data.readUInt32LE(binStart);
  const binChunk = data.subarray(binStart, binStart + 8 + binLength);
  const result = Buffer.alloc(12 + 8 + jsonBytes.length + binChunk.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonBytes.length, 12); result.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(result, 20); binChunk.copy(result, 20 + jsonBytes.length);
  return result;
}

const optimized = withExternalTextures(raw); await writeFile(output, optimized);
console.log(`Optimized ${id}: ${before} → ${after} vertices, ${(source.length / 1024 / 1024).toFixed(2)} → ${(optimized.length / 1024 / 1024).toFixed(2)} MiB.`);
