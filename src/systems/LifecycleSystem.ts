import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import { activeZones, advanceZone, axisIndex, zoneCharacter, zoneKey, zoneOf, type ZoneCell } from '../world/data/zoneGrid';
import type { Zone } from '../world/data/zoning';
import { DAY_CYCLE_SECONDS } from '../world/DayNight';
import { MISSIONS } from './MissionSystem';
import type { PopulationSystem } from './PopulationSystem';

/** Player viewpoint on the xz plane: position plus camera forward. Game builds this so systems stay camera-free. */
export interface ViewPoint { x: number; z: number; dirX: number; dirZ: number; }

export const CLEANUP_HOURS = 6; // in-game hours a corpse/wreck must age before the city removes it
export const SIGHT_FAR = 500; // beyond this the player can never tell what despawns
export const SIGHT_NEAR = 40; // within this nothing is ever removed, even directly behind the camera
// Population bubble: an ambient agent this far from the viewer (always well out of sight, > SIGHT_FAR) is
// recycled even when it's still inside the 3×3 active block. Without this, a crowd left behind when the player
// moves stays alive inside the block, keeps the head-count at target, and starves fresh spawns near the player
// — a full population but a ghost town wherever you actually are. Comfortably beyond the ~825u spawn+wander
// spread so a stationary viewer's crowd is never churned; a real relocation clears the stragglers promptly.
export const REFRESH_RADIUS = 1150;
export const FOV_COS = 0.5; // cos(60°): half-angle of the ~120° forward vision cone

export const LIFECYCLE_INTERVAL = 3; // real seconds between census passes
export const CHANGE_BUDGET = 3; // max spawns+despawns per pass, so the street shifts gradually
export const SPAWN_MIN_DISTANCE = 60;
// Retuned per map scale: the original 380 was authored at 2.94 m/u, widened to 470 for the sparse
// 0.49 m/u 36000u map. At the 0.98 m/u parity scale the same unit band covers twice the real road
// it did at 36000u, so it comes back in a touch — still inside the player-relative
// AI_FREEZE_RADIUS (500) so fresh spawns don't immediately freeze. The busy dial
// (`set busy`) scales the target counts for the rest.
export const SPAWN_MAX_DISTANCE = 425;

// Temporal stagger: hard ceiling on ambient spawns PER SIDE PER census tick, regardless of how big the
// deficit is. A freshly-active zone (after a teleport or a fast cross-zone drive) can be short its whole
// target at once; without this cap the census would burst the lot in one tick and drop a mob at the
// destination. Instead the street trickles in over several ticks and fills naturally. Despawns are not
// capped this way — clearing a dead zone is invisible and should be prompt.
export const AMBIENT_SPAWN_TRICKLE = 10;
// Spatial stagger: minimum separation between agents spawned within the SAME tick, so a batch scatters
// across the streets instead of piling onto neighbouring nav nodes. Only same-tick spawns are spaced
// (no global density cap), so a zone still fills to its full target over successive ticks.
export const PED_SPAWN_SPACING = 16;
export const CAR_SPAWN_SPACING = 30;
/** Forward candidates need a building line-of-sight trace; cap those traces per census so a sparse
 *  rural view cannot turn one population tick into a citywide collider scan. Behind-camera nodes
 *  need no trace and remain available as the guaranteed fallback. */
export const SPAWN_OCCLUSION_PROBE_BUDGET = 24;
/** Keep some fresh life ahead of the player (behind buildings), without making every spawn pay for LOS. */
export const SPAWN_FORWARD_SHARE = 0.4;
/** Construct at most two pedestrians and two vehicles per simulation update. The census can plan a
 *  full trickle immediately, but spreading model construction over subsequent frames removes the
 *  periodic "ten new rigs on one frame" hitch without slowing the visible fill-in. */
export const SPAWN_DRAIN_PER_UPDATE = 2;

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

/** True when (x,z) is outside the population bubble around the viewer — a straggler the census should recycle
 *  toward the player (REFRESH_RADIUS > SIGHT_FAR, so anything this far out is always invisible to recycle). */
