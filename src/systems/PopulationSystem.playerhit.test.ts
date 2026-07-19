import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PLAYER } from '../config';
import type { AudioManager } from '../core/AudioManager';
import { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import { PopulationSystem } from './PopulationSystem';

/**
 * Sim: civilian traffic hitting the on-foot player must voice the male impact reaction at emission —
 * the owner's repro was a car hit producing only the collision tinkle. avoidPlayer() is the contact
 * resolver that files PlayerVehicleHit; we drive it directly with a vehicle overlapping the player.
 */

const points = Array.from({ length: 120 }, (_, index) => ({
  x: SPAWN_POINT.x + 30 + (index % 12) * 12,
  z: SPAWN_POINT.z + 30 + Math.floor(index / 12) * 12,
}));
const graph = { nodes: points, edges: points.map((_, index) => index ? [index - 1] : []) };
for (let index = 1; index < graph.edges.length; index++) graph.edges[index - 1]?.push(index);
const city = {
  vehicleNav: graph, pedNav: graph, sidewalkPoints: points, trafficRoutes: [],
  wanderTarget: () => points[0], collides: () => false, collidesAt: () => false, isOnRoad: () => true,
  signalStops: () => false, districtAt: () => 'Joburg CBD',
  surfaceHeightAt: () => 0, sidewalkHeightAt: () => 0, roadHeightAt: () => 0,
  surfaceNormalAt: () => new THREE.Vector3(0, 1, 0), clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone(),
  nearestRoadPose: (position: THREE.Vector3) => ({ position: position.clone(), heading: 0 }),
  roadPoseAwayFrom: (position: THREE.Vector3, minimum: number) => ({ position: new THREE.Vector3(position.x + minimum, 0, position.z), heading: 0 }),
} as unknown as City;

interface Sim { population: PopulationSystem; calls: string[]; resolve(vehicle: Vehicle, player: THREE.Vector3): void }

const makeSim = (): Sim => {
  const calls: string[] = [];
  const audio = {
    scream: () => calls.push('scream'), grunt: () => calls.push('grunt'), collision: () => calls.push('collision'),
    playerImpact: () => calls.push('playerImpact'), melee: () => calls.push('melee'), whiff: () => {}, setTrafficEngine: () => {},
  } as unknown as AudioManager;
  const population = new PopulationSystem(new THREE.Scene(), city, audio);
  const resolve = (vehicle: Vehicle, player: THREE.Vector3): void => {
    (population as unknown as { avoidPlayer(v: Vehicle, f: THREE.Vector3, p: THREE.Vector3, dt: number): unknown })
      .avoidPlayer(vehicle, new THREE.Vector3(0, 0, 1), player, 1 / 60);
  };
  return { population, calls, resolve };
};

describe('player hit by a car', () => {
  it('a full-speed hit files a knockdown PlayerVehicleHit and triggers the male impact voice', () => {
    const { population, calls, resolve } = makeSim();
    const player = new THREE.Vector3(SPAWN_POINT.x - 60, 0, SPAWN_POINT.z - 60);
    const vehicle = new Vehicle(new THREE.Scene(), 'compact', player.clone());
    vehicle.group.position.z -= vehicle.spec.size[2] / 2 + 0.2; // player just inside the front bumper
    vehicle.speed = 20; // well past SHOVE_SPEED: bumper wins
    resolve(vehicle, player);
    const hits = population.consumePlayerVehicleHits();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.damage).toBeGreaterThan(0);
    expect(hits[0]!.knockdown).toBe(true);
    expect(calls).toContain('playerImpact'); // the voice fires at emission, not only via the damage funnel
    expect(calls).toContain('collision'); // ...alongside the thud, not instead of it
  });

  it('a crawl-speed side shove still earns the impact voice even at zero damage', () => {
    const { population, calls, resolve } = makeSim();
    const player = new THREE.Vector3(SPAWN_POINT.x - 60, 0, SPAWN_POINT.z - 60);
    const vehicle = new Vehicle(new THREE.Scene(), 'compact', player.clone());
    vehicle.group.position.x -= vehicle.spec.size[0] / 2 + PLAYER.radius - 0.2; // shallow side overlap: a side-swipe, not a bumper hit
    vehicle.speed = 2; // below SHOVE_SPEED: a nudge, not a knockdown
    resolve(vehicle, player);
    const hits = population.consumePlayerVehicleHits();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.damage).toBe(0);
    expect(hits[0]!.knockdown).toBe(false);
    expect(calls).toContain('playerImpact'); // damage 0 → damagePlayer never runs, the emission voice is the only one
  });
});
