import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import { buildCityNavPaths, PED_NAV_JOIN, ROAD_NETWORK, VEHICLE_NAV_JOIN, type City } from '../world/City';
import { CALM_THRESHOLD } from './FearSystem';
import {
  BUSY_MAX, BUSY_MIN, CAR_TARGET_CAP, censusBudget, CHANGE_BUDGET, clampBusy, CLEANUP_HOURS, cleanupEligible,
  corpseCleanable, dayPhase, FOV_COS, isAmbientPedestrian, LifecycleSystem, outOfSight, PED_TARGET_CAP,
  pedDespawnable, POPULATION_TARGETS, resolveTargets, SIGHT_FAR, SIGHT_NEAR, targetPopulation, vehicleDespawnable, type ViewPoint,
} from './LifecycleSystem';
import { bridgeIslands, buildNavGraph } from './NavGraph';
import { PopulationSystem } from './PopulationSystem';

const view = (x = 0, z = 0, dirX = 0, dirZ = 1): ViewPoint => ({ x, z, dirX, dirZ });

const ped = (overrides: Partial<{ contact: boolean; police: boolean; hostile: boolean; carGuard: boolean; state: string; fear: number }> = {}) =>
  ({ contact: false, police: false, hostile: false, carGuard: false, state: 'walk', fear: 0, ...overrides });

const vehicle = (overrides: Partial<{ playerControlled: boolean; police: boolean; disabled: boolean; onFire: boolean; wrecked: boolean; health: number; maxHealth: number }> = {}) =>
  ({ playerControlled: false, police: false, disabled: false, onFire: false, wrecked: false, health: 100, maxHealth: 100, ...overrides });

describe('outOfSight', () => {
  it('hides anything beyond the far radius regardless of facing', () => {
    expect(outOfSight(view(), 0, SIGHT_FAR + 1)).toBe(true); // dead ahead but too far
    expect(outOfSight(view(), 0, SIGHT_FAR - 1)).toBe(false);
  });

  it('never hides anything inside the near radius, even directly behind', () => {
    expect(outOfSight(view(), 0, -SIGHT_NEAR + 1)).toBe(false);
    expect(outOfSight(view(), 0, -SIGHT_NEAR)).toBe(false); // boundary is inclusive-safe
  });

  it('hides points behind the ~120° forward cone once past the near radius', () => {
    expect(outOfSight(view(), 0, -SIGHT_NEAR - 5)).toBe(true); // directly behind
    expect(outOfSight(view(), SIGHT_NEAR + 5, 0)).toBe(true); // 90° to the side is outside a 60° half-angle
    expect(outOfSight(view(), 0, SIGHT_NEAR + 5)).toBe(false); // dead ahead stays visible
  });

  it('respects the exact cone half-angle', () => {
    const distance = 100; const angle = Math.acos(FOV_COS);
    const inside = { x: Math.sin(angle - 0.02) * distance, z: Math.cos(angle - 0.02) * distance };
    const outside = { x: Math.sin(angle + 0.02) * distance, z: Math.cos(angle + 0.02) * distance };
    expect(outOfSight(view(), inside.x, inside.z)).toBe(false);
    expect(outOfSight(view(), outside.x, outside.z)).toBe(true);
  });

  it('normalises an unnormalised camera direction', () => {
    expect(outOfSight(view(0, 0, 0, 8), 0, 100)).toBe(false);
    expect(outOfSight(view(0, 0, 0, 8), 0, -100)).toBe(true);
  });

  it('works from an offset viewpoint', () => {
    expect(outOfSight(view(600, 600, 1, 0), 700, 600)).toBe(false); // ahead, 100u
    expect(outOfSight(view(600, 600, 1, 0), 480, 600)).toBe(true); // behind, 120u
  });
});

describe('cleanupEligible', () => {
  it('requires BOTH the age gate and being out of sight', () => {
    const behind = { x: 0, z: -100 }; const ahead = { x: 0, z: 100 };
    expect(cleanupEligible(CLEANUP_HOURS, view(), behind.x, behind.z)).toBe(true);
    expect(cleanupEligible(CLEANUP_HOURS - 0.1, view(), behind.x, behind.z)).toBe(false); // too fresh
    expect(cleanupEligible(CLEANUP_HOURS + 10, view(), ahead.x, ahead.z)).toBe(false); // player is looking at it
    expect(cleanupEligible(CLEANUP_HOURS + 10, view(), 0, SIGHT_FAR + 50)).toBe(true); // in front but beyond far radius
  });

  it('never cleans something the player is looking at up close, no matter how old', () => {
    expect(cleanupEligible(999, view(), 0, 10)).toBe(false);
    expect(cleanupEligible(999, view(), 10, -10)).toBe(false); // behind but inside the near radius
  });
});

