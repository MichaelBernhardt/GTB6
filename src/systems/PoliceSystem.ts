import * as THREE from 'three';
import type { AudioManager } from '../core/AudioManager';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import { ProgressWatchdog, replanInterval, RoutePlanner, type NavPoint } from './NavGraph';
import { ARRIVE_DWELL, ARRIVE_RADIUS, pickRoamGoal, ROAM_RADIUS, SIGHT_RADIUS, type KnownPosition, type PoliceKnowledge } from './PoliceKnowledge';
import type { WantedSystem } from './WantedSystem';

/** Max active interceptors per wanted level: 1-2 stars field two, escalating to eight at five stars. */
export const POLICE_UNITS_BY_WANTED = [0, 2, 2, 4, 6, 8] as const;
export function maxInterceptors(level: number, reinforcementModifier = 0): number {
  const base = POLICE_UNITS_BY_WANTED[Math.min(POLICE_UNITS_BY_WANTED.length - 1, Math.max(0, Math.floor(level)))] ?? 0;
  return base === 0 ? 0 : Math.min(10, base + Math.max(0, Math.floor(reinforcementModifier)));
}

/** Within this range and with clear line of sight, units leave the nav graph and ram the player directly. */
export const PURSUIT_RANGE = 25;

interface PoliceBrain { serial: number; path: NavPoint[]; index: number; replanIn: number; chasing: boolean; roaming: boolean; dwell: number; knownTime: number; watchdog: ProgressWatchdog; backoff: number; }

export class PoliceSystem {
  vehicles: Vehicle[] = [];
  officers: Pedestrian[] = [];
  private spawnCooldown = 0;
  private attackCooldown = 0;
  private serials = 0;
  private brains = new WeakMap<Vehicle, PoliceBrain>();
  private planner: RoutePlanner;

  constructor(private scene: THREE.Scene, private city: City, private audio: AudioManager) {
    this.planner = new RoutePlanner(city.vehicleNav, 2);
  }

  update(dt: number, playerPosition: THREE.Vector3, playerInVehicle: boolean, wanted: WantedSystem, knowledge: PoliceKnowledge<unknown>, damagePlayer: (amount: number) => void, reinforcementModifier = 0): void {
    this.planner.beginFrame();
    this.spawnCooldown -= dt; this.attackCooldown -= dt;
    const desired = maxInterceptors(wanted.level, reinforcementModifier);
    const active = this.vehicles.filter((vehicle) => !vehicle.wrecked);
    const known = knowledge.lastKnown;
    const dispatchAt = known ? new THREE.Vector3(known.x, 0, known.z) : playerPosition;
    while (active.length < desired && this.spawnCooldown <= 0) { this.spawnUnit(dispatchAt); this.spawnCooldown = 4; const spawned = this.vehicles[this.vehicles.length - 1]; if (spawned) active.push(spawned); }
    const sighted = wanted.isWanted && active.some((vehicle) => vehicle.group.position.distanceTo(playerPosition) < SIGHT_RADIUS && this.hasLineOfSight(vehicle.group.position, playerPosition));
    if (sighted) { knowledge.sight(playerPosition.x, playerPosition.z); wanted.reportSeen(); }
    const target = wanted.isWanted ? knowledge.lastKnown : null;
    for (const vehicle of active) {
      const brain = this.brainOf(vehicle);
      if (target) this.pursue(vehicle, brain, dt, target, sighted, playerPosition, playerInVehicle, wanted, damagePlayer);
      else this.patrol(vehicle, brain, dt);
    }
    const nearest = active.reduce<Vehicle | undefined>((best, vehicle) => !best || vehicle.group.position.distanceToSquared(playerPosition) < best.group.position.distanceToSquared(playerPosition) ? vehicle : best, undefined);
    this.audio.setSiren(Boolean(wanted.isWanted && nearest), nearest?.group.position.x, nearest?.group.position.z);
    if (this.vehicles.length > 0) this.despawnFar(playerPosition, wanted.isWanted);
  }

  reset(): void { for (const vehicle of this.vehicles) this.scene.remove(vehicle.group); for (const officer of this.officers) this.scene.remove(officer.group); this.vehicles = []; this.officers = []; }