export function beyondBubble(view: ViewPoint, x: number, z: number): boolean {
  return (x - view.x) ** 2 + (z - view.z) ** 2 > REFRESH_RADIUS * REFRESH_RADIUS;
}

export type DayPhase = 'day' | 'shoulder' | 'night';

export function dayPhase(hour: number): DayPhase {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5 || h >= 22) return 'night';
  if (h < 8 || h >= 18) return 'shoulder';
  return 'day';
}

/**
 * Per-zone base street targets at day, busy 100 — one zone's own quota of ambient peds/cars, before
 * the time-of-day curve and the busy dial. A zone only ever holds people when it is one of the nine
 * active zones, and spawns land within the ~425u spawn ring, so these read as the density the player
 * feels around them: a highrise CBD block bustles, suburbs are moderate, the outskirts near-empty.
 * (The old global 28/15 was spread across the whole 18000u map; this is per active zone instead.)
 */
export const ZONE_DENSITY: Record<Zone, { peds: number; cars: number }> = {
  'commercial-highrise': { peds: 13, cars: 5 }, // CBD towers — packed nearby pavements without 70 animated rigs at the visual horizon
  'commercial-strip': { peds: 10, cars: 4 },    // arterial retail — busy but not a tower canyon
  'residential': { peds: 6, cars: 3 },          // the suburban bulk — a moderate, lived-in street
  'industrial': { peds: 4, cars: 3 },           // yards & sheds — few walkers, some delivery traffic
  'estate': { peds: 3, cars: 2 },               // walled villas — quiet, the odd car
  'rural': { peds: 1, cars: 1 },                // corridor farmland — nearly deserted
  'none': { peds: 0, cars: 0 },                 // parks, water, airport — no ambient life
};

/** Time-of-day multiplier on the base densities, tracking the old ped curve (day full, small hours dead). */
export const PHASE_MULTIPLIER: Record<DayPhase, number> = { day: 1, shoulder: 0.7, night: 0.3 };

export const BUSY_MIN = 10; export const BUSY_MAX = 1000; // percent bounds for the console `set busy` scale
// Ceilings on the SUMMED nine-zone target — protect perf when the 3×3 is dense (a CBD core) and/or the
// busy dial is cranked. Reached only at extreme busy in the densest neighbourhoods; the freeze layer keeps
// far agents idle so the animating count is far lower. Console `set peds/cars` pins are clamped to these too.
export const PED_TARGET_CAP = 100; export const CAR_TARGET_CAP = 50;
export const BUDGET_PASSES = 3; // each pass closes a third of the gap: a console jump fully lands within ~20 real seconds

export function clampBusy(percent: number): number { return Math.min(BUSY_MAX, Math.max(BUSY_MIN, Math.round(percent))); }

/** Console tuning: `busy` scales every active zone's target in percent; `peds`/`cars` pin the active-area total. */
export interface PopulationTuning { busy: number; peds?: number; cars?: number; }

/** One active zone's ambient target for the hour and busy dial: base density × time-of-day curve × busy%. */
export function zoneTarget(zone: Zone, hour: number, busy: number): { peds: number; cars: number } {
  const base = ZONE_DENSITY[zone];
  const scale = PHASE_MULTIPLIER[dayPhase(hour)] * clampBusy(busy) / 100;
  return { peds: base.peds * scale, cars: base.cars * scale };
}

/** Per-pass spawn/despawn allowance: the gentle floor normally, proportional when the console jumps the target. */
export function censusBudget(totalDeficit: number): number { return Math.max(CHANGE_BUDGET, Math.ceil(Math.abs(totalDeficit) / BUDGET_PASSES)); }

interface PedShape { contact: boolean; police: boolean; hostile: boolean; carGuard: boolean; state: string; fear: number; scripted?: boolean; }
interface VehicleShape { playerControlled: boolean; police: boolean; disabled: boolean; onFire: boolean; wrecked: boolean; health: number; maxHealth: number; }

/** Counts toward the ambient ped target: everyday citizens still on their feet (mission cast, feature
 *  fixtures and corpses excluded). Miss `scripted` here and a placed fixture both counts against
 *  PED_TARGET_CAP and satisfies pedDespawnable — silently deleted the moment the player looks away. */
