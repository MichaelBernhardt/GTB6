import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MELEE_COOLDOWN_MIN, MELEE_ENGAGE_RANGE, MELEE_HIT_AT, MELEE_SWING_SECONDS } from '../systems/MeleeSystem';
import type { City } from '../world/City';
import { Pedestrian } from './Pedestrian';

const openCity = {
  surfaceHeightAt: () => 0,
  clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone(),
  wanderTarget: () => undefined,
  collides: () => false,
} as unknown as City;

const DT = 1 / 60;
const step = (ped: Pedestrian, seconds: number, player: THREE.Vector3): void => {
  for (let t = 0; t < seconds; t += DT) ped.update(DT, openCity, [{ x: 40, z: 40 }], player);
};

describe('hostile pursuit', () => {
  it('closes to engage range, keeps the hostile state, and faces the player instead of idling at arm\'s length', () => {
    const player = new THREE.Vector3(0, 0, 0);
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(0, 0, 12), 30, true);
    step(ped, 4, player);
    const distance = ped.group.position.distanceTo(player);
    expect(distance).toBeLessThanOrEqual(MELEE_ENGAGE_RANGE + 0.01);
    expect(distance).toBeGreaterThan(0.5); // squared up, not standing inside the player
    expect(ped.state).toBe('hostile'); // the old arrival branch flipped this to 'idle' — the bug that starved every attack
    const facing = Math.sin(ped.group.rotation.y) * (player.x - ped.group.position.x) + Math.cos(ped.group.rotation.y) * (player.z - ped.group.position.z);
    expect(facing / distance).toBeGreaterThan(0.95);
    step(ped, 3, player); // holding ground stays stable over time
    expect(ped.state).toBe('hostile');
    expect(ped.group.position.distanceTo(player)).toBeLessThanOrEqual(MELEE_ENGAGE_RANGE + 0.01);
  });

  it('an enraged aggressive civilian runs the same engage loop', () => {
    const player = new THREE.Vector3(0, 0, 0);
    const civilian = new Pedestrian(new THREE.Scene(), new THREE.Vector3(0, 0, 10), 9); // index 9: aggressive
    expect(civilian.aggressive).toBe(true);
    civilian.applyFear(60, player);
    expect(civilian.state).toBe('hostile');
    step(civilian, 4, player);
    expect(civilian.state).toBe('hostile');
    expect(civilian.group.position.distanceTo(player)).toBeLessThanOrEqual(MELEE_ENGAGE_RANGE + 0.01);
  });

  it('a police officer in the hostile hustle state keeps the old arrival behaviour (bust flow untouched)', () => {
    const player = new THREE.Vector3(0, 0, 0);
    const officer = new Pedestrian(new THREE.Scene(), new THREE.Vector3(0, 0, 1.2), 5, false, true);
    officer.state = 'hostile'; officer.destination.copy(player); // PoliceSystem's hustle-to-the-door reuse
    officer.update(DT, openCity, [{ x: 40, z: 40 }], player);
    expect(officer.state).toBe('idle'); // arrival flip, exactly as before the melee fix
  });
});

describe('the swing state machine', () => {
  it('punches on request, reports the hit exactly once at the extension frame, then recovers', () => {
    const player = new THREE.Vector3(0, 0, 0);
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(0, 0, 1.4), 30, true);
    expect(ped.meleeReady).toBe(true);
    expect(ped.punch()).toBe(true);
    expect(ped.punching).toBe(true);
    expect(ped.punch()).toBe(false); // mid-swing: no restart

    let hits = 0; let elapsed = 0; let hitAt = 0;
    while (elapsed < MELEE_SWING_SECONDS + 0.1) {
      ped.update(DT, openCity, [], player); elapsed += DT;
      if (ped.consumeMeleeHit()) { hits += 1; hitAt = elapsed; }
    }
    expect(hits).toBe(1);
    expect(hitAt).toBeGreaterThanOrEqual(MELEE_HIT_AT); // a windup, never damage at swing start
    expect(ped.punching).toBe(false);
    expect(ped.meleeReady).toBe(false); // recovering
    expect(ped.punch()).toBe(false);
    step(ped, MELEE_COOLDOWN_MIN + 0.7, player);
    expect(ped.meleeReady).toBe(true); // cooled down: may swing again
  });

  it('going down mid-windup cancels the swing and any queued hit', () => {
    const player = new THREE.Vector3(0, 0, 0);
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(0, 0, 1.4), 30, true);
    ped.punch();
    step(ped, MELEE_HIT_AT / 2, player);
    ped.takeDamage(999, player);
    step(ped, 0.5, player);
    expect(ped.consumeMeleeHit()).toBe(false); // no punches landed from the floor
    expect(ped.punching).toBe(false);
  });
});
