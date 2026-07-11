import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from '../core/InputManager';
import type { City } from '../world/City';
import { Player, type CoverPose } from './Player';

// Player's rig loads jacket/denim textures through THREE.TextureLoader, which needs a DOM
// image element even in the node test environment; a create-only stub keeps the loader inert.
(globalThis as { document?: unknown }).document = {
  createElementNS: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
};

const GROUND = 4.2; // a typical hillside height since the city gained terrain relief
const city = {
  clampMoveAt: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone(),
  supportHeight: () => GROUND,
  surfaceHeightAt: () => GROUND,
} as unknown as City;
const input = (aiming: boolean): InputManager => ({ aiming, firing: false, firePressed: false, down: () => false, consume: () => false } as unknown as InputManager);

describe('Player cover pose on elevated terrain', () => {
  it('keeps feet on the local ground while holding cover', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(4, GROUND, 9));
    const pose: CoverPose = { heading: Math.PI / 2, peek: 0, twist: 0, moving: false };
    for (let i = 0; i < 45; i++) player.update(1 / 60, input(false), 0, city, pose);
    expect(player.group.position.y).toBeCloseTo(GROUND);
    expect(player.onGround).toBe(true);
  });

  it('stays grounded through an over-the-shoulder peek aim', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(4, GROUND, 9));
    const pose: CoverPose = { heading: Math.PI / 2, peek: 1, twist: 0.45, moving: false };
    for (let i = 0; i < 45; i++) player.update(1 / 60, input(true), 0, city, pose);
    expect(player.group.position.y).toBeCloseTo(GROUND);
  });
});