describe('targetPopulation', () => {
  it('maps hours onto the day/shoulder/night table', () => {
    expect(dayPhase(12)).toBe('day'); expect(dayPhase(8)).toBe('day'); expect(dayPhase(17.9)).toBe('day');
    expect(dayPhase(18)).toBe('shoulder'); expect(dayPhase(21.9)).toBe('shoulder'); expect(dayPhase(5)).toBe('shoulder'); expect(dayPhase(7.9)).toBe('shoulder');
    expect(dayPhase(22)).toBe('night'); expect(dayPhase(0)).toBe('night'); expect(dayPhase(3)).toBe('night'); expect(dayPhase(4.9)).toBe('night');
  });

  it('returns the tuned counts for each phase', () => {
    expect(targetPopulation(12)).toEqual({ peds: 28, traffic: 15 });
    expect(targetPopulation(19)).toEqual({ peds: 20, traffic: 11 });
    expect(targetPopulation(2)).toEqual({ peds: 8, traffic: 6 });
    expect(targetPopulation(2)).toBe(POPULATION_TARGETS.night);
  });

  it('is quietest overnight and busiest in the day', () => {
    expect(POPULATION_TARGETS.night.peds).toBeLessThan(POPULATION_TARGETS.shoulder.peds);
    expect(POPULATION_TARGETS.shoulder.peds).toBeLessThan(POPULATION_TARGETS.day.peds);
    expect(POPULATION_TARGETS.night.traffic).toBeLessThan(POPULATION_TARGETS.shoulder.traffic);
    expect(POPULATION_TARGETS.shoulder.traffic).toBeLessThan(POPULATION_TARGETS.day.traffic);
  });

  it('wraps out-of-range hours', () => {
    expect(dayPhase(26)).toBe('night'); // 02:00
    expect(dayPhase(-12)).toBe('day'); // 12:00
  });
});

describe('resolveTargets', () => {
  it('scales the time-of-day table by the busy percent', () => {
    expect(resolveTargets(12, { busy: 100 })).toEqual(targetPopulation(12));
    expect(resolveTargets(12, { busy: 300 })).toEqual({ peds: 84, traffic: 45 });
    expect(resolveTargets(2, { busy: 300 })).toEqual({ peds: 24, traffic: 18 }); // still quieter at night
    expect(resolveTargets(12, { busy: 50 })).toEqual({ peds: 14, traffic: 8 });
  });

  it('lets absolute pins win over the table, each independently', () => {
    expect(resolveTargets(12, { busy: 100, peds: 3 })).toEqual({ peds: 3, traffic: 15 });
    expect(resolveTargets(12, { busy: 300, cars: 2 })).toEqual({ peds: 84, traffic: 2 });
    expect(resolveTargets(2, { busy: 100, peds: 50, cars: 40 })).toEqual({ peds: 50, traffic: 40 });
  });

  it('clamps busy percent and caps absolute targets', () => {
    expect(clampBusy(5)).toBe(BUSY_MIN); expect(clampBusy(99999)).toBe(BUSY_MAX); expect(clampBusy(100)).toBe(100);
    expect(resolveTargets(12, { busy: BUSY_MAX })).toEqual({ peds: PED_TARGET_CAP, traffic: CAR_TARGET_CAP }); // 10× would exceed both caps
    expect(resolveTargets(12, { busy: 100, peds: 9999, cars: 9999 })).toEqual({ peds: PED_TARGET_CAP, traffic: CAR_TARGET_CAP });
    expect(resolveTargets(12, { busy: 100, peds: 0, cars: 0 })).toEqual({ peds: 0, traffic: 0 });
  });
});

describe('censusBudget', () => {
  it('keeps the gentle floor for small drifts and scales for console jumps', () => {
    expect(censusBudget(0)).toBe(CHANGE_BUDGET);
    expect(censusBudget(2)).toBe(CHANGE_BUDGET);
    expect(censusBudget(-2)).toBe(CHANGE_BUDGET);
    expect(censusBudget(56)).toBe(19); // the busy-300 ped jump lands a third per pass
    expect(censusBudget(-56)).toBe(19); // shrinking back is just as brisk
  });
});

