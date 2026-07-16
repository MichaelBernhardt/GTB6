import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const candidates = [process.env.BLENDER, 'blender', '/Applications/Blender.app/Contents/MacOS/Blender'].filter(Boolean);
const blender = candidates.find((candidate) => {
  const check = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return check.status === 0 && /Blender\s+(4\.[2-9]|[5-9]\.)/.test(check.stdout);
});
if (!blender) {
  console.error('Blender 4.2+ is required. Set BLENDER=/path/to/blender when it is not on PATH.');
  process.exit(1);
}
const python = process.env.PYTHON ?? 'python3';
const pillow = spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' });
if (pillow.status !== 0) {
  console.error('Python 3 with Pillow is required to compose the taxi texture and preview.');
  process.exit(1);
}

const buildDir = resolve('build/vehicles');
const previewFrames = resolve(buildDir, 'preview-frames');
const source = resolve(process.env.VEHICLE_SOURCE ?? 'art/vehicles/work/quantum-express-source.blend');
const ribbon = resolve('art/vehicles/materials/quantum-express-ribbon-source.png');
const texture = resolve('public/textures/vehicles/quantum-express-basecolor.jpg');
const output = resolve(buildDir, 'quantum-express.glb');
const installed = resolve('public/models/vehicles/quantum-express.glb');
const preview = resolve('art/vehicles/previews/quantum-express-turnaround.jpg');
await Promise.all([
  mkdir(buildDir, { recursive: true }),
  mkdir(previewFrames, { recursive: true }),
  mkdir(resolve('art/vehicles/work'), { recursive: true }),
  mkdir(resolve('art/vehicles/previews'), { recursive: true }),
  mkdir(resolve('public/models/vehicles'), { recursive: true }),
  mkdir(resolve('public/textures/vehicles'), { recursive: true }),
]);

const textureBuild = spawnSync(python, [resolve('tools/vehicle/build-texture.py'), '--source', ribbon, '--output', texture], { stdio: 'inherit' });
if (textureBuild.status !== 0 || !existsSync(texture)) process.exit(textureBuild.status || 1);

if (!process.env.VEHICLE_SOURCE) {
  await rm(source, { force: true });
  const created = spawnSync(blender, [
    '--background', '--factory-startup', '--python', resolve('tools/vehicle/create-source.py'), '--',
    '--output', source, '--recipe', resolve('art/vehicles/recipe.json'), '--texture', texture,
  ], { stdio: 'inherit' });
  if (created.status !== 0 || !existsSync(source)) process.exit(created.status || 1);
}

await Promise.all([rm(output, { force: true }), rm(previewFrames, { force: true, recursive: true })]);
await mkdir(previewFrames, { recursive: true });
const exported = spawnSync(blender, [
  '--background', '--factory-startup', source, '--python', resolve('tools/vehicle/build.py'), '--',
  '--output', output, '--preview-dir', previewFrames,
], { stdio: 'inherit' });
if (exported.status !== 0 || !existsSync(output)) process.exit(exported.status || 1);
await copyFile(output, installed);

const composed = spawnSync(python, [resolve('tools/vehicle/compose-preview.py'), '--input-dir', previewFrames, '--output', preview], { stdio: 'inherit' });
if (composed.status !== 0 || !existsSync(preview)) process.exit(composed.status || 1);

const committedPaths = [
  'art/vehicles/materials/quantum-express-ribbon-source.png',
  'art/vehicles/livery-prompt.md',
  'art/vehicles/recipe.json',
  'art/vehicles/ATTRIBUTION.md',
  'art/vehicles/work/quantum-express-source.blend',
  'art/vehicles/previews/quantum-express-turnaround.jpg',
  'public/textures/vehicles/quantum-express-basecolor.jpg',
  'public/models/vehicles/quantum-express.glb'
];
const artifacts = [];
for (const path of committedPaths) {
  const data = await readFile(resolve(path));
  artifacts.push({ path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength });
}
const version = spawnSync(blender, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0].trim();
await writeFile(resolve('art/vehicles/sources.lock.json'), `${JSON.stringify({
  version: 1,
  generatedBy: version,
  generatedAt: '2026-07-15',
  generatedRibbonProvider: "ChatGPT built-in image generator",
  committedArtifacts: artifacts,
}, null, 2)}\n`);

const validation = spawnSync(process.execPath, [resolve('tools/vehicle/validate.mjs')], { stdio: 'inherit' });
if (validation.status !== 0) process.exit(validation.status ?? 1);
console.log('Installed validated Blender taxi: public/models/vehicles/quantum-express.glb');
