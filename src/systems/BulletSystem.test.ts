import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID } from '../config';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import { BulletSystem, MAX_BULLETS, type ResolvedShot } from './BulletSystem';
import type { PopulationSystem } from './PopulationSystem';
import type { City } from '../world/City';

const DT = 1 / 60;
const openCity = { collidesAt: () => false, terrainHeightAt: () => -10 } as unknown as City;
const shooter = new THREE.Vector3(0, 0, 0);
const muzzle = new THREE.Vector3(0, 1.5, 0);

const makePed = (position: THREE.Vector3) => {
  const ped = { police: false, hostile: false, state: 'walk', health: 100, received: [] as number[], group: new THREE.Group(), takeDamage(amount: number) { this.received.push(amount); this.health = Math.max(0, this.health - amount); if (this.health === 0) this.state = 'down'; return this.health === 0; } };
  ped.group.position.copy(position);
  return ped as unknown as Pedestrian & { received: number[] };
};

const makeVehicle = (position: THREE.Vector3, heading = 0) => {
  const vehicle = { spec: { size: [1.9, 1.4, 4.2] }, heading, police: false, hits: 0, group: new THREE.Group(), takeDamage() { this.hits += 1; } };
  vehicle.group.position.copy(position);
  return vehicle as unknown as Vehicle & { hits: number };
};

const population = (peds: Pedestrian[] = [], vehicles: Vehicle[] = []): PopulationSystem => ({ pedestrians: peds, vehicles } as unknown as PopulationSystem);

/** Runs the simulation until the shot resolves (or timeout), ticking the mover callback each frame. */
const flyUntilResolved = (system: BulletSystem, pop: PopulationSystem, city = openCity, eachFrame?: (dt: number) => void): { resolution: ResolvedShot | undefined; elapsed: number } => {
  for (let elapsed = 0; elapsed < 3; elapsed += DT) {
    eachFrame?.(DT);
    const resolved = system.update(DT, city, pop, []);
    if (resolved.length > 0) return { resolution: resolved[0], elapsed: elapsed + DT };
  }
  return { resolution: undefined, elapsed: 3 };
};

const aimAt = (target: THREE.Vector3): THREE.Vector3[] => [target.clone().sub(muzzle).normalize()];

