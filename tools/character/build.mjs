import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const candidates = [process.env.BLENDER, 'blender', '/Applications/Blender.app/Contents/MacOS/Blender'].filter(Boolean);
const blender = candidates.find((candidate) => {
  const check = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return check.status === 0 && /Blender\s+(4\.[2-9]|[5-9]\.)/.test(check.stdout);
});
if (!blender) {
  console.error('Blender 4.2+ is required. Set BLENDER=/path/to/blender when it is not on PATH.');
  process.exit(1);
}

const source = resolve(process.env.CHARACTER_SOURCE ?? 'public/models/characters/protagonist.glb');
if (!existsSync(source)) { console.error(`Character source not found: ${source}`); process.exit(1); }
const buildDir = resolve('build/character'); const fbx = resolve(buildDir, 'protagonist.fbx'); const glb = resolve(buildDir, 'protagonist.glb');
await mkdir(buildDir, { recursive: true });
const result = spawnSync(blender, [
  '--background', '--factory-startup', '--python', resolve('tools/character/build.py'), '--',
  '--source', source, '--recipe', resolve('art/character/recipe.json'), '--fbx', fbx, '--glb', glb,
], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const installed = resolve('public/models/characters/protagonist.glb');
const optimization = spawnSync(process.execPath, [resolve('tools/character/optimize.mjs'), glb, installed], { stdio: 'inherit' });
if (optimization.status !== 0) process.exit(optimization.status ?? 1);
const lockPath = resolve('art/character/sources.lock.json'); const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const artifact = lock.committedArtifacts.find((entry) => entry.path === 'public/models/characters/protagonist.glb');
if (!artifact) throw new Error('sources.lock.json has no protagonist GLB entry');
artifact.sha256 = createHash('sha256').update(await readFile(installed)).digest('hex');
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
const installedValidation = spawnSync(process.execPath, [resolve('tools/character/validate.mjs')], { stdio: 'inherit' });
if (installedValidation.status !== 0) process.exit(installedValidation.status ?? 1);
console.log(`Installed validated web asset: public/models/characters/protagonist.glb`);
