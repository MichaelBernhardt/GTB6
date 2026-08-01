import * as THREE from 'three';

/** A fixed pool of effect PointLights that live in the scene from construction and are only ever
 *  driven by intensity/position — never scene.add/removed at runtime.
 *
 *  WHY: three keys every lit material's shader program on the scene's per-type light COUNT
 *  (WebGLLights hash: pointLength/spotLength/...). Adding or removing a single light re-keys all
 *  ~1,700 lit materials, and a never-before-seen count synchronously compiles ~25 shader programs —
 *  measured at 1–25 s in one frame depending on driver. Explosions, muzzle flashes, vehicle fires and
 *  rocket flames used to add/remove lights exactly that way, so every explosion stalled the game.
 *  With a fixed pool the counts never change after boot: zero recompiles, zero re-key sweeps, on
 *  every quality tier. Same pattern DayNight uses for its streetlight/headlight pools.
 *
 *  RULES for pooled lights (three collects a light into the count only while it is visible and all
 *  ancestors are visible):
 *   - always a direct child of the scene root — never parented under a hideable group;
 *   - `visible` stays true forever; an idle light is intensity 0, which three still counts;
 *   - release() instead of scene.remove(); acquire() re-tints and re-ranges the same light.
 *  Slot budgets are fixed per consumer (see Game's construction of the systems): a consumer past its
 *  budget simply renders its effect without a light — invisible next to the effect itself. */
export class EffectLightPool {
  private free: THREE.PointLight[] = [];
  /** All pooled lights, acquired or not — for tests and audits. */
  readonly lights: THREE.PointLight[] = [];

  constructor(scene: THREE.Scene, slots: number) {
    for (let i = 0; i < slots; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1);
      light.name = 'effectlight';
      light.castShadow = false;
      scene.add(light);
      this.lights.push(light);
      this.free.push(light);
    }
  }

  /** Borrow a light, tinted and ranged for the effect. Returns undefined when the pool is exhausted —
   *  callers must treat a missing light as "effect renders without its glow", never as an error. */
  acquire(color: number, intensity: number, distance: number): THREE.PointLight | undefined {
    const light = this.free.pop();
    if (!light) return undefined;
    light.color.setHex(color);
    light.intensity = intensity;
    light.distance = distance;
    return light;
  }

  /** Return a borrowed light to the pool. Idempotent and undefined-tolerant so effect teardown code
   *  can release unconditionally. */
  release(light: THREE.PointLight | undefined): void {
    if (!light || !this.lights.includes(light) || this.free.includes(light)) return;
    light.intensity = 0;
    this.free.push(light);
  }

  /** Idle slots remaining (for tests and the console). */
  get available(): number { return this.free.length; }

  /** Drop the whole pool out of (or back into) the renderer's light census. Used while the player
   *  is inside a feature interior: the outdoor world these lights serve is hidden there, but a
   *  visible light — even at intensity 0 — still costs every rendered fragment a loop iteration.
   *  Borrow/release bookkeeping is untouched; an effect firing while hidden simply renders without
   *  its glow, which is already the pool-exhausted contract. */
  setVisible(visible: boolean): void {
    for (const light of this.lights) light.visible = visible;
  }
}
