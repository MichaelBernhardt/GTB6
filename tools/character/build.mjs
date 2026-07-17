import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

const buildDir = resolve('build/character');
const source = resolve(process.env.CHARACTER_SOURCE ?? 'art/character/work/protagonist-source.blend');
const mocapDir = `${homedir()}/Library/Application Support/GTATHREEJS/character/cmu`;
const walkBvh = resolve(process.env.CMU_WALK_BVH ?? `${mocapDir}/08_02.bvh`);
const runBvh = resolve(process.env.CMU_RUN_BVH ?? `${mocapDir}/09_02.bvh`);
const fbx = resolve(buildDir, 'protagonist.fbx'); const glb = resolve(buildDir, 'protagonist.glb');
await mkdir(buildDir, { recursive: true });
if (!process.env.CHARACTER_SOURCE) {
  for (const bvh of [walkBvh, runBvh]) {
    if (!existsSync(bvh)) {
      console.error(`CMU mocap BVH not found: ${bvh}. Download the cycles pinned in art/character/sources.lock.json or set CMU_WALK_BVH/CMU_RUN_BVH.`);
      process.exit(1);
    }
  }
  await mkdir(resolve('art/character/work'), { recursive: true });
  await rm(source, { force: true });
  const sourceBuild = spawnSync(blender, [
    '--background', '--python', resolve('tools/character/create-source.py'), '--',
    '--output', source, '--walk-bvh', walkBvh, '--run-bvh', runBvh,
  ], { stdio: 'inherit' });
  if (sourceBuild.status !== 0 || !existsSync(source)) {
    console.error('Blender did not produce the editable character source.');
    process.exit(sourceBuild.status || 1);
  }
}
if (!existsSync(source)) { console.error(`Character source not found: ${source}`); process.exit(1); }
await Promise.all([rm(fbx, { force: true }), rm(glb, { force: true })]);
const result = spawnSync(blender, [
  '--background', '--factory-startup', '--python', resolve('tools/character/build.py'), '--',
  '--source', source, '--recipe', resolve('art/character/recipe.json'), '--fbx', fbx, '--glb', glb,
], { stdio: 'inherit' });
if (result.status !== 0 || !existsSync(fbx) || !existsSync(glb)) {
  console.error('Blender did not produce both character exports.');
  process.exit(result.status || 1);
}
const installed = resolve('public/models/characters/protagonist.glb');
const optimization = spawnSync(process.execPath, [resolve('tools/character/optimize.mjs'), glb, installed], { stdio: 'inherit' });
if (optimization.status !== 0) process.exit(optimization.status ?? 1);
const lockPath = resolve('art/character/sources.lock.json'); const lock = JSON.parse(await readFile(lockPath, 'utf8'));
for (const artifact of lock.committedArtifacts) {
  const path = resolve(artifact.path);
  if (existsSync(path)) artifact.sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
}
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
const installedValidation = spawnSync(process.execPath, [resolve('tools/character/validate.mjs')], { stdio: 'inherit' });
if (installedValidation.status !== 0) process.exit(installedValidation.status ?? 1);
console.log(`Installed validated web asset: public/models/characters/protagonist.glb`);
