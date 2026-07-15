import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { JMPD_PATROL_NPC_ID } from '../entities/NpcCatalog';
import type { AudioManager } from '../core/AudioManager';
import { Pedestrian } from '../entities/Pedestrian';
import { WORLD_SIZE } from '../config';
import { buildCityNavPaths, PED_NAV_JOIN, ROAD_NETWORK, VEHICLE_NAV_JOIN, type City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import { bridgeIslands, buildNavGraph } from './NavGraph';
import { PoliceKnowledge, ROAM_RADIUS, SIGHT_RADIUS } from './PoliceKnowledge';
import { maxInterceptors, PoliceSystem } from './PoliceSystem';
import { PopulationSystem } from './PopulationSystem';
import { WantedSystem } from './WantedSystem';

const { lanes, walks } = buildCityNavPaths(ROAD_NETWORK);
const makeCity = (): City => ({
  vehicleNav: bridgeIslands(buildNavGraph(lanes, VEHICLE_NAV_JOIN)),
  pedNav: bridgeIslands(buildNavGraph(walks, PED_NAV_JOIN)),
  sidewalkPoints: walks.flatMap((walk) => walk.points),
  wanderTarget: (x: number, z: number) => { // mirror production: hand back a NEARBY sidewalk point so routes stay short and reachable
    const points = walks.flatMap((walk) => walk.points);
    const near = points.filter((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 250 * 250);
    const pool = near.length ? near : points;
    return pool[Math.floor(Math.random() * pool.length)];
  },
  trafficRoutes: lanes.map((lane) => lane.points),
  collides: () => false,
  collidesAt: () => false,
  isOnRoad: () => true,
  signalStops: () => false, // no robots in this nav-only harness: traffic obedience is covered in JunctionsSignals.test.ts
  signalSlowFactor: () => 1, // no robots: never slow for a signal here
  surfaceHeightAt: () => 0,
  sidewalkHeightAt: () => 0,
  roadHeightAt: () => 0,
  surfaceNormalAt: () => new THREE.Vector3(0, 1, 0),
  clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone(),
  nearestRoadPose: (position: THREE.Vector3) => ({ position: position.clone(), heading: 0 }),
  roadPoseAwayFrom: (position: THREE.Vector3, minimum: number) => ({ position: new THREE.Vector3(position.x + minimum + 5, 0, position.z), heading: 0 }),
}) as unknown as City;

const audio = { scream: () => {}, setSiren: () => {}, taxiHoot: () => {}, setTrafficEngine: () => {}, copGunshot: () => {}, policeShout: () => {}, collision: () => {} } as unknown as AudioManager;

describe('ai intentions simulation', () => {
  it('drives traffic along planned lane routes and keeps peds wandering with sidewalk routes', () => {
    const population = new PopulationSystem(new THREE.Scene(), makeCity(), audio);
    const player = new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z); // the CBD spawn: the opening crowd seeds around it
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

  it('replans a fresh sidewalk route after a ped arrives instead of idling forever', () => {
    const population = new PopulationSystem(new THREE.Scene(), makeCity(), audio);
    const player = new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z);
    const ped = population.pedestrians
      .filter((walker) => !walker.contact && !walker.hostile)
      .sort((a, b) => a.group.position.distanceToSquared(player) - b.group.position.distanceToSquared(player))[0]!; // a walker inside the AI wake radius
    ped.setRoute([{ x: ped.group.position.x + 2, z: ped.group.position.z + 2 }]); // one-hop route: arrival is imminent
    let replanned = false;
    for (let frame = 0; frame < 900 && !replanned; frame++) {
      population.update(1 / 60, player);
      replanned = ped.state === 'walk' && ped.route.length > 1; // arrived → idled briefly → picked a destination → planner granted a graph route
    }
    expect(replanned).toBe(true);
  });

  it('recovers a walker pinned against a wall instead of pushing into it forever', () => {
    const walled = makeCity();
    (walled as { clampMove: City['clampMove'] }).clampMove = (from: THREE.Vector3) => from.clone(); // every step blocked
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(50, 0, 50), 1);
    ped.destination.set(90, 0, 50);
    for (let frame = 0; frame < 5; frame++) ped.update(1 / 60, walled, [{ x: 60, z: 60 }], new THREE.Vector3(400, 0, 400));
    expect(ped.state).toBe('idle'); // blocked step detected at 60fps step size: brief pause, then a fresh pick — never a permanent pinned walk
  });

  it('freezes agents far from the player and thaws them in place without popping', () => {
    const population = new PopulationSystem(new THREE.Scene(), makeCity(), audio);
    // A probe every seeded agent is comfortably outside AI_FREEZE_RADIUS of. Mission contacts sit on
    // data-driven map anchors, so a fixed magic coordinate can land right next to one after a map
    // rescale (at the 18000u parity scale, (2000, 0) fell 296u from Candice from Boksburg).
    const agents = [...population.pedestrians.map((ped) => ped.group.position), ...population.traffic.map((vehicle) => vehicle.group.position)];
    const far = [
      new THREE.Vector3(2000, 0, 0),
      new THREE.Vector3(WORLD_SIZE / 3, 0, -WORLD_SIZE / 3),
      new THREE.Vector3(-WORLD_SIZE / 3, 0, WORLD_SIZE / 3),
      new THREE.Vector3(-WORLD_SIZE / 3, 0, -WORLD_SIZE / 3),
    ].find((probe) => agents.every((agent) => agent.distanceTo(probe) > 600))!;
    expect(far).toBeDefined();
    for (let frame = 0; frame < 15; frame++) population.update(1 / 60, far); // staggered checks: everyone frozen within 10 frames
    expect(population.pedestrians.every((ped) => ped.frozen)).toBe(true);
    expect(population.traffic.every((vehicle) => vehicle.frozen)).toBe(true);
    const pedSnapshot = population.pedestrians.map((ped) => ped.group.position.clone());
    const vehicleSnapshot = population.traffic.map((vehicle) => vehicle.group.position.clone());
    for (let frame = 0; frame < 300; frame++) population.update(1 / 60, far);
    population.pedestrians.forEach((ped, index) => expect(ped.group.position.distanceTo(pedSnapshot[index]!)).toBe(0));
    population.traffic.forEach((vehicle, index) => expect(vehicle.group.position.distanceTo(vehicleSnapshot[index]!)).toBe(0));
    // A walker clear of the seeded CBD traffic: this test measures thaw continuity, not car bumps.
    const walker = population.pedestrians
      .filter((ped) => !ped.contact && !ped.hostile && !ped.aggressive)
      .find((ped) => population.vehicles.every((vehicle) => vehicle.group.position.distanceTo(ped.group.position) > 40))!;
    const near = walker.group.position.clone().add(new THREE.Vector3(20, 0, 0));
    let travelled = 0; let largestStep = 0; const previous = walker.group.position.clone();
    for (let frame = 0; frame < 600; frame++) {
      population.update(1 / 60, near);
      const step = walker.group.position.distanceTo(previous); previous.copy(walker.group.position);
      travelled += step; largestStep = Math.max(largestStep, step);
    }
    expect(walker.frozen).toBe(false);
    expect(travelled).toBeGreaterThan(0.5); // resumed its route after thawing
    expect(largestStep).toBeLessThan(0.3); // continuous motion from the frozen pose — no teleport pop
  });

  it('spawns interceptors up to the wanted-level cap and closes in on the player', () => {
    const police = new PoliceSystem(new THREE.Scene(), makeCity(), audio);
    const wanted = new WantedSystem(); wanted.addCrime(100);
    const player = new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z); // CBD spawn: dense lanes all around
    // Cop-witnessed crime at the player's position: dispatch knows where to start looking.
    const knowledge = new PoliceKnowledge(); knowledge.copWitness(player.x, player.z);
    let damage = 0;
    for (let frame = 0; frame < 1800; frame++) police.update(1 / 30, player, true, wanted, knowledge, (amount) => { damage += amount; });
    const active = police.vehicles.filter((vehicle) => !vehicle.wrecked);
    expect(active).toHaveLength(maxInterceptors(wanted.level));
    expect(wanted.level).toBe(5);
    const nearest = Math.min(...active.map((vehicle) => vehicle.group.position.distanceTo(player)));
    expect(nearest).toBeLessThan(40);
    expect(damage).toBeGreaterThan(0);
  });

  it('arrests a stationary on-foot suspect: standoff, crew deployment and fire — never a deliberate ram', () => {
    const police = new PoliceSystem(new THREE.Scene(), makeCity(), audio);
    const wanted = new WantedSystem(); wanted.addCrime(40); // two stars: live fire authorized
    const knowledge = new PoliceKnowledge(); knowledge.copWitness(SPAWN_POINT.x, SPAWN_POINT.z);
    const player = new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z);
    let damage = 0; let closestAtSpeed = Infinity;
    for (let frame = 0; frame < 1800; frame++) {
      police.update(1 / 30, player, false, wanted, knowledge, (amount) => { damage += amount; });
      for (const vehicle of police.vehicles) if (Math.abs(vehicle.speed) > 10) closestAtSpeed = Math.min(closestAtSpeed, vehicle.group.position.distanceTo(player));
    }
    const events = police.consumeEvents();
    expect(events.some((event) => event.kind === 'freeze')).toBe(true); // the crew got out and shouted
    const officers = events.flatMap((event) => event.kind === 'officers' ? event.officers : []);
    expect(officers.length).toBeGreaterThanOrEqual(2);
    expect(officers.every((officer) => officer.visualVariant === JMPD_PATROL_NPC_ID)).toBe(true);
    expect(damage).toBeGreaterThan(0); // arrest pressure comes from officer fire, not bumpers
    expect(closestAtSpeed).toBeGreaterThan(5); // nobody drove through the suspect at speed
  });

  it('caps interceptors lower at low heat', () => {
    const police = new PoliceSystem(new THREE.Scene(), makeCity(), audio);
    const wanted = new WantedSystem(); wanted.addCrime(15); // one star
    const player = new THREE.Vector3();
    const knowledge = new PoliceKnowledge(); knowledge.copWitness(player.x, player.z);
    for (let frame = 0; frame < 600; frame++) { police.update(1 / 30, player, true, wanted, knowledge, () => {}); wanted.reportSeen(); }
    expect(police.vehicles.filter((vehicle) => !vehicle.wrecked).length).toBeLessThanOrEqual(maxInterceptors(1));
  });

  it('never finds a hidden player: the search fans outward from the scene without cheating, until the heat decays', () => {
    const police = new PoliceSystem(new THREE.Scene(), makeCity(), audio);
    const wanted = new WantedSystem(); wanted.addCrime(60); // three stars: a few units to spread the search
    const knowledge = new PoliceKnowledge(); knowledge.copWitness(0, 0);
    const player = new THREE.Vector3(900, 0, 900); // hiding far away — well beyond any drift before the heat clears
    const scene = new THREE.Vector3(0, 0, 0);
    let closestToPlayer = Infinity; let farthestWhileHot = 0;
    for (let frame = 0; frame < 2400; frame++) {
      police.update(1 / 30, player, true, wanted, knowledge, () => {});
      wanted.update(1 / 30);
      for (const vehicle of police.vehicles.filter((unit) => !unit.wrecked)) {
        closestToPlayer = Math.min(closestToPlayer, vehicle.group.position.distanceTo(player));
        if (wanted.isWanted) farthestWhileHot = Math.max(farthestWhileHot, vehicle.group.position.distanceTo(scene));
      }
    }
    expect(closestToPlayer).toBeGreaterThan(SIGHT_RADIUS); // nobody ever stumbled onto the hidden player
    expect(knowledge.lastKnown).toMatchObject({ x: 0, z: 0 }); // knowledge never advanced past the scene — no cheating onto the live position
    expect(farthestWhileHot).toBeGreaterThan(ROAM_RADIUS); // the search drifts outward from the scene, not orbiting it
    expect(wanted.isWanted).toBe(false); // unseen decay ended the alert
  });
});
