import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NPC_CHARACTER_IDS } from './NpcCatalog';
import { RAGDOLL_TIMEOUT, type RagdollEnvironment } from './PedRagdoll';
import {
  activeRagdollCount, cachedNpcTemplateCount, clearNpcTemplateCache, MAX_ACTIVE_RAGDOLLS,
  NPC_ANIMATIONS, resetActiveRagdolls, RiggedPedestrianVisual,
  selectNpcAnimation, validateNpcGltf, type RiggedPedestrianState,
} from './RiggedPedestrianVisual';

class FakeImage {
  width = 1024; height = 1024;
  private listeners = new Map<string, () => void>();
  addEventListener(name: string, callback: () => void): void { this.listeners.set(name, callback); }
  removeEventListener(): void { /* loader cleanup */ }
  set src(_value: string) { queueMicrotask(() => this.listeners.get('load')?.call(this)); }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { createElementNS: () => new FakeImage() }, configurable: true });
});
beforeEach(() => { clearNpcTemplateCache(); resetActiveRagdolls(); THREE.Cache.clear(); });

const loadNpc = async (id = 'braamfontein-creative'): Promise<GLTF> => {
  const file = await readFile(`public/models/npcs/${id}.glb`);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new GLTFLoader().parseAsync(buffer, '/models/npcs/');
};
const state = (overrides: Partial<RiggedPedestrianState> = {}): RiggedPedestrianState => ({
  state: 'idle', dead: false, punching: false, hailing: false, covering: false, stumbling: false, stumbleAmount: 0, ...overrides,
});

/** World-space min skinned-vertex y — measured from the scene root so the ped's own transform counts. */
const skinnedFloorOf = (root: THREE.Object3D): number => {
  root.updateMatrixWorld(true);
  let floor = Infinity; const box = new THREE.Box3();
  root.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    object.computeBoundingBox();
    floor = Math.min(floor, box.copy(object.boundingBox!).applyMatrix4(object.matrixWorld).min.y);
  });
  return floor;
};

describe('NPC cast asset contract', () => {
  it('validates every unique rig, clip set, material, texture, scale and geometry budget', async () => {
    for (const id of NPC_CHARACTER_IDS) {
      const file = await readFile(`public/models/npcs/${id}.glb`); const gltf = await loadNpc(id);
      const validated = validateNpcGltf(gltf, id); let triangles = 0; const materials = new Set<THREE.Material>();
      gltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        expect(object).toBeInstanceOf(THREE.SkinnedMesh);
        triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
        materials.add(object.material as THREE.Material);
      });
      expect(validated.clips.size).toBe(5); expect(gltf.animations.map((clip) => clip.name).sort()).toEqual([...NPC_ANIMATIONS].sort());
      expect(triangles).toBeGreaterThanOrEqual(12_000); expect(triangles).toBeLessThanOrEqual(30_000);
      expect(materials.size).toBeLessThanOrEqual(5); expect(file.byteLength).toBeLessThan(3 * 1024 * 1024);
    }
  });
});

