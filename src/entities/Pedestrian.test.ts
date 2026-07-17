import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { City } from '../world/City';
import { DEATH_SPIN_DURATION, Pedestrian } from './Pedestrian';

const flatCity = { surfaceHeightAt: () => 0 } as unknown as City;
const step = (ped: Pedestrian, seconds: number): void => {
  for (let t = 0; t < seconds; t += 1 / 30) ped.update(1 / 30, flatCity, [], new THREE.Vector3(50, 0, 50));
};

describe('death spin', () => {
  const shoot = (originX: number): Pedestrian => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    ped.group.rotation.y = 0; // facing +z
    expect(ped.takeDamage(999, new THREE.Vector3(originX, 1, 0))).toBe(true);
    return ped;
  };

  it('whips the felled body away from the shot side, then comes to rest', () => {
    const ped = shoot(4); // shot from the ped's right
    step(ped, DEATH_SPIN_DURATION + 0.2);
    const settled = ped.group.rotation.y;
    expect(settled).toBeLessThan(-1); // spun left, a meaningful whip (~65-125°)
    expect(Math.abs(settled)).toBeLessThanOrEqual(2.3);
    step(ped, 0.5);
    expect(ped.group.rotation.y).toBe(settled); // the corpse does not keep creeping around
    expect(ped.state).toBe('down');
  });

  it('spins the opposite way when hit from the other side and is front-loaded like an impact', () => {
    const ped = shoot(-4); // shot from the ped's left
    step(ped, DEATH_SPIN_DURATION / 2);
    const early = ped.group.rotation.y;
    expect(early).toBeGreaterThan(0);
    step(ped, DEATH_SPIN_DURATION);
    const settled = ped.group.rotation.y;
    expect(settled).toBeGreaterThan(1);
    expect(early).toBeGreaterThan(settled / 2); // most of the whip lands in the first half — impact, not a lazy turntable
  });

  it('still spins on kills with no known source, and survivors do not spin', () => {
    const blasted = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    expect(blasted.takeDamage(999)).toBe(true);
    step(blasted, DEATH_SPIN_DURATION + 0.1);
    expect(Math.abs(blasted.group.rotation.y)).toBeGreaterThan(1);

    const grazed = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    expect(grazed.takeDamage(5, new THREE.Vector3(4, 1, 0))).toBe(false);
    expect(grazed.state).not.toBe('down');
  });
});
