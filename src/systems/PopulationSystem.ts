import * as THREE from 'three';
import { PLAYER, resolveFrozen, TRAFFIC_SPEED_FACTOR, WORLD_SIZE, type VehicleKind } from '../config';
import type { AudioManager } from '../core/AudioManager';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import { BUMP_COOLDOWN, BUMP_FEAR, BUMP_RADIUS, bumpEscalates, recordBump, separationPush } from './BumpSystem';
import { FEAR_EVENTS, fearContribution, FEAR_MAX, seesBrandish, type FearEvent } from './FearSystem';
import { MISSIONS } from './MissionSystem';
import { ProgressWatchdog, RoutePlanner, type NavPoint } from './NavGraph';
import { AVOID_RANGE, bumperAhead, carYields, corridorBlocked, DODGE_AHEAD, DODGE_SIDE, DODGE_THROTTLE, DODGE_TIME, firstHonkDelay, HIT_COOLDOWN, HIT_SPEED_KEEP, HOLD_SPEED, holdRelease, overlapPush, pullAroundPatience, pullAroundSide, rehonkDelay, vehicleHitDamage } from './TrafficAvoidance';
import type { City, RoadPoint } from '../world/City';
import { HOSTILE_SPOTS, PARKED_VEHICLES, SPAWN_POINT } from '../world/placements';
import { CITY_JUNCTIONS } from '../world/UrbanInfrastructure';
import { powerOn } from '../world/powerGrid';

interface DrivePlan { points: NavPoint[]; index: number; watchdog: ProgressWatchdog; backoff: number; }
interface TaxiState { stopTimer: number; dwell: number; hootTimer: number; }
interface Holdup { held: number; honkAt: number; giveUpAt: number; dodge: number; side: number; holding: boolean; clearFor: number; } // one blocked-by-the-player driver's patience
export interface PlayerBump { ped: Pedestrian; position: THREE.Vector3; knockdown: boolean; killed: boolean; assault: boolean; }
export interface PlayerVehicleHit { speed: number; damage: number; knockdown: boolean; }

/** Freeze/thaw distance checks run for each agent once per this many frames, staggered by agent index. */
const FREEZE_CHECK_FRAMES = 10;

