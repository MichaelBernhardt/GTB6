import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { City, RoadPoint } from '../world/City';
import { Pedestrian } from './Pedestrian';

// Free-movement stub: the ped walks unobstructed toward its destination, so it stays in the 'walk' state
// across the frames a cooldown test needs (no wall snags flipping it to idle).
const city = { clampMove: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone(), surfaceHeightAt: () => 0 } as unknown as City;
const far: RoadPoint[] = [{ x: 500, z: 500 }]; // kept far so the ped never arrives and keeps wanting a route

describe('Pedestrian replan cooldown', () => {
  it('wants a route while walking without one', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 1);
    ped.pickDestination(far);
    expect(ped.wantsRoute).toBe(true);
  });

  it('stops asking after a deferred (failed) attempt, then asks again once the cooldown elapses', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 1);
    ped.pickDestination(far);
    ped.deferRoute();
    expect(ped.wantsRoute).toBe(false); // gated: a starved/failed request won't re-solve A* every frame
    // cooldown is 0.8–2.0s; advance ~2.4s of walking (destination stays far, so it keeps walking)
    for (let i = 0; i < 150; i++) ped.update(1 / 60, city, far, new THREE.Vector3(1000, 0, 1000));
    expect(ped.wantsRoute).toBe(true); // eligible again after the cooldown drains
  });
});
