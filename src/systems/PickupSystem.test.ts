import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PICKUP_BLINK_AT, PICKUP_LIFETIME, PICKUP_RADIUS, PickupSystem } from './PickupSystem';

const far = new THREE.Vector3(500, 0, 500);

describe('PickupSystem', () => {
  it('collects items on walk-over when on foot', () => {
    const scene = new THREE.Scene();
    const system = new PickupSystem(scene);
    system.spawnCash(new THREE.Vector3(0, 0, 0), 55);
    expect(system.update(0.016, far, true)).toHaveLength(0);
    const collected = system.update(0.016, new THREE.Vector3(PICKUP_RADIUS * 0.5, 0, 0), true);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ kind: 'cash', amount: 55 });
    expect(system.pickups).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
  });

  it('ignores walk-over while driving', () => {
    const system = new PickupSystem(new THREE.Scene());
    system.spawnWeapon(new THREE.Vector3(0, 0, 0), 'smg');
    expect(system.update(0.016, new THREE.Vector3(), false)).toHaveLength(0);
    expect(system.pickups).toHaveLength(1);
    const collected = system.update(0.016, new THREE.Vector3(), true);
    expect(collected[0]).toMatchObject({ kind: 'weapon', weapon: 'smg' });
  });

  it('despawns after the lifetime and blinks near the end', () => {
    const scene = new THREE.Scene();
    const system = new PickupSystem(scene);
    system.spawnAmmo(new THREE.Vector3(0, 0, 0));
    for (let t = 0; t < PICKUP_BLINK_AT - 1; t += 0.5) system.update(0.5, far, true);
    expect(system.pickups[0]?.group.visible).toBe(true);
    let sawBlink = false;
    while (system.pickups.length > 0) { system.update(0.05, far, true); if (system.pickups[0] && !system.pickups[0].group.visible) sawBlink = true; }
    expect(sawBlink).toBe(true);
    expect(scene.children).toHaveLength(0);
  });

  it('enforces the configured timing constants', () => {
    expect(PICKUP_LIFETIME).toBe(30);
    expect(PICKUP_LIFETIME - PICKUP_BLINK_AT).toBe(5);
  });
});
