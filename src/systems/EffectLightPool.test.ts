import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AudioManager } from '../core/AudioManager';
import type { InputManager } from '../core/InputManager';
import { WEAPON_BY_ID } from '../config';
import { Vehicle } from '../entities/Vehicle';
import type { PopulationSystem } from './PopulationSystem';
import type { City } from '../world/City';
import { CombatSystem } from './CombatSystem';
import { EffectLightPool } from './EffectLightPool';
import { ProjectileSystem } from './ProjectileSystem';
import { CHAIN_CAP, VehicleFireSystem } from './VehicleFireSystem';

/** Every light reachable in the scene graph, by id. three counts a light into its shader-program hash
 *  whenever it is visible anywhere in the graph, so identity+count stability of THIS set is exactly
 *  the "no recompile storm" invariant the pool exists to hold. */
const lightIds = (scene: THREE.Scene): number[] => {
  const ids: number[] = [];
  scene.traverse((object) => { if ((object as THREE.Light).isLight) ids.push(object.id); });
  return ids.sort((a, b) => a - b);
};

const litCount = (pool: EffectLightPool): number => pool.lights.filter((light) => light.intensity > 0).length;

const farPlayer = new THREE.Vector3(0, 0, -500);
const rpg = WEAPON_BY_ID.rpg.projectile!;
const openCity = { collidesAt: () => false, terrainHeightAt: () => -50 } as unknown as City;
const emptyPopulation = { pedestrians: [], vehicles: [], nearestPedestrian: () => undefined } as unknown as PopulationSystem;
const fakeInput = (firing = false, firePressed = false): InputManager => ({ firing, firePressed, consume: () => false } as unknown as InputManager);

describe('EffectLightPool', () => {
  it('adds its whole population to the scene at construction and only ever lends it out', () => {
    const scene = new THREE.Scene();
    const before = lightIds(scene);
    const pool = new EffectLightPool(scene, 3);
    expect(lightIds(scene)).toHaveLength(before.length + 3);
    const stable = lightIds(scene);
    const a = pool.acquire(0xff0000, 5, 12)!;
    expect(a.color.getHex()).toBe(0xff0000); expect(a.intensity).toBe(5); expect(a.distance).toBe(12);
    const b = pool.acquire(0x00ff00, 1, 4)!;
    const c = pool.acquire(0x0000ff, 2, 6)!;
    expect(pool.acquire(0xffffff, 1, 1)).toBeUndefined(); // exhausted: caller renders without a glow
    expect(pool.available).toBe(0);
    pool.release(b);
    expect(b.intensity).toBe(0);
    pool.release(b); pool.release(undefined); // double/undefined release is a no-op
    expect(pool.available).toBe(1);
    pool.release(new THREE.PointLight()); // foreign lights are refused, not adopted
    expect(pool.available).toBe(1);
    pool.release(a); pool.release(c);
    expect(pool.available).toBe(3);
    expect(lightIds(scene)).toEqual(stable); // nothing was ever added or removed
  });
});

describe('scene light-count stability across effects', () => {
  it('a car cook-off never adds or removes a scene light (fire light, flash, burnout, fade)', () => {
    const scene = new THREE.Scene();
    const system = new VehicleFireSystem(scene);
    const vehicle = new Vehicle(scene, 'compact', new THREE.Vector3());
    const baseline = lightIds(scene);
    vehicle.takeDamage(9999);
    expect(vehicle.onFire).toBe(true);
    let burnouts = 0;
    for (let step = 0; step < 120; step++) {
      burnouts += system.update(0.1, [vehicle], [], farPlayer).burnouts.length;
      expect(lightIds(scene)).toEqual(baseline); // every frame: ignition, burn, bang, flash fade
    }
    expect(burnouts).toBe(1);
    expect(system.lights.available).toBe(CHAIN_CAP + 2); // fire light and flash both back in the pool
  });

  it('caps simultaneous fire lights below the pool so a flash always finds a slot', () => {
    const scene = new THREE.Scene();
    const system = new VehicleFireSystem(scene);
    const vehicles = Array.from({ length: CHAIN_CAP + 4 }, (_, i) => new Vehicle(scene, 'compact', new THREE.Vector3(i * 40, 0, 0)));
    for (const vehicle of vehicles) vehicle.takeDamage(9999);
    const baseline = lightIds(scene);
    system.update(0.1, vehicles, [], farPlayer);
    expect(litCount(system.lights)).toBe(CHAIN_CAP); // 8 burning cars, 4 lit — 2 slots held for flashes
    expect(system.lights.available).toBe(2);
    let burnouts = 0;
    for (let step = 0; step < 200; step++) burnouts += system.update(0.1, vehicles, [], farPlayer).burnouts.length;
    expect(burnouts).toBe(vehicles.length);
    expect(lightIds(scene)).toEqual(baseline);
    expect(system.lights.available).toBe(CHAIN_CAP + 2);
  });

  it('a rocket flies, detonates and fades without adding or removing a scene light', () => {
    const scene = new THREE.Scene();
    const system = new ProjectileSystem(scene);
    const baseline = lightIds(scene);
    system.spawn(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1), rpg, 60);
    expect(lightIds(scene)).toEqual(baseline); // flame is borrowed, not added
    let explosions = 0;
    for (let step = 0; step < 80; step++) {
      explosions += system.update(0.05, openCity, emptyPopulation, [], farPlayer).length;
      expect(lightIds(scene)).toEqual(baseline);
    }
    expect(explosions).toBe(1);
    expect(system.lights.available).toBe(3); // flame and flash both returned
  });

  it('rocket trail puffs share one geometry and dispose their materials on expiry', () => {
    const scene = new THREE.Scene();
    const system = new ProjectileSystem(scene);
    system.spawn(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1), rpg, 60);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const disposed = new Set<THREE.Material>();
    for (let step = 0; step < 100; step++) {
      system.update(0.05, openCity, emptyPopulation, [], farPlayer);
      // Puffs are direct scene children; the rocket's own meshes (shared, permanent materials) sit
      // inside the rocket group and are deliberately excluded from the disposal census.
      for (const child of scene.children) {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) continue;
        geometries.add(mesh.geometry);
        if (materials.has(mesh.material as THREE.Material)) continue;
        materials.add(mesh.material as THREE.Material);
        (mesh.material as THREE.Material).addEventListener('dispose', (event) => disposed.add(event.target as THREE.Material));
      }
    }
    expect(materials.size).toBeGreaterThan(10); // the flight actually shed trail puffs
    expect(geometries.size).toBe(1); // one shared sphere for every puff — no per-puff geometry
    expect(disposed.size).toBe(materials.size); // every per-puff material disposed when it expired
  });

  it('gunfire drives one permanent muzzle light instead of add/remove per shot', () => {
    const scene = new THREE.Scene();
    const combat = new CombatSystem(scene, new AudioManager());
    const baseline = lightIds(scene);
    expect(baseline.length).toBeGreaterThan(0); // the muzzle light exists from construction
    const camera = new THREE.PerspectiveCamera();
    expect(combat.fire(fakeInput(true, true), camera, new THREE.Vector3(), emptyPopulation).fired).toBe(true);
    expect(lightIds(scene)).toEqual(baseline);
    const muzzle = scene.children.find((child) => child.name === 'muzzlelight') as THREE.PointLight;
    expect(muzzle.intensity).toBeGreaterThan(0);
    for (let step = 0; step < 40; step++) { combat.update(0.05); expect(lightIds(scene)).toEqual(baseline); }
    expect(muzzle.intensity).toBe(0); // decayed to idle, still in the scene
  });
});
