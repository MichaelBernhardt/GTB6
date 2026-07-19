import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RagdollEnvironment } from './PedRagdoll';
import { initialPlayerVisualState, RiggedPlayerVisual, type PlayerVisualState } from './RiggedPlayerVisual';

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

const flat: RagdollEnvironment = { heightAt: () => 0 };

/** World-space min skinned-vertex y — measured from the parent so the player's own transform counts. */
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

const setup = async (): Promise<{ parent: THREE.Group; visual: RiggedPlayerVisual; state: PlayerVisualState }> => {
  const parent = new THREE.Group();
  const visual = new RiggedPlayerVisual(parent, { load: async () => loadProtagonist() });
  await visual.load();
  const state = initialPlayerVisualState();
  return { parent, visual, state };
};

const drive = (visual: RiggedPlayerVisual, state: PlayerVisualState, seconds: number, env = flat): void => {
  for (let frame = 0; frame < Math.ceil(seconds * 30); frame++) { visual.setState(state); visual.update(1 / 30, env); }
};

describe('player knockdown ragdoll on the real protagonist rig', () => {
  it('a car-hit kick settles the body grounded (skin within ±0.05) and carried along the impact', async () => {
    const { parent, visual, state } = await setup();
    state.locomotionSpeed = 3; drive(visual, state, 0.5); // seed mid-walk like a street hit
    visual.primeRagdollImpact(1, 0, 7);
    state.locomotionSpeed = 0; state.ragdoll = true;
    for (let frame = 0; frame < 305 && !visual.ragdollBody?.frozen; frame++) { visual.setState(state); visual.update(1 / 30, flat); }
    expect(visual.ragdollBody!.frozen).toBe(true);
    const hips = new THREE.Vector3();
    expect(visual.ragdollHips(hips)).toBe(true);
    expect(hips.x).toBeGreaterThan(0.3); // thrown along the car's travel, not dropped in place
    const settled = skinnedFloorOf(parent);
    expect(settled).toBeGreaterThan(-0.05); expect(settled).toBeLessThan(0.05); // skin ON the surface — never buried, never hovering
  });

  it('a hard-landing kick (downward carry) also rests inside the settle band', async () => {
    const { parent, visual, state } = await setup();
    drive(visual, state, 0.2);
    visual.primeRagdollImpact(0, 1, 2, 6);
    state.ragdoll = true;
    for (let frame = 0; frame < 305 && !visual.ragdollBody?.frozen; frame++) { visual.setState(state); visual.update(1 / 30, flat); }
    expect(visual.ragdollBody!.frozen).toBe(true);
    const settled = skinnedFloorOf(parent);
    expect(settled).toBeGreaterThan(-0.05); expect(settled).toBeLessThan(0.05);
  });

  it('recovers to the mixer cleanly: stands back up into locomotion with no ragdoll residue', async () => {
    const { parent, visual, state } = await setup();
    drive(visual, state, 0.2);
    visual.primeRagdollImpact(1, 0.2, 6);
    state.ragdoll = true;
    drive(visual, state, 2.2);
    expect(visual.ragdollBody).toBeDefined();
    state.ragdoll = false; state.locomotionSpeed = 3; // Player cleared the flag and walked off
    drive(visual, state, 0.5);
    expect(visual.ragdollBody).toBeUndefined(); // sim released, bones handed back
    expect(visual.activeAnimation).toBe('walk');
    const floor = skinnedFloorOf(parent);
    expect(floor).toBeGreaterThan(-0.05); expect(floor).toBeLessThan(0.2); // upright on its feet, not lying in the road
    let height = -Infinity;
    parent.updateMatrixWorld(true);
    const box = new THREE.Box3();
    parent.traverse((object) => {
      if (!(object instanceof THREE.SkinnedMesh)) return;
      object.computeBoundingBox();
      height = Math.max(height, box.copy(object.boundingBox!).applyMatrix4(object.matrixWorld).max.y);
    });
    expect(height).toBeGreaterThan(1.4); // standing tall again — the undo really restored the skeleton
  });

  it('death during the ragdoll keeps simulating the downed body instead of snapping to the death clip', async () => {
    const { visual, state } = await setup();
    drive(visual, state, 0.2);
    visual.primeRagdollImpact(1, 0, 7);
    state.ragdoll = true;
    drive(visual, state, 0.3);
    state.dead = true; // lethal hit landed mid-ragdoll
    drive(visual, state, 0.3);
    expect(visual.ragdollBody).toBeDefined(); // still the ragdoll's body, no mixer takeover
    expect(visual.activeAnimation).toBeUndefined();
  });
});
