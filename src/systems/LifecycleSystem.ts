import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import { DAY_CYCLE_SECONDS } from '../world/DayNight';
import { CALM_THRESHOLD } from './FearSystem';
import { MISSIONS } from './MissionSystem';
import type { PopulationSystem } from './PopulationSystem';

/** Player viewpoint on the xz plane: position plus camera forward. Game builds this so systems stay camera-free. */
export interface ViewPoint { x: number; z: number; dirX: number; dirZ: number; }

export const CLEANUP_HOURS = 6; // in-game hours a corpse/wreck must age before the city removes it
export const SIGHT_FAR = 500; // beyond this the player can never tell what despawns
export const SIGHT_NEAR = 40; // within this nothing is ever removed, even directly behind the camera
export const FOV_COS = 0.5; // cos(60°): half-angle of the ~120° forward vision cone

export const LIFECYCLE_INTERVAL = 3; // real seconds between census passes
export const CHANGE_BUDGET = 3; // max spawns+despawns per pass, so the street shifts gradually
export const SPAWN_MIN_DISTANCE = 60; export const SPAWN_MAX_DISTANCE = 380;

/** True when (x,z) is invisible to the viewer: past SIGHT_FAR, or outside the forward cone and past SIGHT_NEAR. */
export function outOfSight(view: ViewPoint, x: number, z: number): boolean {
  const dx = x - view.x; const dz = z - view.z; const distance = Math.hypot(dx, dz);
  if (distance > SIGHT_FAR) return true;
  if (distance <= SIGHT_NEAR) return false;
  const length = Math.hypot(view.dirX, view.dirZ) || 1;
  return (dx * view.dirX + dz * view.dirZ) / (distance * length) < FOV_COS;
}

/** A body or wreck may be cleaned only once it is BOTH old enough and unobserved. */
export function cleanupEligible(deadHours: number, view: ViewPoint, x: number, z: number): boolean {
  return deadHours >= CLEANUP_HOURS && outOfSight(view, x, z);
}

export type DayPhase = 'day' | 'shoulder' | 'night';

export function dayPhase(hour: number): DayPhase {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5 || h >= 22) return 'night';
  if (h < 8 || h >= 18) return 'shoulder';
  return 'day';
}

/** Ambient street targets per phase, tuned around the hand-authored counts (28 peds / 15 traffic at the 10:00 start). */
export const POPULATION_TARGETS: Record<DayPhase, { peds: number; traffic: number }> = {
  day: { peds: 28, traffic: 15 },
  shoulder: { peds: 20, traffic: 11 },
  night: { peds: 8, traffic: 6 },
};

export function targetPopulation(hour: number): { peds: number; traffic: number } { return POPULATION_TARGETS[dayPhase(hour)]; }

export const BUSY_MIN = 10; export const BUSY_MAX = 1000; // percent bounds for the console `set busy` scale
export const PED_TARGET_CAP = 200; export const CAR_TARGET_CAP = 120; // absolute ceilings, whatever the console asks for
export const BUDGET_PASSES = 3; // each pass closes a third of the gap: a console jump fully lands within ~20 real seconds

export function clampBusy(percent: number): number { return Math.min(BUSY_MAX, Math.max(BUSY_MIN, Math.round(percent))); }

/** Console tuning: `busy` scales the time-of-day table in percent; absolute `peds`/`cars` pins win until cleared. */
export interface PopulationTuning { busy: number; peds?: number; cars?: number; }

export function resolveTargets(hour: number, tuning: PopulationTuning): { peds: number; traffic: number } {
  const base = targetPopulation(hour); const scale = clampBusy(tuning.busy) / 100;
  const peds = tuning.peds ?? base.peds * scale;
  const traffic = tuning.cars ?? base.traffic * scale;
  return { peds: Math.min(PED_TARGET_CAP, Math.max(0, Math.round(peds))), traffic: Math.min(CAR_TARGET_CAP, Math.max(0, Math.round(traffic))) };
}

/** Per-pass spawn/despawn allowance: the gentle floor normally, proportional when the console jumps the target. */
export function censusBudget(totalDeficit: number): number { return Math.max(CHANGE_BUDGET, Math.ceil(Math.abs(totalDeficit) / BUDGET_PASSES)); }

interface PedShape { contact: boolean; police: boolean; hostile: boolean; carGuard: boolean; state: string; fear: number; }
interface VehicleShape { playerControlled: boolean; police: boolean; disabled: boolean; onFire: boolean; wrecked: boolean; health: number; maxHealth: number; }

/** Counts toward the ambient ped target: everyday citizens still on their feet (mission cast and corpses excluded). */
export function isAmbientPedestrian(ped: PedShape): boolean {
  return !ped.contact && !ped.police && !ped.hostile && !ped.carGuard && ped.state !== 'down';
}

/** Safe to silently remove: a calm, uninvolved wanderer — never mission cast, police, or anyone reacting to the player. */
export function pedDespawnable(ped: PedShape): boolean {
  return isAmbientPedestrian(ped) && (ped.state === 'walk' || ped.state === 'idle') && ped.fear < CALM_THRESHOLD;
}

/** Safe to silently remove: healthy anonymous traffic — never the player's ride, police, or anything damaged/burning. */
export function vehicleDespawnable(vehicle: VehicleShape): boolean {
  return !vehicle.playerControlled && !vehicle.police && !vehicle.disabled && !vehicle.onFire && !vehicle.wrecked && vehicle.health >= vehicle.maxHealth;
}

/** Mission cast decays in place: cleaning a downed rank enforcer would let the mission respawn the whole crew. */
export function corpseCleanable(ped: PedShape): boolean { return ped.state === 'down' && !ped.hostile && !ped.contact; }

