import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NPC_CHARACTER_IDS } from './NpcCatalog';
import {
  cachedNpcTemplateCount, clearNpcTemplateCache, NPC_ANIMATIONS, RiggedPedestrianVisual,
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
beforeEach(() => { clearNpcTemplateCache(); THREE.Cache.clear(); });

const loadNpc = async (id = 'braamfontein-creative'): Promise<GLTF> => {
  const file = await readFile(`public/models/npcs/${id}.glb`);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new GLTFLoader().parseAsync(buffer, '/models/npcs/');
};
const state = (overrides: Partial<RiggedPedestrianState> = {}): RiggedPedestrianState => ({
  state: 'idle', punching: false, hailing: false, covering: false, stumbling: false, stumbleAmount: 0, ...overrides,
});

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
    const visual = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 });
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
    for (let frame = 0; frame < 45; frame++) { // through the fall AND at rest: in ground contact, never hovering or buried
      visual.update(1 / 30);
      expect(Math.abs(skinnedFloor())).toBeLessThan(0.08);
    }
    visual.update(10); // fully clamped at the clip end
    expect(skinnedFloor()).toBeCloseTo(0, 1); // the settled corpse lies ON the ground, not floating above it
  });

  it('slams the death fall: playback accelerates instead of floating down at capture speed', async () => {
    const visual = new RiggedPedestrianVisual(new THREE.Group(), 'braamfontein-creative', { load: () => loadNpc(), random: () => 0.25 });
    await visual.load();
    visual.setState(state({ state: 'down' })); visual.update(1 / 30);
    const start = visual.animationTime('death')!;
    for (let frame = 0; frame < 6; frame++) visual.update(1 / 30);
    const early = visual.animationTime('death')! - start;
    for (let frame = 0; frame < 6; frame++) visual.update(1 / 30);
    const late = visual.animationTime('death')! - start - early;
    expect(early).toBeGreaterThan(6 / 30); // faster than the raw capture from the first frames
    expect(late).toBeGreaterThan(early * 1.15); // and accelerating — gravity wins, the body slams
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
