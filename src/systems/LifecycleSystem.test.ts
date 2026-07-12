import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import { buildCityNavPaths, PED_NAV_JOIN, ROAD_NETWORK, VEHICLE_NAV_JOIN, type City } from '../world/City';
import { CALM_THRESHOLD } from './FearSystem';
import { activeZones, axisIndex, zoneCharacter, ZONE_SIZE } from '../world/data/zoneGrid';
import {
  AMBIENT_SPAWN_TRICKLE, BUSY_MAX, BUSY_MIN, CAR_TARGET_CAP, censusBudget, CHANGE_BUDGET, clampBusy, CLEANUP_HOURS, cleanupEligible,
  corpseCleanable, dayPhase, FOV_COS, isAmbientPedestrian, LIFECYCLE_INTERVAL, LifecycleSystem, outOfSight, PED_SPAWN_SPACING, PED_TARGET_CAP,
  pedDespawnable, PHASE_MULTIPLIER, SIGHT_FAR, SIGHT_NEAR, vehicleDespawnable, ZONE_DENSITY, zoneTarget, type ViewPoint,
} from './LifecycleSystem';
import { bridgeIslands, buildNavGraph } from './NavGraph';
import { PopulationSystem } from './PopulationSystem';
import { SPAWN_POINT } from '../world/placements';

/** Sum each active zone's own target across the 3×3 around a cell — the theoretical area population. */
const areaTarget = (col: number, row: number, hour: number, busy: number) =>
  activeZones({ col, row }).reduce((acc, cell) => {
    const target = zoneTarget(zoneCharacter(cell.col, cell.row), hour, busy);
    return { peds: acc.peds + target.peds, cars: acc.cars + target.cars };
  }, { peds: 0, cars: 0 });

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

describe('dayPhase', () => {
  it('maps hours onto the day/shoulder/night bands', () => {
    expect(dayPhase(12)).toBe('day'); expect(dayPhase(8)).toBe('day'); expect(dayPhase(17.9)).toBe('day');
    expect(dayPhase(18)).toBe('shoulder'); expect(dayPhase(21.9)).toBe('shoulder'); expect(dayPhase(5)).toBe('shoulder'); expect(dayPhase(7.9)).toBe('shoulder');
    expect(dayPhase(22)).toBe('night'); expect(dayPhase(0)).toBe('night'); expect(dayPhase(3)).toBe('night'); expect(dayPhase(4.9)).toBe('night');
  });

  it('wraps out-of-range hours', () => {
    expect(dayPhase(26)).toBe('night'); // 02:00
    expect(dayPhase(-12)).toBe('day'); // 12:00
  });

  it('runs the time-of-day curve fullest by day and quietest overnight', () => {
    expect(PHASE_MULTIPLIER.night).toBeLessThan(PHASE_MULTIPLIER.shoulder);
    expect(PHASE_MULTIPLIER.shoulder).toBeLessThan(PHASE_MULTIPLIER.day);
    expect(PHASE_MULTIPLIER.day).toBe(1);
  });
});

