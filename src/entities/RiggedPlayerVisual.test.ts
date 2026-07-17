import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findHumanoidBones, initialPlayerVisualState, PLAYER_ANIMATIONS, RiggedPlayerVisual,
  selectPlayerAnimation, validatePlayerGltf,
} from './RiggedPlayerVisual';
import { Player } from './Player';

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

const loadVisual = async (): Promise<RiggedPlayerVisual> => {
  const visual = new RiggedPlayerVisual(new THREE.Group(), { load: async () => loadProtagonist() });
  await visual.load(); return visual;
};

const stepVisual = (visual: RiggedPlayerVisual, seconds: number, dt = 1 / 60): void => {
  for (let remaining = seconds; remaining > 0.000001; remaining -= dt) visual.update(Math.min(dt, remaining));
};

interface VisualInternals {
  currentName?: string;
  actions: Map<string, THREE.AnimationAction>;
  recoilAge: number;
}

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

  it('raises the weapon for a held trigger without treating the trigger as the fire clip', () => {
    const state = { ...initialPlayerVisualState(), firing: true };
    expect(selectPlayerAnimation(state)).toBe('aim');
    state.locomotionSpeed = 2; state.moveSide = 1; expect(selectPlayerAnimation(state)).toBe('aim_right');
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
    for (const clip of gltf.animations) expect(clip.tracks.some((track) => track.name.endsWith('.position') && !track.name.startsWith('Hips.'))).toBe(false);

    const sample = (clipName: string, time: number, boneName: string): THREE.Vector3 => {
      const mixer = new THREE.AnimationMixer(gltf.scene); const clip = THREE.AnimationClip.findByName(gltf.animations, clipName)!;
      mixer.clipAction(clip).play(); mixer.setTime(time); gltf.scene.updateMatrixWorld(true);
      const point = gltf.scene.getObjectByName(boneName)!.getWorldPosition(new THREE.Vector3()); mixer.stopAllAction(); return point;
    };
    expect(sample('idle', 0, 'Hand_R').distanceTo(sample('idle', 1, 'Hand_R'))).toBeLessThan(0.01);
    const chest = sample('aim', 0, 'Chest'); const firingHand = sample('aim', 0, 'Hand_R');
    expect(firingHand.z - chest.z).toBeGreaterThan(0.42); expect(firingHand.y - chest.y).toBeGreaterThan(0.18);
    expect(sample('fire', 0, 'Hand_R').distanceTo(firingHand)).toBeLessThan(0.005);
    expect(sample('fire', THREE.AnimationClip.findByName(gltf.animations, 'fire')!.duration, 'Hand_R').distanceTo(firingHand)).toBeLessThan(0.005);
    const walk = THREE.AnimationClip.findByName(gltf.animations, 'walk')!;
    expect(Math.abs(sample('walk', 0, 'Foot_L').z - sample('walk', walk.duration / 2, 'Foot_L').z)).toBeGreaterThan(0.4);
    const rightFootHeights = Array.from({ length: 12 }, (_, index) => sample('walk', walk.duration * index / 12, 'Foot_R').y);
    expect(Math.max(...rightFootHeights) - Math.min(...rightFootHeights)).toBeGreaterThan(0.14);
    expect(walk.tracks.some((track) => track.name === 'Hips.position')).toBe(true);
    const pelvisHeights = Array.from({ length: 12 }, (_, index) => sample('walk', walk.duration * index / 12, 'Hips').y);
    expect(Math.max(...pelvisHeights) - Math.min(...pelvisHeights)).toBeGreaterThan(0.015);
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

describe('rigged player runtime transitions and firearm poses', () => {
  it('keeps long-duration idle stable and cleans the walk action after returning to idle', async () => {
    const visual = await loadVisual(); const state = initialPlayerVisualState(); visual.setState(state);
    stepVisual(visual, 0.4); visual.group.updateMatrixWorld(true);
    const initialHand = visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3());
    stepVisual(visual, 30); visual.group.updateMatrixWorld(true);
    const internals = visual as unknown as VisualInternals;
    expect(internals.currentName).toBe('idle');
    expect(internals.actions.get('idle')!.time).toBeGreaterThan(0.3);
    expect(visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3()).distanceTo(initialHand)).toBeLessThan(0.01);

    visual.setState({ ...state, locomotionSpeed: 4.6 }); stepVisual(visual, 0.4); expect(internals.currentName).toBe('walk');
    visual.setState(state); stepVisual(visual, 0.4); expect(internals.currentName).toBe('idle');
    expect(internals.actions.get('walk')!.isRunning()).toBe(false);
    expect(internals.actions.get('walk')!.getEffectiveWeight()).toBe(0);
  });

  it('carries weapons muzzle-down-forward and aims them along the facing for every ranged weapon', async () => {
    const visual = await loadVisual();
    for (const weapon of ['pistol', 'smg', 'shotgun', 'sniper', 'rpg'] as const) {
      visual.setWeapon(weapon); visual.setState(initialPlayerVisualState()); stepVisual(visual, 0.6);
      visual.group.updateMatrixWorld(true);
      const mesh = visual.group.getObjectByName(`RiggedWeapon:${weapon}`)!;
      const muzzle = () => new THREE.Vector3(0, -1, 0).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
      const carry = muzzle();
      expect(carry.y, `${weapon} carry points down`).toBeLessThan(-0.55);
      expect(carry.z, `${weapon} carry points forward, not backwards`).toBeGreaterThan(0.4);
      expect(Math.abs(carry.x), `${weapon} carry stays in the sagittal plane`).toBeLessThan(0.25);
      visual.setState({ ...initialPlayerVisualState(), aiming: true }); stepVisual(visual, 0.6);
      visual.group.updateMatrixWorld(true);
      const aim = muzzle();
      expect(aim.z, `${weapon} aims along the facing`).toBeGreaterThan(0.97);
    }
  });

  it('raises every ranged weapon on unaimed fire and supports long guns with the off-hand', async () => {
    const visual = await loadVisual();
    for (const weapon of ['pistol', 'smg', 'shotgun', 'sniper', 'rpg'] as const) {
      visual.setWeapon(weapon); visual.setState({ ...initialPlayerVisualState(), firing: true }); stepVisual(visual, 0.4);
      visual.group.updateMatrixWorld(true);
      const right = visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3());
      const left = visual.group.getObjectByName('Hand_L')!.getWorldPosition(new THREE.Vector3());
      const weaponBox = new THREE.Box3().setFromObject(visual.group.getObjectByName(`RiggedWeapon:${weapon}`)!);
      expect(right.y, weapon).toBeGreaterThan(1.2); expect(right.z, weapon).toBeGreaterThan(0.35);
      expect(left.y, weapon).toBeGreaterThan(1.2); expect(weaponBox.distanceToPoint(left), weapon).toBeLessThan(0.28);
    }
    expect((visual as unknown as VisualInternals).currentName).toBe('aim');
  });

  it('holds aim between shots and restarts recoil for semi-automatic and automatic weapons', async () => {
    const visual = await loadVisual(); const internals = visual as unknown as VisualInternals; let shotSequence = 0;
    for (const [weapon, duration] of [['pistol', 0.18], ['smg', 0.11]] as const) {
      visual.setWeapon(weapon); let state = { ...initialPlayerVisualState(), aiming: true, shotSequence };
      visual.setState(state); stepVisual(visual, 0.4); expect(internals.currentName).toBe('aim');
      visual.group.updateMatrixWorld(true);
      const rest = visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3());
      state = { ...state, shotSequence: ++shotSequence }; visual.setState(state); visual.update(duration / 2);
      expect(internals.recoilAge).toBeCloseTo(duration / 2, 5);
      visual.group.updateMatrixWorld(true);
      expect(visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3()).distanceTo(rest)).toBeGreaterThan(0.005);
      if (weapon === 'smg') {
        state = { ...state, shotSequence: ++shotSequence }; visual.setState(state); visual.update(0.01);
        expect(internals.recoilAge).toBeCloseTo(0.01, 5); // an automatic follow-up restarts the active pulse
        visual.update(duration / 2 - 0.01); visual.group.updateMatrixWorld(true);
        expect(visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3()).distanceTo(rest)).toBeGreaterThan(0.005);
      }
      visual.setState(state); stepVisual(visual, duration); expect(internals.currentName).toBe('aim'); visual.group.updateMatrixWorld(true);
      const settled = visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3());
      state = { ...state, shotSequence: ++shotSequence }; visual.setState(state); visual.update(duration / 2);
      expect(internals.recoilAge).toBeCloseTo(duration / 2, 5);
      visual.group.updateMatrixWorld(true);
      expect(visual.group.getObjectByName('Hand_R')!.getWorldPosition(new THREE.Vector3()).distanceTo(settled)).toBeGreaterThan(0.005);
      expect(internals.currentName).toBe('aim');
    }
  });

  it('increments the visual shot sequence only through the ranged-shot API', () => {
    const player = new Player(new THREE.Scene());
    const state = (player as unknown as { visualState: ReturnType<typeof initialPlayerVisualState> }).visualState;
    player.registerShot(); player.registerShot(); expect(state.shotSequence).toBe(2);
    player.setWeapon('fists'); player.registerShot(); expect(state.shotSequence).toBe(2);
  });
});
