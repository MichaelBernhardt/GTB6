import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import { buildCityNavPaths, PED_NAV_JOIN, ROAD_NETWORK, VEHICLE_NAV_JOIN, type City } from '../world/City';
import { bridgeIslands, buildNavGraph } from './NavGraph';
import { maxInterceptors, PoliceSystem } from './PoliceSystem';
import { PopulationSystem } from './PopulationSystem';
import { WantedSystem } from './WantedSystem';

const { lanes, walks } = buildCityNavPaths(ROAD_NETWORK);
const makeCity = (): City => ({
  vehicleNav: bridgeIslands(buildNavGraph(lanes, VEHICLE_NAV_JOIN)),
  pedNav: bridgeIslands(buildNavGraph(walks, PED_NAV_JOIN)),
  sidewalkPoints: walks.flatMap((walk) => walk.points),
  trafficRoutes: lanes.map((lane) => lane.points),
  collides: () => false,
  isOnRoad: () => true,
  clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone(),
  nearestRoadPose: (position: THREE.Vector3) => ({ position: position.clone(), heading: 0 }),
  roadPoseAwayFrom: (position: THREE.Vector3, minimum: number) => ({ position: new THREE.Vector3(position.x + minimum + 5, 0, position.z), heading: 0 }),
}) as unknown as City;

const audio = { scream: () => {}, setSiren: () => {}, taxiHoot: () => {} } as unknown as AudioManager;

describe('ai intentions simulation', () => {
  it('drives traffic along planned lane routes and keeps peds wandering with sidewalk routes', () => {
    const population = new PopulationSystem(new THREE.Scene(), makeCity(), audio);
    const player = new THREE.Vector3();
    const startPositions = population.traffic.map((vehicle) => vehicle.group.position.clone());
    for (let frame = 0; frame < 900; frame++) population.update(1 / 60, player);
    const moved = population.traffic.filter((vehicle, index) => vehicle.group.position.distanceTo(startPositions[index]!) > 15);
    expect(moved.length).toBeGreaterThan(population.traffic.length * 0.6);
    for (const vehicle of population.traffic) expect(vehicle.aiTarget.lengthSq()).toBeGreaterThan(0);
    const walkers = population.pedestrians.filter((ped) => !ped.contact);
    expect(walkers.some((ped) => ped.route.length > 1)).toBe(true);
    const contacts = population.pedestrians.filter((ped) => ped.contact);
    expect(contacts.every((ped) => ped.state === 'idle' && ped.route.length === 0)).toBe(true);
  });

  it('spawns interceptors up to the wanted-level cap and closes in on the player', () => {
    const police = new PoliceSystem(new THREE.Scene(), makeCity(), audio);
    const wanted = new WantedSystem(); wanted.addCrime(100);
    const player = new THREE.Vector3(0, 0, 0);
    let damage = 0;
    for (let frame = 0; frame < 1800; frame++) police.update(1 / 30, player, true, wanted, (amount) => { damage += amount; });
    const active = police.vehicles.filter((vehicle) => !vehicle.wrecked);
    expect(active).toHaveLength(maxInterceptors(wanted.level));
    expect(wanted.level).toBe(5);
    const nearest = Math.min(...active.map((vehicle) => vehicle.group.position.distanceTo(player)));
    expect(nearest).toBeLessThan(40);
    expect(damage).toBeGreaterThan(0);
  });

  it('caps interceptors lower at low heat', () => {
    const police = new PoliceSystem(new THREE.Scene(), makeCity(), audio);
    const wanted = new WantedSystem(); wanted.addCrime(15); // one star
    const player = new THREE.Vector3();
    for (let frame = 0; frame < 600; frame++) { police.update(1 / 30, player, true, wanted, () => {}); wanted.reportSeen(); }
    expect(police.vehicles.filter((vehicle) => !vehicle.wrecked).length).toBeLessThanOrEqual(maxInterceptors(1));
  });
});