describe('BulletSystem', () => {
  it('takes real time of flight: the sniper round reaches a 170u target in about half a second', () => {
    const system = new BulletSystem(new THREE.Scene());
    const ped = makePed(new THREE.Vector3(0, 0, 170));
    system.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 0.9, 170)), 1, WEAPON_BY_ID.sniper);
    const pop = population([ped]);
    for (let t = 0; t < 0.45; t += DT) expect(system.update(DT, openCity, pop, [])).toHaveLength(0); // still in the air at 0.45s
    expect(ped.health).toBe(100);
    const { resolution, elapsed } = flyUntilResolved(system, pop);
    expect(elapsed).toBeLessThan(0.1); // lands within a few frames of the 0.5s mark
    expect(resolution?.result.victim).toBe(ped);
    expect(resolution?.result.killed).toBe(true); // 110 damage, falloffFloor 1: full power at range
    expect(resolution?.weapon).toBe('sniper');
    expect(resolution?.position).toEqual(shooter);
  });

  it('misses a laterally moving target when fired straight at it, hits when properly led', () => {
    const sniper = WEAPON_BY_ID.sniper; const pace = 4; const distance = 300;
    const straight = new BulletSystem(new THREE.Scene());
    const runner = makePed(new THREE.Vector3(0, 0, distance));
    straight.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 0.9, distance)), 1, sniper); // dead-on at the current position
    const miss = flyUntilResolved(straight, population([runner]), openCity, (dt) => { runner.group.position.x += pace * dt; });
    expect(miss.resolution?.result.victim).toBeUndefined(); // by arrival the runner is ~3.5u away — clean miss
    expect(runner.health).toBe(100);

    const led = new BulletSystem(new THREE.Scene());
    const runner2 = makePed(new THREE.Vector3(0, 0, distance));
    const lead = pace * (distance / sniper.bulletSpeed!); // aim where the runner WILL be after the flight
    led.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(lead, 0.9, distance)), 1, sniper);
    const hit = flyUntilResolved(led, population([runner2]), openCity, (dt) => { runner2.group.position.x += pace * dt; });
    expect(hit.resolution?.result.victim).toBe(runner2);
    expect(hit.resolution?.result.killed).toBe(true);
  });

  it('is stopped mid-flight by city geometry before reaching the target behind it', () => {
    const wallCity = { collidesAt: (_x: number, z: number) => z >= 100, terrainHeightAt: () => -10 } as unknown as City;
    const system = new BulletSystem(new THREE.Scene());
    const ped = makePed(new THREE.Vector3(0, 0, 150));
    system.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 0.9, 150)), 1, WEAPON_BY_ID.sniper);
    const { resolution, elapsed } = flyUntilResolved(system, population([ped]), wallCity);
    expect(resolution?.result.victim).toBeUndefined();
    expect(ped.health).toBe(100);
    expect(elapsed).toBeLessThan(0.4); // died at the wall (~0.3s), not at max range (~1.24s)
    expect(system.bullets).toHaveLength(0);
  });

  it('applies damage falloff by distance actually travelled', () => {
    const pistol = WEAPON_BY_ID.pistol;
    const near = new BulletSystem(new THREE.Scene());
    const close = makePed(new THREE.Vector3(0, 0, 10));
    near.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 0.9, 10)), 1, pistol);
    flyUntilResolved(near, population([close]));
    expect(close.received).toEqual([38]); // inside the 15u falloff grace: full damage

    const far = new BulletSystem(new THREE.Scene());
    const distant = makePed(new THREE.Vector3(0, 0, 110));
    far.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 0.9, 110)), 1, pistol);
    flyUntilResolved(far, population([distant]));
    expect(distant.received).toEqual([13]); // 38 x 0.35 floor after ~110u of travel
  });

  it('expires at max range and still reports the trigger pull as a miss', () => {
    const system = new BulletSystem(new THREE.Scene());
    system.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 1.5, 100)), 1, WEAPON_BY_ID.smg);
    const { resolution, elapsed } = flyUntilResolved(system, population());
    expect(resolution?.result).toMatchObject({ fired: true, killed: false, policeHit: false });
    expect(resolution?.result.victim).toBeUndefined();
    expect(elapsed).toBeGreaterThan(0.28); expect(elapsed).toBeLessThan(0.4); // 90u at 280 u/s
    expect(system.bullets).toHaveLength(0);
  });

  it('aggregates a full shotgun blast into one resolution and bills each vehicle once per trigger pull', () => {
    const system = new BulletSystem(new THREE.Scene());
    const ped = makePed(new THREE.Vector3(0, 0, 8));
    const directions = Array.from({ length: 7 }, () => aimAt(new THREE.Vector3(0, 0.9, 8))[0]!);
    system.spawnShot(shooter, muzzle, directions, 7, WEAPON_BY_ID.shotgun);
    const { resolution } = flyUntilResolved(system, population([ped]));
    expect(resolution?.result.victim).toBe(ped);
    expect(ped.received).toHaveLength(7); // every pellet lands and bills separately, like the hitscan loop did

    const truck = new BulletSystem(new THREE.Scene());
    const van = makeVehicle(new THREE.Vector3(0, 0, 12));
    truck.spawnShot(shooter, muzzle, directions.map((direction) => direction.clone()), 7, WEAPON_BY_ID.shotgun);
    const outcome = flyUntilResolved(truck, population([], [van]));
    expect(outcome.resolution).toBeDefined();
    expect(van.hits).toBe(1); // pellets stop on the bodywork but only one damage tick per shot
  });

  it('respects drive-by exclusion so your own bakkie never eats your rounds', () => {
    const system = new BulletSystem(new THREE.Scene());
    const own = makeVehicle(new THREE.Vector3(0, 0, 2));
    const other = makeVehicle(new THREE.Vector3(0, 0, 30));
    system.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 0.7, 30)), 1, WEAPON_BY_ID.pistol, own);
    flyUntilResolved(system, population([], [own, other]));
    expect(own.hits).toBe(0);
    expect(other.hits).toBe(1);
  });

  it('enforces the hard pool cap without allocating and resolves starved shots as instant misses', () => {
    const system = new BulletSystem(new THREE.Scene());
    for (let i = 0; i < MAX_BULLETS + 40; i++) system.spawnShot(shooter, muzzle, aimAt(new THREE.Vector3(0, 1.5, 400)), 1, WEAPON_BY_ID.sniper);
    expect(system.bullets).toHaveLength(MAX_BULLETS);
    const resolved = system.update(DT, openCity, population(), []);
    expect(resolved.length).toBeGreaterThanOrEqual(40); // the dropped trigger pulls still report as misses
    expect(system.bullets.length).toBeLessThanOrEqual(MAX_BULLETS);
  });
});
