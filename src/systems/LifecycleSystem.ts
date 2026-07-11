import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import { activeZones, advanceZone, axisIndex, zoneCharacter, zoneKey, zoneOf, type ZoneCell } from '../world/data/zoneGrid';
import type { Zone } from '../world/data/zoning';
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
export const AMBIENT_SPAWN_TRICKLE = 6;
// Spatial stagger: minimum separation between agents spawned within the SAME tick, so a batch scatters
// across the streets instead of piling onto neighbouring nav nodes. Only same-tick spawns are spaced
// (no global density cap), so a zone still fills to its full target over successive ticks.
export const PED_SPAWN_SPACING = 16;
export const CAR_SPAWN_SPACING = 30;

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

/**
 * Per-zone base street targets at day, busy 100 — one zone's own quota of ambient peds/cars, before
 * the time-of-day curve and the busy dial. A zone only ever holds people when it is one of the nine
 * active zones, and spawns land within the ~425u spawn ring, so these read as the density the player
 * feels around them: a highrise CBD block bustles, suburbs are moderate, the outskirts near-empty.
 * (The old global 28/15 was spread across the whole 18000u map; this is per active zone instead.)
 */
export const ZONE_DENSITY: Record<Zone, { peds: number; cars: number }> = {
  'commercial-highrise': { peds: 22, cars: 9 }, // CBD / Sandton towers — packed pavements and traffic
  'commercial-strip': { peds: 15, cars: 7 },    // arterial retail — busy but not a tower canyon
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
export const PED_TARGET_CAP = 180; export const CAR_TARGET_CAP = 100;
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
  private gameHours = 0;
  private timer = LIFECYCLE_INTERVAL;
  private downSince = new Map<Pedestrian, number>();
  private wreckedSince = new Map<Vehicle, number>();
  private currentZone: ZoneCell | undefined; // undefined until the first census; then slid with hysteresis
  private lastArea = { peds: 0, traffic: 0 }; // last active-area totals, for the console crowd readout

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
    const pedTotal = Math.min(PED_TARGET_CAP, Math.max(0, this.tuning.peds ?? Math.round(pedNatural)));
    const carTotal = Math.min(CAR_TARGET_CAP, Math.max(0, this.tuning.cars ?? Math.round(carNatural)));
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
    for (const ped of this.population.pedestrians.filter(isAmbientPedestrian)) // dead zones sit ≥1 zone (1800u) past the 3×3, always out of sight
      if (!activeKeys.has(pointZone(ped.group.position.x, ped.group.position.z)) && pedDespawnable(ped)) this.population.removePedestrian(ped);

    const live = this.population.pedestrians.filter(isAmbientPedestrian);
    const zoneLive = countByZone(live.map((ped) => ped.group.position));
    let deficit = total - live.length; let budget = censusBudget(deficit);
    if (deficit < 0) {
      const surplus = (ped: Pedestrian) => (zoneLive.get(pointZone(ped.group.position.x, ped.group.position.z)) ?? 0) - (target.get(pointZone(ped.group.position.x, ped.group.position.z)) ?? 0);
      const trimmable = live.filter((ped) => pedDespawnable(ped) && outOfSight(view, ped.group.position.x, ped.group.position.z)).sort((a, b) => surplus(b) - surplus(a)); // densest-over-target zones shed first
      for (const ped of trimmable) { if (deficit >= 0 || budget <= 0) break; this.population.removePedestrian(ped); deficit++; budget--; }
    } else {
      const deficitKeys = deficitZones(activeKeys, zoneLive, target);
      const batch: Array<{ x: number; z: number }> = []; // this tick's spawns, kept apart from one another
      for (let placed = 0; deficit > 0 && placed < AMBIENT_SPAWN_TRICKLE; deficit--, placed++) {
        const point = this.hiddenPoint(this.city.sidewalkPoints, view, activeKeys, deficitKeys, batch, PED_SPAWN_SPACING); if (!point) break;
        this.population.spawnAmbientPedestrian(point.x, point.z); batch.push(point);
      }
    }
  }

  /** Ambient traffic: same discipline as peds, honouring the protected/mission-vehicle guards. */
  private reconcileTraffic(view: ViewPoint, protectedVehicles: ReadonlySet<Vehicle>, activeKeys: Set<number>, target: Map<number, number>, total: number): void {
    const drivable = (vehicle: Vehicle) => !vehicle.wrecked && !vehicle.disabled;
    for (const vehicle of this.population.traffic.filter(drivable))
      if (!activeKeys.has(pointZone(vehicle.group.position.x, vehicle.group.position.z)) && !protectedVehicles.has(vehicle) && vehicleDespawnable(vehicle)) this.population.removeVehicle(vehicle);

    const live = this.population.traffic.filter(drivable);
    const zoneLive = countByZone(live.map((vehicle) => vehicle.group.position));
    let deficit = total - live.length; let budget = censusBudget(deficit);
    if (deficit < 0) {
      const surplus = (vehicle: Vehicle) => (zoneLive.get(pointZone(vehicle.group.position.x, vehicle.group.position.z)) ?? 0) - (target.get(pointZone(vehicle.group.position.x, vehicle.group.position.z)) ?? 0);
      const trimmable = live.filter((vehicle) => !protectedVehicles.has(vehicle) && vehicleDespawnable(vehicle) && outOfSight(view, vehicle.group.position.x, vehicle.group.position.z)).sort((a, b) => surplus(b) - surplus(a));
      for (const vehicle of trimmable) { if (deficit >= 0 || budget <= 0) break; this.population.removeVehicle(vehicle); deficit++; budget--; }
    } else {
      const deficitKeys = deficitZones(activeKeys, zoneLive, target);
      const batch: Array<{ x: number; z: number }> = [];
      for (let placed = 0; deficit > 0 && placed < AMBIENT_SPAWN_TRICKLE; deficit--, placed++) {
        const node = this.hiddenPoint(this.city.vehicleNav.nodes, view, activeKeys, deficitKeys, batch, CAR_SPAWN_SPACING); if (!node) break;
        this.population.spawnTrafficVehicle(node.x, node.z); batch.push(node);
      }
    }
  }

  /** Scans nav nodes from a random offset for one hidden and in spawn range within an active zone,
   *  preferring a zone still short of its own target so density pools in the busy zones near the player.
   *  Rejects any node within `spacing` of a node already picked this tick (`batch`) so a fresh fill
   *  scatters over the streets instead of mobbing one spot. */
  private hiddenPoint(points: ReadonlyArray<{ x: number; z: number }>, view: ViewPoint, activeKeys: Set<number>, deficitKeys: Set<number>, batch: ReadonlyArray<{ x: number; z: number }>, spacing: number): { x: number; z: number } | undefined {
    if (!points.length) return undefined;
    const start = Math.floor(Math.random() * points.length);
    const crowded = (point: { x: number; z: number }) => batch.some((other) => Math.hypot(point.x - other.x, point.z - other.z) < spacing);
    let fallback: { x: number; z: number } | undefined;
    for (let i = 0; i < points.length; i++) {
      const point = points[(start + i) % points.length]; if (!point) continue;
      const distance = Math.hypot(point.x - view.x, point.z - view.z);
      if (distance < SPAWN_MIN_DISTANCE || distance > SPAWN_MAX_DISTANCE || !outOfSight(view, point.x, point.z)) continue;
      const key = pointZone(point.x, point.z);
      if (!activeKeys.has(key) || crowded(point)) continue;
      if (deficitKeys.has(key)) return point; // ideal: a zone that still wants people, well clear of the batch
      fallback ??= point; // else keep the first in-range active node so the area total can still be met
    }
    return fallback;
  }
}
