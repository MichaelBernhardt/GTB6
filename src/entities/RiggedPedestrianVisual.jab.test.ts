import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { MELEE_HIT_AT, MELEE_SWING_SECONDS, PALM_LOCAL_X, PALM_LOCAL_Z, PALM_SIGN } from '../systems/MeleeSystem';
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
    // The OFF-hand holds guard through the entire swing: fist forward of the torso, never
    // trailing behind the back (the relaxed base pose + punch lean used to read exactly that).
    for (const t of [0.06, 0.18, 0.3, 0.42, 0.54]) {
      visual.setState(state({ punchElapsed: t })); visual.update(1 / 30);
      parent.updateMatrixWorld(true);
      const off = bone('Hand_L');
      expect(off.z).toBeGreaterThan(0.1);
      expect(off.y).toBeGreaterThan(1.1); expect(off.y).toBeLessThan(1.6); // chin/chest guard height
    }
    // Full engagement cycle at frame rate — braced hold, whole swing, recovery, back to hold:
    // NEITHER fist ever crosses behind the torso plane. The guard is the floor pose under the
    // jab, so the swing's blend-in and retract tail can never expose the relaxed base
    // (owner report: "both hands return to behind the back before/after punch").
    const bothInFront = () => {
      parent.updateMatrixWorld(true);
      expect(bone('Hand_L').z).toBeGreaterThan(0);
      expect(bone('Hand_R').z).toBeGreaterThan(0);
    };
    visual.setState(state({ punching: false, braced: true }));
    for (let i = 0; i < 10; i++) { visual.update(1 / 30); bothInFront(); }
    for (let t = 1 / 30; t < MELEE_SWING_SECONDS; t += 1 / 30) {
      visual.setState(state({ punchElapsed: t, braced: true })); visual.update(1 / 30); bothInFront();
    }
    visual.setState(state({ punching: false, braced: true }));
    for (let i = 0; i < 6; i++) { visual.update(1 / 30); bothInFront(); }
    expect(bone('Hand_L').z).toBeGreaterThan(0.1); // and the settled braced stance is a real guard
    expect(bone('Hand_R').z).toBeGreaterThan(0.1);
    // Palms face INWARD (toward the body midline) with a downward bias — never palm-up
    // "offering". Body right is -x in this identity-parent frame (the right hand hangs at
    // negative x); the palm normal comes from the measured hand-local flat axis.
    const palmNormal = (handName: 'Hand_L' | 'Hand_R'): THREE.Vector3 => {
      const hand = parent.getObjectByName(handName)!;
      parent.updateMatrixWorld(true);
      const mirror = handName === 'Hand_R' ? 1 : -1;
      return new THREE.Vector3(PALM_SIGN * PALM_LOCAL_X, 0, PALM_SIGN * (mirror > 0 ? PALM_LOCAL_Z : -PALM_LOCAL_Z))
        .applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()));
    };
    const expectInward = () => {
      // Hand_R hangs at -x on these rigs, so its midline direction is +x (and mirrored for L).
      const right = palmNormal('Hand_R'); const left = palmNormal('Hand_L');
      expect(right.x).toBeGreaterThan(0.5); // right palm toward the midline
      expect(left.x).toBeLessThan(-0.5); // left palm toward the midline
      expect(right.y).toBeLessThan(0.2); expect(left.y).toBeLessThan(0.2); // never tipped palm-up
    };
    expectInward(); // settled guard
    visual.setState(state({ punchElapsed: MELEE_HIT_AT - 0.001, braced: true })); visual.update(1 / 30);
    expectInward(); // and at full extension
    expect(midDrive.straightDeg).toBeLessThan(120); // still coiled well into the drive
    expect(atHit.f.z - chamber.z).toBeGreaterThan(0.35); // real forward travel
  });
});