export class PopulationSystem {
  pedestrians: Pedestrian[] = [];
  vehicles: Vehicle[] = [];
  traffic: Vehicle[] = [];
  hostiles: Pedestrian[] = [];
  private hostileAttackCooldown = 0;
  private impacts: Array<{ position: THREE.Vector3; killed: boolean; vehicle: Vehicle; ped: Pedestrian }> = [];
  private pedestrianImpactCooldown = new WeakMap<Pedestrian, number>();
  private trafficPlans = new WeakMap<Vehicle, DrivePlan>();
  private trafficRecoveries = new WeakMap<Vehicle, number>();
  private vehiclePlanner: RoutePlanner;
  private pedPlanner: RoutePlanner;
  private taxiState = new WeakMap<Vehicle, TaxiState>();
  private bumpTimes = new WeakMap<Pedestrian, number[]>();
  private bumpCooldown = new WeakMap<Pedestrian, number>();
  private bumpClock = 0;
  private hootCooldown = 0;
  private holdups = new WeakMap<Vehicle, Holdup>();
  private playerVehicleHits: PlayerVehicleHit[] = [];
  private playerHitCooldown = 0;
  private parkedSpots: Array<[number, number]> = [];
  private policePatrols: Pedestrian[] = [];
  private ambientSerial = 200; // seeds variety (colours, wallets, bravery) for lifecycle-spawned agents
  private frame = 0;
  private forward = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private city: City, private audio: AudioManager) {
    this.vehiclePlanner = new RoutePlanner(city.vehicleNav, 2);
    this.pedPlanner = new RoutePlanner(city.pedNav, 2);
    this.spawnVehicles(); this.spawnPedestrians();
  }

  update(dt: number, player: THREE.Vector3, damagePlayer?: (amount: number) => void, playerOnFoot = false): void {
    this.vehiclePlanner.beginFrame(); this.pedPlanner.beginFrame(); this.frame += 1;
    this.hostileAttackCooldown = Math.max(0, this.hostileAttackCooldown - dt);
    this.playerHitCooldown = Math.max(0, this.playerHitCooldown - dt);
    this.pedestrians.forEach((ped, index) => {
      if ((this.frame + index) % FREEZE_CHECK_FRAMES === 0) {
        const wasFrozen = ped.frozen;
        ped.frozen = resolveFrozen(ped.frozen, ped.group.position.distanceToSquared(player));
        if (ped.frozen !== wasFrozen) ped.resetProgress(); // stalled time must not straddle a frozen gap
      }
      if (ped.frozen) return; // far agents: no motion, routing, or animation until the player closes in again
      ped.update(dt, this.city, this.city.sidewalkPoints, player);
      if (ped.wantsRoute) { const points = this.pedPlanner.tryPlanTo(ped.group.position.x, ped.group.position.z, ped.destination.x, ped.destination.z); if (points) ped.setRoute(points); else ped.deferRoute(); }
      this.pedestrianImpactCooldown.set(ped, Math.max(0, (this.pedestrianImpactCooldown.get(ped) ?? 0) - dt));
    });
    this.witnessBodies(dt);
    const robotsOut = !powerOn();
    this.hootCooldown = Math.max(0, this.hootCooldown - dt);
    this.traffic.forEach((vehicle, index) => {
      if (vehicle.playerControlled || vehicle.disabled || !vehicle.occupied) return; // no NPC aboard (e.g. a carjacked car the player has since left): sit still, don't plan routes
      vehicle.routeCooldown = Math.max(0, vehicle.routeCooldown - dt);
      if ((this.frame + index * 3 + 1) % FREEZE_CHECK_FRAMES === 0) {
        const wasFrozen = vehicle.frozen;
        vehicle.frozen = resolveFrozen(vehicle.frozen, vehicle.group.position.distanceToSquared(player));
        if (vehicle.frozen !== wasFrozen) this.trafficPlans.get(vehicle)?.watchdog.reset();
        if (vehicle.frozen && !wasFrozen) vehicle.speed = 0; // park in place: a stale speed would fire impact checks and jerk on thaw
      }
      if (vehicle.frozen) return;
      // Obey robots (powered only): a car approaching a signalised junction on a red/amber axis holds.
      const taxiKind = vehicle.spec.kind === 'taxi';
      const signalStop = !robotsOut && !taxiKind && this.city.signalStops(vehicle.group.position, vehicle.heading);
      if (signalStop) this.trafficPlans.get(vehicle)?.watchdog.reset(); // a legal red-light wait (up to ~16s) is not a stall
      if (!this.followDrivePlan(vehicle, dt)) return; // reversing out of a watchdog stall this frame
      const forward = this.forward.set(Math.sin(vehicle.heading), 0, Math.cos(vehicle.heading));
      const blocked = this.vehicles.some((other) => { // same-lane car just ahead; a wide dot>0 sweep used to gridlock oncoming lanes on narrow roads
        if (other === vehicle) return false;
        const dx = other.group.position.x - vehicle.group.position.x; const dz = other.group.position.z - vehicle.group.position.z;
        const ahead = dx * forward.x + dz * forward.z;
        if (ahead <= 1 || ahead >= 9 || dx * dx + dz * dz - ahead * ahead >= 6.25) return false;
        return Math.cos(other.heading - vehicle.heading) > -0.35 || Math.abs(other.speed) < 2; // brake for the queue and for parked obstructions, not for oncoming movers: the undirected graph puts them on this lane and mutual braking is a head-on crawl deadlock
      });
      let playerBlocked = false; let playerHold = false; let dodge: THREE.Vector3 | undefined;
      if (playerOnFoot && !vehicle.police && vehicle.group.position.distanceToSquared(player) < AVOID_RANGE * AVOID_RANGE) ({ blocked: playerBlocked, hold: playerHold, dodge } = this.avoidPlayer(vehicle, forward, player, dt));
      else this.holdups.delete(vehicle);
      const taxi = taxiKind;
      const junctionPanic = robotsOut && !taxi && CITY_JUNCTIONS.some((junction) => (junction.x - vehicle.group.position.x) ** 2 + (junction.z - vehicle.group.position.z) ** 2 < 576);
      const throttle = playerHold ? 0 // held: a full stop with hysteresis, no 0.05 creep — this is what arms the honk clock
        : dodge ? DODGE_THROTTLE
        : taxi ? this.taxiThrottle(vehicle, dt, player, blocked || playerBlocked)
        : blocked || playerBlocked ? 0.05 : signalStop ? 0 : junctionPanic ? 0.03 : TRAFFIC_SPEED_FACTOR;
      vehicle.updateAI(dt, this.city, dodge, throttle);
      const outsideWorld = Math.abs(vehicle.group.position.x) > WORLD_SIZE / 2 || Math.abs(vehicle.group.position.z) > WORLD_SIZE / 2;
      if (outsideWorld || vehicle.aiStuck > 9) this.rehomeVehicle(vehicle);
    });
    this.handleVehiclePedestrianImpacts();
    this.handleTrafficSeparation();
    this.updateTrafficEngineAudio(player);
    if (damagePlayer && this.hostileAttackCooldown <= 0) {
      const attacker = this.pedestrians.find((ped) => ped.state === 'hostile' && ped.group.position.distanceTo(player) < 2.3);
      if (attacker) { attacker.punch(); damagePlayer(7); this.hostileAttackCooldown = 0.9; }
    }
  }

  private updateTrafficEngineAudio(player: THREE.Vector3): void {
    let nearest: Vehicle | undefined; let best = 60 * 60;
    for (const vehicle of this.traffic) {
      if (vehicle.playerControlled || vehicle.disabled || !vehicle.occupied || vehicle.spec.kind === 'bicycle') continue; // no engine to hum (an abandoned car sits silent)
      const d2 = vehicle.group.position.distanceToSquared(player);
      if (d2 < best) { best = d2; nearest = vehicle; }
    }
    if (nearest) this.audio.setTrafficEngine(true, nearest.group.position.x, nearest.group.position.z, nearest.speed, nearest.spec.maxSpeed, nearest.spec.kind);
    else this.audio.setTrafficEngine(false);
  }

  /** Soft player↔ped collision: gentle radial push both ways, stumble grunt, repeat-bump/knockdown escalation. */
  bumpPlayer(dt: number, position: THREE.Vector3, moving: boolean, sprinting: boolean): PlayerBump[] {
    this.bumpClock += dt;
    const events: PlayerBump[] = [];
    for (const ped of this.pedestrians) {
      if (ped.contact || ped.state === 'down') continue;
      const delta = ped.group.position.clone().sub(position); delta.y = 0;
      const distance = delta.length();
      if (distance >= BUMP_RADIUS) continue;
      const direction = distance > 0.001 ? delta.multiplyScalar(1 / distance) : new THREE.Vector3(1, 0, 0);
      const push = separationPush(distance);
      ped.group.position.copy(this.city.clampMove(ped.group.position, ped.group.position.clone().addScaledVector(direction, push.ped), 0.42));
      position.copy(this.city.clampMove(position, position.clone().addScaledVector(direction, -push.player), PLAYER.radius));
      if (!moving || ped.police || ped.hostile || (this.bumpCooldown.get(ped) ?? 0) > this.bumpClock) continue;
      this.bumpCooldown.set(ped, this.bumpClock + BUMP_COOLDOWN);
      const times = this.bumpTimes.get(ped) ?? []; this.bumpTimes.set(ped, times);
      const count = recordBump(times, this.bumpClock);
      const assault = bumpEscalates(count, sprinting);
      const killed = sprinting ? ped.knockdown(position) : false;
      if (!sprinting) {
        ped.stumble(position);
        if (assault) this.frighten(ped, FEAR_EVENTS.assault.base, position); else ped.applyFear(BUMP_FEAR, position);
      }
      if (killed || sprinting) this.audio.scream('pain', ped.group.position.x, ped.group.position.z);
      else this.audio.grunt(ped.group.position.x, ped.group.position.z);
      events.push({ ped, position: ped.group.position.clone(), knockdown: sprinting, killed, assault });
    }
    return events;
  }

  broadcastFear(origin: THREE.Vector3, event: FearEvent): void {
    this.spreadPanic(this.pedestrians.filter((ped) => this.frighten(ped, fearContribution(event, ped.group.position.distanceTo(origin)), origin)));
  }

  /** A raised weapon frightens only peds who can see it: within radius and facing the player (or close enough to sense). */
  broadcastBrandish(origin: THREE.Vector3, event: FearEvent = FEAR_EVENTS.brandish): void {
    this.spreadPanic(this.pedestrians.filter((ped) => {
      const distance = ped.group.position.distanceTo(origin);
      if (distance >= event.radius || !seesBrandish(Math.sin(ped.group.rotation.y), Math.cos(ped.group.rotation.y), origin.x - ped.group.position.x, origin.z - ped.group.position.z, distance)) return false;
      return this.frighten(ped, fearContribution(event, distance), origin);
    }));
  }

  /** Fear contagion: each freshly panicked ped's shrieking rattles bystanders with a smaller secondary burst (one hop, no recursion). */
  private spreadPanic(sources: Pedestrian[]): void {
    for (const source of sources) for (const ped of this.pedestrians) {
      if (ped !== source) this.frighten(ped, fearContribution(FEAR_EVENTS.panic, ped.group.position.distanceTo(source.group.position)), source.group.position);
    }
  }

  /** Returns true when the fear pushed the ped into a fresh flee/cower panic. */
  private frighten(ped: Pedestrian, amount: number, origin: THREE.Vector3): boolean {
    const before = ped.state;
    ped.applyFear(amount, origin);
    const panicked = before !== ped.state && (ped.state === 'flee' || ped.state === 'cower');
    if (panicked && Math.random() < 0.4) this.audio.scream('panic', ped.group.position.x, ped.group.position.z);
    return panicked;
  }

  private taxiThrottle(vehicle: Vehicle, dt: number, player: THREE.Vector3, blocked: boolean): number {
    const state = this.taxiState.get(vehicle) ?? { stopTimer: 6 + Math.random() * 9, dwell: 0, hootTimer: 2 + Math.random() * 3 };
    state.stopTimer -= dt; state.hootTimer -= dt; state.dwell = Math.max(0, state.dwell - dt);
    if (state.stopTimer <= 0) {
      const passengerNearby = this.pedestrians.some((ped) => ped.state === 'walk' && ped.group.position.distanceToSquared(vehicle.group.position) < 784);
      state.dwell = passengerNearby ? 2.6 : 1.2;
      state.stopTimer = 7 + Math.random() * 10;
    }
    if (state.hootTimer <= 0 && this.hootCooldown === 0 && vehicle.group.position.distanceToSquared(player) < 9025) {
      this.audio.taxiHoot(); state.hootTimer = 3 + Math.random() * 5; this.hootCooldown = 0.6;
    }
    this.taxiState.set(vehicle, state);
    if (state.dwell > 0) return 0;
    return blocked ? 0.05 : TRAFFIC_SPEED_FACTOR * 2;
  }

  consumeImpacts(): Array<{ position: THREE.Vector3; killed: boolean; vehicle: Vehicle; ped: Pedestrian }> { return this.impacts.splice(0); }

  /** Traffic-vs-on-foot-player contacts since last frame; Game applies damage/tumble (cheats respected there). */
  consumePlayerVehicleHits(): PlayerVehicleHit[] { return this.playerVehicleHits.splice(0); }

  /** Cumulative A* solves (ped + car planners) — the perf HUD samples the per-second delta. */
  navSolveCount(): number { return this.pedPlanner.solves + this.vehiclePlanner.solves; }
  /** Cumulative wall-time (ms) spent in A* across both planners — HUD samples the per-second delta. */
  navSolveMs(): number { return this.pedPlanner.solveMs + this.vehiclePlanner.solveMs; }

  /** One civilian driver vs the on-foot player: resolves body contact (crawl = the car yields, speed =
   *  shove/damage on the player), then the forward corridor measured from the FRONT BUMPER — brake while
   *  he's inside the stopping envelope, hold at a standstill (with clear-time hysteresis so a 20cm shift
   *  never restarts the creep), honk once held, and after pullAroundPatience swing past a clear side. */
  private avoidPlayer(vehicle: Vehicle, forward: THREE.Vector3, player: THREE.Vector3, dt: number): { blocked: boolean; hold: boolean; dodge?: THREE.Vector3 } {
    const position = vehicle.group.position;
    const dx = player.x - position.x; const dz = player.z - position.z;
    const ahead = dx * forward.x + dz * forward.z;
    const lateral = dx * forward.z - dz * forward.x; // positive = the car's right (side vector cos/-sin, as ejectDriver)
    const halfWidth = vehicle.spec.size[0] / 2; const halfLength = vehicle.spec.size[2] / 2;
    const push = overlapPush(ahead, lateral, halfLength, halfWidth, PLAYER.radius);
    const impact = Math.abs(vehicle.speed);
    if (push) { // contact: the player never occupies the car's volume
      if (carYields(push.lateral, vehicle.speed)) { // crawl-speed bumper kiss: back the CAR off, never bulldoze a standing player
        const back = position.clone(); back.x -= forward.x * push.ahead; back.z -= forward.z * push.ahead;
        position.copy(this.city.clampMove(position, back, Math.max(vehicle.spec.size[0], vehicle.spec.size[2]) * 0.34));
        vehicle.speed = 0;
      } else {
        const target = player.clone(); target.x += forward.x * push.ahead + forward.z * push.lateral; target.z += forward.z * push.ahead - forward.x * push.lateral;
        player.copy(this.city.clampMove(player, target, PLAYER.radius));
        if (impact > 0.8 && this.playerHitCooldown <= 0) {
          this.playerHitCooldown = HIT_COOLDOWN;
          const damage = vehicleHitDamage(impact);
          this.playerVehicleHits.push({ speed: impact, damage, knockdown: damage > 0 });
          if (damage > 0) { vehicle.speed *= HIT_SPEED_KEEP; this.audio.collision(impact); } // the body costs the car some momentum
        }
      }
    }
    const state = this.holdups.get(vehicle);
    if (state && state.dodge > 0) { // mid pull-around: hold the offset target until the swing completes
      state.dodge -= dt;
      if (state.dodge <= 0) { this.holdups.delete(vehicle); return { blocked: false, hold: false }; }
      return { blocked: false, hold: false, dodge: new THREE.Vector3(position.x + forward.x * DODGE_AHEAD + forward.z * state.side * DODGE_SIDE, 0, position.z + forward.z * DODGE_AHEAD - forward.x * state.side * DODGE_SIDE) };
    }
    const blocked = corridorBlocked(bumperAhead(ahead, halfLength), lateral * lateral, vehicle.speed, halfWidth);
    if (state?.holding) { // held: full stop until the corridor stays clear long enough — no creep-nudge loop
      const clearFor = holdRelease(state.clearFor, blocked, dt);
      if (clearFor === undefined) { this.holdups.delete(vehicle); return { blocked: false, hold: false }; }
      state.clearFor = clearFor;
      this.runHoldupClock(state, vehicle, forward, position, lateral, halfWidth, dt);
      return { blocked: true, hold: true };
    }
    if (!blocked) { this.holdups.delete(vehicle); return { blocked: false, hold: false }; }
    const fresh = state ?? { held: 0, honkAt: firstHonkDelay(), giveUpAt: pullAroundPatience(), dodge: 0, side: 0, holding: false, clearFor: 0 };
    this.holdups.set(vehicle, fresh);
    if (impact < HOLD_SPEED) { fresh.holding = true; this.runHoldupClock(fresh, vehicle, forward, position, lateral, halfWidth, dt); } // rolled to a stop with him still there: the patience clock arms
    return { blocked: true, hold: fresh.holding };
  }

  /** Patience of a held driver: hoot on the jittered cadence, and past giveUpAt try the pull-around. */
  private runHoldupClock(state: Holdup, vehicle: Vehicle, forward: THREE.Vector3, position: THREE.Vector3, lateral: number, halfWidth: number, dt: number): void {
    state.held += dt;
    if (state.held >= state.honkAt) {
      state.honkAt = state.held + rehonkDelay();
      this.audio.hornAt(position.x, position.z, vehicle.spec.kind === 'taxi'); this.hootCooldown = 0.6; // suppress the ambient hoot piling on
    }
    if (state.held >= state.giveUpAt) {
      const clear = (side: number): boolean => !this.city.collides(position.x + forward.x * 3 + forward.z * side * DODGE_SIDE, position.z + forward.z * 3 - forward.x * side * DODGE_SIDE, halfWidth + 0.3);
      const side = pullAroundSide(lateral, clear(1), clear(-1));
      if (side) { state.dodge = DODGE_TIME; state.side = side; }
      else state.giveUpAt = state.held + 2; // boxed in: stay put, hoot some more, try again shortly
    }
  }

  /** Keeps a small, fully interactive foot-patrol presence near the player while district pressure is high. */
  setPolicePatrolCount(count: number, focus: THREE.Vector3): void {
    const desired = Math.max(0, Math.min(2, Math.floor(count)));
    while (this.policePatrols.length > desired) {
      const officer = this.policePatrols.pop(); if (!officer) break;
      this.scene.remove(officer.group); const index = this.pedestrians.indexOf(officer); if (index >= 0) this.pedestrians.splice(index, 1);
    }
    while (this.policePatrols.length < desired) {
      const candidates = this.city.sidewalkPoints.filter((point) => {
        const distance = Math.hypot(point.x - focus.x, point.z - focus.z);
        return distance > 25 && distance < 75 && this.city.districtAt(point.x, point.z) === 'Joburg CBD';
      });
      const point = candidates[(this.policePatrols.length * 17 + 5) % candidates.length]; if (!point) break;
      const officer = new Pedestrian(this.scene, this.clearSpawn(point.x, point.z), 90 + this.policePatrols.length, false, true);
      officer.pickDestination(this.localChoice(officer.group.position.x, officer.group.position.z)); this.policePatrols.push(officer); this.pedestrians.push(officer);
    }
  }

  nearestPedestrian(position: THREE.Vector3, maxDistance = 3.2): Pedestrian | undefined {
    let nearest: Pedestrian | undefined; let best = maxDistance * maxDistance;
    for (const ped of this.pedestrians) {
      if (ped.contact || ped.state === 'down') continue;
      const distance = ped.group.position.distanceToSquared(position);
      if (distance <= best) { nearest = ped; best = distance; }
    }
    return nearest;
  }

  ejectDriver(vehicle: Vehicle, threat: THREE.Vector3, police = false): Pedestrian {
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading));
    const exit = vehicle.group.position.clone().addScaledVector(side, -2.1);
    const driver = new Pedestrian(this.scene, this.clearSpawn(exit.x, exit.z), 120 + this.pedestrians.length, false, police);
    const away = driver.group.position.clone().sub(threat); if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    driver.state = 'flee'; driver.fear = FEAR_MAX; driver.threat.copy(threat); driver.destination.copy(driver.group.position).add(away.normalize().multiplyScalar(55));
    this.pedestrians.push(driver); this.audio.scream('panic', driver.group.position.x, driver.group.position.z); this.broadcastFear(threat, FEAR_EVENTS.assault); return driver;
  }

  spawnHostiles(): void {
    if (this.hostiles.some((ped) => ped.state !== 'down')) return;
    HOSTILE_SPOTS.forEach(({ x, z }, index) => { const ped = new Pedestrian(this.scene, this.clearSpawn(x, z), index + 30, true); ped.destination.set(x, 0, z); this.pedestrians.push(ped); this.hostiles.push(ped); });
  }

  nearestEnterable(position: THREE.Vector3, maxDistance = 4.2): Vehicle | undefined {
    let nearest: Vehicle | undefined; let best = maxDistance * maxDistance;
    for (const vehicle of this.vehicles) {
      if (vehicle.playerControlled || vehicle.disabled) continue;
      const distance = vehicle.group.position.distanceToSquared(position);
      if (distance < best) { nearest = vehicle; best = distance; }
    }
    return nearest;
  }

  /** Lifecycle spawn: one ambient citizen placed on a sidewalk point the lifecycle system already vetted as hidden. */
  spawnAmbientPedestrian(x: number, z: number): Pedestrian {
    const ped = new Pedestrian(this.scene, this.clearSpawn(x, z), this.ambientSerial++);
    ped.pickDestination(this.localChoice(ped.group.position.x, ped.group.position.z)); this.pedestrians.push(ped); return ped;
  }

  /** A one-element choice list at a nearby sidewalk point, so a spawning ped's FIRST route is short and
   *  reachable rather than a citywide solve that blows the A* budget. Falls back to the full set only if the
   *  spawn spot has no sidewalk nearby. */
  private localChoice(x: number, z: number): RoadPoint[] {
    const near = this.city.wanderTarget(x, z);
    return near ? [near] : this.city.sidewalkPoints;
  }

  /** Lifecycle spawn: one AI-driven vehicle dropped on a vetted lane node and routed immediately. */
  spawnTrafficVehicle(x: number, z: number): Vehicle {
    const kinds: VehicleKind[] = ['compact', 'taxi', 'sport', 'motorbike', 'van', 'courier', 'taxi']; // the lime courier is actually working, allegedly
    const kind = kinds[this.ambientSerial % kinds.length] ?? 'compact';
    const vehicle = new Vehicle(this.scene, kind, new THREE.Vector3(x, this.city.roadHeightAt(x, z), z), kind === 'taxi' ? undefined : [0x5c88a8, 0xd28452, 0x8c9273, 0xc7c8c4][this.ambientSerial % 4]);
    this.ambientSerial++;
    vehicle.occupied = true; this.vehicles.push(vehicle); this.traffic.push(vehicle); this.assignVehicleRoute(vehicle, true);
    return vehicle;
  }

  /** Removes a ped and its bookkeeping. Hostiles keep their `hostiles` entry so spawnHostiles() won't refill a cleared crew. */
  removePedestrian(ped: Pedestrian): void {
    this.scene.remove(ped.group); ped.dispose();
    const index = this.pedestrians.indexOf(ped); if (index >= 0) this.pedestrians.splice(index, 1);
    const patrol = this.policePatrols.indexOf(ped); if (patrol >= 0) this.policePatrols.splice(patrol, 1);
  }

  /** Removes a vehicle and its route plan; fire FX (children of the group) leave the scene with it. */
  removeVehicle(vehicle: Vehicle): void {
    this.scene.remove(vehicle.group); vehicle.dispose();
    const index = this.vehicles.indexOf(vehicle); if (index >= 0) this.vehicles.splice(index, 1);
    const traffic = this.traffic.indexOf(vehicle); if (traffic >= 0) this.traffic.splice(traffic, 1);
    this.trafficPlans.delete(vehicle);
  }

  private spawnVehicles(): void {
    // Parked vehicles come from the generated-map placements: kerbside spots around the CBD spawn
    // blocks (plus a Sandton toy), already vetted against roads and each other.
    for (const spot of PARKED_VEHICLES) {
      const vehicle = new Vehicle(this.scene, spot.kind as VehicleKind, new THREE.Vector3(spot.x, 0, spot.z), spot.color);
      vehicle.heading = spot.heading; vehicle.group.rotation.y = vehicle.heading; this.vehicles.push(vehicle);
      this.parkedSpots.push([spot.x, spot.z]);
    }
    const kinds: VehicleKind[] = ['compact', 'taxi', 'cab', 'sport', 'motorbike', 'courier', 'van']; // the odd commuter and delivery bikes weave through traffic
    // Seed the opening traffic on lanes around the player spawn (the map is far bigger than the
    // AI wake radius; the lifecycle system keeps density right as the player moves).
    const nearbyRoutes = this.city.trafficRoutes.filter((route) => {
      const point = route[0];
      return point && (point.x - SPAWN_POINT.x) ** 2 + (point.z - SPAWN_POINT.z) ** 2 < 400 * 400;
    });
    const routePool = nearbyRoutes.length >= 8 ? nearbyRoutes : this.city.trafficRoutes;
    for (let i = 0; i < 15; i++) {
      const routeIndex = (i * 5 + 3) % routePool.length; const route = routePool[routeIndex]; const point = route?.[(i * 7) % Math.max(1, route.length)]; if (!point) continue;
      const kind = kinds[i % kinds.length] ?? 'compact';
      const vehicle = new Vehicle(this.scene, kind, new THREE.Vector3(point.x, this.city.roadHeightAt(point.x, point.z), point.z), kind === 'taxi' || kind === 'cab' ? undefined : [0x5c88a8, 0xd28452, 0x8c9273, 0xc7c8c4][i % 4]);
      vehicle.occupied = true; this.vehicles.push(vehicle); this.traffic.push(vehicle); this.assignVehicleRoute(vehicle, true);
    }
  }

  /** Sidewalk points can sit inside prop colliders (trees, benches, hydrants, shelters). A ped spawned
   *  embedded can never move — clampMove rejects every step — so nudge to the nearest clear pose. */
  private clearSpawn(x: number, z: number): THREE.Vector3 {
    if (!this.city.collides(x, z, 0.5)) return new THREE.Vector3(x, this.city.surfaceHeightAt(x, z), z);
    for (const radius of [1.4, 2.6, 3.8]) for (let step = 0; step < 8; step++) {
      const angle = step / 8 * Math.PI * 2 + radius;
      const nx = x + Math.cos(angle) * radius; const nz = z + Math.sin(angle) * radius;
      if (!this.city.collides(nx, nz, 0.5)) return new THREE.Vector3(nx, this.city.surfaceHeightAt(nx, nz), nz);
    }
    return new THREE.Vector3(x, this.city.surfaceHeightAt(x, z), z);
  }

  private spawnPedestrians(): void {
    // Opening crowd walks the spawn district; the lifecycle census takes over from there.
    const nearby = this.city.sidewalkPoints.filter((point) => (point.x - SPAWN_POINT.x) ** 2 + (point.z - SPAWN_POINT.z) ** 2 < 320 * 320);
    const pool = nearby.length >= 40 ? nearby : this.city.sidewalkPoints;
    for (let i = 0; i < 28; i++) {
      const point = pool[(i * 17 + 4) % pool.length]; if (!point) continue;
      const ped = new Pedestrian(this.scene, this.clearSpawn(point.x, point.z), i); ped.pickDestination(this.localChoice(point.x, point.z)); this.pedestrians.push(ped);
    }
    MISSIONS.forEach((mission, index) => {
      const contactPosition = mission.start.position.clone(); contactPosition.y = this.city.surfaceHeightAt(contactPosition.x, contactPosition.z);
      const contact = new Pedestrian(this.scene, contactPosition, index + 70);
      contact.state = 'idle'; contact.idleTime = 999999; contact.contact = true; contact.group.name = mission.contact; this.pedestrians.push(contact);
    });
    this.parkedSpots.slice(0, 4).forEach(([x, z], index) => {
      let best: { x: number; z: number } | undefined; let bestDistance = Infinity;
      for (const point of this.city.sidewalkPoints) { const distance = (point.x - x) ** 2 + (point.z - z) ** 2; if (distance < bestDistance) { bestDistance = distance; best = point; } }
      if (!best) return;
      const guard = new Pedestrian(this.scene, this.clearSpawn(best.x, best.z), index + 50);
      guard.state = 'idle'; guard.idleTime = 999999; guard.makeCarGuard(); this.pedestrians.push(guard);
    });
  }

  /** Advances the vehicle along its A* route; picks a fresh destination on arrival (budget permitting).
   *  Runs the progress watchdog: 10s without closing on the current waypoint backs the car out for a
   *  second and replans; a third strike rehomes it onto the nearest lane node. Returns false while the
   *  stall-reverse is in progress (callers skip normal driving that frame). */
  private followDrivePlan(vehicle: Vehicle, dt: number): boolean {
    const plan = this.trafficPlans.get(vehicle);
    if (!plan) { if (vehicle.routeCooldown <= 0 && !this.assignVehicleRoute(vehicle, false)) vehicle.routeCooldown = 0.8 + Math.random() * 1.2; return true; } // no plan yet: request one, but back off after an empty result instead of re-solving every frame
    if (plan.backoff > 0) {
      plan.backoff -= dt; vehicle.reverse(dt, this.city);
      if (plan.backoff <= 0) { this.trafficPlans.delete(vehicle); this.assignVehicleRoute(vehicle, false); } // replan from wherever we backed out to
      return false;
    }
    const position = vehicle.group.position;
    if (position.distanceToSquared(vehicle.aiTarget) < 85) {
      plan.watchdog.reset(); plan.index += 1;
      const point = plan.points[plan.index];
      if (point) vehicle.aiTarget.set(point.x, 0, point.z);
      else { this.trafficPlans.delete(vehicle); this.trafficRecoveries.delete(vehicle); this.assignVehicleRoute(vehicle, false); } // healthy arrival clears the strike count
      return true;
    }
    if (plan.watchdog.update(Math.hypot(vehicle.aiTarget.x - position.x, vehicle.aiTarget.z - position.z), dt)) {
      const recoveries = (this.trafficRecoveries.get(vehicle) ?? 0) + 1;
      this.trafficRecoveries.set(vehicle, recoveries); plan.watchdog.reset();
      if (recoveries >= 3) { this.trafficRecoveries.delete(vehicle); this.rehomeVehicle(vehicle); } // reversing twice didn't free it: snap back to the lane
      else plan.backoff = 1.1;
    }
    return true;
  }

  private assignVehicleRoute(vehicle: Vehicle, free: boolean): boolean {
    const position = vehicle.group.position;
    const goal = this.vehiclePlanner.goalNear(position.x, position.z); // a nearby lane node, not a citywide one: short, reachable route
    const points = free ? this.vehiclePlanner.plan(position.x, position.z, goal) : this.vehiclePlanner.tryPlan(position.x, position.z, goal);
    if (!points?.length) return false; // budget spent or destination unreachable: caller backs off before retrying
    this.trafficPlans.set(vehicle, { points, index: 0, watchdog: new ProgressWatchdog(), backoff: 0 });
    const first = points[0]; if (first) vehicle.aiTarget.set(first.x, 0, first.z);
    const next = points[1];
    if (next && Math.abs(vehicle.speed) < 1) { vehicle.heading = Math.atan2(next.x - position.x, next.z - position.z); vehicle.group.rotation.y = vehicle.heading; }
    return true;
  }

  /** Snaps a lost/stuck vehicle back onto the nearest lane node and forces a replan. */
  private rehomeVehicle(vehicle: Vehicle): void {
    const node = this.vehiclePlanner.node(this.vehiclePlanner.nearest(vehicle.group.position.x, vehicle.group.position.z));
    if (node) { vehicle.reset(new THREE.Vector3(node.x, this.city.roadHeightAt(node.x, node.z), node.z)); vehicle.aiTarget.set(node.x, 0, node.z); }
    vehicle.aiStuck = 0;
    this.trafficPlans.delete(vehicle);
  }

  private witnessBodies(dt: number): void {
    const bodies = this.pedestrians.filter((ped) => ped.state === 'down');
    if (!bodies.length) return;
    for (const ped of this.pedestrians) {
      if (ped.state === 'down' || ped.frozen) continue;
      for (const body of bodies) this.frighten(ped, fearContribution(FEAR_EVENTS.body, ped.group.position.distanceTo(body.group.position)) * dt, body.group.position);
    }
  }

  private handleVehiclePedestrianImpacts(): void {
    for (const vehicle of this.vehicles) {
      if (Math.abs(vehicle.speed) < 7) continue;
      for (const ped of this.pedestrians) {
        if (ped.state === 'down' || (this.pedestrianImpactCooldown.get(ped) ?? 0) > 0) continue;
        const distanceSq = vehicle.group.position.distanceToSquared(ped.group.position);
        if (distanceSq < 5) {
          const killed = ped.takeDamage(Math.abs(vehicle.speed) * 2.8); this.broadcastFear(ped.group.position, killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault); this.impacts.push({ position: ped.group.position.clone().add(new THREE.Vector3(0, 0.7, 0)), killed, vehicle, ped });
          this.audio.scream('pain', ped.group.position.x, ped.group.position.z);
          this.pedestrianImpactCooldown.set(ped, 1);
        } else if (distanceSq < 22 && Math.abs(vehicle.speed) > 16 && !ped.contact && !ped.hostile && !ped.police && Math.random() < 0.01) this.audio.scream('panic', ped.group.position.x, ped.group.position.z);
      }
    }
  }

  private handleTrafficSeparation(): void {
    for (let i = 0; i < this.traffic.length; i++) for (let j = i + 1; j < this.traffic.length; j++) {
      const first = this.traffic[i]; const second = this.traffic[j]; if (!first || !second || first.group.position.distanceToSquared(second.group.position) > 7.8) continue;
      first.speed *= 0.65; second.speed *= 0.65;
    }
  }
}
