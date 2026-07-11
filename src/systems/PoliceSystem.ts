import * as THREE from 'three';
import type { AudioManager } from '../core/AudioManager';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import { replanInterval, RoutePlanner, type NavPoint } from './NavGraph';
import { ARRIVE_DWELL, ARRIVE_RADIUS, pickRoamGoal, ROAM_RADIUS, SIGHT_RADIUS, type KnownPosition, type PoliceKnowledge } from './PoliceKnowledge';
import type { WantedSystem } from './WantedSystem';

/** Max active interceptors per wanted level: 1-2 stars field two, escalating to eight at five stars. */
export const POLICE_UNITS_BY_WANTED = [0, 2, 2, 4, 6, 8] as const;
export function maxInterceptors(level: number, reinforcementModifier = 0): number {
  const base = POLICE_UNITS_BY_WANTED[Math.min(POLICE_UNITS_BY_WANTED.length - 1, Math.max(0, Math.floor(level)))] ?? 0;
  return base === 0 ? 0 : Math.min(10, base + Math.max(0, Math.floor(reinforcementModifier)));
}

/** Within this range and with an active sighting, units leave the nav graph and engage directly. */
export const PURSUIT_RANGE = 25;
/** On-foot suspects get a standoff, not a bumper: units aim to stop about this far out (8-12u band). */
export const STANDOFF_RANGE = 10;
/** Rolled to a stop (below ARREST_STOP_SPEED) inside this ring, the crew bails out to make the arrest. */
export const ARREST_DEPLOY_RANGE = 14;
export const ARREST_STOP_SPEED = 3;
/** Suspect legging it this far from the arrest car sends one officer chasing on foot. */
export const FOOT_CHASE_RANGE = 16;
/** Beyond this the cover officer mounts back up and the car resumes the vehicle pursuit. */
export const REBOARD_RANGE = 46;
/** Below two stars JMPD only follows and shouts; live fire starts at two. */
export const SHOOT_MIN_WANTED = 2;

export type UnitMode = 'drive' | 'standoff' | 'arrest';
export interface UnitSituation { sighted: boolean; playerInVehicle: boolean; distance: number; speed: number; crewOut: boolean; }

/** Arrest state machine. drive = nav/direct pursuit; standoff = braking approach on an on-foot suspect;
 *  arrest = stopped, crew deploys. A deployed crew pins the car on scene until it reboards or dies —
 *  those transitions are event-driven (reboard/abandon), never inferred here. */
export function nextUnitMode(mode: UnitMode, s: UnitSituation): UnitMode {
  if (s.crewOut) return 'arrest';
  if (s.playerInVehicle || !s.sighted || s.distance >= PURSUIT_RANGE) return 'drive';
  if (mode === 'standoff' && s.distance < ARREST_DEPLOY_RANGE && Math.abs(s.speed) < ARREST_STOP_SPEED) return 'arrest';
  return 'standoff';
}

/** Approach throttle toward an on-foot suspect: zero inside the projected stopping envelope (arriving fast
 *  brakes earlier), ramping to full pursuit throttle by PURSUIT_RANGE. Never plans to drive through anyone. */
export function standoffThrottle(distance: number, speed = 0): number {
  if (distance <= STANDOFF_RANGE + Math.max(0, speed) * 0.55) return 0;
  return Math.min(1, (distance - STANDOFF_RANGE) / (PURSUIT_RANGE - STANDOFF_RANGE));
}

/** JMPD marksmanship: accuracy falls off with range, always some miss chance, never a guaranteed hit. */
export function copHitChance(distance: number): number { return Math.min(0.8, Math.max(0.15, 0.85 - distance * 0.016)); }

/** A cruiser is up for grabs only when nobody is in it: crew deployed on an arrest, or crew dead. */
export function policeCarStealable(vehicle: { police: boolean; occupied: boolean; wrecked: boolean; disabled: boolean; playerControlled: boolean }): boolean {
  return vehicle.police && !vehicle.occupied && !vehicle.wrecked && !vehicle.disabled && !vehicle.playerControlled;
}

