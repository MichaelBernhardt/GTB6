import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import {
  AMBIENT_NPC_CHARACTER_IDS,
  CAR_GUARD_NPC_ID,
  DRIVER_NPC_ID,
  JMPD_PATROL_NPC_ID,
  MISSION_CONTACT_NPC_IDS,
  RANK_ENFORCER_NPC_ID,
} from '../entities/NpcCatalog';
import type { City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import {
  MAX_AMBIENT_RIGGED_PEDESTRIANS,
  MAX_RIGGED_PEDESTRIANS,
  PopulationSystem,
  RIGGED_PEDESTRIAN_CADENCE,
} from './PopulationSystem';

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

describe('rigged NPC population policy', () => {
  it('assigns exactly every fourth eligible ambient pedestrian and rotates the full ambient cast', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const ambient = population.pedestrians.filter((ped) => !ped.contact && !ped.carGuard && !ped.hostile && !ped.police);
    expect(ambient).toHaveLength(28);
    expect(population.ambientRiggedPedestrianCount()).toBe(28 / RIGGED_PEDESTRIAN_CADENCE);
    expect(ambient.map((ped) => ped.visualVariant).filter(Boolean)).toEqual(AMBIENT_NPC_CHARACTER_IDS.slice(0, 7));
  });

  it('caps ambient rigs at eight, rotates evenly, and replaces a despawned identity on cadence', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    for (let index = 0; index < RIGGED_PEDESTRIAN_CADENCE; index++) population.spawnAmbientPedestrian(points[index]!.x, points[index]!.z);
    expect(population.ambientRiggedPedestrianCount()).toBe(MAX_AMBIENT_RIGGED_PEDESTRIANS);
    expect(AMBIENT_NPC_CHARACTER_IDS.map((id) => population.pedestrians.filter((ped) => ped.visualVariant === id).length)).toEqual(Array(8).fill(1));

    const removed = population.pedestrians.find((ped) => ped.visualVariant === AMBIENT_NPC_CHARACTER_IDS[0])!;
    population.removePedestrian(removed);
    expect(population.ambientRiggedPedestrianCount()).toBe(MAX_AMBIENT_RIGGED_PEDESTRIANS - 1);
    for (let index = 0; index < RIGGED_PEDESTRIAN_CADENCE; index++) population.spawnAmbientPedestrian(points[index]!.x, points[index]!.z);
    expect(population.ambientRiggedPedestrianCount()).toBe(MAX_AMBIENT_RIGGED_PEDESTRIANS);
    expect(AMBIENT_NPC_CHARACTER_IDS.map((id) => population.pedestrians.filter((ped) => ped.visualVariant === id).length)).toEqual(Array(8).fill(1));
  });

  it('assigns distinct rigged identities to mission contacts, guards, hostiles, patrols, and drivers', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const contacts = population.pedestrians.filter((ped) => ped.contact && !ped.carGuard);
    expect(contacts.map((ped) => ped.visualVariant)).toEqual(Object.values(MISSION_CONTACT_NPC_IDS));
    expect(population.pedestrians.filter((ped) => ped.carGuard).every((ped) => ped.visualVariant === CAR_GUARD_NPC_ID)).toBe(true);

    population.spawnHostiles();
    expect(population.hostiles.every((ped) => ped.visualVariant === RANK_ENFORCER_NPC_ID)).toBe(true);
    population.setPolicePatrolCount(2, new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z));
    expect(population.pedestrians.filter((ped) => ped.police).every((ped) => ped.visualVariant === JMPD_PATROL_NPC_ID)).toBe(true);

    const vehicle = population.vehicles[0]!;
    expect(population.ejectDriver(vehicle, new THREE.Vector3()).visualVariant).toBe(DRIVER_NPC_ID);
    expect(population.ejectDriver(vehicle, new THREE.Vector3(), true).visualVariant).toBe(JMPD_PATROL_NPC_ID);
  });

  it('never exceeds the total live rig cap and falls back procedurally beyond it', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const vehicle = population.vehicles[0]!;
    const drivers = Array.from({ length: MAX_RIGGED_PEDESTRIANS + 4 }, () => population.ejectDriver(vehicle, new THREE.Vector3()));
    expect(population.riggedPedestrianCount()).toBe(MAX_RIGGED_PEDESTRIANS);
    expect(drivers.at(-1)?.visualVariant).toBeUndefined();
  });
});
