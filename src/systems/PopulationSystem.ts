import * as THREE from 'three';
import { AI_FREEZE_RADIUS_VEHICLE, AI_THAW_RADIUS_VEHICLE, PLAYER, resolveFrozen, TRAFFIC_SPEED_FACTOR, WORLD_SIZE, type VehicleKind } from '../config';
import type { AudioManager } from '../core/AudioManager';
import {
  AMBIENT_NPC_CHARACTER_IDS,
  CAR_GUARD_NPC_ID,
  DRIVER_NPC_ID,
  JMPD_PATROL_NPC_ID,
  MISSION_CONTACT_NPC_IDS,
  NPC_CATALOG,
  RANK_ENFORCER_NPC_ID,
  type NpcCharacterId,
} from '../entities/NpcCatalog';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import { BUMP_COOLDOWN, BUMP_FEAR, BUMP_RADIUS, bumpEscalates, recordBump, separationPush } from './BumpSystem';
import { FEAR_EVENTS, fearContribution, FEAR_MAX, seesBrandish, type FearEvent } from './FearSystem';
import { MELEE_DAMAGE, MELEE_GLOBAL_STAGGER, MELEE_HEIGHT_REACH, MELEE_START_RANGE, meleeHitLands } from './MeleeSystem';
import { MISSIONS } from './MissionSystem';
import { ProgressWatchdog, RoutePlanner, type NavPoint } from './NavGraph';
import { AVOID_RANGE, bumperAhead, carYields, corridorBlocked, DODGE_AHEAD, DODGE_SIDE, DODGE_THROTTLE, DODGE_TIME, firstHonkDelay, HIT_COOLDOWN, HIT_SPEED_KEEP, HOLD_SPEED, holdRelease, overlapPush, pullAroundPatience, pullAroundSide, rehonkDelay, vehicleHitDamage } from './TrafficAvoidance';
import type { City, RoadPoint } from '../world/City';
import { HOSTILE_SPOTS, PARKED_VEHICLES, SPAWN_POINT } from '../world/placements';
import { powerOn } from '../world/powerGrid';

interface DrivePlan { points: NavPoint[]; index: number; watchdog: ProgressWatchdog; backoff: number; }
interface TaxiState { stopTimer: number; dwell: number; hootTimer: number; }
interface Holdup { held: number; honkAt: number; giveUpAt: number; dodge: number; side: number; holding: boolean; clearFor: number; } // one blocked-by-the-player driver's patience
export interface PlayerBump { ped: Pedestrian; position: THREE.Vector3; knockdown: boolean; killed: boolean; assault: boolean; }
export interface PlayerVehicleHit { speed: number; damage: number; knockdown: boolean; dirX: number; dirZ: number; } // dir = the car's travel direction (the way the body gets thrown)

/** Freeze/thaw distance checks run for each agent once per this many frames, staggered by agent index. */
const FREEZE_CHECK_FRAMES = 10;

/** Car-following corridor half-width²: the leader must sit within this of the driver's forward ray. Now that
 *  lanes are one-way, oncoming traffic rides a separate lane outside this corridor, so we brake for anything
 *  ahead in it — no head-on-crawl exemption needed. */
const FOLLOW_CORRIDOR_SQ = 6.25; // 2.5u to each side
/** Speed-scaled car-following ("time headway"): the clear bumper gap held at a standstill, plus a slow zone
 *  that GROWS with speed so a fast car lifts off far sooner. A driver doing v u/s eases across
 *  FOLLOW_SLOW_ZONE_MIN + v·FOLLOW_HEADWAY units, and watches that far ahead (plus a margin) for a leader —
 *  the old fixed 14u look-ahead couldn't shed cruise speed before rear-ending a car stopped at a light. */
const FOLLOW_STOP_GAP = 2.4;
const FOLLOW_HEADWAY = 1.15; // seconds of gap per unit of speed
const FOLLOW_SLOW_ZONE_MIN = 6; // floor so even a crawl still eases smoothly instead of snapping on/off
const FOLLOW_RANGE_MARGIN = 4; // look this much past the ease distance, so the leader is in view before easing must start
/** Cars ease for pedestrians in their path too, not just cars ahead. A NARROWER corridor than the vehicle one
 *  so a driver brakes for someone actually crossing in front, not everyone strolling the pavement; the
 *  pedestrian's body radius folds into the gap so the car holds off a person's front, not their centre. */