describe('isAmbientPedestrian', () => {
  it('counts everyday citizens, walking or reacting', () => {
    expect(isAmbientPedestrian(ped())).toBe(true);
    expect(isAmbientPedestrian(ped({ state: 'flee', fear: 90 }))).toBe(true); // frightened civilians still count
  });

  it('excludes mission cast, police, and corpses', () => {
    expect(isAmbientPedestrian(ped({ contact: true }))).toBe(false);
    expect(isAmbientPedestrian(ped({ police: true }))).toBe(false);
    expect(isAmbientPedestrian(ped({ hostile: true }))).toBe(false);
    expect(isAmbientPedestrian(ped({ carGuard: true }))).toBe(false);
    expect(isAmbientPedestrian(ped({ state: 'down' }))).toBe(false);
  });
});

describe('pedDespawnable', () => {
  it('allows only calm, idle-or-walking anonymous citizens', () => {
    expect(pedDespawnable(ped())).toBe(true);
    expect(pedDespawnable(ped({ state: 'idle' }))).toBe(true);
  });

  it('never despawns anyone involved with the player', () => {
    expect(pedDespawnable(ped({ state: 'flee', fear: 80 }))).toBe(false); // actively fleeing
    expect(pedDespawnable(ped({ state: 'cower', fear: 95 }))).toBe(false);
    expect(pedDespawnable(ped({ state: 'hostile' }))).toBe(false);
    expect(pedDespawnable(ped({ fear: CALM_THRESHOLD }))).toBe(false); // still rattled
    expect(pedDespawnable(ped({ fear: CALM_THRESHOLD - 1 }))).toBe(true);
  });

  it('never despawns mission contacts, guards, or police', () => {
    expect(pedDespawnable(ped({ contact: true }))).toBe(false);
    expect(pedDespawnable(ped({ carGuard: true }))).toBe(false);
    expect(pedDespawnable(ped({ police: true }))).toBe(false);
    expect(pedDespawnable(ped({ hostile: true }))).toBe(false);
  });
});

describe('vehicleDespawnable', () => {
  it('allows healthy anonymous traffic only', () => {
    expect(vehicleDespawnable(vehicle())).toBe(true);
  });

  it('never despawns the player ride, police, or anything damaged or burning', () => {
    expect(vehicleDespawnable(vehicle({ playerControlled: true }))).toBe(false);
    expect(vehicleDespawnable(vehicle({ police: true }))).toBe(false);
    expect(vehicleDespawnable(vehicle({ disabled: true }))).toBe(false);
    expect(vehicleDespawnable(vehicle({ onFire: true }))).toBe(false);
    expect(vehicleDespawnable(vehicle({ wrecked: true }))).toBe(false);
    expect(vehicleDespawnable(vehicle({ health: 99 }))).toBe(false); // recently damaged: leave it be
  });
});

describe('corpseCleanable', () => {
  it('cleans downed civilians and police but leaves the mission cast in place', () => {
    expect(corpseCleanable(ped({ state: 'down' }))).toBe(true);
    expect(corpseCleanable(ped({ state: 'down', police: true }))).toBe(true);
    expect(corpseCleanable(ped({ state: 'down', hostile: true }))).toBe(false); // rank enforcers would respawn
    expect(corpseCleanable(ped({ state: 'down', contact: true }))).toBe(false);
    expect(corpseCleanable(ped({ state: 'walk' }))).toBe(false); // alive
  });
});

const { lanes, walks } = buildCityNavPaths(ROAD_NETWORK);
const makeCity = (): City => ({
  vehicleNav: bridgeIslands(buildNavGraph(lanes, VEHICLE_NAV_JOIN)),
  pedNav: bridgeIslands(buildNavGraph(walks, PED_NAV_JOIN)),
  sidewalkPoints: walks.flatMap((walk) => walk.points),
  trafficRoutes: lanes.map((lane) => lane.points),
  collides: () => false,
  isOnRoad: () => true,
  signalStops: () => false, // no robots in this lifecycle harness
  surfaceHeightAt: () => 0,
  roadHeightAt: () => 0,
  surfaceNormalAt: () => new THREE.Vector3(0, 1, 0),
  clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone(),
  nearestRoadPose: (position: THREE.Vector3) => ({ position: position.clone(), heading: 0 }),
  roadPoseAwayFrom: (position: THREE.Vector3, minimum: number) => ({ position: new THREE.Vector3(position.x + minimum + 5, 0, position.z), heading: 0 }),
}) as unknown as City;

