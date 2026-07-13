import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from '../core/InputManager';
import type { City } from '../world/City';
import { Player } from './Player';

// Player's rig loads textures through THREE.TextureLoader, which needs a DOM image element even in the
// node test environment; a create-only stub keeps the loader inert (mirrors Player.skyfall.test.ts).
(globalThis as { document?: unknown }).document = {
  createElementNS: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
};

const GROUND = 0;
const city = {
  clampMoveAt: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone(),
  supportHeight: () => GROUND,
  surfaceHeightAt: () => GROUND,
} as unknown as City;
const idle: InputManager = { aiming: false, firing: false, firePressed: false, down: () => false, consume: () => false } as unknown as InputManager;

// Regression: a rider knocked off a two-wheeler used to land inverted, feet poking under the tar. While
// riding, the player group copies the bike's FULL orientation (Game.updateDriving), so it carries the
// bike's terrain pitch on rotation.x. The old tumble only ever wrote rotation.z, so that inherited pitch
// survived and flipped the body below the surface. knockOff now calls resetAirbornePose() and applyTumble
// pins rotation.x = 0.
describe('two-wheeler knock-off tumble', () => {
  it('never lands inverted even when the rider inherited a steep bike pitch, and gets up upright', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, GROUND, 0));
    // Mimic a pitched/banked bike whose orientation was copied onto the rider at the moment of the crash.
    player.group.rotation.set(1.1, Math.PI * 0.5, 0.4);

    // knockOff() does exactly this before the tumble: wipe the inherited airborne/bike pose, keep heading.
    const heading = player.group.rotation.y;
    player.resetAirbornePose();
    player.group.position.set(0, GROUND, 0);
    player.onGround = true; player.velocityY = 0;
    player.tumble();

    for (let i = 0; i < 200 && player.tumbling; i++) {
      player.update(1 / 60, idle, 0, city);
      expect(player.bodyUp().y).toBeGreaterThan(-0.001); // rolled onto the side at worst — never head-under-heels
    }

    expect(player.tumbling).toBe(false); // the tumble finished, not locked
    expect(player.group.rotation.x).toBeCloseTo(0);
    expect(player.group.rotation.z).toBeCloseTo(0);
    expect(player.group.rotation.y).toBeCloseTo(heading); // heading survives the knock-off
    expect(player.bodyUp().y).toBeGreaterThan(0.999); // fully upright again
  });

  it('clears an inherited pitch through the tumble alone (applyTumble pins rotation.x = 0)', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, GROUND, 0));
    player.group.rotation.x = 1.3; // a stray pitch reaches the tumble without a reset (e.g. a car-bump knockdown)
    player.onGround = true;
    player.tumble();

    for (let i = 0; i < 200 && player.tumbling; i++) {
      player.update(1 / 60, idle, 0, city);
      expect(player.bodyUp().y).toBeGreaterThan(-0.001);
    }

    expect(player.group.rotation.x).toBeCloseTo(0);
    expect(player.bodyUp().y).toBeGreaterThan(0.999);
  });
});
