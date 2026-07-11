import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from '../core/InputManager';
import type { City } from '../world/City';
import { FREEFALL_TIP, FREEFALL_TIP_RANGE, Player } from './Player';
import { SKYFALL_ALTITUDE, startAirborne, stepAirborne, type AirborneStick } from '../systems/SkyfallSystem';

// Player's rig loads textures through THREE.TextureLoader, which needs a DOM image element even in the
// node test environment; a create-only stub keeps the loader inert (mirrors Player.cover.test.ts).
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

describe('skyfall pose', () => {
  it('never tips the neutral+dive band past vertical, so the diver stays face-down (never on their back)', () => {
    expect(FREEFALL_TIP + FREEFALL_TIP_RANGE).toBeLessThan(Math.PI / 2); // full dive still short of vertical
    expect(FREEFALL_TIP - FREEFALL_TIP_RANGE).toBeGreaterThan(0); // full flatten still belly-down
  });

  it('snaps belly-to-earth the instant the skyfall starts (not upright then tipping over)', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, SKYFALL_ALTITUDE, 0));
    player.startSkydive();
    const up = player.bodyUp();
    expect(up.y).toBeGreaterThan(0); // still face-down, head above horizontal
    expect(up.y).toBeLessThan(0.5); // but already firmly tipped over — not the standing pose
  });

  it('flies a full freefall descent holding W (dive) and never inverts, then lands upright + controllable', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, SKYFALL_ALTITUDE, 0));
    player.startSkydive();
    const state = startAirborne(player.heading, SKYFALL_ALTITUDE);
    const dive: AirborneStick = { pitch: 1, steer: 0, flare: false }; // hold W the whole way down
    let y = SKYFALL_ALTITUDE;
    let landed = false;
    for (let i = 0; i < 6000 && !landed; i++) {
      const step = stepAirborne(state, dive, 1 / 60, y, GROUND);
      y = step.y; landed = step.landed;
      player.animateAirborne(1 / 60, state.mode, state.pitch, state.bank);
      expect(player.bodyUp().y).toBeGreaterThanOrEqual(0); // belly-to-earth every frame — never rolled onto the back
    }
    expect(landed).toBe(true);

    // Touchdown: Game clears the airborne pose and settles the player on the support surface. Without the
    // reset the dive tip survives and the player is stuck inverted.
    player.resetAirbornePose();
    player.group.position.set(0, GROUND, 0);
    player.onGround = true; player.velocityY = 0;
    for (let i = 0; i < 60; i++) player.update(1 / 60, idle, 0, city);

    expect(player.group.rotation.x).toBeCloseTo(0);
    expect(player.group.rotation.z).toBeCloseTo(0);
    expect(player.bodyUp().y).toBeGreaterThan(0.999); // fully upright again
    expect(player.onGround).toBe(true);
    expect(player.tumbling).toBe(false); // controllable, not locked in a tumble
  });
});
