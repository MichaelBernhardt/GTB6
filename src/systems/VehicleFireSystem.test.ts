import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { splashDamage } from '../core/GameRules';
import type { InputManager } from '../core/InputManager';
import type { Pedestrian } from '../entities/Pedestrian';
import type { City } from '../world/City';
import { Vehicle } from '../entities/Vehicle';
import {
  BURN_DURATION_MAX, BURN_DURATION_MIN, BURNOUT_PED_DAMAGE, BURNOUT_RADIUS, CHAIN_CAP,
  fireStage, POLICE_WRECK_HEAT, rollBurnDuration, VehicleFireSystem,
} from './VehicleFireSystem';
import { WantedSystem } from './WantedSystem';

const farPlayer = new THREE.Vector3(0, 0, -500);
const openCity = { clampMove: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone() } as unknown as City;
const idleInput = { down: () => false } as unknown as InputManager;

const makePed = (position: THREE.Vector3) => {
  const ped = { police: false, hostile: false, state: 'walk', health: 60, group: new THREE.Group(), takeDamage(amount: number) { this.health = Math.max(0, this.health - amount); if (this.health === 0) this.state = 'down'; return this.health === 0; } };
  ped.group.position.copy(position);
  return ped as unknown as Pedestrian;
};

const burnOut = (system: VehicleFireSystem, vehicle: Vehicle, vehicles: Vehicle[] = [vehicle], peds: Pedestrian[] = [], player = farPlayer) => {
  const burnouts = []; let elapsed = 0; let ignitions = 0;
  for (let step = 0; step < 100 && burnouts.length === 0; step++) {
    const events = system.update(0.1, vehicles, peds, player);
    ignitions += events.ignitions.length; burnouts.push(...events.burnouts); elapsed += 0.1;
  }
  return { burnouts, elapsed, ignitions };
};

describe('fire damage stages', () => {
  it('maps health fractions to smoke and flame thresholds', () => {
    expect(fireStage(100, 100)).toBe('none');
    expect(fireStage(50, 100)).toBe('none');
    expect(fireStage(49, 100)).toBe('smoke');
    expect(fireStage(25, 100)).toBe('smoke');
    expect(fireStage(24, 100)).toBe('critical');
    expect(fireStage(0, 100)).toBe('critical');
  });

  it('ignites at zero health from accumulated gunfire', () => {
    const vehicle = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3());
    vehicle.takeDamage(60);
    expect(vehicle.onFire).toBe(false);
    expect(fireStage(vehicle.health, vehicle.maxHealth)).toBe('smoke');
    vehicle.takeDamage(999);
    expect(vehicle.onFire).toBe(true);
    expect(vehicle.disabled).toBe(true);
    expect(vehicle.burnTimer).toBeGreaterThanOrEqual(BURN_DURATION_MIN);
    expect(vehicle.burnTimer).toBeLessThanOrEqual(BURN_DURATION_MAX);
  });

  it('rolls burn durations inside the four to six second window', () => {
    expect(rollBurnDuration(() => 0)).toBe(BURN_DURATION_MIN);
    expect(rollBurnDuration(() => 0.999)).toBeLessThanOrEqual(BURN_DURATION_MAX);
    expect(rollBurnDuration(() => 0.5)).toBeCloseTo((BURN_DURATION_MIN + BURN_DURATION_MAX) / 2);
  });
});

describe('burnout transition', () => {
  it('burns for the rolled duration then explodes once into a wreck', () => {
    const scene = new THREE.Scene();
    const system = new VehicleFireSystem(scene);
    const vehicle = new Vehicle(scene, 'sport', new THREE.Vector3());
    vehicle.ignite(() => 0.5);
    const { burnouts, elapsed, ignitions } = burnOut(system, vehicle);
    expect(ignitions).toBe(1);
    expect(burnouts).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(BURN_DURATION_MIN);
    expect(elapsed).toBeLessThanOrEqual(BURN_DURATION_MAX + 0.2);
    expect(vehicle.wrecked).toBe(true);
    expect(vehicle.onFire).toBe(false);
    for (let step = 0; step < 20; step++) expect(system.update(0.1, [vehicle], [], farPlayer).burnouts).toHaveLength(0);
  });

  it('leaves the wreck undriveable with charred paint', () => {
    const vehicle = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3());
    const body = vehicle.group.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    const originalColor = (body?.material as THREE.MeshPhysicalMaterial).color.getHex();
    vehicle.occupied = true;
    vehicle.wreck();
    expect(vehicle.disabled).toBe(true);
    expect(vehicle.occupied).toBe(false);
    expect((body?.material as THREE.MeshPhysicalMaterial).color.getHex()).toBeLessThan(originalColor);
    expect(vehicle.updatePlayer(0.016, idleInput, openCity)).toBe(0);
    vehicle.takeDamage(500);
    expect(vehicle.onFire).toBe(false);
  });

  it('restores a wrecked mission vehicle for a clean retry', () => {
    const vehicle = new Vehicle(new THREE.Scene(), 'sport', new THREE.Vector3(), 0xd83a40);
    const body = vehicle.group.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    vehicle.ignite(); vehicle.wreck(); vehicle.restore();
    expect(vehicle.health).toBe(vehicle.maxHealth);
    expect(vehicle.wrecked).toBe(false);
    expect(vehicle.disabled).toBe(false);
    expect(vehicle.onFire).toBe(false);
    expect((body?.material as THREE.MeshPhysicalMaterial).color.getHex()).toBe(0xd83a40);
  });
});