export function isAmbientPedestrian(ped: PedShape): boolean {
  return !ped.scripted && !ped.contact && !ped.police && !ped.hostile && !ped.carGuard && ped.state !== 'down';
}

/** Safe to silently remove: any anonymous wanderer — mission cast, police, hostiles, guards and corpses
 *  excluded. Panic is deliberately NOT a gate: the recycle only ever fires on agents already out of sight or
 *  beyond the active block, so a fleeing civilian the player can't see must still make way for fresh spawns. */
export function pedDespawnable(ped: PedShape): boolean {
  return isAmbientPedestrian(ped);
}

/** Safe to silently remove: anonymous traffic that isn't the player's ride, police, or already burning/wrecked
 *  (those go through the slower wreck-cleanup). Damage is deliberately NOT a gate — potholes and fender-benders
 *  dent nearly every car, and the recycle only fires out of sight, so a dinged car far away must still be free
 *  to make room for fresh traffic near the player. */
export function vehicleDespawnable(vehicle: VehicleShape): boolean {
  return !vehicle.playerControlled && !vehicle.police && !vehicle.disabled && !vehicle.onFire && !vehicle.wrecked;
}

/** Mission cast decays in place: cleaning a downed rank enforcer would let the mission respawn the whole crew. */
export function corpseCleanable(ped: PedShape): boolean { return ped.state === 'down' && !ped.hostile && !ped.contact; }

/** Vehicles a mission looks up by paint colour must survive cleanup or the objective soft-locks. */
const MISSION_VEHICLE_COLORS = new Set(MISSIONS.flatMap((mission) => mission.objectives.map((objective) => objective.vehicleColor)).filter((color): color is number => color !== undefined));

/** Active-area census: the summed nine-zone target and each active zone's share, after busy/pins/caps. */
interface AreaCensus {
  activeKeys: Set<number>;
  pedTarget: Map<number, number>; // per active zone, fractional (for placement/trim bias)
  carTarget: Map<number, number>;
  pedTotal: number; carTotal: number; // rounded active-area totals the live counts converge to
}

/** Grid-cell key of a world point (raw cell, no hysteresis — an agent's true zone). */
function pointZone(x: number, z: number): number { return zoneKey(axisIndex(x), axisIndex(z)); }

/** Tallies how many of the given positions sit in each grid cell. */
function countByZone(positions: ReadonlyArray<{ x: number; z: number }>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const p of positions) { const key = pointZone(p.x, p.z); counts.set(key, (counts.get(key) ?? 0) + 1); }
  return counts;
}

/** Active zones still short of their own target — where fresh spawns should prefer to land. */
function deficitZones(activeKeys: Set<number>, live: Map<number, number>, target: Map<number, number>): Set<number> {
  const deficit = new Set<number>();
  for (const key of activeKeys) if ((live.get(key) ?? 0) < (target.get(key) ?? 0)) deficit.add(key);
  return deficit;
}

/** Rescales a per-zone target map so its entries sum to `total` (pin/cap), keeping each zone's relative weight. */
function rescale(target: Map<number, number>, natural: number, total: number, keys: Set<number>): void {
  if (total <= 0) { for (const key of keys) target.set(key, 0); return; }
  if (natural > 0) { const factor = total / natural; for (const [key, value] of target) target.set(key, value * factor); return; }
  const each = total / Math.max(1, keys.size); for (const key of keys) target.set(key, each); // pinned over an all-'none' area: spread evenly
}

/** Ages corpses/wrecks on the in-game clock and steers the ambient population toward its zone-local target.
 *  Only the player's zone and its eight neighbours (a 3×3 block) are ever populated; every add or removal
 *  happens where the player cannot witness it (`outOfSight`, or beyond the active set entirely). */