describe('zoneTarget', () => {
  it('is base density × time-of-day curve × busy percent', () => {
    expect(zoneTarget('commercial-highrise', 12, 100)).toEqual(ZONE_DENSITY['commercial-highrise']); // day, normal busy = base
    expect(zoneTarget('commercial-highrise', 12, 300)).toEqual({ peds: 66, cars: 27 }); // 3× busy
    expect(zoneTarget('commercial-highrise', 2, 100)).toEqual({ peds: 22 * PHASE_MULTIPLIER.night, cars: 9 * PHASE_MULTIPLIER.night }); // small hours
    expect(zoneTarget('none', 12, 500)).toEqual({ peds: 0, cars: 0 }); // parks/water never populate
  });

  it('ranks the built characters densest-first, suburbs moderate, outskirts sparse', () => {
    const peds = (zone: Parameters<typeof zoneTarget>[0]) => zoneTarget(zone, 12, 100).peds;
    expect(peds('commercial-highrise')).toBeGreaterThan(peds('commercial-strip'));
    expect(peds('commercial-strip')).toBeGreaterThan(peds('residential'));
    expect(peds('residential')).toBeGreaterThan(peds('estate'));
    expect(peds('estate')).toBeGreaterThan(peds('rural'));
    expect(peds('rural')).toBeGreaterThan(peds('none'));
  });

  it('clamps the busy percent to the console bounds', () => {
    expect(clampBusy(5)).toBe(BUSY_MIN); expect(clampBusy(99999)).toBe(BUSY_MAX); expect(clampBusy(100)).toBe(100);
    expect(zoneTarget('commercial-highrise', 12, 5)).toEqual(zoneTarget('commercial-highrise', 12, BUSY_MIN)); // below floor pins to the floor
    expect(zoneTarget('commercial-highrise', 12, 99999)).toEqual(zoneTarget('commercial-highrise', 12, BUSY_MAX)); // above ceiling pins to the ceiling
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
  wanderTarget: () => undefined, // fall back to the citywide set: this harness asserts census counts, not route locality
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

  it('fills the local area to the summed nine-zone target, sparing the mission cast', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const contacts = population.pedestrians.filter((p) => p.contact).length;
    const cbdView = { x: SPAWN_POINT.x, z: SPAWN_POINT.z, dirX: 0, dirZ: 1 }; // stand in the CBD
    const nightArea = areaTarget(axisIndex(SPAWN_POINT.x), axisIndex(SPAWN_POINT.z), 2, 100);
    for (let i = 0; i < 240; i++) lifecycle.update(1, 2, cbdView, new Set()); // 02:00
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(lifecycle.targets(2).peds);
    expect(population.traffic.length).toBe(lifecycle.targets(2).traffic);
    expect(lifecycle.targets(2).peds).toBe(Math.round(nightArea.peds)); // the census equals the manual sum-over-active-zones
    expect(population.pedestrians.filter((p) => p.contact).length).toBe(contacts); // contacts untouched
    const nightPeds = population.pedestrians.filter(isAmbientPedestrian).length;
    for (let i = 0; i < 300; i++) lifecycle.update(1, 12, cbdView, new Set()); // noon: the same block fills far busier
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(lifecycle.targets(12).peds);
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBeGreaterThan(nightPeds); // daytime CBD bustles
    expect(population.traffic.length).toBe(lifecycle.targets(12).traffic);
  });

  it('trickles a freshly-active area in over several ticks, spaced apart — never a mob', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const fresh = { x: -600, z: 1769, dirX: 0, dirZ: 1 }; // teleport away from the CBD spawn crowd to a cold district
    lifecycle.update(LIFECYCLE_INTERVAL, 12, fresh, new Set()); // one census: CBD crowd (now a dead zone) cleared, fresh area begins filling
    const firstBatch = population.pedestrians.filter(isAmbientPedestrian);
    expect(firstBatch.length).toBeGreaterThan(0); // it does start filling
    expect(firstBatch.length).toBeLessThanOrEqual(AMBIENT_SPAWN_TRICKLE); // temporal stagger: no one-tick mob of the whole target
    firstBatch.forEach((a, i) => firstBatch.slice(i + 1).forEach((b) => // spatial stagger: the batch is scattered, not stacked
      expect(a.group.position.distanceTo(b.group.position)).toBeGreaterThanOrEqual(PED_SPAWN_SPACING - 1e-6)));
    for (let k = 0; k < 300; k++) lifecycle.update(1, 12, fresh, new Set()); // let it keep trickling
    const full = population.pedestrians.filter(isAmbientPedestrian).length;
    expect(full).toBe(lifecycle.targets(12).peds); // eventually reaches the full area target...
    expect(full).toBeGreaterThan(firstBatch.length); // ...which took many ticks, not the first one
  });

  it('empties the dead ring when the player drives off to a fresh area', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const cbdView = { x: SPAWN_POINT.x, z: SPAWN_POINT.z, dirX: 0, dirZ: 1 };
    for (let i = 0; i < 300; i++) lifecycle.update(1, 12, cbdView, new Set());
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBeGreaterThan(40); // a lively crowd is standing
    const farView = { x: -8000, z: -8000, dirX: 0, dirZ: 1 }; // teleport to the far corner
    for (let i = 0; i < 5; i++) lifecycle.update(1, 12, farView, new Set());
    // the whole CBD crowd (now two-plus zones away, always out of sight) has been cleared
    for (const ped of population.pedestrians.filter(isAmbientPedestrian))
      expect(Math.hypot(ped.group.position.x - SPAWN_POINT.x, ped.group.position.z - SPAWN_POINT.z)).toBeGreaterThan(ZONE_SIZE);
  });

  it('scales the whole active area with `set busy`, caps the summed total, and honours pins', () => {
    const city = makeCity();
    const population = new PopulationSystem(new THREE.Scene(), city, audio);
    const lifecycle = new LifecycleSystem(city, population);
    const cbdView = { x: SPAWN_POINT.x, z: SPAWN_POINT.z, dirX: 0, dirZ: 1 };
    lifecycle.tuning = { busy: 300 }; // crank the CBD: the summed target blows past the perf cap
    for (let i = 0; i < 300; i++) lifecycle.update(1, 12, cbdView, new Set());
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(PED_TARGET_CAP);
    expect(population.traffic.length).toBe(CAR_TARGET_CAP);
    lifecycle.tuning = { busy: 100, peds: 18, cars: 6 }; // pin the area totals low
    const elsewhere = { x: -600, z: 1769, dirX: 0, dirZ: 1 }; // drive to a fresh district: the CBD crowd is left behind (dead zone) and the pin fills here
    for (let i = 0; i < 90; i++) lifecycle.update(1, 12, elsewhere, new Set());
    expect(population.pedestrians.filter(isAmbientPedestrian).length).toBe(18);
    expect(population.traffic.length).toBe(6);
  });
});