describe('burnout splash damage', () => {
  it('reuses splash falloff over the four unit radius', () => {
    expect(splashDamage(BURNOUT_PED_DAMAGE, 0, BURNOUT_RADIUS)).toBe(BURNOUT_PED_DAMAGE);
    expect(splashDamage(BURNOUT_PED_DAMAGE, BURNOUT_RADIUS / 2, BURNOUT_RADIUS)).toBe(Math.round(BURNOUT_PED_DAMAGE / 2));
    expect(splashDamage(BURNOUT_PED_DAMAGE, BURNOUT_RADIUS, BURNOUT_RADIUS)).toBe(0);
  });

  it('kills close pedestrians, wings the edge, spares the far, splashes the player', () => {
    const scene = new THREE.Scene();
    const system = new VehicleFireSystem(scene);
    const vehicle = new Vehicle(scene, 'compact', new THREE.Vector3());
    const near = makePed(new THREE.Vector3(0.4, 0, 0));
    const edge = makePed(new THREE.Vector3(3.4, 0, 0));
    const outside = makePed(new THREE.Vector3(BURNOUT_RADIUS + 2, 0, 0));
    vehicle.ignite(() => 0);
    const { burnouts } = burnOut(system, vehicle, [vehicle], [near, edge, outside], new THREE.Vector3(1.5, 0, 0));
    const boom = burnouts[0]!;
    expect(boom.victims.some((victim) => victim.ped === near && victim.killed)).toBe(true);
    expect(boom.victims.some((victim) => victim.ped === edge && !victim.killed)).toBe(true);
    expect(boom.victims.some((victim) => victim.ped === outside)).toBe(false);
    expect(boom.playerDamage).toBeGreaterThan(0);
  });

  it('chains to an adjacent weakened vehicle but respects the chain cap', () => {
    const scene = new THREE.Scene();
    const system = new VehicleFireSystem(scene);
    const bomb = new Vehicle(scene, 'compact', new THREE.Vector3());
    const neighbour = new Vehicle(scene, 'compact', new THREE.Vector3(2.5, 0, 0));
    neighbour.takeDamage(neighbour.maxHealth - 5);
    bomb.ignite(() => 0);
    burnOut(system, bomb, [bomb, neighbour]);
    expect(neighbour.onFire).toBe(true);

    const capped = new VehicleFireSystem(scene);
    const second = new Vehicle(scene, 'compact', new THREE.Vector3());
    const bystander = new Vehicle(scene, 'compact', new THREE.Vector3(2.5, 0, 0));
    const bystanderHealth = bystander.health;
    const burners = Array.from({ length: CHAIN_CAP - 1 }, (_, i) => { const extra = new Vehicle(scene, 'van', new THREE.Vector3(300 + i * 30, 0, 0)); extra.ignite(() => 0.999); return extra; });
    second.ignite(() => 0);
    const { burnouts } = burnOut(capped, second, [second, bystander, ...burners]);
    expect(burnouts[0]?.vehicle).toBe(second);
    expect(bystander.health).toBe(bystanderHealth);
  });
});

describe('police burnout heat', () => {
  it('adds two full wanted levels when an interceptor is destroyed', () => {
    expect(POLICE_WRECK_HEAT).toBe(30);
    const wanted = new WantedSystem();
    wanted.addCrime(POLICE_WRECK_HEAT);
    expect(wanted.level).toBe(2);
  });

  it('runs police interceptors through the same fire pipeline', () => {
    const scene = new THREE.Scene();
    const system = new VehicleFireSystem(scene);
    const interceptor = new Vehicle(scene, 'police', new THREE.Vector3());
    interceptor.takeDamage(999);
    expect(interceptor.onFire).toBe(true);
    const { burnouts } = burnOut(system, interceptor);
    expect(burnouts[0]?.vehicle.police).toBe(true);
    expect(interceptor.wrecked).toBe(true);
    expect(interceptor.group.getObjectByName('lightbar')?.visible).toBe(false);
  });
});
