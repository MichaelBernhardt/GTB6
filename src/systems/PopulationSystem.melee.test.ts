import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import type { City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import { MELEE_DAMAGE, MELEE_GLOBAL_STAGGER } from './MeleeSystem';
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
const audio = { scream: () => {}, grunt: () => {}, melee: () => {}, whiff: () => {}, setTrafficEngine: () => {} } as unknown as AudioManager;

const DT = 1 / 60;
// The fight yard sits 60u from the sidewalk grid, so ambient wanderers never blunder into it.
const player = () => new THREE.Vector3(SPAWN_POINT.x - 60, 0, SPAWN_POINT.z - 60);
const waveSpots = (position: THREE.Vector3) => [
  { x: position.x + 10, z: position.z },
  { x: position.x - 8, z: position.z + 6 },
  { x: position.x, z: position.z - 11 },
];

describe('hostile wave melee', () => {
  it('a standing player takes readable, survivable damage — and only while a punch animation is playing', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const position = player();
    population.spawnHostileWave(waveSpots(position));
    const timeline: Array<{ time: number; amount: number }> = [];
    let time = 0;
    const damage = (amount: number): void => {
      // No invisible damage: every landed hit must coincide with a visible mid-swing attacker.
      expect(population.hostiles.some((ped) => ped.punching)).toBe(true);
      timeline.push({ time, amount });
    };
    while (time < 15) { population.update(DT, position, damage, true); time += DT; }

    const total = timeline.reduce((sum, entry) => sum + entry.amount, 0);
    expect(total).toBeGreaterThanOrEqual(3 * MELEE_DAMAGE); // the wave genuinely fights
    expect(timeline.filter((entry) => entry.time < 1.2)).toHaveLength(0); // approach + windup: never instant
    expect(timeline.filter((entry) => entry.time < 2.5).length).toBeLessThanOrEqual(2); // a fumbling player is not deleted on contact
    // Global stagger bounds the worst-case cadence even with three attackers engaged.
    expect(total).toBeLessThanOrEqual(MELEE_DAMAGE * Math.ceil(15 / MELEE_GLOBAL_STAGGER));
    for (let i = 1; i < timeline.length; i++) expect(timeline[i]!.time - timeline[i - 1]!.time).toBeGreaterThanOrEqual(MELEE_GLOBAL_STAGGER - 2 * DT);
  });

  it('backing off mid-windup escapes the hit', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const position = player();
    population.spawnHostileWave(waveSpots(position));
    let hits = 0;
    let time = 0;
    // Close until the first swing starts, then immediately break away out of aggro range.
    while (time < 10 && !population.hostiles.some((ped) => ped.punching)) {
      population.update(DT, position, (amount) => { hits += amount; }, true);
      time += DT;
    }
    expect(population.hostiles.some((ped) => ped.punching)).toBe(true);
    expect(hits).toBe(0); // the windup itself dealt nothing
    position.x += 200; // sprinted off: out of reach AND out of the 70u aggro leash
    for (let t = 0; t < 3; t += DT) population.update(DT, position, (amount) => { hits += amount; }, true);
    expect(hits).toBe(0); // the started swing whiffed; nobody lands a phantom hit
  });

  it('never punches a player in a vehicle', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const position = player();
    population.spawnHostileWave(waveSpots(position));
    let hits = 0;
    for (let t = 0; t < 8; t += DT) population.update(DT, position, (amount) => { hits += amount; }, false); // playerOnFoot = false
    expect(hits).toBe(0);
  });

  it('defeat crediting still counts melee-wave hostiles downed by any path', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const position = player();
    population.spawnHostileWave(waveSpots(position));
    for (let t = 0; t < 2; t += DT) population.update(DT, position, () => {}, true);
    expect(population.defeatedHostiles()).toBe(0);
    population.hostiles[0]!.takeDamage(999, position);
    population.hostiles[1]!.knockdown(position, 999);
    expect(population.defeatedHostiles()).toBe(2);
  });
});
