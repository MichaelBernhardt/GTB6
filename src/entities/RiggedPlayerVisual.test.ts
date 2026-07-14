import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canActivateRiggedVisual, findHumanoidBones, initialPlayerVisualState, RiggedPlayerVisual,
  selectPlayerAnimation, type ProceduralHumanoidPose,
} from './RiggedPlayerVisual';

const pose = (): ProceduralHumanoidPose => {
  const part = (): THREE.Object3D => new THREE.Object3D();
  return {
    model: part(), torso: part(), head: part(), leftArm: part(), rightArm: part(),
    leftForearm: part(), rightForearm: part(), leftLeg: part(), rightLeg: part(), leftShin: part(), rightShin: part(),
  };
};

const loadPlaceholder = async (): Promise<GLTF> => {
  const file = await readFile('public/models/characters/player-placeholder.glb');
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new GLTFLoader().parseAsync(buffer, '');
};

afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

describe('rigged player animation selection', () => {
  it('prioritises death, attacks and airborne motion over locomotion', () => {
    const state = { ...initialPlayerVisualState(), moving: true, sprinting: true };
    expect(selectPlayerAnimation(state)).toBe('sprint');
    state.onGround = false; state.velocityY = 2; expect(selectPlayerAnimation(state)).toBe('jump');
    state.velocityY = -2; expect(selectPlayerAnimation(state)).toBe('fall');
    state.attack = 'punch_left'; expect(selectPlayerAnimation(state)).toBe('punch_left');
    state.dead = true; expect(selectPlayerAnimation(state)).toBe('death');
  });

  it('selects camera-facing aim locomotion by dominant input axis', () => {
    const state = { ...initialPlayerVisualState(), moving: true, aiming: true, moveSide: -1 };
    expect(selectPlayerAnimation(state)).toBe('aim_left');
    state.moveSide = 1; expect(selectPlayerAnimation(state)).toBe('aim_right');
    state.moveSide = 0; state.moveForward = 1; expect(selectPlayerAnimation(state)).toBe('aim_forward');
    state.moveForward = -1; expect(selectPlayerAnimation(state)).toBe('aim_back');
  });

  it('only allows the first visual swap from a neutral grounded pose', () => {
    const state = initialPlayerVisualState(); expect(canActivateRiggedVisual(state)).toBe(true);
    for (const key of ['moving', 'aiming', 'cover', 'riding', 'airborne', 'tumbling', 'dead'] as const) {
      const blocked = { ...state, [key]: true }; expect(canActivateRiggedVisual(blocked)).toBe(false);
    }
    expect(canActivateRiggedVisual({ ...state, onGround: false })).toBe(false);
  });
});

describe('player placeholder GLB contract', () => {
  it('contains the required humanoid bones and canonical core clips', async () => {
    const file = await readFile('public/models/characters/player-placeholder.glb');
    const gltf = await loadPlaceholder(); let triangles = 0; const materials = new Set<THREE.Material>();
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      triangles += (object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3;
      const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]; meshMaterials.forEach((material) => materials.add(material));
    });
    expect(findHumanoidBones(gltf.scene)).toBeDefined();
    const names = new Set(gltf.animations.map((clip) => clip.name));
    for (const name of ['idle', 'walk', 'sprint', 'aim', 'fire', 'punch_left', 'punch_right', 'jump', 'fall', 'land', 'death', 'ride']) expect(names.has(name)).toBe(true);
    expect(file.byteLength).toBeLessThan(10 * 1024 * 1024); expect(triangles).toBeLessThan(60_000); expect(materials.size).toBeLessThanOrEqual(4);
  });

  it('activates a valid model and preserves the procedural fallback for load failure', async () => {
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
    const parent = new THREE.Group(); const procedural = new THREE.Group(); parent.add(procedural);
    const gltf = await loadPlaceholder();
    const valid = new RiggedPlayerVisual(parent, procedural, pose(), { load: async () => gltf });
    const failed = new RiggedPlayerVisual(parent, new THREE.Group(), pose(), { load: async () => { throw new Error('missing'); }, onError: () => undefined });
    const invalid = new RiggedPlayerVisual(parent, new THREE.Group(), pose(), { load: async () => ({ scene: new THREE.Group(), animations: [] }) as unknown as GLTF });
    await Promise.resolve(); await Promise.resolve();
    valid.setState(initialPlayerVisualState()); valid.update(1 / 60);
    expect(valid.ready).toBe(true); expect(valid.active).toBe(true); expect(procedural.visible).toBe(false);
    valid.setWeapon('shotgun');
    expect(valid.group.getObjectByName('RiggedWeapon:shotgun')?.visible).toBe(true);
    expect(valid.group.getObjectByName('RiggedWeapon:pistol')?.visible).toBe(false);
    expect(failed.failed).toBe(true); expect(failed.active).toBe(false);
    expect(invalid.failed).toBe(true); expect(invalid.active).toBe(false);
  });
});
