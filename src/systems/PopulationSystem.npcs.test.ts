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
import { MISSIONS } from '../systems/MissionSystem';
import type { City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import { PopulationSystem } from './PopulationSystem';

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

describe('all-Blender NPC population policy', () => {
  it('assigns a rig to every opening ambient pedestrian and rotates the full ambient cast evenly', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const ambient = population.pedestrians.filter((ped) => !ped.contact && !ped.carGuard && !ped.hostile && !ped.police);
    expect(ambient).toHaveLength(28);
    expect(ambient.every((ped) => ped.visualVariant !== undefined)).toBe(true);
    expect(ambient.map((ped) => ped.visualVariant)).toEqual(Array.from({ length: 28 }, (_, index) => AMBIENT_NPC_CHARACTER_IDS[index % AMBIENT_NPC_CHARACTER_IDS.length]));
  });

  it('keeps assigning rotating Blender identities through lifecycle growth and replacement', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const spawned = Array.from({ length: 132 }, (_, index) => population.spawnAmbientPedestrian(points[index % points.length]!.x, points[index % points.length]!.z));
    expect(spawned.every((ped) => ped.visualVariant !== undefined)).toBe(true);
    expect(population.ambientRiggedPedestrianCount()).toBe(160);
    expect(AMBIENT_NPC_CHARACTER_IDS.map((id) => population.pedestrians.filter((ped) => ped.visualVariant === id && !ped.contact).length)).toEqual(Array(8).fill(20)); // contacts reuse ambient bodies but sit outside the crowd rotation

    const removed = population.pedestrians.find((ped) => ped.visualVariant === AMBIENT_NPC_CHARACTER_IDS[0])!;
    population.removePedestrian(removed);
    const replacement = population.spawnAmbientPedestrian(points[0]!.x, points[0]!.z);
    expect(replacement.visualVariant).toBe(AMBIENT_NPC_CHARACTER_IDS[0]);
  });

  it('assigns dedicated Blender identities to contacts, guards, hostiles, patrols, and drivers', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const contacts = population.pedestrians.filter((ped) => ped.contact && !ped.carGuard);
    // One body per contact person: missions sharing a contact (story arc) share the spawned pedestrian.
    const seen = new Set<string>();
    const expected = MISSIONS.filter((mission) => { if (seen.has(mission.contact) || !MISSION_CONTACT_NPC_IDS[mission.id]) return false; seen.add(mission.contact); return true; }).map((mission) => MISSION_CONTACT_NPC_IDS[mission.id]);
    expect(contacts.map((ped) => ped.visualVariant)).toEqual(expected);
    expect(population.pedestrians.filter((ped) => ped.carGuard).every((ped) => ped.visualVariant === CAR_GUARD_NPC_ID)).toBe(true);

    population.spawnHostiles();
    expect(population.hostiles.every((ped) => ped.visualVariant === RANK_ENFORCER_NPC_ID)).toBe(true);
    population.setPolicePatrolCount(2, new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z));
    expect(population.pedestrians.filter((ped) => ped.police).every((ped) => ped.visualVariant === JMPD_PATROL_NPC_ID)).toBe(true);

    const vehicle = population.vehicles[0]!;
    const drivers = Array.from({ length: 40 }, () => population.ejectDriver(vehicle, new THREE.Vector3()));
    expect(drivers.every((ped) => ped.visualVariant === DRIVER_NPC_ID)).toBe(true);
    expect(population.ejectDriver(vehicle, new THREE.Vector3(), true).visualVariant).toBe(JMPD_PATROL_NPC_ID);
    expect(population.riggedPedestrianCount()).toBe(population.pedestrians.length);
  });
});

  it('derives defeat credit from ROSTER TRUTH (spawned - standing) — every kill path counts', () => {
    // Regression: Rank Cold War stuck at 0/3 when heavies were run over — vehicle kills never
    // reached the shot-handler counter. defeatedHostiles() = spawned - still-standing, so ANY way of
    // downing a hostile (bullet, melee, vehicle, explosion, ragdoll) credits, and a despawned one
    // counts too — the "red dots gone but 0/N" contradiction is impossible.
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    population.spawnHostileWave([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 8, z: 0 }]);
    expect(population.hostiles).toHaveLength(3);
    expect(population.defeatedHostiles()).toBe(0);
    population.hostiles[0]!.takeDamage(1000);           // killed via the ped's own damage path
    expect(population.defeatedHostiles()).toBe(1);
    population.hostiles[1]!.knockdown(new THREE.Vector3()); // knocked down (state 'down') — red dot gone → counts
    expect(population.defeatedHostiles()).toBe(2);
    population.removePedestrian(population.hostiles[2]!);   // despawned entirely — also counts as defeated
    expect(population.defeatedHostiles()).toBe(3);
    // a fresh wave resets the roster size — the count starts over for the next objective
    population.spawnHostileWave([{ x: 0, z: 0 }]);
    expect(population.defeatedHostiles()).toBe(0);
  });
