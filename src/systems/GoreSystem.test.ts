import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { GoreSystem } from './GoreSystem';

// The tests run in the node environment (vite.config.ts); GoreSystem paints its decal texture onto a
// canvas at construction, so give it just enough of a document to do that.
beforeAll(() => {
  const context = {
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    fillStyle: '', beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
    closePath: () => undefined, fill: () => undefined, arc: () => undefined,
  };
  (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
});

const droplets = (scene: THREE.Scene): number => scene.children.filter((child) => child.name === 'gore-droplet').length;

/** High spawn point + tiny dt so no droplet lands or expires inside the census window. */
const SPAWN = new THREE.Vector3(0, 40, 0);
const TICK = 0.001;

describe('GoreSystem burst amortisation', () => {
  it('spawns only the onset tranche in the burst frame and the rest over later updates', () => {
    const scene = new THREE.Scene();
    const gore = new GoreSystem(scene);
    gore.burst(SPAWN, 1.5, true); // kill-sized: round(70 * 1.5) = 105 droplets
    const onset = droplets(scene);
    expect(onset).toBeGreaterThan(0); // blood visible on the very frame of the hit
    expect(onset).toBeLessThanOrEqual(14); // but the frame never eats the whole burst
    let previous = onset;
    for (let step = 0; step < 10 && droplets(scene) - previous >= 0; step++) {
      gore.update(TICK);
      const added = droplets(scene) - previous;
      expect(added).toBeLessThanOrEqual(110); // per-frame drain budget
      previous = droplets(scene);
    }
    expect(droplets(scene)).toBe(105); // nothing lost — the full spray arrives
  });

  it('a crowd blast never exceeds the per-frame budget or the live droplet cap', () => {
    const scene = new THREE.Scene();
    const gore = new GoreSystem(scene);
    for (let victim = 0; victim < 16; victim++) gore.burst(SPAWN, 1.7, true); // 16 kills: 16 * round(70*1.7) = 1,904 requested
    expect(droplets(scene)).toBeLessThanOrEqual(16 * 14); // burst frame: onset tranches only
    let previous = droplets(scene);
    for (let step = 0; step < 40; step++) {
      gore.update(TICK);
      expect(droplets(scene) - previous).toBeLessThanOrEqual(110);
      expect(droplets(scene)).toBeLessThanOrEqual(650); // hard cap: the unseen tail is discarded, airborne blood never vanishes
      previous = droplets(scene);
    }
    expect(droplets(scene)).toBe(650); // the cap actually engaged for this melee
  });

  it('a single wounded-sized burst still fully lands (no cap, no truncation)', () => {
    const scene = new THREE.Scene();
    const gore = new GoreSystem(scene);
    gore.burst(SPAWN, 0.9, false); // round(40 * 0.9) = 36
    for (let step = 0; step < 5; step++) gore.update(TICK);
    expect(droplets(scene)).toBe(36);
  });
});