export class LifecycleSystem {
  /** Console-adjustable population tuning; `set busy` / `set peds` / `set cars` mutate this. */
  tuning: PopulationTuning = { busy: 100 };
  /** Quality-tier crowd multiplier (potato halves it). Scales the NATURAL targets only — console
   *  `set peds/cars` pins stay absolute so debugging numbers mean what they say. */
  densityScale = 1;
  private gameHours = 0;
  private timer = LIFECYCLE_INTERVAL;
  private downSince = new Map<Pedestrian, number>();
  private wreckedSince = new Map<Vehicle, number>();
  private currentZone: ZoneCell | undefined; // undefined until the first census; then slid with hysteresis
  private lastArea = { peds: 0, traffic: 0 }; // last active-area totals, for the console crowd readout
  private pendingPedSpawns: Array<{ x: number; z: number }> = [];
  private pendingCarSpawns: Array<{ x: number; z: number }> = [];

  constructor(private city: City, private population: PopulationSystem) {}

  /** Active-area targets from the last census — what the console `busy` readout reports as live-count goals. */
  targets(hour: number): { peds: number; traffic: number } {
    if (!this.currentZone) return { peds: this.lastArea.peds, traffic: this.lastArea.traffic };
    const census = this.censusZones(hour);
    return { peds: census.pedTotal, traffic: census.carTotal };
  }

  update(dt: number, hour: number, view: ViewPoint, protectedVehicles: ReadonlySet<Vehicle>): void {
    this.gameHours += dt * 24 / DAY_CYCLE_SECONDS; // advances at exactly the DayNight clock rate
    this.stampDeaths();
    const drained = this.drainSpawnQueues();
    this.timer -= dt; if (this.timer > 0) return; this.timer = LIFECYCLE_INTERVAL;
    this.sweep(view, protectedVehicles);
    this.converge(hour, view, protectedVehicles);
    // The census that created an empty queue still places its first citizen/car immediately; all
    // remaining construction is amortised by the ordinary per-frame drain above.
    if (drained === 0) this.drainSpawnQueues();
  }