  /** Chase: replan an A* route to the LAST KNOWN position every 1.5-2s (staggered per unit) — never to the
   *  live player. Ram directly only while an active sighting exists; arriving at a cold scene turns to roam. */
  private pursue(vehicle: Vehicle, brain: PoliceBrain, dt: number, known: KnownPosition, sighted: boolean, playerPosition: THREE.Vector3, playerInVehicle: boolean, wanted: WantedSystem, damagePlayer: (amount: number) => void): void {
    if (brain.knownTime !== known.time) { brain.knownTime = known.time; brain.roaming = false; brain.dwell = 0; }
    const distance = vehicle.group.position.distanceTo(playerPosition);
    const aggression = 0.82 + wanted.level * 0.035;
    if (sighted && distance < PURSUIT_RANGE && this.hasLineOfSight(vehicle.group.position, playerPosition)) {
      brain.chasing = true; brain.path = []; brain.index = 0; brain.replanIn = 0; brain.watchdog.reset(); // live target: the ram is its own progress
      vehicle.updateAI(dt, this.city, playerPosition, aggression);
    } else if (brain.roaming) {
      this.roam(vehicle, brain, dt, known);
    } else {
      if (Math.hypot(vehicle.group.position.x - known.x, vehicle.group.position.z - known.z) < ARRIVE_RADIUS) {
        brain.dwell += dt;
        if (brain.dwell >= ARRIVE_DWELL) { brain.roaming = true; brain.chasing = false; brain.path = []; brain.index = 0; return; }
      }
      brain.replanIn -= dt;
      if (brain.replanIn <= 0 || !brain.chasing || brain.index >= brain.path.length || vehicle.aiStuck > 5) {
        // Roads as far as they go, then offroad to the scene itself — otherwise an off-road lastKnown (park, parcel) never trips ARRIVE_RADIUS and units sit at the curb.
        const path = this.planner.tryPlanTo(vehicle.group.position.x, vehicle.group.position.z, known.x, known.z);
        if (path) { brain.path = path; brain.index = 0; brain.chasing = true; brain.replanIn = replanInterval(brain.serial); vehicle.aiStuck = 0; }
      }
      this.followPath(vehicle, brain, dt, aggression);
    }
    if (distance < 5 && Math.abs(vehicle.speed) > 8 && this.attackCooldown <= 0) { damagePlayer(Math.min(24, Math.abs(vehicle.speed) * 0.8)); this.attackCooldown = 1.2; }
    // Close-range fire needs THIS unit to have line of sight — `sighted` is fleet-wide, so without the extra
    // check a unit on the far side of a building could shoot through the wall and taking cover would be useless.
    if (sighted && !playerInVehicle && distance < 20 && this.attackCooldown <= 0 && this.hasLineOfSight(vehicle.group.position, playerPosition)) { damagePlayer(4 + wanted.level * 1.5); this.attackCooldown = 1.1; }
  }

  /** Trail ran cold: cruise random nav nodes near the last known position until decay or fresh intel. */
  private roam(vehicle: Vehicle, brain: PoliceBrain, dt: number, known: KnownPosition): void {
    if (brain.index >= brain.path.length) {
      const goal = pickRoamGoal(this.planner.nodes, known, ROAM_RADIUS);
      const path = goal >= 0 ? this.planner.tryPlan(vehicle.group.position.x, vehicle.group.position.z, goal) : undefined;
      if (path) { brain.path = path; brain.index = 0; }
    }
    this.followPath(vehicle, brain, dt, 0.55);
  }

  /** No heat: cruise the lane graph toward random destinations, replanning on arrival. */
  private patrol(vehicle: Vehicle, brain: PoliceBrain, dt: number): void {
    if (brain.chasing || brain.roaming) { brain.chasing = false; brain.roaming = false; brain.dwell = 0; brain.knownTime = -1; brain.path = []; brain.index = 0; }
    if (brain.index >= brain.path.length) {
      const path = this.planner.tryPlan(vehicle.group.position.x, vehicle.group.position.z);
      if (path) { brain.path = path; brain.index = 0; }
    }
    this.followPath(vehicle, brain, dt, 0.4);
  }

  /** Drives the current path with the progress watchdog: 10s without closing on the waypoint backs the
   *  unit out for a second and clears the path, so pursue/roam/patrol all replan instead of grinding a wall. */
  private followPath(vehicle: Vehicle, brain: PoliceBrain, dt: number, aggression: number): void {
    if (brain.backoff > 0) {
      brain.backoff -= dt; vehicle.reverse(dt, this.city);
      if (brain.backoff <= 0) { brain.path = []; brain.index = 0; brain.chasing = false; brain.replanIn = 0; }
      return;
    }
    const point = brain.path[brain.index];
    if (!point) { vehicle.speed *= Math.exp(-dt); brain.watchdog.reset(); return; } // waiting on the planner budget
    vehicle.aiTarget.set(point.x, 0, point.z);
    if (vehicle.group.position.distanceToSquared(vehicle.aiTarget) < 85) {
      brain.index += 1; brain.watchdog.reset();
      const next = brain.path[brain.index];
      if (next) vehicle.aiTarget.set(next.x, 0, next.z);
    } else if (brain.watchdog.update(Math.hypot(point.x - vehicle.group.position.x, point.z - vehicle.group.position.z), dt)) {
      brain.watchdog.reset(); brain.backoff = 1.1; return;
    }
    vehicle.updateAI(dt, this.city, undefined, aggression);
  }

  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(distance / 4));
    for (let step = 1; step < steps; step++) { const t = step / steps; if (this.city.collides(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, 0.4)) return false; }
    return true;
  }

  private brainOf(vehicle: Vehicle): PoliceBrain {
    let brain = this.brains.get(vehicle);
    if (!brain) { brain = { serial: this.serials++, path: [], index: 0, replanIn: 0, chasing: false, roaming: false, dwell: 0, knownTime: -1, watchdog: new ProgressWatchdog(), backoff: 0 }; this.brains.set(vehicle, brain); }
    return brain;
  }

  /** Units are dispatched around the last known position (the report's crime scene), not the player. */
  private spawnUnit(dispatchAt: THREE.Vector3): void {
    const pose = this.city.roadPoseAwayFrom(dispatchAt, 105, 165);
    const vehicle = new Vehicle(this.scene, 'police', pose.position); vehicle.occupied = true; vehicle.heading = pose.heading; vehicle.group.rotation.y = pose.heading; this.vehicles.push(vehicle);
  }

  private despawnFar(player: THREE.Vector3, wreckedOnly: boolean): void {
    const index = this.vehicles.findIndex((vehicle) => (!wreckedOnly || vehicle.wrecked) && vehicle.group.position.distanceTo(player) > 130);
    if (index >= 0) { const [vehicle] = this.vehicles.splice(index, 1); if (vehicle) this.scene.remove(vehicle.group); }
  }
}