const audio = { scream: () => {}, setSiren: () => {}, taxiHoot: () => {} } as unknown as AudioManager;

describe('lifecycle simulation', () => {
  const CLEANUP_REAL_SECONDS = 150; // 6 in-game hours on the 10-minute day cycle

  it('removes a far-away corpse and wreck only after six in-game hours', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const farView = { x: 2000, z: 2000, dirX: 0, dirZ: 1 }; // everything is >500u away
    const victim = population.pedestrians.find((p) => isAmbientPedestrian(p));
    const wreck = population.traffic[0];
    if (!victim || !wreck) throw new Error('fixture missing');
    victim.takeDamage(999); wreck.wreck();
    for (let i = 0; i < CLEANUP_REAL_SECONDS - 20; i++) lifecycle.update(1, 12, farView, new Set());
    expect(population.pedestrians).toContain(victim); // too fresh
    expect(population.vehicles).toContain(wreck);
    for (let i = 0; i < 40; i++) lifecycle.update(1, 12, farView, new Set());
    expect(population.pedestrians).not.toContain(victim);
    expect(population.vehicles).not.toContain(wreck);
    expect(population.traffic).not.toContain(wreck);
    expect(victim.group.parent).toBeNull(); // gone from the scene too
    expect(wreck.group.parent).toBeNull();
  });

  it('never removes a corpse the player keeps in view, and spares hostile corpses and protected wrecks', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const victim = population.pedestrians.find((p) => isAmbientPedestrian(p));
    const wreck = population.traffic[0];
    if (!victim || !wreck) throw new Error('fixture missing');
    victim.takeDamage(999); wreck.wreck();
    population.spawnHostiles();
    const enforcer = population.hostiles[0];
    if (!enforcer) throw new Error('fixture missing');
    enforcer.takeDamage(999);
    const position = victim.group.position;
    const watching = { x: position.x, z: position.z - 20, dirX: 0, dirZ: 1 }; // staring at the body from 20u
    for (let i = 0; i < CLEANUP_REAL_SECONDS + 60; i++) lifecycle.update(1, 12, watching, new Set([wreck]));
    expect(population.pedestrians).toContain(victim); // watched up close forever
    expect(population.vehicles).toContain(wreck); // protected (player's ride)
    expect(population.pedestrians).toContain(enforcer); // mission cast decays in place
  });

  it('converges the ambient population down to the night target, sparing the mission cast', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const contacts = population.pedestrians.filter((p) => p.contact).length;
    const edgeView = { x: -300, z: -300, dirX: -0.71, dirZ: -0.71 }; // map corner, facing out: the city is behind
    for (let i = 0; i < 120; i++) lifecycle.update(1, 2, edgeView, new Set()); // 02:00
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(POPULATION_TARGETS.night.peds);
    expect(population.traffic.length).toBe(POPULATION_TARGETS.night.traffic);
    expect(population.pedestrians.filter((p) => p.contact).length).toBe(contacts); // contacts untouched
    for (let i = 0; i < 240; i++) lifecycle.update(1, 12, edgeView, new Set()); // noon: fill back up
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(POPULATION_TARGETS.day.peds);
    expect(population.traffic.length).toBe(POPULATION_TARGETS.day.traffic);
  });

  it('floods the streets within ~15 seconds of `set busy 300`, then honours pins on the way back down', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const edgeView = { x: -300, z: -300, dirX: -0.71, dirZ: -0.71 }; // map corner, facing out
    lifecycle.tuning = { busy: 300 };
    for (let i = 0; i < 27; i++) lifecycle.update(1, 12, edgeView, new Set()); // 9 census passes (~27s)
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(84); // 3 × 28
    expect(population.traffic.length).toBe(45); // 3 × 15
    lifecycle.tuning = { busy: 100, cars: 3 }; // back to normal, traffic pinned low
    const farView = { x: 2000, z: 2000, dirX: 0, dirZ: 1 }; // player leaves: everything is fair game
    for (let i = 0; i < 30; i++) lifecycle.update(1, 12, farView, new Set());
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(28);
    expect(population.traffic.length).toBe(3);
  });
});
