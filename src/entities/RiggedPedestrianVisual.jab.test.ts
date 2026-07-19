import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { MELEE_HIT_AT, MELEE_SWING_SECONDS } from '../systems/MeleeSystem';
import { RiggedPedestrianVisual, type RiggedPedestrianState } from './RiggedPedestrianVisual';

class FakeImage {
  width = 1024; height = 1024;
  private listeners = new Map<string, () => void>();
  addEventListener(name: string, callback: () => void): void { this.listeners.set(name, callback); }
  removeEventListener(): void {}
  set src(_value: string) { queueMicrotask(() => this.listeners.get('load')?.call(this)); }
}
beforeAll(() => {
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { createElementNS: () => new FakeImage() }, configurable: true });
});
const loadNpc = async (): Promise<GLTF> => {
  const file = await readFile('public/models/npcs/bree-rank-enforcer.glb');
  return new GLTFLoader().parseAsync(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), '/models/npcs/');
};
const state = (overrides: Partial<RiggedPedestrianState> = {}): RiggedPedestrianState => ({
  state: 'hostile', dead: false, knockdown: false, punching: true, punchElapsed: 0, braced: true, hailing: false, covering: false, stumbling: false, stumbleAmount: 0, ...overrides,
});

describe("jab mechanics regression", () => {
  it('fist travels a straight late-snapping line; elbow bent until late, straight at the hit', async () => {
    const parent = new THREE.Group();
    const visual = new RiggedPedestrianVisual(parent, 'bree-rank-enforcer', { load: () => loadNpc(), random: () => 0.95 });
    await visual.load();
    const bone = (name: string) => parent.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
    const sample = (elapsed: number) => {
      visual.setState(state({ punchElapsed: elapsed })); visual.update(1 / 30);
      parent.updateMatrixWorld(true);
      const s = bone('UpperArm_R'), e = bone('LowerArm_R'), f = bone('Hand_R');
      const elbowDeg = THREE.MathUtils.radToDeg(e.clone().sub(s).angleTo(f.clone().sub(e)));
      return { f, straightDeg: 180 - elbowDeg, elapsed };
    };
    const rows: ReturnType<typeof sample>[] = [];
    for (let t = 0.04; t <= MELEE_SWING_SECONDS - 0.02; t += 0.04) rows.push(sample(t));
    // Drive-phase straight line: deviation of intermediate fist points from the chamber→extension chord.
    const chamber = rows.find((r) => Math.abs(r.elapsed - 0.12) < 0.021)!.f;
    const ext = sample(MELEE_HIT_AT - 0.001).f;
    const chord = ext.clone().sub(chamber);
    for (const r of rows.filter((x) => x.elapsed > 0.12 && x.elapsed <= MELEE_HIT_AT)) {
      const rel = r.f.clone().sub(chamber);
      const dev = rel.clone().sub(chord.clone().multiplyScalar(rel.dot(chord) / chord.lengthSq())).length();
      expect(dev).toBeLessThan(0.14); // a jab line, not an arc up
    }
    const atHit = sample(MELEE_HIT_AT - 0.001); // the exact damage frame
    const midDrive = rows.find((r) => Math.abs(r.elapsed - 0.24) < 0.021)!;
    expect(atHit.straightDeg).toBeGreaterThan(150); // snapped straight at the damage frame
    expect(midDrive.straightDeg).toBeLessThan(120); // still coiled well into the drive
    expect(atHit.f.z - chamber.z).toBeGreaterThan(0.35); // real forward travel
  });
});