const FOLLOW_PED_CORRIDOR_SQ = 2.25; // ~1.5u to each side of the car's path
const FOLLOW_PED_RADIUS = 0.5;

/** NPC-vs-NPC contact resolution. Below NPC_CRASH_MIN_SPEED (relative) a touch just bleeds speed and separates;
 *  above it deals a much gentler knock than a player/police hit (NPC_CRASH_DAMAGE per unit over the threshold)
 *  so ordinary fender-benders don't turn the street into a row of husks. */
const NPC_CRASH_MIN_SPEED = 6;
const NPC_CRASH_DAMAGE = 0.12;
const NPC_CRASH_COOLDOWN = 0.9; // one damage tick per pair per this long
const TRAFFIC_MAX_PUSH = 0.3; // per-frame positional separation cap, so a nudge never shoves a car through a wall
/** After any collision (car, wall, or pedestrian) a driver waits this long before it may reroute again — one
 *  fresh path out of the jam, not an A* storm. */
const COLLISION_REPLAN_COOLDOWN = 2.5;

export class PopulationSystem {
  pedestrians: Pedestrian[] = [];
  vehicles: Vehicle[] = [];
  traffic: Vehicle[] = [];
  hostiles: Pedestrian[] = [];
  private hostileWaveSize = 0; // how many the current defeat wave spawned — the roster's ground truth
  private hostileAttackCooldown = 0;
  private impacts: Array<{ position: THREE.Vector3; killed: boolean; vehicle: Vehicle; ped: Pedestrian }> = [];
  private pedestrianImpactCooldown = new WeakMap<Pedestrian, number>();
  private trafficPlans = new WeakMap<Vehicle, DrivePlan>();
  private trafficRecoveries = new WeakMap<Vehicle, number>();
  private vehicleCrashCooldown = new WeakMap<Vehicle, number>(); // gates NPC-NPC collision damage per vehicle
  private replanCooldown = new WeakMap<Vehicle, number>(); // gates post-collision reroutes so one prang isn't an A* storm
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
  private npcVariantCursor = 0;
  private frame = 0;
  private forward = new THREE.Vector3();
  private playerPos = new THREE.Vector3(SPAWN_POINT.x, 0, SPAWN_POINT.z); // last known player position; biases new traffic goals player-ward

  constructor(private scene: THREE.Scene, private city: City, private audio: AudioManager) {
    this.vehiclePlanner = new RoutePlanner(city.vehicleNav, 2);
    this.pedPlanner = new RoutePlanner(city.pedNav, 2);
    this.spawnVehicles(); this.spawnPedestrians();
  }

