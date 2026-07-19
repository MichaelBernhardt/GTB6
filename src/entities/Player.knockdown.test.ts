import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from '../core/InputManager';
import type { City } from '../world/City';
import { KNOCKDOWN_RISE_MAX, KNOCKDOWN_RISE_MIN, Player } from './Player';

// Player's rig loads textures through THREE.TextureLoader, which needs a DOM image element even in the
// node test environment; a create-only stub keeps the loader inert (mirrors Player.tumble.test.ts).
(globalThis as { document?: unknown }).document = {
  createElementNS: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
};

const GROUND = 0;
const makeCity = (support = GROUND): City => ({
  clampMoveAt: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone(),
  supportHeight: () => support,
  surfaceHeightAt: () => support,
} as unknown as City);

const input = (keys: string[] = []): InputManager => ({
  aiming: false, firing: false, firePressed: false,
  down: (code: string) => keys.includes(code), consume: () => false,
} as unknown as InputManager);

const step = (player: Player, seconds: number, city: City, held: string[] = []): void => {
  for (let remaining = seconds; remaining > 1e-9; remaining -= 1 / 60) player.update(Math.min(1 / 60, remaining), input(held), 0, city);
};

describe('player impact knockdown', () => {
  it('a hard landing goes ragdoll (not the canned tumble) and bills fall damage through the usual path', () => {
    const city = makeCity();
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, 30, 0)); // 30u over the safe 12u drop
    step(player, 3, city);
    expect(player.consumeFallDamage()).toBeGreaterThan(0);
    expect(player.knockedDown).toBe(true);
    expect(player.tumbling).toBe(false);
    expect(player.onGround).toBe(true);
  });

  it('a landing inside the safe drop stays on its feet — no ragdoll, no damage', () => {
    const city = makeCity();
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, 8, 0));
    step(player, 3, city);
    expect(player.consumeFallDamage()).toBe(0);
    expect(player.knockedDown).toBe(false);
  });

  it('locks input while down and restores control after the down window', () => {
    const city = makeCity();
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, GROUND, 0));
    player.knockdown(1, 0, 4, 0, city);
    expect(player.knockedDown).toBe(true);
    const before = player.group.position.clone();
    step(player, KNOCKDOWN_RISE_MIN, city, ['KeyW', 'ShiftLeft']); // hammering sprint does nothing from the deck
    expect(player.group.position.distanceTo(before)).toBeLessThan(1e-6);
    expect(player.moving).toBe(false);
    // No rig loaded in this test, so there is no rest signal: the max window is the rise time.
    step(player, KNOCKDOWN_RISE_MAX, city, ['KeyW']);
    expect(player.knockedDown).toBe(false);
    step(player, 0.5, city, ['KeyW']);
    expect(player.group.position.distanceTo(before)).toBeGreaterThan(0.5); // walking again
  });

  it('cancels an in-flight tumble and ignores re-triggers while already down', () => {
    const city = makeCity();
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, GROUND, 0));
    player.tumble();
    expect(player.tumbling).toBe(true);
    player.knockdown(0, 1, 3, 0, city);
    expect(player.tumbling).toBe(false);
    expect(player.knockedDown).toBe(true);
    step(player, KNOCKDOWN_RISE_MAX - 0.2, city);
    player.knockdown(1, 0, 9, 0, city); // second car rolls over the body: damage is billed elsewhere, the clock must not restart
    step(player, 0.3, city);
    expect(player.knockedDown).toBe(false); // rose on the original window
  });

  it('death during the ragdoll stays down and only heal() (respawn) clears it', () => {
    const city = makeCity();
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, GROUND, 0));
    player.knockdown(1, 0, 6, 0, city);
    player.takeDamage(200);
    player.setDead(true);
    step(player, KNOCKDOWN_RISE_MAX + 1, city); // update() short-circuits for the dead — no rise
    expect(player.knockedDown).toBe(true);
    player.heal(); // the respawn path
    expect(player.knockedDown).toBe(false);
    expect(player.health).toBe(player.maxHealth);
  });

  it('never knocks down an already-dead player (a normal death keeps the death clip)', () => {
    const city = makeCity();
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, GROUND, 0));
    player.takeDamage(200);
    player.setDead(true);
    player.knockdown(1, 0, 6, 0, city);
    expect(player.knockedDown).toBe(false);
  });
});
