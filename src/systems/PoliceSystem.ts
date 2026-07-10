import * as THREE from 'three';
import type { AudioManager } from '../core/AudioManager';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import { replanInterval, RoutePlanner, type NavPoint } from './NavGraph';
import type { WantedSystem } from './WantedSystem';

/** Max active interceptors per wanted level: 1-2 stars field two, escalating to eight at five stars. */
export const POLICE_UNITS_BY_WANTED = [0, 2, 2, 4, 6, 8] as const;
export function maxInterceptors(level: number): number {
  return POLICE_UNITS_BY_WANTED[Math.min(POLICE_UNITS_BY_WANTED.length - 1, Math.max(0, Math.floor(level)))] ?? 0;
}

/** Within this range and with clear line of sight, units leave the nav graph and ram the player directly. */
export const PURSUIT_RANGE = 25;

interface PoliceBrain { serial: number; path: NavPoint[]; index: number; replanIn: number; chasing: boolean; }

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

  update(dt: number, playerPosition: THREE.Vector3, playerInVehicle: boolean, wanted: WantedSystem, damagePlayer: (amount: number) => void): void {
    this.planner.beginFrame();
    this.spawnCooldown -= dt; this.attackCooldown -= dt;
    const desired = maxInterceptors(wanted.level);
    const active = this.vehicles.filter((vehicle) => !vehicle.wrecked);
    while (active.length < desired && this.spawnCooldown <= 0) { this.spawnUnit(playerPosition); this.spawnCooldown = 4; const spawned = this.vehicles[this.vehicles.length - 1]; if (spawned) active.push(spawned); }
    for (const vehicle of active) {
      const brain = this.brainOf(vehicle);
      if (wanted.isWanted) this.pursue(vehicle, brain, dt, playerPosition, playerInVehicle, wanted, damagePlayer);
      else this.patrol(vehicle, brain, dt);
    }
    const nearest = active.reduce<Vehicle | undefined>((best, vehicle) => !best || vehicle.group.position.distanceToSquared(playerPosition) < best.group.position.distanceToSquared(playerPosition) ? vehicle : best, undefined);
    this.audio.setSiren(Boolean(wanted.isWanted && nearest), nearest?.group.position.x, nearest?.group.position.z);
    if (this.vehicles.length > 0) this.despawnFar(playerPosition, wanted.isWanted);
  }

  reset(): void { for (const vehicle of this.vehicles) this.scene.remove(vehicle.group); for (const officer of this.officers) this.scene.remove(officer.group); this.vehicles = []; this.officers = []; }

  /** Chase: replan an A* route to the player every 1.5-2s (staggered per unit), ram directly once close with line of sight. */
  private pursue(vehicle: Vehicle, brain: PoliceBrain, dt: number, playerPosition: THREE.Vector3, playerInVehicle: boolean, wanted: WantedSystem, damagePlayer: (amount: number) => void): void {
    const distance = vehicle.group.position.distanceTo(playerPosition);
    if (distance < 70) wanted.reportSeen();
    const aggression = 0.82 + wanted.level * 0.035;
    if (distance < PURSUIT_RANGE && this.hasLineOfSight(vehicle.group.position, playerPosition)) {
      brain.chasing = true; brain.path = []; brain.index = 0; brain.replanIn = 0;
      vehicle.updateAI(dt, this.city, playerPosition, aggression);
    } else {
      brain.replanIn -= dt;
      if (brain.replanIn <= 0 || !brain.chasing || brain.index >= brain.path.length || vehicle.aiStuck > 5) {
        const path = this.planner.tryPlan(vehicle.group.position.x, vehicle.group.position.z, this.planner.nearest(playerPosition.x, playerPosition.z));
        if (path) { brain.path = path; brain.index = 0; brain.chasing = true; brain.replanIn = replanInterval(brain.serial); vehicle.aiStuck = 0; }
      }
      this.followPath(vehicle, brain, dt, aggression);
    }
    if (distance < 5 && Math.abs(vehicle.speed) > 8 && this.attackCooldown <= 0) { damagePlayer(Math.min(24, Math.abs(vehicle.speed) * 0.8)); this.attackCooldown = 1.2; }
    if (!playerInVehicle && distance < 20 && this.attackCooldown <= 0) { damagePlayer(4 + wanted.level * 1.5); this.attackCooldown = 1.1; }
  }

  /** No heat: cruise the lane graph toward random destinations, replanning on arrival. */
  private patrol(vehicle: Vehicle, brain: PoliceBrain, dt: number): void {
    if (brain.chasing) { brain.chasing = false; brain.path = []; brain.index = 0; }
    if (brain.index >= brain.path.length) {
      const path = this.planner.tryPlan(vehicle.group.position.x, vehicle.group.position.z);
      if (path) { brain.path = path; brain.index = 0; }
    }
    this.followPath(vehicle, brain, dt, 0.4);
  }

  private followPath(vehicle: Vehicle, brain: PoliceBrain, dt: number, aggression: number): void {
    const point = brain.path[brain.index];
    if (!point) { vehicle.speed *= Math.exp(-dt); return; } // waiting on the planner budget
    vehicle.aiTarget.set(point.x, 0, point.z);
    if (vehicle.group.position.distanceToSquared(vehicle.aiTarget) < 85) {
      brain.index += 1;
      const next = brain.path[brain.index];
      if (next) vehicle.aiTarget.set(next.x, 0, next.z);
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
    if (!brain) { brain = { serial: this.serials++, path: [], index: 0, replanIn: 0, chasing: false }; this.brains.set(vehicle, brain); }
    return brain;
  }

  private spawnUnit(player: THREE.Vector3): void {
    const pose = this.city.roadPoseAwayFrom(player, 105, 165);
    const vehicle = new Vehicle(this.scene, 'police', pose.position); vehicle.occupied = true; vehicle.heading = pose.heading; vehicle.group.rotation.y = pose.heading; this.vehicles.push(vehicle);
  }

  private despawnFar(player: THREE.Vector3, wreckedOnly: boolean): void {
    const index = this.vehicles.findIndex((vehicle) => (!wreckedOnly || vehicle.wrecked) && vehicle.group.position.distanceTo(player) > 130);
    if (index >= 0) { const [vehicle] = this.vehicles.splice(index, 1); if (vehicle) this.scene.remove(vehicle.group); }
  }
}
