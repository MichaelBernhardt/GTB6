import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findHumanoidBones, initialPlayerVisualState, PLAYER_ANIMATIONS, RiggedPlayerVisual,
  selectPlayerAnimation, validatePlayerGltf,
} from './RiggedPlayerVisual';

class FakeImage {
  width = 2048;
  height = 2048;
  private listeners = new Map<string, () => void>();
  addEventListener(name: string, callback: () => void): void { this.listeners.set(name, callback); }
  removeEventListener(): void { /* loader cleanup */ }
  set src(_value: string) { queueMicrotask(() => this.listeners.get('load')?.call(this)); }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { createElementNS: () => new FakeImage() }, configurable: true });
});

const loadProtagonist = async (): Promise<GLTF> => {
  THREE.Cache.clear();
  const file = await readFile('public/models/characters/protagonist.glb');
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new GLTFLoader().parseAsync(buffer, '/models/characters/');
};

describe('rigged player animation selection', () => {
  it('uses explicit speed and pose modes with deterministic priority', () => {
    const state = { ...initialPlayerVisualState(), locomotionSpeed: 8 };
    expect(selectPlayerAnimation(state)).toBe('sprint');
    state.onGround = false; state.velocityY = 2; expect(selectPlayerAnimation(state)).toBe('jump');
    state.velocityY = -2; expect(selectPlayerAnimation(state)).toBe('fall');
    state.onGround = true; state.airMode = 'freefall'; expect(selectPlayerAnimation(state)).toBe('freefall');
    state.airMode = 'none'; state.rideMode = 'superbike'; expect(selectPlayerAnimation(state)).toBe('ride_superbike');
    state.rideMode = 'none'; state.coverMode = 'aim'; expect(selectPlayerAnimation(state)).toBe('cover_aim');
    state.tumbleProgress = 0.3; expect(selectPlayerAnimation(state)).toBe('tumble');
    state.dead = true; expect(selectPlayerAnimation(state)).toBe('death');
  });

  it('selects camera-facing aim locomotion by dominant input axis', () => {
    const state = { ...initialPlayerVisualState(), locomotionSpeed: 2, aiming: true, moveSide: -1 };
    expect(selectPlayerAnimation(state)).toBe('aim_left');
    state.moveSide = 1; expect(selectPlayerAnimation(state)).toBe('aim_right');
    state.moveSide = 0; state.moveForward = 1; expect(selectPlayerAnimation(state)).toBe('aim_forward');
    state.moveForward = -1; expect(selectPlayerAnimation(state)).toBe('aim_back');
  });
});

describe('protagonist GLB contract', () => {
  it('contains the exact rig, clips, geometry, materials, textures, scale and in-place animation set', async () => {
    const file = await readFile('public/models/characters/protagonist.glb'); const gltf = await loadProtagonist();
    const validated = validatePlayerGltf(gltf); let triangles = 0; const materials = new Set<THREE.Material>(); let skinned = 0;
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
      materials.add(object.material as THREE.Material); if (object instanceof THREE.SkinnedMesh) skinned++;
    });
    expect(findHumanoidBones(gltf.scene)).toBeDefined(); expect(validated.clips.size).toBe(PLAYER_ANIMATIONS.length);
    expect(gltf.animations.map((clip) => clip.name).sort()).toEqual([...PLAYER_ANIMATIONS].sort());
    expect(file.byteLength).toBeLessThan(10 * 1024 * 1024); expect(triangles).toBeGreaterThanOrEqual(45_000); expect(triangles).toBeLessThanOrEqual(60_000);
    expect(materials.size).toBe(4); expect(skinned).toBe(4);
    const box = new THREE.Box3().setFromObject(gltf.scene); expect(box.max.y - box.min.y).toBeCloseTo(1.8, 2); expect(box.min.y).toBeCloseTo(0, 1);
    for (const clip of gltf.animations) expect(clip.tracks.some((track) => track.name.endsWith('.position'))).toBe(false);
  });

  it('loads only through the explicit lifecycle and fails closed on invalid data', async () => {
    const parent = new THREE.Group(); const valid = new RiggedPlayerVisual(parent, { load: async () => loadProtagonist() });
    expect(valid.status).toBe('idle'); expect(valid.group.visible).toBe(false); expect(parent.children).toEqual([valid.group]);
    await valid.load(); expect(valid.status).toBe('ready'); expect(valid.group.visible).toBe(true);
    valid.setState(initialPlayerVisualState()); valid.update(1 / 60); valid.setWeapon('shotgun');
    expect(valid.group.getObjectByName('RiggedWeapon:shotgun')?.visible).toBe(true);
    expect(valid.group.getObjectByName('RiggedWeapon:pistol')?.visible).toBe(false);

    valid.setWeapon('pistol'); valid.group.updateMatrixWorld(true);
    const hand = valid.group.getObjectByName('Hand_R')!; const pistol = valid.group.getObjectByName('RiggedWeapon:pistol')!;
    const handPosition = hand.getWorldPosition(new THREE.Vector3());
    const pistolCenter = new THREE.Box3().setFromObject(pistol).getCenter(new THREE.Vector3());
    expect(pistolCenter.distanceTo(handPosition)).toBeLessThan(0.2);

    const invalid = new RiggedPlayerVisual(new THREE.Group(), { load: async () => ({ scene: new THREE.Group(), animations: [] }) as unknown as GLTF });
    await expect(invalid.load()).rejects.toThrow(/metadata/i); expect(invalid.status).toBe('failed'); expect(invalid.group.visible).toBe(false);
  });

  it('keeps gameplay blocked after a network failure and allows retry to install the real rig', async () => {
    let calls = 0;
    const visual = new RiggedPlayerVisual(new THREE.Group(), { load: async () => { calls++; if (calls === 1) throw new Error('offline'); return loadProtagonist(); } });
    await expect(visual.load()).rejects.toThrow(/unable to load/i); expect(visual.failed).toBe(true); expect(visual.ready).toBe(false);
    await visual.retry(); expect(calls).toBe(2); expect(visual.ready).toBe(true); expect(visual.group.visible).toBe(true);
  });
});