  private drainSpawnQueues(): number {
    let drained = 0;
    for (let index = 0; index < SPAWN_DRAIN_PER_UPDATE; index++) {
      const point = this.pendingPedSpawns.shift();
      if (point) { this.population.spawnAmbientPedestrian(point.x, point.z); drained++; }
      const node = this.pendingCarSpawns.shift();
      if (node) { this.population.spawnTrafficVehicle(node.x, node.z); drained++; }
    }
    return drained;
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

  /** Builds the per-zone and summed targets for the nine active zones under the current hour + tuning. */
  private censusZones(hour: number): AreaCensus {
    const active = activeZones(this.currentZone ?? zoneOf(0, 0));
    const activeKeys = new Set<number>();
    const pedTarget = new Map<number, number>(); const carTarget = new Map<number, number>();
    let pedNatural = 0; let carNatural = 0;
    for (const cell of active) {
      const key = zoneKey(cell.col, cell.row); activeKeys.add(key);
      const target = zoneTarget(zoneCharacter(cell.col, cell.row), hour, this.tuning.busy);
      pedTarget.set(key, target.peds); carTarget.set(key, target.cars);
      pedNatural += target.peds; carNatural += target.cars;
    }
    const pedTotal = Math.min(PED_TARGET_CAP, Math.max(0, this.tuning.peds ?? Math.round(pedNatural * this.densityScale)));
    const carTotal = Math.min(CAR_TARGET_CAP, Math.max(0, this.tuning.cars ?? Math.round(carNatural * this.densityScale)));
    rescale(pedTarget, pedNatural, pedTotal, activeKeys);
    rescale(carTarget, carNatural, carTotal, activeKeys);
    return { activeKeys, pedTarget, carTarget, pedTotal, carTotal };
  }

  /** Slides the active 3×3, clears the dead ring beyond it, then converges each side of the population. */
  private converge(hour: number, view: ViewPoint, protectedVehicles: ReadonlySet<Vehicle>): void {
    this.currentZone = this.currentZone ? advanceZone(this.currentZone, view.x, view.z) : zoneOf(view.x, view.z);
    const { activeKeys, pedTarget, carTarget, pedTotal, carTotal } = this.censusZones(hour);
    this.lastArea = { peds: pedTotal, traffic: carTotal };
    this.reconcilePeds(view, activeKeys, pedTarget, pedTotal);
    this.reconcileTraffic(view, protectedVehicles, activeKeys, carTarget, carTotal);
  }

  /** Ambient pedestrians: clear the dead ring, then trim over / spawn under the active-area target. */
  private reconcilePeds(view: ViewPoint, activeKeys: Set<number>, target: Map<number, number>, total: number): void {
    this.pendingPedSpawns = this.pendingPedSpawns.filter((point) => activeKeys.has(pointZone(point.x, point.z)) && !beyondBubble(view, point.x, point.z));
    for (const ped of this.population.pedestrians.filter(isAmbientPedestrian)) // dead zones (past the 3×3) AND stragglers left behind inside it: both out of sight, both recycled toward the player
      if ((!activeKeys.has(pointZone(ped.group.position.x, ped.group.position.z)) || beyondBubble(view, ped.group.position.x, ped.group.position.z)) && pedDespawnable(ped)) this.population.removePedestrian(ped);

    const live = this.population.pedestrians.filter(isAmbientPedestrian);
    this.pendingPedSpawns.length = Math.min(this.pendingPedSpawns.length, Math.max(0, total - live.length));
    const zoneLive = countByZone(live.map((ped) => ped.group.position));
    let deficit = total - live.length - this.pendingPedSpawns.length; let budget = censusBudget(deficit);
    if (deficit < 0) {
      const surplus = (ped: Pedestrian) => (zoneLive.get(pointZone(ped.group.position.x, ped.group.position.z)) ?? 0) - (target.get(pointZone(ped.group.position.x, ped.group.position.z)) ?? 0);
      const trimmable = live.filter((ped) => pedDespawnable(ped) && outOfSight(view, ped.group.position.x, ped.group.position.z)).sort((a, b) => surplus(b) - surplus(a)); // densest-over-target zones shed first
      for (const ped of trimmable) { if (deficit >= 0 || budget <= 0) break; this.population.removePedestrian(ped); deficit++; budget--; }
    } else {
      const deficitKeys = deficitZones(activeKeys, zoneLive, target);
      const count = Math.min(deficit, AMBIENT_SPAWN_TRICKLE);
      if (this.pendingPedSpawns.length === 0)
        this.pendingPedSpawns.push(...this.hiddenPoints(this.city.sidewalkPoints, view, activeKeys, deficitKeys, count, PED_SPAWN_SPACING));
    }
  }

  /** Ambient traffic: same discipline as peds, honouring the protected/mission-vehicle guards. */
  private reconcileTraffic(view: ViewPoint, protectedVehicles: ReadonlySet<Vehicle>, activeKeys: Set<number>, target: Map<number, number>, total: number): void {
    this.pendingCarSpawns = this.pendingCarSpawns.filter((point) => activeKeys.has(pointZone(point.x, point.z)) && !beyondBubble(view, point.x, point.z));
    const drivable = (vehicle: Vehicle) => !vehicle.wrecked && !vehicle.disabled;
    for (const vehicle of this.population.traffic.filter(drivable))
      if ((!activeKeys.has(pointZone(vehicle.group.position.x, vehicle.group.position.z)) || beyondBubble(view, vehicle.group.position.x, vehicle.group.position.z)) && !protectedVehicles.has(vehicle) && !MISSION_VEHICLE_COLORS.has(vehicle.spec.color) && vehicleDespawnable(vehicle)) this.population.removeVehicle(vehicle);

    const live = this.population.traffic.filter(drivable);
    this.pendingCarSpawns.length = Math.min(this.pendingCarSpawns.length, Math.max(0, total - live.length));
    const zoneLive = countByZone(live.map((vehicle) => vehicle.group.position));
    let deficit = total - live.length - this.pendingCarSpawns.length; let budget = censusBudget(deficit);
    if (deficit < 0) {
      const surplus = (vehicle: Vehicle) => (zoneLive.get(pointZone(vehicle.group.position.x, vehicle.group.position.z)) ?? 0) - (target.get(pointZone(vehicle.group.position.x, vehicle.group.position.z)) ?? 0);
      const trimmable = live.filter((vehicle) => !protectedVehicles.has(vehicle) && !MISSION_VEHICLE_COLORS.has(vehicle.spec.color) && vehicleDespawnable(vehicle) && outOfSight(view, vehicle.group.position.x, vehicle.group.position.z)).sort((a, b) => surplus(b) - surplus(a));
      for (const vehicle of trimmable) { if (deficit >= 0 || budget <= 0) break; this.population.removeVehicle(vehicle); deficit++; budget--; }
    } else {
      const deficitKeys = deficitZones(activeKeys, zoneLive, target);
      const count = Math.min(deficit, AMBIENT_SPAWN_TRICKLE);
      if (this.pendingCarSpawns.length === 0)
        this.pendingCarSpawns.push(...this.hiddenPoints(this.city.vehicleNav.nodes, view, activeKeys, deficitKeys, count, CAR_SPAWN_SPACING));
    }
  }

  /**
   * Select a whole spawn batch in ONE randomized traversal. The old one-at-a-time helper traversed
   * the full city array again for every requested agent (up to 20 scans on one census) and repeated
   * the same building sight-line traces. That made the three-second census hitch scale with map size.
   *
   * Cheap behind-camera candidates are collected directly. In-cone candidates are sampled, then only
   * a bounded number pay for city.sightBlocked; a share of those is selected first so the world still
   * populates ahead behind corners. Deficit-zone preference and same-tick spacing remain unchanged.
   */
  private hiddenPoints(
    points: ReadonlyArray<{ x: number; z: number }>,
    view: ViewPoint,
    activeKeys: Set<number>,
    deficitKeys: Set<number>,
    limit: number,
    spacing: number,
  ): Array<{ x: number; z: number }> {
    if (!points.length || limit <= 0) return [];
    const start = Math.floor(Math.random() * points.length);
    const behindPreferred: Array<{ x: number; z: number }> = [];
    const behindFallback: Array<{ x: number; z: number }> = [];
    const forwardPreferred: Array<{ x: number; z: number }> = [];
    const forwardFallback: Array<{ x: number; z: number }> = [];
    const forwardCandidates: Array<{ point: { x: number; z: number }; preferred: boolean }> = [];
    for (let i = 0; i < points.length; i++) {
      const point = points[(start + i) % points.length]; if (!point) continue;
      const distance = Math.hypot(point.x - view.x, point.z - view.z);
      if (distance < SPAWN_MIN_DISTANCE || distance > SPAWN_MAX_DISTANCE) continue;
      const key = pointZone(point.x, point.z);
      if (!activeKeys.has(key)) continue;
      const preferred = deficitKeys.has(key);
      if (outOfSight(view, point.x, point.z)) {
        (preferred ? behindPreferred : behindFallback).push(point);
      } else if (forwardCandidates.length < SPAWN_OCCLUSION_PROBE_BUDGET) {
        forwardCandidates.push({ point, preferred });
      }
    }
    // Hidden from the player while still ahead = a building blocks the sight line. These are the
    // expensive candidates, and the bounded sample above is the hitch-prevention guarantee.
    for (const candidate of forwardCandidates) {
      if (!this.city.sightBlocked(view.x, view.z, candidate.point.x, candidate.point.z)) continue;
      (candidate.preferred ? forwardPreferred : forwardFallback).push(candidate.point);
    }

    const selected: Array<{ x: number; z: number }> = [];
    const take = (source: ReadonlyArray<{ x: number; z: number }>, ceiling: number): void => {
      for (const point of source) {
        if (selected.length >= ceiling) break;
        if (selected.some((other) => Math.hypot(point.x - other.x, point.z - other.z) < spacing)) continue;
        selected.push(point);
      }
    };
    const forwardTarget = Math.max(1, Math.ceil(limit * SPAWN_FORWARD_SHARE));
    take(forwardPreferred, forwardTarget);
    take(forwardFallback, forwardTarget);
    take(behindPreferred, limit);
    take(behindFallback, limit);
    // If the view is enclosed and there were few behind-camera nodes, use more occluded-forward ones.
    take(forwardPreferred, limit);
    take(forwardFallback, limit);
    return selected;
  }
}
