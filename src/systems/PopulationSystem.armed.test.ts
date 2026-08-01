import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import type { City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import { PopulationSystem } from './PopulationSystem';
import { CIVILIAN_GUN_DAMAGE } from './SidearmSystem';

/**
 * The armed-citizen FIRE path: a civilian with the sidearm out shoots exactly like a cop
 * (probabilistic hitscan, sight line, cadence) through PopulationSystem — and an unarmed
 * civilian confronted with the same drawn gun never fires anything, he leaves.
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

const DT = 1 / 60;
// The fight yard sits 60u from the sidewalk grid, so ambient wanderers never blunder into it.
const player = () => new THREE.Vector3(SPAWN_POINT.x - 60, 0, SPAWN_POINT.z - 60);

interface Shots { count: number }
const makeAudio = (shots: Shots): AudioManager => ({
  scream: () => {}, grunt: () => {}, melee: () => {}, whiff: () => {}, setTrafficEngine: () => {},
  copGunshot: () => { shots.count += 1; },
} as unknown as AudioManager);

/** An armed citizen (deterministic trait), moved to the fight yard and legitimately enraged. */
const armedCitizenNear = (population: PopulationSystem, position: THREE.Vector3): ReturnType<PopulationSystem['spawnAmbientPedestrian']> => {
  for (let i = 0; i < 12; i++) {
    const ped = population.spawnAmbientPedestrian(position.x + 30, position.z + 30);
    if (!ped.armed) { population.removePedestrian(ped); continue; }
    ped.group.position.set(position.x + 6, 0, position.z); // inside the gun hold ring
    ped.fear = 100; ped.enraged = true; ped.threat.copy(position);
    return ped;
  }
  throw new Error('no armed citizen in 12 consecutive ambient spawns — the 1-in-12 wheel is broken');
};

describe('armed citizens fight armed players', () => {
  it('a drawn sidearm fires the police path: paced positional shots, gun damage, and not one punch', () => {
    const shots: Shots = { count: 0 };
    const population = new PopulationSystem(new THREE.Scene(), city, makeAudio(shots));
    const position = player();
    const ped = armedCitizenNear(population, position);
    let damage = 0; let everPunched = false;
    for (let t = 0; t < 10; t += DT) {
      population.update(DT, position, (amount) => { damage += amount; }, true, true); // player on foot, visibly armed
      everPunched ||= ped.punching;
    }
    expect(ped.state).toBe('hostile'); // continues the fight against the gun
    expect(ped.gunDrawn).toBe(true);
    expect(shots.count).toBeGreaterThanOrEqual(3); // ~1.1-1.9s cadence over 10s, minus the draw beat
    expect(damage).toBeGreaterThan(0);
    expect(damage % CIVILIAN_GUN_DAMAGE).toBe(0); // every point arrived as gunfire, none as fists
    expect(everPunched).toBe(false);
  });

  it('the draw beat holds fire long enough for the stance to read before it wounds', () => {
    const shots: Shots = { count: 0 };
    const population = new PopulationSystem(new THREE.Scene(), city, makeAudio(shots));
    const position = player();
    armedCitizenNear(population, position);
    for (let t = 0; t < 0.9; t += DT) population.update(DT, position, () => {}, true, true);
    expect(shots.count).toBe(0); // CIVILIAN_FIRE_MIN has not elapsed since the aim settled
  });

  it('an unarmed attacker facing the same drawn gun breaks off and never fires anything', () => {
    const shots: Shots = { count: 0 };
    const population = new PopulationSystem(new THREE.Scene(), city, makeAudio(shots));
    const position = player();
    const ped = population.spawnAmbientPedestrian(position.x + 30, position.z + 30);
    expect(ped.armed).toBe(false); // ambientSerial 200: the first ambient spawn is unarmed
    ped.group.position.set(position.x + 2, 0, position.z);
    ped.aggressive = true;
    population.update(DT, position, () => {}, true, false); // fists vs fists: the fight starts
    expect(ped.state).toBe('hostile');
    let damage = 0;
    for (let t = 0; t < 2; t += DT) population.update(DT, position, (amount) => { damage += amount; }, true, true); // the gun comes out
    expect(ped.state).toBe('flee');
    expect(ped.gunDrawn).toBe(false);
    expect(shots.count).toBe(0);
    expect(damage).toBe(0);
  });
});
