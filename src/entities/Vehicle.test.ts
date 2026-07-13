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
  it('builds the Sixty-Sekonds bike with a branded grocery box', () => {
    const bike = new Vehicle(new THREE.Scene(), 'courier', new THREE.Vector3());
    const box = bike.group.getObjectByName('courierbox');
    expect(box).toBeDefined(); expect(box?.getObjectByName('sign')).toBeDefined();
  });

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

describe('first-person view clears the taxi driver line of sight', () => {
  it('hides the full-length yellow livery slab in first person (regression: solid-yellow taxi FPV)', () => {
    const taxi = new Vehicle(new THREE.Scene(), 'taxi', new THREE.Vector3());
    const stripe = taxi.group.getObjectByName('taxistripe');
    expect(stripe).toBeDefined();
    expect(stripe!.visible).toBe(true); // livery shows in third person
    const sign = taxi.group.getObjectByName('sign');
    expect(sign).toBeDefined();
    taxi.setFirstPerson(true);
    expect(stripe!.visible).toBe(false); // ...and clears out of the driver's eye in first person, like the cabin/roof
    expect(sign!.visible).toBe(false); // the roof sign bar clears too — not left hanging in the raised driver's view
    taxi.setFirstPerson(false);
    expect(stripe!.visible).toBe(true); // and comes back
    expect(sign!.visible).toBe(true);
  });

  it('hides the meter cab roof light box in first person', () => {
    const cab = new Vehicle(new THREE.Scene(), 'cab', new THREE.Vector3());
    const box = cab.group.getObjectByName('taxilight');
    expect(box).toBeDefined();
    cab.setFirstPerson(true);
    expect(box!.visible).toBe(false);
    cab.setFirstPerson(false);
    expect(box!.visible).toBe(true);
  });
});

describe('steered front wheels spin cleanly (no wobble)', () => {
  const flat = slopedCity(0, 0);
  const frontWheel = (car: Vehicle) => (car as unknown as { wheels: THREE.Object3D[] }).wheels[0]!;
  const axleInCarFrame = (wheel: THREE.Object3D) => new THREE.Vector3(1, 0, 0).applyQuaternion(wheel.quaternion).normalize(); // local: strips out the car's heading

  it('rolls about the steered axle, so a turned wheel keeps a fixed spin axis instead of precessing', () => {
    const car = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3());
    car.playerControlled = true; car.speed = 20;
    const turn = heldInput(new Set(['KeyW', 'KeyD'])); // throttle + steer, held
    for (let i = 0; i < 60; i++) car.updatePlayer(1 / 60, turn, flat); // settle the steer angle and build roll
    const wheel = frontWheel(car);
    expect(Math.abs(wheel.rotation.y)).toBeGreaterThan(0.1); // the wheel really is steered
    const before = axleInCarFrame(wheel);
    for (let i = 0; i < 60; i++) car.updatePlayer(1 / 60, turn, flat); // steer holds; the wheel rolls a lot more
    const after = axleInCarFrame(wheel);
    expect(before.dot(after)).toBeGreaterThan(0.999); // axle unchanged by rolling — clean spin (with the old XYZ order it precesses and this drops well below 1)
  });
});

describe('mouse steering (LMB-drag) feeds the same steer input as the keys', () => {
  const flat = slopedCity(0, 0);
  const drive = (steer: 'keyA' | 'mouse' | 'both', primed = 20): Vehicle => {
    const car = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3()); car.playerControlled = true; car.speed = primed;
    const keys = heldInput(new Set(steer === 'mouse' ? [] : ['KeyA']));
    const mouseSteer = steer === 'keyA' ? 0 : 1;
    for (let i = 0; i < 30; i++) car.updatePlayer(1 / 60, keys, flat, mouseSteer);
    return car;
  };

  it('turns the same direction as the matching key, and does nothing at a standstill', () => {
    const byKey = drive('keyA');
    const byMouse = drive('mouse');
    expect(byMouse.heading).not.toBe(0);
    expect(Math.sign(byMouse.heading)).toBe(Math.sign(byKey.heading)); // +mouseSteer steers like KeyA

    const parked = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3()); parked.playerControlled = true; // speed 0
    for (let i = 0; i < 30; i++) parked.updatePlayer(1 / 60, heldInput(new Set()), flat, 1);
    expect(parked.heading).toBeCloseTo(0); // no speed, no steering — same rule as the keys
  });

  it('clamps key + mouse to the single-input maximum (no double-rate steering)', () => {
    const keyOnly = drive('keyA');
    const both = drive('both'); // KeyA (+1) AND mouseSteer +1 -> clamps to +1
    expect(both.heading).toBeCloseTo(keyOnly.heading);
  });
});
