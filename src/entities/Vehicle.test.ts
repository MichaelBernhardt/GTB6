import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from '../core/InputManager';
import type { City } from '../world/City';
import { bikeLeanTarget, MAX_BIKE_LEAN, Vehicle } from './Vehicle';

// A tilted ground plane with its analytic normal, so alignToRoad sees genuine terrain pitch.
function slopedCity(a: number, b: number): City {
  return {
    clampMove: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone(),
    roadHeightAt: (x: number, z: number) => a * x + b * z,
    surfaceNormalAt: () => new THREE.Vector3(-a, 1, -b).normalize(),
    props: undefined,
  } as unknown as City;
}
const heldInput = (keys: Set<string>) => ({ down: (code: string) => keys.has(code) }) as unknown as InputManager;
const worldRoll = (bike: Vehicle) => Math.acos(THREE.MathUtils.clamp(new THREE.Vector3(0, 1, 0).applyQuaternion(bike.group.quaternion).y, -1, 1));

describe('bikeLeanTarget', () => {
  it('rests on a gentle kickstand tilt when parked/disabled', () => {
    expect(bikeLeanTarget(0.48, 30, 46, true)).toBe(0.15);
  });
  it('banks with steer and speed, clamped to a sane maximum', () => {
    expect(bikeLeanTarget(0, 46, 46, false)).toBeCloseTo(0);
    expect(bikeLeanTarget(-0.5, 46, 46, false)).toBeGreaterThan(0); // steer one way -> lean that way
    expect(bikeLeanTarget(0.5, 46, 46, false)).toBeLessThan(0);
    expect(Math.abs(bikeLeanTarget(1000, 9999, 46, false))).toBeLessThanOrEqual(MAX_BIKE_LEAN); // never blows past the cap
    expect(Math.abs(bikeLeanTarget(0.48, 2, 46, false))).toBeLessThan(0.05); // barely moving -> barely leans
  });
});

describe('two-wheeler never flips onto its side while turning', () => {
  it('keeps world roll modest through a sustained turn on sloped terrain (regression: terrain-elevation)', () => {
    const scene = new THREE.Scene();
    const bike = new Vehicle(scene, 'motorbike', new THREE.Vector3(0, 0, 0));
    bike.playerControlled = true;
    const city = slopedCity(0.14, 0.09); // ~10deg slope, the kind of cell a moderate turn crosses
    const input = heldInput(new Set(['KeyW', 'KeyD'])); // throttle + steer right, held
    let maxRoll = 0;
    for (let i = 0; i < 600; i++) { bike.updatePlayer(1 / 60, input, city); maxRoll = Math.max(maxRoll, worldRoll(bike)); }
    expect(bike.wrecked).toBe(false); // no crash happened
    expect(maxRoll).toBeLessThan(MAX_BIKE_LEAN + 0.35); // lean + terrain pitch only, never near a 90deg side-lie
  });

  it('a wrecked bike still falls over onto its side (that behaviour must stay)', () => {
    const scene = new THREE.Scene();
    const bike = new Vehicle(scene, 'motorbike', new THREE.Vector3(0, 0, 0));
    bike.wreck();
    expect(bike.wrecked).toBe(true);
    expect(Math.abs(bike.group.rotation.z)).toBeGreaterThan(1); // ~75deg tip, deliberately on its side
  });
});
