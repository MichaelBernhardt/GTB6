import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID } from '../config';
import type { Pedestrian } from '../entities/Pedestrian';
import { ProjectileSystem } from './ProjectileSystem';
import type { PopulationSystem } from './PopulationSystem';
import type { City } from '../world/City';

const openCity = { collidesAt: () => false, terrainHeightAt: () => 0 } as unknown as City;
const spec = WEAPON_BY_ID.rpg.projectile!;
const farPlayer = new THREE.Vector3(0, 0, -500);

const makePed = (position: THREE.Vector3) => {
  const ped = { police: false, hostile: false, state: 'walk', health: 100, group: new THREE.Group(), takeDamage(amount: number) { this.health = Math.max(0, this.health - amount); if (this.health === 0) this.state = 'down'; return this.health === 0; } };
  ped.group.position.copy(position);
  return ped as unknown as Pedestrian;
};

const population = (peds: Pedestrian[] = []): PopulationSystem => ({ pedestrians: peds, vehicles: [] } as unknown as PopulationSystem);

describe('ProjectileSystem', () => {
  it('flies at a readable speed and self-detonates at max range', () => {
    const system = new ProjectileSystem(new THREE.Scene());
    system.spawn(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1), spec, 200);
    let explosions = system.update(1, openCity, population(), [], farPlayer);
    expect(explosions).toHaveLength(0);
    expect(system.rockets[0]?.group.position.z).toBeCloseTo(spec.speed, 1);
    for (let t = 0; t < 5 && explosions.length === 0; t += 0.1) explosions = system.update(0.1, openCity, population(), [], farPlayer);
    expect(explosions).toHaveLength(1);
    expect(explosions[0]!.position.z).toBeGreaterThanOrEqual(199);
    expect(explosions[0]!.position.z).toBeLessThan(212);
    expect(system.rockets).toHaveLength(0);
  });

  it('explodes on pedestrian contact and applies splash with falloff', () => {
    const system = new ProjectileSystem(new THREE.Scene());
    const near = makePed(new THREE.Vector3(0, 0, 30));
    const edge = makePed(new THREE.Vector3(4, 0, 30));
    const outside = makePed(new THREE.Vector3(0, 0, 30 + spec.radius + 3));
    const peds = population([near, edge, outside]);
    system.spawn(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(0, 0, 1), spec, 200);
    let explosion;
    for (let t = 0; t < 3 && !explosion; t += 0.05) explosion = system.update(0.05, openCity, peds, [], farPlayer)[0];
    expect(explosion).toBeDefined();
    expect(explosion!.victims.some((victim) => victim.ped === near && victim.killed)).toBe(true);
    expect(explosion!.victims.some((victim) => victim.ped === edge)).toBe(true);
    expect(explosion!.victims.some((victim) => victim.ped === outside)).toBe(false);
    expect(near.health).toBe(0);
    expect(edge.health).toBeGreaterThan(0);
    expect(outside.health).toBe(100);
  });

  it('splashes the player when they stand too close', () => {
    const system = new ProjectileSystem(new THREE.Scene());
    system.spawn(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(0, 0, 1), spec, 10);
    let explosion;
    for (let t = 0; t < 2 && !explosion; t += 0.05) explosion = system.update(0.05, openCity, population(), [], new THREE.Vector3(0, 0, 12))[0];
    expect(explosion).toBeDefined();
    expect(explosion!.playerDamage).toBeGreaterThan(0);
  });

  it('detonates against buildings', () => {
    const wallCity = { collidesAt: (_x: number, z: number) => z >= 20, terrainHeightAt: () => 0 } as unknown as City;
    const system = new ProjectileSystem(new THREE.Scene());
    system.spawn(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(0, 0, 1), spec, 200);
    let explosion;
    for (let t = 0; t < 3 && !explosion; t += 0.05) explosion = system.update(0.05, wallCity, population(), [], farPlayer)[0];
    expect(explosion).toBeDefined();
    expect(explosion!.position.z).toBeGreaterThanOrEqual(20);
    expect(explosion!.position.z).toBeLessThan(25);
  });
});
