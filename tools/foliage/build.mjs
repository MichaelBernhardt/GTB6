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

const buildDir = resolve('build/foliage');
const source = resolve(process.env.FOLIAGE_SOURCE ?? 'art/foliage/work/joburg-trees.blend');
const output = resolve(buildDir, 'joburg-trees.glb');
const installed = resolve('public/models/foliage/joburg-trees.glb');
await mkdir(buildDir, { recursive: true });
if (!process.env.FOLIAGE_SOURCE) {
  await mkdir(resolve('art/foliage/work'), { recursive: true });
  await rm(source, { force: true });
  const created = spawnSync(blender, [
    '--background', '--factory-startup', '--python', resolve('tools/foliage/create-source.py'), '--',
    '--output', source, '--recipe', resolve('art/foliage/recipe.json'),
  ], { stdio: 'inherit' });
  if (created.status !== 0 || !existsSync(source)) process.exit(created.status || 1);
}
await rm(output, { force: true });
const exported = spawnSync(blender, [
  '--background', '--factory-startup', source, '--python', resolve('tools/foliage/build.py'), '--', '--output', output,
], { stdio: 'inherit' });
if (exported.status !== 0 || !existsSync(output)) process.exit(exported.status || 1);
await mkdir(resolve('public/models/foliage'), { recursive: true });
await copyFile(output, installed);

const lockPath = resolve('art/foliage/sources.lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
for (const artifact of lock.committedArtifacts) {
  artifact.sha256 = createHash('sha256').update(await readFile(resolve(artifact.path))).digest('hex');
}
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
const validation = spawnSync(process.execPath, [resolve('tools/foliage/validate.mjs')], { stdio: 'inherit' });
if (validation.status !== 0) process.exit(validation.status ?? 1);
console.log('Installed validated Blender tree library: public/models/foliage/joburg-trees.glb');
