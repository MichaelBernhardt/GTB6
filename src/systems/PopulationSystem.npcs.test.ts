import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import { NPC_CHARACTER_IDS } from '../entities/NpcCatalog';
import type { City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import { MAX_RIGGED_PEDESTRIANS, PopulationSystem, RIGGED_PEDESTRIAN_CADENCE } from './PopulationSystem';

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
const audio = { scream: () => {}, broadcastFear: () => {}, setTrafficEngine: () => {} } as unknown as AudioManager;

describe('ambient rigged NPC population cadence', () => {
  it('assigns exactly every fourth eligible opening pedestrian and rotates variants evenly', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const ambient = population.pedestrians.filter((ped) => !ped.contact && !ped.carGuard && !ped.hostile && !ped.police);
    expect(ambient).toHaveLength(28); expect(population.riggedPedestrianCount()).toBe(28 / RIGGED_PEDESTRIAN_CADENCE);
    expect(ambient.map((ped) => ped.visualVariant).filter(Boolean)).toEqual([
      ...NPC_CHARACTER_IDS, ...NPC_CHARACTER_IDS.slice(0, 3),
    ]);
  });

  it('caps live rigs at 20, frees a slot on despawn, and resumes on the next cadence slot', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    for (let index = 0; index < 100; index++) population.spawnAmbientPedestrian(points[index % points.length]!.x, points[index % points.length]!.z);
    expect(population.riggedPedestrianCount()).toBe(MAX_RIGGED_PEDESTRIANS);
    const counts = new Map(NPC_CHARACTER_IDS.map((id) => [id, population.pedestrians.filter((ped) => ped.visualVariant === id).length]));
    expect([...counts.values()]).toEqual([5, 5, 5, 5]);
    const removed = population.pedestrians.find((ped) => ped.visualVariant)!; population.removePedestrian(removed);
    expect(population.riggedPedestrianCount()).toBe(MAX_RIGGED_PEDESTRIANS - 1);
    for (let index = 0; index < RIGGED_PEDESTRIAN_CADENCE; index++) population.spawnAmbientPedestrian(points[index]!.x, points[index]!.z);
    expect(population.riggedPedestrianCount()).toBe(MAX_RIGGED_PEDESTRIANS);
  });

  it('never assigns first-release rigs to contacts, car guards, police, hostiles, or ejected drivers', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    expect(population.pedestrians.filter((ped) => ped.contact || ped.carGuard).every((ped) => ped.visualVariant === undefined)).toBe(true);
    population.spawnHostiles(); expect(population.hostiles.every((ped) => ped.visualVariant === undefined)).toBe(true);
    population.setPolicePatrolCount(2, new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z));
    expect(population.pedestrians.filter((ped) => ped.police).every((ped) => ped.visualVariant === undefined)).toBe(true);
    const vehicle = population.vehicles[0]!; const driver = population.ejectDriver(vehicle, new THREE.Vector3());
    expect(driver.visualVariant).toBeUndefined();
  });
});
