import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const candidates = [process.env.BLENDER, 'blender', '/Applications/Blender.app/Contents/MacOS/Blender'].filter(Boolean);
const blender = candidates.find((candidate) => {
  const check = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return check.status === 0 && /Blender\s+(4\.[2-9]|[5-9]\.)/.test(check.stdout);
});
if (!blender) { console.error('Blender 4.2+ is required. Set BLENDER=/path/to/blender.'); process.exit(1); }

const manifestPath = resolve('art/npcs/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const selected = process.env.NPC_ID ? manifest.characters.filter((character) => character.id === process.env.NPC_ID) : manifest.characters;
if (!selected.length) { console.error(`Unknown NPC_ID: ${process.env.NPC_ID}`); process.exit(1); }
const buildDir = resolve('build/npcs'); const workDir = resolve('art/npcs/work'); const previewDir = resolve('art/npcs/previews');
const mocapDir = `${homedir()}/Library/Application Support/GTATHREEJS/character/cmu`;
const walkBvh = resolve(process.env.CMU_WALK_BVH ?? `${mocapDir}/08_02.bvh`);
const runBvh = resolve(process.env.CMU_RUN_BVH ?? `${mocapDir}/09_02.bvh`);
for (const bvh of [walkBvh, runBvh]) {
  if (!existsSync(bvh)) { console.error(`CMU mocap BVH not found: ${bvh}. Download the cycles pinned in art/npcs/sources.lock.json or set CMU_WALK_BVH/CMU_RUN_BVH.`); process.exit(1); }
}
await Promise.all([mkdir(buildDir, { recursive: true }), mkdir(workDir, { recursive: true }), mkdir(previewDir, { recursive: true }), mkdir(resolve('public/models/npcs'), { recursive: true }), mkdir(resolve('public/textures/npcs'), { recursive: true })]);

for (const character of selected) {
  const source = resolve(process.env.NPC_SOURCE_DIR ?? workDir, `${character.id}-source.blend`);
  const fbx = resolve(buildDir, `${character.id}.fbx`); const rawGlb = resolve(buildDir, `${character.id}.glb`);
  await Promise.all([rm(source, { force: true }), rm(fbx, { force: true }), rm(rawGlb, { force: true })]);
  const create = spawnSync(blender, [
    '--background', '--python', resolve('tools/npc/create-source.py'), '--',
    '--manifest', manifestPath, '--id', character.id, '--output', source, '--walk-bvh', walkBvh, '--run-bvh', runBvh,
  ], { stdio: 'inherit' });
  if (create.status !== 0 || !existsSync(source)) process.exit(create.status || 1);
  const turnaround = resolve(previewDir, `${character.id}-turnaround.jpg`);
  const contacts = resolve(previewDir, `${character.id}-animations.jpg`);
  await Promise.all([rm(turnaround, { force: true }), rm(contacts, { force: true })]);
  const preview = spawnSync(blender, [
    '--background', source, '--python', resolve('tools/npc/render-previews.py'), '--', '--id', character.id,
    '--turnaround', turnaround, '--contacts', contacts, '--work', resolve(buildDir, 'previews'),
  ], { stdio: 'inherit' });
  if (preview.status !== 0 || !existsSync(turnaround) || !existsSync(contacts)) process.exit(preview.status || 1);
  const build = spawnSync(blender, [
    '--background', '--factory-startup', '--python', resolve('tools/npc/build.py'), '--',
    '--source', source, '--manifest', manifestPath, '--id', character.id, '--fbx', fbx, '--glb', rawGlb,
  ], { stdio: 'inherit' });
  if (build.status !== 0 || !existsSync(fbx) || !existsSync(rawGlb)) process.exit(build.status || 1);
  const installed = resolve(`public/models/npcs/${character.id}.glb`);
  const optimize = spawnSync(process.execPath, [resolve('tools/npc/optimize.mjs'), rawGlb, installed, character.id], { stdio: 'inherit' });
  if (optimize.status !== 0) process.exit(optimize.status ?? 1);
}

const lockPath = resolve('art/npcs/sources.lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const artifactPaths = ['art/npcs/manifest.json'];
  for (const character of manifest.characters) {
    artifactPaths.push(
      character.materialSource,
      character.turnaround,
      `art/npcs/previews/${character.id}-animations.jpg`,
      `art/npcs/previews/${character.id}-turnaround.jpg`,
      `public/models/npcs/${character.id}.glb`,
      `public/textures/npcs/${character.id}-eyes-basecolor.jpg`,
      `public/textures/npcs/${character.id}-hair-shoes-basecolor.jpg`,
      `public/textures/npcs/${character.id}-outfit-basecolor.jpg`,
      `public/textures/npcs/${character.id}-skin-basecolor.jpg`,
    );
  }
  lock.committedArtifacts = [...new Set(artifactPaths)].sort().map((path) => ({ path, sha256: '' }));
  for (const artifact of lock.committedArtifacts) artifact.sha256 = createHash('sha256').update(await readFile(resolve(artifact.path))).digest('hex');
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}
const validation = spawnSync(process.execPath, [resolve('tools/npc/validate.mjs')], { stdio: 'inherit' });
if (validation.status !== 0) process.exit(validation.status ?? 1);
console.log(`Installed ${selected.length} validated NPC asset${selected.length === 1 ? '' : 's'} under public/models/npcs/.`);