describe('cached rigged pedestrian instances', () => {
  it('loads each URL once while cloning independent skeletons over shared immutable render resources', async () => {
    let loads = 0; const loader = async (): Promise<GLTF> => { loads++; return loadNpc(); };
    const first = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: loader, random: () => 0.1 });
    const second = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: loader, random: () => 0.7 });
    await Promise.all([first.load(), second.load()]);
    expect(loads).toBe(1); expect(cachedNpcTemplateCount()).toBe(1); expect(first.ready && second.ready).toBe(true);
    const firstMesh = first.group.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    const secondMesh = second.group.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    expect(firstMesh.geometry).toBe(secondMesh.geometry); expect(firstMesh.material).toBe(secondMesh.material);
    expect(firstMesh.skeleton).not.toBe(secondMesh.skeleton); expect(firstMesh.skeleton.bones[0]).not.toBe(secondMesh.skeleton.bones[0]);
    expect(first.animationTime('idle')).not.toBe(second.animationTime('idle'));
  });

  it('maps pedestrian behavior to locomotion and one-shot animations', async () => {
    const visual = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.7 }); // 0.7: the mocap-pose death path
    await visual.load();
    const transitions: Array<[Partial<RiggedPedestrianState>, string]> = [
      [{ state: 'walk' }, 'walk'], [{ state: 'flee' }, 'sprint'], [{ state: 'hostile' }, 'sprint'],
      [{ state: 'idle' }, 'idle'], [{ state: 'cower' }, 'idle'], [{ state: 'hostile', punching: true }, 'punch_right'], [{ state: 'down' }, 'death'],
    ];
    for (const [change, animation] of transitions) { visual.setState(state(change)); visual.update(1 / 30); expect(visual.activeAnimation).toBe(animation); }
    expect(selectNpcAnimation(state({ state: 'walk' }))).toBe('walk');
    visual.setState(state({ state: 'cower' })); visual.update(1 / 30); expect(visual.group.position.y).toBeLessThan(0);
    visual.setState(state({ state: 'idle', covering: true })); visual.update(1 / 30); expect(visual.group.position.y).toBeLessThan(0);
    visual.setState(state({ state: 'idle', hailing: true })); visual.update(1 / 30);
    expect(visual.group.getObjectByName('UpperArm_R')!.rotation.z).not.toBe(0);
    visual.setState(state({ state: 'walk', stumbling: true, stumbleAmount: 0.5 })); visual.update(1 / 30); expect(visual.group.rotation.x).toBeCloseTo(-0.16);
    const skinnedFloor = (): number => {
      visual.group.updateMatrixWorld(true);
      let floor = Infinity; const box = new THREE.Box3();
      visual.group.traverse((object) => {
        if (!(object instanceof THREE.SkinnedMesh)) return;
        object.computeBoundingBox();
        floor = Math.min(floor, box.copy(object.boundingBox!).applyMatrix4(object.matrixWorld).min.y);
      });
      return floor;
    };
    visual.setState(state({ state: 'down' })); visual.update(1 / 30);
    expect(visual.group.position.y).toBeGreaterThan(-0.05); // the just-shot body hasn't fallen yet — no early sink through the road
    for (let frame = 0; frame < 45; frame++) { // through the fall AND at rest: never hovering, never buried deeper than the deliberate sink
      visual.update(1 / 30);
      const floor = skinnedFloor();
      expect(floor).toBeLessThan(0.08); expect(floor).toBeGreaterThan(-0.3);
    }
    visual.update(10); // fully clamped at the clip end
    expect(skinnedFloor()).toBeCloseTo(-0.2, 1); // the settled corpse presses INTO the ground by the deliberate sink, not floating above it
  });

  it('slams the death fall: playback accelerates instead of floating down at capture speed', async () => {
    const visual = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.7 });
    await visual.load();
    expect(visual.deathStyle).toBe('pose');
    visual.setState(state({ state: 'down' })); visual.update(1 / 30);
    const start = visual.animationTime('death')!;
    for (let frame = 0; frame < 3; frame++) visual.update(1 / 30);
    const early = visual.animationTime('death')! - start;
    for (let frame = 0; frame < 3; frame++) visual.update(1 / 30);
    const late = visual.animationTime('death')! - start - early;
    expect(early).toBeGreaterThan(2 * 3 / 30); // at least double capture speed from the first frames
    expect(late).toBeGreaterThan(early * 1.15); // and accelerating — gravity wins, the body slams
  });

  it('ragdolls half the cast: the body settles on the ground in a non-standing pose, then freezes', async () => {
    const parent = new THREE.Group();
    const visual = new RiggedPedestrianVisual(parent, 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 }); // 0.25 < ragdoll chance
    await visual.load();
    expect(visual.deathStyle).toBe('ragdoll');
    const env: RagdollEnvironment = { heightAt: () => 0 };
    visual.setState(state({ state: 'down', dead: true }));
    for (let frame = 0; frame < 305 && !visual.ragdollBody?.frozen; frame++) { // ≤ ~10 simulated seconds
      visual.update(1 / 30, env);
      expect(skinnedFloorOf(parent)).toBeGreaterThan(-0.45); // never punched through the road mid-fall
    }
    expect(visual.activeAnimation).toBeUndefined(); // the mixer is frozen — this death is physical
    expect(visual.ragdollBody!.frozen).toBe(true);
    expect(visual.ragdollBody!.elapsed).toBeLessThan(RAGDOLL_TIMEOUT); // came to genuine rest, not the timeout backstop
    const settled = skinnedFloorOf(parent);
    expect(settled).toBeGreaterThan(-0.25); expect(settled).toBeLessThan(0.05); // resting on the ground, not hovering or buried
    parent.updateMatrixWorld(true);
    const head = new THREE.Vector3(); visual.group.getObjectByName('Head')!.getWorldPosition(head);
    expect(head.y).toBeLessThan(0.6); // collapsed, not a standing statue
    expect(activeRagdollCount()).toBe(0); // frozen corpses cost nothing
    const hipsBefore = visual.group.getObjectByName('Hips')!.quaternion.clone();
    for (let frame = 0; frame < 30; frame++) visual.update(1 / 30, env);
    expect(visual.group.getObjectByName('Hips')!.quaternion.equals(hipsBefore)).toBe(true); // frozen means frozen
  });

  it('regression: settles on the ground even when the ped stands far from the origin, yaw-rotated', async () => {
    // The old heap floated in production because its floor measurement was only correct with the ped
    // group at the origin — exactly what its test exercised. This pins the displaced + rotated case.
    const parent = new THREE.Group();
    parent.position.set(500, 12, -300); parent.rotation.y = 2.1;
    const visual = new RiggedPedestrianVisual(parent, 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 });
    await visual.load();
    const env: RagdollEnvironment = { heightAt: () => 12 };
    visual.setState(state({ state: 'down', dead: true }));
    for (let frame = 0; frame < 305 && !visual.ragdollBody?.frozen; frame++) visual.update(1 / 30, env);
    expect(visual.ragdollBody!.frozen).toBe(true);
    const settled = skinnedFloorOf(parent) - 12;
    expect(settled).toBeGreaterThan(-0.25); expect(settled).toBeLessThan(0.05);
    parent.updateMatrixWorld(true);
    const hips = new THREE.Vector3(); visual.group.getObjectByName('Hips')!.getWorldPosition(hips);
    expect(Math.abs(hips.x - 500)).toBeLessThan(3); expect(Math.abs(hips.z + 300)).toBeLessThan(3); // the body stayed where the ped died
  });

  it('knockdown survivors never ragdoll and recover cleanly to animation', async () => {
    const visual = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 }); // ragdoll-fated ped
    await visual.load();
    visual.setState(state({ state: 'down', dead: false })); // floored but alive: downTimer is running
    for (let frame = 0; frame < 30; frame++) visual.update(1 / 30);
    expect(visual.activeAnimation).toBe('death'); // the pose path plays; no physics took over
    expect(visual.ragdollBody).toBeUndefined();
    expect(activeRagdollCount()).toBe(0);
    visual.setState(state({ state: 'walk' })); visual.update(1 / 30);
    expect(visual.activeAnimation).toBe('walk'); // back on their feet, mixer in charge
  });

  it('caps concurrent ragdolls: the oldest freezes where it is when one more death starts', async () => {
    const env: RagdollEnvironment = { heightAt: () => 0 };
    const visuals: RiggedPedestrianVisual[] = [];
    for (let index = 0; index <= MAX_ACTIVE_RAGDOLLS; index++) visuals.push(new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 }));
    await Promise.all(visuals.map((visual) => visual.load()));
    for (const visual of visuals) { visual.setState(state({ state: 'down', dead: true })); visual.update(1 / 30, env); }
    expect(activeRagdollCount()).toBe(MAX_ACTIVE_RAGDOLLS);
    expect(visuals[0].ragdollBody!.frozen).toBe(true); // oldest gave up its slot
    expect(visuals[MAX_ACTIVE_RAGDOLLS].ragdollBody!.frozen).toBe(false); // the fresh death simulates
  });

  it('releases its registry slot when a ragdolling ped is disposed (lifecycle culling)', async () => {
    const env: RagdollEnvironment = { heightAt: () => 0 };
    const visuals: RiggedPedestrianVisual[] = [];
    for (let index = 0; index < MAX_ACTIVE_RAGDOLLS; index++) visuals.push(new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 }));
    await Promise.all(visuals.map((visual) => visual.load()));
    for (const visual of visuals) { visual.setState(state({ state: 'down', dead: true })); visual.update(1 / 30, env); }
    expect(activeRagdollCount()).toBe(MAX_ACTIVE_RAGDOLLS);
    visuals[3].dispose(); // corpse culled mid-simulation
    expect(activeRagdollCount()).toBe(MAX_ACTIVE_RAGDOLLS - 1); // no leaked slot pinning the cap
    const fresh = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 });
    await fresh.load();
    fresh.setState(state({ state: 'down', dead: true })); fresh.update(1 / 30, env);
    expect(activeRagdollCount()).toBe(MAX_ACTIVE_RAGDOLLS); // freed slot reused...
    expect(visuals[0].ragdollBody!.frozen).toBe(false); // ...without evicting the oldest survivor
  });

  it('a settled corpse shrugs off another hit: late impacts neither crash nor restart the ragdoll', async () => {
    const env: RagdollEnvironment = { heightAt: () => 0 };
    const visual = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 });
    await visual.load();
    visual.setState(state({ state: 'down', dead: true }));
    for (let frame = 0; frame < 305 && !visual.ragdollBody?.frozen; frame++) visual.update(1 / 30, env);
    const body = visual.ragdollBody!;
    expect(body.frozen).toBe(true);
    visual.primeRagdollImpact(1, 0); // Pedestrian.takeDamage early-returns for down peds, but even a stray prime must be inert
    for (let frame = 0; frame < 10; frame++) visual.update(1 / 30, env);
    expect(visual.ragdollBody).toBe(body); // same body, still frozen — no re-seed, no re-kick
    expect(body.frozen).toBe(true);
    expect(activeRagdollCount()).toBe(0);
  });

  it('replaces a placeholder asynchronously and remains fail-open when loading fails', async () => {
    const parent = new THREE.Group(); const placeholder = new THREE.Group(); parent.add(placeholder);
    let resolve!: (gltf: GLTF) => void; const deferred = new Promise<GLTF>((accept) => { resolve = accept; });
    const visual = new RiggedPedestrianVisual(parent, 'braamfontein-creative', { load: () => deferred, onReady: () => { placeholder.visible = false; } });
    const pending = visual.load(); expect(placeholder.visible).toBe(true); expect(visual.group.visible).toBe(false);
    resolve(await loadNpc()); await pending; expect(placeholder.visible).toBe(false); expect(visual.group.visible).toBe(true);

    clearNpcTemplateCache(); const fallback = new THREE.Group(); const failed = new RiggedPedestrianVisual(fallback, 'sandton-professional', { load: async () => { throw new Error('offline'); } });
    await expect(failed.load()).rejects.toThrow(/unable to load/i); expect(failed.failed).toBe(true); expect(failed.group.visible).toBe(false); expect(fallback.children).toContain(failed.group);
  });

  it('detaches safely when disposed during an outstanding shared load without disposing shared GPU data', async () => {
    const parent = new THREE.Group(); let resolve!: (gltf: GLTF) => void;
    const deferred = new Promise<GLTF>((accept) => { resolve = accept; });
    const visual = new RiggedPedestrianVisual(parent, 'rosebank-athlete', { load: () => deferred });
    const pending = visual.load(); visual.dispose(); expect(parent.children).not.toContain(visual.group);
    resolve(await loadNpc('rosebank-athlete')); await pending;
    expect(visual.status).toBe('disposed'); expect(visual.group.children).toHaveLength(0); expect(parent.children).not.toContain(visual.group);
  });
});