/** Vehicles a mission looks up by paint colour must survive cleanup or the objective soft-locks. */
const MISSION_VEHICLE_COLORS = new Set(MISSIONS.flatMap((mission) => mission.objectives.map((objective) => objective.vehicleColor)).filter((color): color is number => color !== undefined));

/** Ages corpses/wrecks on the in-game clock and steers the ambient population toward the time-of-day target.
 *  All additions and removals happen only where `outOfSight` says the player cannot witness them. */
export class LifecycleSystem {
  /** Console-adjustable population tuning; `set busy` / `set peds` / `set cars` mutate this. */
  tuning: PopulationTuning = { busy: 100 };
  private gameHours = 0;
  private timer = LIFECYCLE_INTERVAL;
  private downSince = new Map<Pedestrian, number>();
  private wreckedSince = new Map<Vehicle, number>();

  constructor(private city: City, private population: PopulationSystem) {}

  targets(hour: number): { peds: number; traffic: number } { return resolveTargets(hour, this.tuning); }

  update(dt: number, hour: number, view: ViewPoint, protectedVehicles: ReadonlySet<Vehicle>): void {
    this.gameHours += dt * 24 / DAY_CYCLE_SECONDS; // advances at exactly the DayNight clock rate
    this.stampDeaths();
    this.timer -= dt; if (this.timer > 0) return; this.timer = LIFECYCLE_INTERVAL;
    this.sweep(view, protectedVehicles);
    this.converge(hour, view, protectedVehicles);
  }

  /** Records the game-hour a ped went down or a vehicle wrecked; a Pay-'n'-Spray restore clears the stamp. */
  private stampDeaths(): void {
    for (const ped of this.population.pedestrians) if (ped.state === 'down' && !this.downSince.has(ped)) this.downSince.set(ped, this.gameHours);
    for (const vehicle of this.population.vehicles) {
      if (vehicle.wrecked) { if (!this.wreckedSince.has(vehicle)) this.wreckedSince.set(vehicle, this.gameHours); }
      else this.wreckedSince.delete(vehicle);
    }
  }

  private sweep(view: ViewPoint, protectedVehicles: ReadonlySet<Vehicle>): void {
    for (const [ped, since] of this.downSince) {
      if (!this.population.pedestrians.includes(ped)) { this.downSince.delete(ped); continue; } // removed elsewhere
      if (!corpseCleanable(ped)) continue;
      if (cleanupEligible(this.gameHours - since, view, ped.group.position.x, ped.group.position.z)) { this.population.removePedestrian(ped); this.downSince.delete(ped); }
    }
    for (const [vehicle, since] of this.wreckedSince) {
      if (!this.population.vehicles.includes(vehicle)) { this.wreckedSince.delete(vehicle); continue; }
      if (protectedVehicles.has(vehicle) || MISSION_VEHICLE_COLORS.has(vehicle.spec.color)) continue;
      if (cleanupEligible(this.gameHours - since, view, vehicle.group.position.x, vehicle.group.position.z)) { this.population.removeVehicle(vehicle); this.wreckedSince.delete(vehicle); }
    }
  }

  /** Compares live ambient counts to the (console-tuned) time-of-day target and spawns/despawns per pass. */
  private converge(hour: number, view: ViewPoint, protectedVehicles: ReadonlySet<Vehicle>): void {
    const target = resolveTargets(hour, this.tuning);
    const peds = this.population.pedestrians.filter(isAmbientPedestrian);
    const traffic = this.population.traffic.filter((vehicle) => !vehicle.wrecked && !vehicle.disabled);
    let pedDeficit = target.peds - peds.length;
    let flowDeficit = target.traffic - traffic.length;
    let pedBudget = censusBudget(pedDeficit); let carBudget = censusBudget(flowDeficit);
    if (pedDeficit < 0) {
      for (const ped of peds) {
        if (pedDeficit >= 0 || pedBudget <= 0) break;
        if (!pedDespawnable(ped) || !outOfSight(view, ped.group.position.x, ped.group.position.z)) continue;
        this.population.removePedestrian(ped); pedDeficit++; pedBudget--;
      }
    } else for (; pedDeficit > 0 && pedBudget > 0; pedDeficit--, pedBudget--) {
      const point = this.hiddenPoint(this.city.sidewalkPoints, view); if (!point) break;
      this.population.spawnAmbientPedestrian(point.x, point.z);
    }
    if (flowDeficit < 0) {
      for (const vehicle of traffic) {
        if (flowDeficit >= 0 || carBudget <= 0) break;
        if (protectedVehicles.has(vehicle) || !vehicleDespawnable(vehicle) || !outOfSight(view, vehicle.group.position.x, vehicle.group.position.z)) continue;
        this.population.removeVehicle(vehicle); flowDeficit++; carBudget--;
      }
    } else for (; flowDeficit > 0 && carBudget > 0; flowDeficit--, carBudget--) {
      const node = this.hiddenPoint(this.city.vehicleNav.nodes, view); if (!node) break;
      this.population.spawnTrafficVehicle(node.x, node.z);
    }
  }

  /** Scans graph nodes from a random offset for the first one hidden from the player within spawn range. */
  private hiddenPoint(points: ReadonlyArray<{ x: number; z: number }>, view: ViewPoint): { x: number; z: number } | undefined {
    if (!points.length) return undefined;
    const start = Math.floor(Math.random() * points.length);
    for (let i = 0; i < points.length; i++) {
      const point = points[(start + i) % points.length]; if (!point) continue;
      const distance = Math.hypot(point.x - view.x, point.z - view.z);
      if (distance >= SPAWN_MIN_DISTANCE && distance <= SPAWN_MAX_DISTANCE && outOfSight(view, point.x, point.z)) return point;
    }
    return undefined;
  }
}
