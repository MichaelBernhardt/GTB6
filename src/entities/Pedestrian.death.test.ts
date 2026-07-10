import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { City, RoadPoint } from '../world/City';
import { Pedestrian } from './Pedestrian';

const city = { clampMove: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone() } as unknown as City;
const choices: RoadPoint[] = [{ x: 40, z: 40 }];
const expectDown = (ped: Pedestrian): void => {
  expect(ped.state).toBe('down');
  expect(ped.group.scale.y).toBe(1);
  expect(ped.group.rotation.z).toBeCloseTo(Math.PI / 2);
  expect(ped.group.rotation.x).toBe(0);
  expect(ped.group.position.y).toBeCloseTo(0.36);
};

describe('Pedestrian death pose', () => {
  it('falls over cleanly when killed while walking', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 1);
    for (let i = 0; i < 30; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(5, 0, 5));
    ped.takeDamage(999);
    for (let i = 0; i < 30; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(5, 0, 5));
    expectDown(ped);
  });

  it('falls over cleanly when killed while cowering', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 2);
    ped.bravery = 0.1; ped.aggressive = false;
    ped.applyFear(100, new THREE.Vector3(1, 0, 0));
    ped.update(1 / 60, city, choices, new THREE.Vector3(5, 0, 5));
    expect(ped.state).toBe('cower');
    expect(ped.group.scale.y).toBeLessThan(1);
    ped.takeDamage(999);
    for (let i = 0; i < 30; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(5, 0, 5));
    expectDown(ped);
  });

  it('falls over cleanly when killed while hostile mid-lean', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 0);
    ped.aggressive = true;
    ped.applyFear(100, new THREE.Vector3(1, 0, 0));
    for (let i = 0; i < 10; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(8, 0, 8));
    expect(ped.state).toBe('hostile');
    ped.takeDamage(999);
    for (let i = 0; i < 30; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(8, 0, 8));
    expectDown(ped);
  });

  it('never freezes into a cower while fleeing under sustained gunfire', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 2);
    ped.bravery = 0.1; ped.aggressive = false;
    ped.takeDamage(10);
    expect(ped.state).toBe('flee');
    for (let round = 0; round < 4; round++) {
      ped.applyFear(60, new THREE.Vector3(1, 0, 0));
      for (let i = 0; i < 10; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(5, 0, 5));
      expect(ped.state).toBe('flee');
      expect(ped.group.scale.y).toBe(1);
    }
  });

  it('falls over cleanly when killed by partial damage in two hits', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    ped.takeDamage(35);
    for (let i = 0; i < 10; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(5, 0, 5));
    ped.takeDamage(35);
    for (let i = 0; i < 30; i++) ped.update(1 / 60, city, choices, new THREE.Vector3(5, 0, 5));
    expectDown(ped);
  });
});
