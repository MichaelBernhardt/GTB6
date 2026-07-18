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
  console.error('Python 3 with Pillow is required to compose the vehicle textures and previews.');
  process.exit(1);
}

const buildDir = resolve('build/vehicles');
const workDir = resolve('art/vehicles/work');
const previewsDir = resolve('art/vehicles/previews');
const modelsDir = resolve('public/models/vehicles');
const textureDir = resolve('public/textures/vehicles');
await Promise.all([buildDir, workDir, previewsDir, modelsDir, textureDir].map((path) => mkdir(path, { recursive: true })));

function run(command, args, expected) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0 || (expected && !existsSync(expected))) process.exit(result.status || 1);
}

// The fleet's uniform Quantum retains its authored atlas and dedicated high-roof generator.
const taxiSource = resolve(process.env.VEHICLE_SOURCE ?? 'art/vehicles/work/quantum-express-source.blend');
const ribbon = resolve('art/vehicles/materials/quantum-express-ribbon-source.png');
const texture = resolve('public/textures/vehicles/quantum-express-basecolor.jpg');
const taxiOutput = resolve(buildDir, 'quantum-express.glb');
const taxiInstalled = resolve(modelsDir, 'quantum-express.glb');
const taxiFrames = resolve(buildDir, 'quantum-express-preview-frames');
const taxiPreview = resolve(previewsDir, 'quantum-express-turnaround.jpg');

run(python, [resolve('tools/vehicle/build-texture.py'), '--source', ribbon, '--output', texture], texture);
if (!process.env.VEHICLE_SOURCE) {
  await rm(taxiSource, { force: true });
  run(blender, [
    '--background', '--factory-startup', '--python', resolve('tools/vehicle/create-source.py'), '--',
    '--output', taxiSource, '--recipe', resolve('art/vehicles/recipe.json'), '--texture', texture,
  ], taxiSource);
}
await Promise.all([rm(taxiOutput, { force: true }), rm(taxiFrames, { force: true, recursive: true })]);
await mkdir(taxiFrames, { recursive: true });
run(blender, [
  '--background', '--factory-startup', taxiSource, '--python', resolve('tools/vehicle/build.py'), '--',
  '--output', taxiOutput, '--preview-dir', taxiFrames,
], taxiOutput);
await copyFile(taxiOutput, taxiInstalled);
run(python, [resolve('tools/vehicle/compose-preview.py'), '--input-dir', taxiFrames, '--output', taxiPreview, '--title', 'Quantum Express'], taxiPreview);

// The remaining four cars share one strict catalog and generator while retaining distinct silhouettes.
const catalogPath = resolve('art/vehicles/road-cars.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
for (const car of catalog.cars) {
  const source = resolve(workDir, `${car.fileStem}-source.blend`);
  const output = resolve(buildDir, `${car.fileStem}.glb`);
  const installed = resolve(modelsDir, `${car.fileStem}.glb`);
  const frames = resolve(buildDir, `${car.fileStem}-preview-frames`);
  const preview = resolve(previewsDir, `${car.fileStem}-turnaround.jpg`);
  await Promise.all([rm(source, { force: true }), rm(output, { force: true }), rm(frames, { force: true, recursive: true })]);
  await mkdir(frames, { recursive: true });
  run(blender, [
    '--background', '--factory-startup', '--python', resolve('tools/vehicle/create-road-car.py'), '--',
    '--output', source, '--catalog', catalogPath, '--kind', car.kind,
  ], source);
  run(blender, [
    '--background', '--factory-startup', source, '--python', resolve('tools/vehicle/build-road-car.py'), '--',
    '--output', output, '--preview-dir', frames, '--root', car.assetName,
  ], output);
  await copyFile(output, installed);
  run(python, [resolve('tools/vehicle/compose-preview.py'), '--input-dir', frames, '--output', preview, '--title', car.assetName.replace(/^Car_/, '').replace(/([a-z])([A-Z])/g, '$1 $2')], preview);
}

const committedPaths = [
  'art/vehicles/materials/quantum-express-ribbon-source.png',
  'art/vehicles/livery-prompt.md',
  'art/vehicles/recipe.json',
  'art/vehicles/road-cars.json',
  'art/vehicles/ATTRIBUTION.md',
  'art/vehicles/work/quantum-express-source.blend',
  'art/vehicles/previews/quantum-express-turnaround.jpg',
  'public/textures/vehicles/quantum-express-basecolor.jpg',
  'public/models/vehicles/quantum-express.glb',
];
for (const car of catalog.cars) committedPaths.push(
  `art/vehicles/work/${car.fileStem}-source.blend`,
  `art/vehicles/previews/${car.fileStem}-turnaround.jpg`,
  `public/models/vehicles/${car.fileStem}.glb`,
);
const artifacts = [];
for (const path of committedPaths) {
  const data = await readFile(resolve(path));
  artifacts.push({ path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength });
}
const version = spawnSync(blender, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0].trim();
await writeFile(resolve('art/vehicles/sources.lock.json'), `${JSON.stringify({
  version: 2,
  generatedBy: version,
  generatedAt: '2026-07-18',
  generatedRibbonProvider: 'ChatGPT built-in image generator',
  committedArtifacts: artifacts,
}, null, 2)}\n`);

run(process.execPath, [resolve('tools/vehicle/validate.mjs')]);
console.log('Installed validated Blender vehicle fleet: public/models/vehicles/*.glb');