  update(dt: number, player: THREE.Vector3, damagePlayer?: (amount: number) => void, playerOnFoot = false): void {
    this.playerPos.copy(player);
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
      this.replanCooldown.set(vehicle, Math.max(0, (this.replanCooldown.get(vehicle) ?? 0) - dt));
      if ((this.frame + index * 3 + 1) % FREEZE_CHECK_FRAMES === 0) {
        const wasFrozen = vehicle.frozen;
        vehicle.frozen = resolveFrozen(vehicle.frozen, vehicle.group.position.distanceToSquared(player), AI_FREEZE_RADIUS_VEHICLE, AI_THAW_RADIUS_VEHICLE);
        if (vehicle.frozen !== wasFrozen) this.trafficPlans.get(vehicle)?.watchdog.reset();
        if (vehicle.frozen && !wasFrozen) vehicle.speed = 0; // park in place: a stale speed would fire impact checks and jerk on thaw
      }
      if (vehicle.frozen) return;
      // Obey robots (powered only): a car approaching a signalised junction on a red/amber axis eases off and
      // holds. Graded (1 = cruise, 0 = stop at the box) so it brakes SOONER across the whole approach ring.
      const taxiKind = vehicle.spec.kind === 'taxi';
      const signalScale = robotsOut || taxiKind ? 1 : this.city.signalSlowFactor(vehicle.group.position, vehicle.heading);
      if (signalScale < 1) this.trafficPlans.get(vehicle)?.watchdog.reset(); // a legal easing/red-light wait (up to ~16s) is not a stall
      if (!this.followDrivePlan(vehicle, dt)) return; // reversing out of a watchdog stall this frame
      const forward = this.forward.set(Math.sin(vehicle.heading), 0, Math.cos(vehicle.heading));
      // Nearest leader in my lane corridor: keep the bumper-to-bumper gap and ease speed down as it closes.
      // The ease distance (and how far ahead we look) scales with speed, so a fast car starts braking well
      // before a car stopped at a light instead of arriving hot and rear-ending it.
      const speedNow = Math.max(0, vehicle.speed);
      const slowZone = FOLLOW_SLOW_ZONE_MIN + speedNow * FOLLOW_HEADWAY;
      const scanRange = FOLLOW_STOP_GAP + slowZone + FOLLOW_RANGE_MARGIN;
      let leadGap = Infinity;
      for (const other of this.vehicles) {
        if (other === vehicle) continue;
        const dx = other.group.position.x - vehicle.group.position.x; const dz = other.group.position.z - vehicle.group.position.z;
        const ahead = dx * forward.x + dz * forward.z;
        if (ahead <= 0 || ahead >= scanRange || dx * dx + dz * dz - ahead * ahead >= FOLLOW_CORRIDOR_SQ) continue;
        leadGap = Math.min(leadGap, ahead - (vehicle.spec.size[2] + other.spec.size[2]) / 2);
      }
      // Also brake for a pedestrian crossing/standing in the car's path (skip corpses and far frozen peds). The
      // narrower corridor keeps this to people actually in front, and folds into the same gap-follow easing.
      for (const ped of this.pedestrians) {
        if (ped.state === 'down' || ped.frozen) continue;
        const dx = ped.group.position.x - vehicle.group.position.x; const dz = ped.group.position.z - vehicle.group.position.z;
        const ahead = dx * forward.x + dz * forward.z;
        if (ahead <= 0 || ahead >= scanRange || dx * dx + dz * dz - ahead * ahead >= FOLLOW_PED_CORRIDOR_SQ) continue;
        leadGap = Math.min(leadGap, ahead - vehicle.spec.size[2] / 2 - FOLLOW_PED_RADIUS);
      }
      const followScale = leadGap === Infinity ? 1 : THREE.MathUtils.clamp((leadGap - FOLLOW_STOP_GAP) / slowZone, 0, 1); // 1 = clear road, 0 = hold at the stop gap
      const blocked = followScale < 0.5; // still "blocked" for the taxi/honk bookkeeping when closing in on a leader
      let playerBlocked = false; let playerHold = false; let dodge: THREE.Vector3 | undefined;
      if (playerOnFoot && !vehicle.police && vehicle.group.position.distanceToSquared(player) < AVOID_RANGE * AVOID_RANGE) ({ blocked: playerBlocked, hold: playerHold, dodge } = this.avoidPlayer(vehicle, forward, player, dt));
      else this.holdups.delete(vehicle);
      const taxi = taxiKind;
      const junctionPanic = robotsOut && !taxi && this.city.signalNearby(vehicle.group.position);
      const speedScale = Math.min(followScale, signalScale); // whichever wants us slower: the leader ahead or the robot
      const throttle = playerHold ? 0 // held: a full stop with hysteresis, no 0.05 creep — this is what arms the honk clock
        : dodge ? DODGE_THROTTLE
        : taxi ? this.taxiThrottle(vehicle, dt, player, blocked || playerBlocked) * followScale // taxis still ease off a leader (and skip robots)
        : playerBlocked ? 0.05
        : junctionPanic ? TRAFFIC_SPEED_FACTOR * 0.75 * speedScale // dead robot (load shedding): a cautious ~75%-speed roll-through, not a crawl
        : TRAFFIC_SPEED_FACTOR * speedScale; // normal cruise, eased down for a leader ahead or a robot
      vehicle.updateAI(dt, this.city, dodge, throttle);
      if (vehicle.collided) { vehicle.collided = false; this.requestCollisionReplan(vehicle); } // hit a wall/prop: reroute out of the jam
      const outsideWorld = Math.abs(vehicle.group.position.x) > WORLD_SIZE / 2 || Math.abs(vehicle.group.position.z) > WORLD_SIZE / 2;
      if (outsideWorld || vehicle.aiStuck > 9) this.rehomeVehicle(vehicle);
    });
    this.handleVehiclePedestrianImpacts();
    this.handleTrafficSeparation(dt);
    this.updateTrafficEngineAudio(player);
    this.resolveMelee(player, damagePlayer, playerOnFoot);
  }

  /** Hostile melee. Swings START here (readable one-at-a-time cadence via the global stagger)
   *  and RESOLVE here: damage lands only on the swing's hit frame, and only if the player is
   *  still in reach and in front of the attacker — backing off mid-windup escapes clean, and
   *  there is never damage without the matching punch animation. Arrest officers reuse the
   *  'hostile' ped state to hustle to the cruiser, so police are excluded: the bust flow stays
   *  proximity-only. Everything gates on the player being on foot — nobody punches a car door. */
  private resolveMelee(player: THREE.Vector3, damagePlayer: ((amount: number) => void) | undefined, playerOnFoot: boolean): void {
    if (!damagePlayer) return;
    for (const ped of this.pedestrians) {
      if (ped.police || ped.frozen) continue;
      const dx = player.x - ped.group.position.x; const dz = player.z - ped.group.position.z;
      const heightGap = player.y - ped.group.position.y;
      if (ped.consumeMeleeHit()) {
        const distance = Math.hypot(dx, dz);
        const facingDot = distance > 1e-4 ? (Math.sin(ped.group.rotation.y) * dx + Math.cos(ped.group.rotation.y) * dz) / distance : 1;
        if (playerOnFoot && meleeHitLands(distance, heightGap, facingDot)) { damagePlayer(MELEE_DAMAGE); this.audio.melee(); }
        else this.audio.whiff();
      }
      // Swings need the target in fist reach VERTICALLY too: a player on a roof directly above
      // gets glowered at from below, never swung at (and per the hit gate, never damaged).
      if (playerOnFoot && this.hostileAttackCooldown <= 0 && ped.state === 'hostile' && ped.meleeReady
        && Math.abs(heightGap) <= MELEE_HEIGHT_REACH
        && dx * dx + dz * dz < MELEE_START_RANGE * MELEE_START_RANGE && ped.punch()) {
        this.hostileAttackCooldown = MELEE_GLOBAL_STAGGER;
      }
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
      if (killed || sprinting) this.audio.scream('pain', ped.group.position.x, ped.group.position.z, ped.voiceSex, ped, killed);
      else this.audio.grunt(ped.group.position.x, ped.group.position.z, ped.voiceSex, ped);
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
    if (panicked && Math.random() < 0.4) this.audio.scream('panic', ped.group.position.x, ped.group.position.z, ped.voiceSex, ped);
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
          this.playerVehicleHits.push({ speed: impact, damage, knockdown: damage > 0, dirX: forward.x * Math.sign(vehicle.speed || 1), dirZ: forward.z * Math.sign(vehicle.speed || 1) });
          this.audio.playerImpact(); // voiced at emission (even a zero-damage shove earns an "oof"); the damage funnel's own trigger dedupes via the shared speaker token
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
      this.scene.remove(officer.group); officer.dispose(); const index = this.pedestrians.indexOf(officer); if (index >= 0) this.pedestrians.splice(index, 1);
    }
    while (this.policePatrols.length < desired) {
      const candidates = this.city.sidewalkPoints.filter((point) => {
        const distance = Math.hypot(point.x - focus.x, point.z - focus.z);
        return distance > 25 && distance < 75 && this.city.districtAt(point.x, point.z) === 'Joburg CBD';
      });
      const point = candidates[(this.policePatrols.length * 17 + 5) % candidates.length]; if (!point) break;
      const officer = new Pedestrian(this.scene, this.clearSpawn(point.x, point.z), 90 + this.policePatrols.length, false, true, this.nextSpecialNpcVariant(JMPD_PATROL_NPC_ID));
      officer.pickDestination(this.localChoice(officer.group.position.x, officer.group.position.z)); this.policePatrols.push(officer); this.pedestrians.push(officer);
    }
  }

  /** Nearest mug/melee target. Height-gated like NPC melee: a ped below a rooftop/ledge is out
   *  of fist reach — the player can't punch (or get a mug prompt) through a floor either. */
  nearestPedestrian(position: THREE.Vector3, maxDistance = 3.2): Pedestrian | undefined {
    let nearest: Pedestrian | undefined; let best = maxDistance * maxDistance;
    for (const ped of this.pedestrians) {
      if (ped.contact || ped.state === 'down' || Math.abs(ped.group.position.y - position.y) > MELEE_HEIGHT_REACH) continue;
      const distance = ped.group.position.distanceToSquared(position);
      if (distance <= best) { nearest = ped; best = distance; }
    }
    return nearest;
  }

  ejectDriver(vehicle: Vehicle, threat: THREE.Vector3, police = false): Pedestrian {
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading));
    const exit = vehicle.group.position.clone().addScaledVector(side, -2.1);
    const driver = new Pedestrian(this.scene, this.clearSpawn(exit.x, exit.z), 120 + this.pedestrians.length, false, police, this.nextSpecialNpcVariant(police ? JMPD_PATROL_NPC_ID : DRIVER_NPC_ID));
    const away = driver.group.position.clone().sub(threat); if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    driver.state = 'flee'; driver.fear = FEAR_MAX; driver.threat.copy(threat); driver.destination.copy(driver.group.position).add(away.normalize().multiplyScalar(55));
    this.pedestrians.push(driver); this.audio.scream('panic', driver.group.position.x, driver.group.position.z, driver.voiceSex, driver); this.broadcastFear(threat, FEAR_EVENTS.assault); return driver;
  }

  spawnHostiles(): void {
    if (this.hostiles.some((ped) => ped.state !== 'down')) return;
    this.spawnHostileWave(HOSTILE_SPOTS);
  }

  /** Mission credit: how many of the current hostile crew are down — killed OR knocked out, by ANY
   *  path (bullet, melee, vehicle, explosion, ragdoll slam). Authoritative, so defeat objectives can't
   *  miss a kill just because a death flow doesn't route through a per-site counter. */
  /** Mission credit, DERIVED FROM ROSTER TRUTH: defeated = what the wave spawned minus who is still
   *  standing (down OR despawned both count). Recomputed every sim step, so every kill path — bullet,
   *  melee, VEHICLE, explosion, fire, ragdoll, anything invented later — is automatically correct, and
   *  the "red dots all gone but 0/N" contradiction is structurally impossible (a downed hostile loses
   *  its red dot AND is counted defeated by the same state). */
  defeatedHostiles(): number {
    const standing = this.hostiles.filter((ped) => ped.state !== 'down' && this.pedestrians.includes(ped)).length;
    return Math.max(0, this.hostileWaveSize - standing);
  }

  /** Story missions: replace the current hostile crew with a fresh wave at the given spots. */
  spawnHostileWave(spots: ReadonlyArray<{ x: number; z: number }>): void {
    for (const ped of this.hostiles) this.removePedestrian(ped);
    this.hostiles.length = 0;
    this.hostileWaveSize = spots.length; // roster truth for this objective's defeat count
    spots.forEach(({ x, z }, index) => { const ped = new Pedestrian(this.scene, this.clearSpawn(x, z), index + 30, true, false, this.nextSpecialNpcVariant(RANK_ENFORCER_NPC_ID)); ped.destination.set(x, 0, z); this.pedestrians.push(ped); this.hostiles.push(ped); });
  }

  /** Story: a hi-vis security guard standing a post (Kelvin Yard); the mission director sweeps his torch. */
  spawnYardGuard(x: number, z: number): Pedestrian {
    const guard = new Pedestrian(this.scene, this.clearSpawn(x, z), this.ambientSerial++ + 90, false, false, this.nextSpecialNpcVariant(CAR_GUARD_NPC_ID));
    guard.state = 'idle'; guard.idleTime = 999999; guard.makeCarGuard(); guard.group.name = 'Yard Security';
    this.pedestrians.push(guard);
    return guard;
  }

  /** Story missions: a scripted vehicle parked at a kerb, driven only once routed somewhere. */
  spawnScriptVehicle(kind: VehicleKind, x: number, z: number, heading: number, color?: number): Vehicle {
    const vehicle = new Vehicle(this.scene, kind, new THREE.Vector3(x, this.city.surfaceHeightAt(x, z), z), color);
    vehicle.heading = heading; vehicle.group.rotation.y = heading;
    this.vehicles.push(vehicle);
    return vehicle;
  }

  /** Put a scripted vehicle on the road toward a specific destination (nearest lane node to it). */
  routeVehicleTo(vehicle: Vehicle, x: number, z: number): boolean {
    // A scripted quarry may cross the whole city (Vusi's block to Kelvin Yard): the per-frame
    // expansion cap declared such routes unreachable, so this one-off solve gets the citywide cap.
    const points = this.vehiclePlanner.planFar(vehicle.group.position.x, vehicle.group.position.z, x, z);
    if (!points?.length) return false;
    vehicle.occupied = true;
    if (!this.traffic.includes(vehicle)) this.traffic.push(vehicle);
    this.trafficPlans.set(vehicle, { points, index: 0, watchdog: new ProgressWatchdog(), backoff: 0 });
    const first = points[0]; if (first) vehicle.aiTarget.set(first.x, 0, first.z);
    return true;
  }

  /** A scripted vehicle reached its mark: pull it off the road so ambient routing never claims it. */
  parkScriptVehicle(vehicle: Vehicle): void {
    const index = this.traffic.indexOf(vehicle); if (index >= 0) this.traffic.splice(index, 1);
    this.trafficPlans.delete(vehicle);
    vehicle.occupied = false; vehicle.speed = 0;
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
    const ped = new Pedestrian(this.scene, this.clearSpawn(x, z), this.ambientSerial++, false, false, this.nextAmbientNpcVariant());
    ped.pickDestination(this.localChoice(ped.group.position.x, ped.group.position.z)); this.pedestrians.push(ped); return ped;
  }

  /** Live rigged count across ambient and role-specific pedestrians. */
  riggedPedestrianCount(): number { return this.pedestrians.filter((ped) => ped.visualVariant !== undefined).length; }

  ambientRiggedPedestrianCount(): number {
    // Story contacts may reuse ambient bodies (Solly, Sindi, Sipho): the contact flag keeps them out of the crowd census.
    return this.pedestrians.filter((ped) => ped.visualVariant !== undefined && !ped.contact && NPC_CATALOG[ped.visualVariant].role === 'ambient').length;
  }

  private nextAmbientNpcVariant(): NpcCharacterId {
    const variant = AMBIENT_NPC_CHARACTER_IDS[this.npcVariantCursor % AMBIENT_NPC_CHARACTER_IDS.length];
    this.npcVariantCursor += 1; return variant!;
  }

  private nextSpecialNpcVariant(variant: NpcCharacterId): NpcCharacterId { return variant; }

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
      // Parked cars never run the driving update that grounds moving traffic — spawn at the surface,
      // not y=0 (terrain relief raised the CBD ~18u and buried the whole kerbside fleet).
      const vehicle = new Vehicle(this.scene, spot.kind as VehicleKind, new THREE.Vector3(spot.x, this.city.surfaceHeightAt(spot.x, spot.z), spot.z), spot.color);
      vehicle.heading = spot.heading; vehicle.group.rotation.y = vehicle.heading; this.vehicles.push(vehicle);
      this.parkedSpots.push([spot.x, spot.z]);
    }
    const kinds: VehicleKind[] = ['compact', 'taxi', 'taxi', 'sport', 'motorbike', 'courier', 'van']; // the uniform Quantum fleet fills both former taxi slots
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
      const vehicle = new Vehicle(this.scene, kind, new THREE.Vector3(point.x, this.city.roadHeightAt(point.x, point.z), point.z), kind === 'taxi' ? undefined : [0x5c88a8, 0xd28452, 0x8c9273, 0xc7c8c4][i % 4]);
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
      const ped = new Pedestrian(this.scene, this.clearSpawn(point.x, point.z), i, false, false, this.nextAmbientNpcVariant()); ped.pickDestination(this.localChoice(point.x, point.z)); this.pedestrians.push(ped);
    }
    const seenContacts = new Set<string>(); // one body per contact, at their first-listed mission's spot
    MISSIONS.forEach((mission, index) => {
      if (seenContacts.has(mission.contact)) return; seenContacts.add(mission.contact);
      const variant = MISSION_CONTACT_NPC_IDS[mission.id]; if (!variant) return;
      const contactPosition = mission.start.position.clone(); contactPosition.y = this.city.surfaceHeightAt(contactPosition.x, contactPosition.z);
      const contact = new Pedestrian(this.scene, contactPosition, index + 70, false, false, this.nextSpecialNpcVariant(variant));
      contact.state = 'idle'; contact.idleTime = 999999; contact.contact = true; contact.group.name = mission.contact; this.pedestrians.push(contact);
    });
    this.parkedSpots.slice(0, 4).forEach(([x, z], index) => {
      let best: { x: number; z: number } | undefined; let bestDistance = Infinity;
      for (const point of this.city.sidewalkPoints) { const distance = (point.x - x) ** 2 + (point.z - z) ** 2; if (distance < bestDistance) { bestDistance = distance; best = point; } }
      if (!best) return;
      const guard = new Pedestrian(this.scene, this.clearSpawn(best.x, best.z), index + 50, false, false, this.nextSpecialNpcVariant(CAR_GUARD_NPC_ID));
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
    // Horizontal-only arrival: the vehicle's y tracks terrain height while the waypoint's y is 0, so a 3D
    // distance never converges on sloped ground (the car orbits the point until the watchdog rehomes it).
    const toTargetX = vehicle.aiTarget.x - position.x; const toTargetZ = vehicle.aiTarget.z - position.z;
    if (toTargetX * toTargetX + toTargetZ * toTargetZ < 85) {
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
    const goal = this.vehiclePlanner.goalNear(position.x, position.z, this.playerPos); // nearby lane node, biased player-ward so traffic trends toward the visible streets
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
        if ((this.pedestrianImpactCooldown.get(ped) ?? 0) > 0) continue;
        if (ped.state === 'down') {
          // Overkill: rolling over a settled corpse re-kicks its ragdoll — no damage, heat, or replan.
          if (ped.health === 0 && vehicle.group.position.distanceToSquared(ped.group.position) < 5) {
            ped.corpseHit(vehicle.group.position, Math.abs(vehicle.speed) * 2.8);
            this.pedestrianImpactCooldown.set(ped, 1);
          }
          continue;
        }
        const distanceSq = vehicle.group.position.distanceToSquared(ped.group.position);
        if (distanceSq < 5) {
          // Unified with the sprint-bump path: a survivable car hit floors the ped into the knockdown
          // ragdoll (direction-correct, speed-scaled kick) instead of an instant standing flee; a fatal
          // one flows into the same down-dead state knockdownOutcome reports.
          const killed = ped.knockdown(vehicle.group.position, Math.abs(vehicle.speed) * 2.8); this.broadcastFear(ped.group.position, killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault); this.impacts.push({ position: ped.group.position.clone().add(new THREE.Vector3(0, 0.7, 0)), killed, vehicle, ped });
          this.audio.scream('pain', ped.group.position.x, ped.group.position.z, ped.voiceSex, ped, killed);
          this.pedestrianImpactCooldown.set(ped, 1);
          if (!vehicle.playerControlled) this.requestCollisionReplan(vehicle); // NPC that just hit someone: try a fresh way through
        } else if (distanceSq < 22 && Math.abs(vehicle.speed) > 16 && !ped.contact && !ped.hostile && !ped.police && Math.random() < 0.01) this.audio.scream('panic', ped.group.position.x, ped.group.position.z, ped.voiceSex, ped);
      }
    }
  }

  private handleTrafficSeparation(dt: number): void {
    for (const vehicle of this.traffic) this.vehicleCrashCooldown.set(vehicle, Math.max(0, (this.vehicleCrashCooldown.get(vehicle) ?? 0) - dt));
    for (let i = 0; i < this.traffic.length; i++) for (let j = i + 1; j < this.traffic.length; j++) {
      const first = this.traffic[i]; const second = this.traffic[j]; if (!first || !second) continue;
      const dx = second.group.position.x - first.group.position.x; const dz = second.group.position.z - first.group.position.z;
      const distSq = dx * dx + dz * dz;
      // Length-aware contact radius: a quarter of both lengths + widths ≈ a bounding circle per car, so a taxi or
      // van excludes at a bigger radius than a compact, without a bare half-length falsely catching adjacent lanes.
      const reach = (first.spec.size[2] + second.spec.size[2] + first.spec.size[0] + second.spec.size[0]) / 4;
      if (distSq > reach * reach) continue;
      const dist = Math.sqrt(distSq) || 1e-4;
      const impact = Math.abs(first.speed - second.speed); // relative closing speed: a same-speed convoy reads ~0
      first.speed *= 0.65; second.speed *= 0.65; // bleed speed (unchanged from the old soft separation)
      const nx = dx / dist; const nz = dz / dist; const push = Math.min(reach - dist, TRAFFIC_MAX_PUSH) / 2; // shove apart so they don't sit pinned in a heap
      first.group.position.x -= nx * push; first.group.position.z -= nz * push;
      second.group.position.x += nx * push; second.group.position.z += nz * push;
      if (impact > NPC_CRASH_MIN_SPEED && (this.vehicleCrashCooldown.get(first) ?? 0) <= 0 && (this.vehicleCrashCooldown.get(second) ?? 0) <= 0) {
        const damage = (impact - NPC_CRASH_MIN_SPEED) * NPC_CRASH_DAMAGE; // gentler than player/police hits (0.25-0.35): no road of husks
        first.takeDamage(damage); second.takeDamage(damage);
        this.vehicleCrashCooldown.set(first, NPC_CRASH_COOLDOWN); this.vehicleCrashCooldown.set(second, NPC_CRASH_COOLDOWN);
        if (impact > 9 && this.playerPos.distanceToSquared(first.group.position) < 55 * 55) this.audio.collision(impact); // only a real prang near the player is worth a sound
        this.requestCollisionReplan(first); this.requestCollisionReplan(second); // a prang is a jam: reroute both out of it
      }
    }
  }

  /** After a collision, reroute a driver to the SAME destination from where it now sits, so it works its way
   *  out of the jam instead of grinding on the old path. Rate-limited per vehicle so one prang isn't an A* storm. */
  private requestCollisionReplan(vehicle: Vehicle): void {
    if (vehicle.playerControlled || vehicle.disabled || (this.replanCooldown.get(vehicle) ?? 0) > 0) return;
    this.replanCooldown.set(vehicle, COLLISION_REPLAN_COOLDOWN);
    const plan = this.trafficPlans.get(vehicle);
    const dest = plan?.points[plan.points.length - 1];
    if (!dest) { this.assignVehicleRoute(vehicle, false); return; } // no known destination yet: just take a fresh goal
    const pos = vehicle.group.position;
    const points = this.vehiclePlanner.tryPlanTo(pos.x, pos.z, dest.x, dest.z);
    if (!points?.length) return; // A* budget spent this frame: the watchdog stays the backstop
    this.trafficPlans.set(vehicle, { points, index: 0, watchdog: new ProgressWatchdog(), backoff: 0 });
    const first = points[0]; if (first) vehicle.aiTarget.set(first.x, 0, first.z);
  }
}