/** G toggles the siren, but only a real cruiser has one to toggle. */
export function toggleSiren(vehicle: { police: boolean; sirenOn: boolean }): boolean { return vehicle.police ? !vehicle.sirenOn : vehicle.sirenOn; }

export type PoliceEvent =
  | { kind: 'freeze'; x: number; z: number }
  | { kind: 'officers'; officers: Pedestrian[] }
  | { kind: 'reboard'; officers: Pedestrian[] }
  | { kind: 'abandoned'; vehicle: Vehicle };

interface PoliceBrain { serial: number; path: NavPoint[]; index: number; replanIn: number; chasing: boolean; roaming: boolean; dwell: number; knownTime: number; mode: UnitMode; shootIn: number; contactIn: number; }
interface Officer { ped: Pedestrian; car?: Vehicle; role: 'cover' | 'chase'; side: 1 | -1; shootIn: number; }

export class PoliceSystem {
  vehicles: Vehicle[] = [];
  private officers: Officer[] = [];
  private events: PoliceEvent[] = [];
  private spawnCooldown = 0;
  private serials = 0;
  private brains = new WeakMap<Vehicle, PoliceBrain>();
  private planner: RoutePlanner;
  private scratch = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private city: City, private audio: AudioManager) {
    this.planner = new RoutePlanner(city.vehicleNav, 2);
  }

  /** Deploy shouts, spawned/retiring officer peds and abandoned cruisers, for the caller to route into the world. */
  consumeEvents(): PoliceEvent[] { return this.events.splice(0); }

  update(dt: number, playerPosition: THREE.Vector3, playerInVehicle: boolean, wanted: WantedSystem, knowledge: PoliceKnowledge<unknown>, damagePlayer: (amount: number) => void, reinforcementModifier = 0, damageVehicle?: (amount: number) => void, playerSirenOn = false): void {
    const damageCar = damageVehicle ?? damagePlayer;
    this.planner.beginFrame();
    this.spawnCooldown -= dt;
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
      brain.shootIn -= dt; brain.contactIn -= dt;
      const distance = vehicle.group.position.distanceTo(playerPosition);
      const seen = sighted && distance < SIGHT_RADIUS && this.hasLineOfSight(vehicle.group.position, playerPosition);
      if (brain.mode !== 'arrest') {
        brain.mode = target ? nextUnitMode(brain.mode, { sighted: seen, playerInVehicle, distance, speed: vehicle.speed, crewOut: false }) : 'drive';
        if (brain.mode === 'arrest') this.deployCrew(vehicle);
      }
      if (brain.mode === 'arrest') this.holdArrestScene(vehicle, brain, dt, playerPosition, wanted);
      else if (brain.mode === 'standoff') {
        brain.chasing = true; brain.path = []; brain.index = 0; brain.replanIn = 0;
        const throttle = standoffThrottle(distance, Math.abs(vehicle.speed));
        if (throttle === 0) this.brake(vehicle, dt);
        else vehicle.updateAI(dt, this.city, playerPosition, (0.82 + wanted.level * 0.035) * throttle);
      } else if (target) this.pursue(vehicle, brain, dt, target, seen, playerPosition, wanted);
      else this.patrol(vehicle, brain, dt);
      // Genuine contact with an on-foot player: speed-derived impact through the damage path, never scripted proximity harm.
      if (!playerInVehicle && brain.contactIn <= 0 && distance < 3 && Math.abs(vehicle.speed) > 6) {
        damagePlayer(Math.min(30, Math.abs(vehicle.speed) * 0.9)); this.audio.collision(Math.abs(vehicle.speed));
        vehicle.speed *= 0.35; brain.contactIn = 1;
      }
      // Drive-by fire at the fleeing car — two stars up, from the pursuit position, feeding real vehicle damage.
      if (playerInVehicle && seen && brain.mode === 'drive' && wanted.level >= SHOOT_MIN_WANTED && distance < 34 && brain.shootIn <= 0) {
        brain.shootIn = 1.3 + Math.random() * 0.9;
        this.audio.copGunshot(vehicle.group.position.x, vehicle.group.position.z);
        if (Math.random() < copHitChance(distance)) damageCar(3 + wanted.level * 1.2);
      }
    }
    this.updateOfficers(dt, playerPosition, playerInVehicle, wanted, known, damagePlayer, damageCar);
    const alive = this.vehicles.filter((vehicle) => !vehicle.wrecked);
    const nearest = alive.reduce<Vehicle | undefined>((best, vehicle) => !best || vehicle.group.position.distanceToSquared(playerPosition) < best.group.position.distanceToSquared(playerPosition) ? vehicle : best, undefined);
    this.audio.setSiren(playerSirenOn || Boolean(wanted.isWanted && nearest), playerSirenOn ? playerPosition.x : nearest?.group.position.x, playerSirenOn ? playerPosition.z : nearest?.group.position.z);
    if (this.vehicles.length > 0) this.despawnFar(playerPosition, wanted.isWanted);
  }

  /** Removes everything and hands back the tracked officer peds so the caller can drop them from the population. */
  reset(): Pedestrian[] {
    for (const vehicle of this.vehicles) this.scene.remove(vehicle.group);
    const peds = this.officers.map((officer) => officer.ped);
    for (const ped of peds) this.scene.remove(ped.group);
    this.vehicles = []; this.officers = []; this.events = [];
    return peds;
  }

  /** Nearest empty cruiser in grabbing range — pair with release() when the player actually takes it. */
  stealableNear(position: THREE.Vector3, maxDistance = 4.2): Vehicle | undefined {
    const nearest = this.vehicles.filter((vehicle) => policeCarStealable(vehicle)).sort((a, b) => a.group.position.distanceToSquared(position) - b.group.position.distanceToSquared(position))[0];
    return nearest && nearest.group.position.distanceTo(position) < maxDistance ? nearest : undefined;
  }

  /** Hands a cruiser over to the player: JMPD stops driving it; any crew on foot will notice on their own. */
  release(vehicle: Vehicle): void {
    const index = this.vehicles.indexOf(vehicle); if (index >= 0) this.vehicles.splice(index, 1);
    vehicle.sirenOn = false;
  }

  /** Chase: replan an A* route to the LAST KNOWN position every 1.5-2s (staggered per unit) — never to the
   *  live player. Direct engagement only while an active sighting exists; a driving player is chased with an
   *  avoidance offset (no intentional ramming), and a cold scene turns to roam. */
  private pursue(vehicle: Vehicle, brain: PoliceBrain, dt: number, known: KnownPosition, seen: boolean, playerPosition: THREE.Vector3, wanted: WantedSystem): void {
    if (brain.knownTime !== known.time) { brain.knownTime = known.time; brain.roaming = false; brain.dwell = 0; }
    const distance = vehicle.group.position.distanceTo(playerPosition);
    const aggression = 0.82 + wanted.level * 0.035;
    if (seen && distance < PURSUIT_RANGE) { // only reachable with the player in a vehicle: on-foot sightings become standoffs
      brain.chasing = true; brain.path = []; brain.index = 0; brain.replanIn = 0;
      this.chaseVehicle(vehicle, brain, dt, playerPosition, distance, aggression);
    } else if (brain.roaming) {
      this.roam(vehicle, brain, dt, known);
    } else {
      if (Math.hypot(vehicle.group.position.x - known.x, vehicle.group.position.z - known.z) < ARRIVE_RADIUS) {
        brain.dwell += dt;
        if (brain.dwell >= ARRIVE_DWELL) { brain.roaming = true; brain.chasing = false; brain.path = []; brain.index = 0; return; }
      }
      brain.replanIn -= dt;
      if (brain.replanIn <= 0 || !brain.chasing || brain.index >= brain.path.length || vehicle.aiStuck > 5) {
        const path = this.planner.tryPlan(vehicle.group.position.x, vehicle.group.position.z, this.planner.nearest(known.x, known.z));
        if (path) { brain.path = path; brain.index = 0; brain.chasing = true; brain.replanIn = replanInterval(brain.serial); vehicle.aiStuck = 0; }
      }
      this.followPath(vehicle, brain, dt, aggression);
    }
  }

  /** Direct chase on a driving player: aim beside the car (staggered per unit) and ease off at the bumper —
   *  contact is physics from here, never intent. */
  private chaseVehicle(vehicle: Vehicle, brain: PoliceBrain, dt: number, playerPosition: THREE.Vector3, distance: number, aggression: number): void {
    const dx = playerPosition.x - vehicle.group.position.x; const dz = playerPosition.z - vehicle.group.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const lane = (brain.serial % 2 === 0 ? 1 : -1) * Math.min(4, distance * 0.35);
    this.scratch.set(playerPosition.x - (dz / length) * lane, 0, playerPosition.z + (dx / length) * lane);
    vehicle.updateAI(dt, this.city, this.scratch, distance < 9 ? aggression * 0.45 : aggression);
  }

  /** Roll to a stop while keeping heading and the lightbar alive (aiming at a point straight ahead, zero throttle). */
  private brake(vehicle: Vehicle, dt: number): void {
    vehicle.speed *= Math.exp(-2.2 * dt);
    const position = vehicle.group.position;
    this.scratch.set(position.x + Math.sin(vehicle.heading) * 4, 0, position.z + Math.cos(vehicle.heading) * 4);
    vehicle.updateAI(dt, this.city, this.scratch, 0);
  }

  /** Crew out at the doors: FREEZE bark, cover positions, and events for the caller (toast + population entry). */
  private deployCrew(vehicle: Vehicle): void {
    vehicle.occupied = false;
    const spawned: Pedestrian[] = [];
    for (const side of [1, -1] as const) {
      const door = vehicle.group.position.clone().add(new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading)).multiplyScalar(side * 1.6));
      const ped = new Pedestrian(this.scene, door, 91 + this.serials++, false, true);
      ped.state = 'hostile'; ped.destination.copy(door);
      this.officers.push({ ped, car: vehicle, role: 'cover', side, shootIn: 0.8 + Math.random() * 0.6 });
      spawned.push(ped);
    }
    this.audio.policeShout(vehicle.group.position.x, vehicle.group.position.z);
    this.events.push({ kind: 'officers', officers: spawned }, { kind: 'freeze', x: vehicle.group.position.x, z: vehicle.group.position.z });
  }

  /** Parked arrest car: promotes one officer to a foot chase when the suspect runs, reboards cover officers
   *  when the suspect is long gone (or the heat dies), abandons the car when the whole crew is lost. */
  private holdArrestScene(vehicle: Vehicle, brain: PoliceBrain, dt: number, playerPosition: THREE.Vector3, wanted: WantedSystem): void {
    this.brake(vehicle, dt);
    const crew = this.officers.filter((officer) => officer.car === vehicle);
    if (!crew.length) { this.abandon(vehicle); return; }
    const covers = crew.filter((officer) => officer.role === 'cover');
    if (!covers.length) return; // only the foot chaser holds a claim: the car sits empty (and stealable)
    const distance = vehicle.group.position.distanceTo(playerPosition);
    if (wanted.isWanted && distance > FOOT_CHASE_RANGE && covers.length === crew.length) covers[0]!.role = 'chase';
    if (!wanted.isWanted || distance > REBOARD_RANGE) this.reboard(vehicle, brain, covers.filter((officer) => officer.role === 'cover'));
  }

  private abandon(vehicle: Vehicle): void {
    const index = this.vehicles.indexOf(vehicle); if (index >= 0) this.vehicles.splice(index, 1);
    vehicle.occupied = false; vehicle.sirenOn = false;
    this.events.push({ kind: 'abandoned', vehicle });
  }

  private reboard(vehicle: Vehicle, brain: PoliceBrain, covers: Officer[]): void {
    if (!covers.length) return;
    for (const officer of covers) { this.scene.remove(officer.ped.group); const index = this.officers.indexOf(officer); if (index >= 0) this.officers.splice(index, 1); }
    vehicle.occupied = true; brain.mode = 'drive'; brain.chasing = false; brain.path = []; brain.index = 0;
    this.events.push({ kind: 'reboard', officers: covers.map((officer) => officer.ped) });
  }

  /** Foot officers: crouch in cover at the car doors or run the suspect down (on belief — live position only
   *  with their own line of sight). Two stars releases hitscan fire with distance falloff and cooldowns. */
  private updateOfficers(dt: number, playerPosition: THREE.Vector3, playerInVehicle: boolean, wanted: WantedSystem, known: KnownPosition | null, damagePlayer: (amount: number) => void, damageCar: (amount: number) => void): void {
    for (let index = this.officers.length - 1; index >= 0; index--) {
      const officer = this.officers[index]; if (!officer) continue;
      const ped = officer.ped;
      if (ped.state === 'down') { this.officers.splice(index, 1); continue; }
      const position = ped.group.position;
      const carValid = Boolean(officer.car && this.vehicles.includes(officer.car) && !officer.car.wrecked);
      if (!carValid && officer.role === 'cover') officer.role = 'chase'; // car stolen or wrecked: nothing left to hold
      if (!wanted.isWanted) { // heat gone: covers wait for holdArrestScene to mount them up, chasers become beat cops
        if (!(officer.role === 'cover' && carValid)) { ped.state = 'walk'; this.officers.splice(index, 1); }
        continue;
      }
      if (position.distanceTo(playerPosition) > 130) { ped.state = 'walk'; this.officers.splice(index, 1); continue; }
      if (officer.role === 'cover' && officer.car) {
        const car = officer.car.group.position;
        const away = this.scratch.copy(car).sub(playerPosition).setY(0);
        if (away.lengthSq() < 0.01) away.set(0, 0, 1);
        away.normalize();
        ped.destination.set(car.x + away.x * 2.4 - away.z * officer.side * 1.1, 0, car.z + away.z * 2.4 + away.x * officer.side * 1.1);
        if (position.distanceToSquared(ped.destination) > 2.2) ped.state = 'hostile'; // hustle to the door
        else { ped.state = 'idle'; ped.idleTime = 6; ped.takeCover(); ped.group.rotation.y = Math.atan2(playerPosition.x - position.x, playerPosition.z - position.z); }
      } else {
        ped.state = 'hostile';
        if (position.distanceTo(playerPosition) < SIGHT_RADIUS && this.hasLineOfSight(position, playerPosition)) ped.destination.copy(playerPosition);
        else if (known) ped.destination.set(known.x, 0, known.z);
      }
      officer.shootIn -= dt;
      if (wanted.level >= SHOOT_MIN_WANTED && officer.shootIn <= 0) {
        const distance = position.distanceTo(playerPosition);
        if (distance > 2.4 && distance < 44 && this.hasLineOfSight(position, playerPosition)) {
          officer.shootIn = 0.9 + Math.random() * 0.9;
          this.audio.copGunshot(position.x, position.z);
          if (Math.random() < copHitChance(distance)) { if (playerInVehicle) damageCar(4); else damagePlayer(4 + wanted.level); }
        }
      }
    }
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
    if (!brain) { brain = { serial: this.serials++, path: [], index: 0, replanIn: 0, chasing: false, roaming: false, dwell: 0, knownTime: -1, mode: 'drive', shootIn: 0, contactIn: 0 }; this.brains.set(vehicle, brain); }
    return brain;
  }

  /** Units are dispatched around the last known position (the report's crime scene), not the player. */
  private spawnUnit(dispatchAt: THREE.Vector3): void {
    const pose = this.city.roadPoseAwayFrom(dispatchAt, 105, 165);
    const vehicle = new Vehicle(this.scene, 'police', pose.position); vehicle.occupied = true; vehicle.sirenOn = true; vehicle.heading = pose.heading; vehicle.group.rotation.y = pose.heading; this.vehicles.push(vehicle);
  }

  private despawnFar(player: THREE.Vector3, wreckedOnly: boolean): void {
    const index = this.vehicles.findIndex((vehicle) => (!wreckedOnly || vehicle.wrecked) && vehicle.group.position.distanceTo(player) > 130);
    if (index >= 0) { const [vehicle] = this.vehicles.splice(index, 1); if (vehicle) this.scene.remove(vehicle.group); }
  }
}
