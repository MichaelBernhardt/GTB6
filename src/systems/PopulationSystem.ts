import * as THREE from 'three';
import { TRAFFIC_SPEED_FACTOR, WORLD_SIZE, type VehicleKind } from '../config';
import type { AudioManager } from '../core/AudioManager';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import { FEAR_EVENTS, fearContribution, FEAR_MAX, type FearEvent } from './FearSystem';
import { MISSIONS } from './MissionSystem';
import { RoutePlanner, type NavPoint } from './NavGraph';
import type { City } from '../world/City';

interface DrivePlan { points: NavPoint[]; index: number; }

export class PopulationSystem {
  pedestrians: Pedestrian[] = [];
  vehicles: Vehicle[] = [];
  traffic: Vehicle[] = [];
  hostiles: Pedestrian[] = [];
  private hostileAttackCooldown = 0;
  private impacts: Array<{ position: THREE.Vector3; killed: boolean; vehicle: Vehicle }> = [];
  private pedestrianImpactCooldown = new WeakMap<Pedestrian, number>();
  private trafficPlans = new WeakMap<Vehicle, DrivePlan>();
  private vehiclePlanner: RoutePlanner;
  private pedPlanner: RoutePlanner;

  constructor(private scene: THREE.Scene, private city: City, private audio: AudioManager) {
    this.vehiclePlanner = new RoutePlanner(city.vehicleNav, 2);
    this.pedPlanner = new RoutePlanner(city.pedNav, 2);
    this.spawnVehicles(); this.spawnPedestrians();
  }

  update(dt: number, player: THREE.Vector3, damagePlayer?: (amount: number) => void): void {
    this.vehiclePlanner.beginFrame(); this.pedPlanner.beginFrame();
    this.hostileAttackCooldown = Math.max(0, this.hostileAttackCooldown - dt);
    for (const ped of this.pedestrians) {
      ped.update(dt, this.city, this.city.sidewalkPoints, player);
      if (ped.wantsRoute) { const points = this.pedPlanner.tryPlan(ped.group.position.x, ped.group.position.z); if (points) ped.setRoute(points); }
      this.pedestrianImpactCooldown.set(ped, Math.max(0, (this.pedestrianImpactCooldown.get(ped) ?? 0) - dt));
    }
    this.witnessBodies(dt);
    for (const vehicle of this.traffic) {
      if (vehicle.playerControlled || vehicle.disabled) continue;
      this.followDrivePlan(vehicle);
      const forward = new THREE.Vector3(Math.sin(vehicle.heading), 0, Math.cos(vehicle.heading));
      const blocked = this.vehicles.some((other) => other !== vehicle && other.group.position.distanceToSquared(vehicle.group.position) < 70 && other.group.position.clone().sub(vehicle.group.position).dot(forward) > 0);
      if (vehicle.group.position.distanceToSquared(player) < 320 * 320) vehicle.updateAI(dt, this.city, undefined, blocked ? 0.05 : TRAFFIC_SPEED_FACTOR);
      const outsideWorld = Math.abs(vehicle.group.position.x) > WORLD_SIZE / 2 || Math.abs(vehicle.group.position.z) > WORLD_SIZE / 2;
      if (outsideWorld || vehicle.aiStuck > 9) this.rehomeVehicle(vehicle);
    }
    this.handleVehiclePedestrianImpacts();
    this.handleTrafficSeparation();
    if (damagePlayer && this.hostileAttackCooldown <= 0) {
      const attacker = this.pedestrians.find((ped) => ped.state === 'hostile' && ped.group.position.distanceTo(player) < 2.3);
      if (attacker) { attacker.punch(); damagePlayer(7); this.hostileAttackCooldown = 0.9; }
    }
  }

  broadcastFear(origin: THREE.Vector3, event: FearEvent): void {
    for (const ped of this.pedestrians) this.frighten(ped, fearContribution(event, ped.group.position.distanceTo(origin)), origin);
  }

  private frighten(ped: Pedestrian, amount: number, origin: THREE.Vector3): void {
    const before = ped.state;
    ped.applyFear(amount, origin);
    if (before !== ped.state && (ped.state === 'flee' || ped.state === 'cower') && Math.random() < 0.4) this.audio.scream('panic', ped.group.position.x, ped.group.position.z);
  }

  consumeImpacts(): Array<{ position: THREE.Vector3; killed: boolean; vehicle: Vehicle }> { return this.impacts.splice(0); }

  nearestPedestrian(position: THREE.Vector3, maxDistance = 3.2): Pedestrian | undefined {
    const nearest = this.pedestrians.filter((ped) => !ped.contact && ped.state !== 'down').sort((a, b) => a.group.position.distanceToSquared(position) - b.group.position.distanceToSquared(position))[0];
    return nearest && nearest.group.position.distanceTo(position) <= maxDistance ? nearest : undefined;
  }

  ejectDriver(vehicle: Vehicle, threat: THREE.Vector3, police = false): Pedestrian {
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading));
    const driver = new Pedestrian(this.scene, vehicle.group.position.clone().addScaledVector(side, -2.1), 120 + this.pedestrians.length, false, police);
    const away = driver.group.position.clone().sub(threat); if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    driver.state = 'flee'; driver.fear = FEAR_MAX; driver.threat.copy(threat); driver.destination.copy(driver.group.position).add(away.normalize().multiplyScalar(55));
    this.pedestrians.push(driver); this.audio.scream('panic', driver.group.position.x, driver.group.position.z); this.broadcastFear(threat, FEAR_EVENTS.assault); return driver;
  }

  spawnHostiles(): void {
    if (this.hostiles.some((ped) => ped.state !== 'down')) return;
    const spots = [[-250, -245], [-278, -230], [-292, -245]];
    spots.forEach(([x, z], index) => { const ped = new Pedestrian(this.scene, new THREE.Vector3(x, 0, z), index + 30, true); ped.destination.set(x, 0, z); this.pedestrians.push(ped); this.hostiles.push(ped); });
  }

  nearestEnterable(position: THREE.Vector3, maxDistance = 4.2): Vehicle | undefined {
    const nearest = this.vehicles
      .filter((vehicle) => !vehicle.playerControlled && !vehicle.disabled)
      .sort((a, b) => a.group.position.distanceToSquared(position) - b.group.position.distanceToSquared(position))[0];
    return nearest && nearest.group.position.distanceTo(position) < maxDistance ? nearest : undefined;
  }

  private spawnVehicles(): void {
    const parked: Array<[VehicleKind, number, number, number, number?]> = [
      ['compact', -105.5, 240, 0, 0xf1c232], ['sport', 30, 205.5, Math.PI / 2, 0xd83a40], ['van', -205.5, -72, 0],
      ['compact', 205.5, 86, 0], ['sport', 252, -205.5, Math.PI / 2, 0x3f6faa], ['van', -105.5, -190, 0], ['compact', 205.5, 286, 0],
    ];
    for (const [kind, x, z, heading, color] of parked) {
      const pose = this.city.nearestRoadPose(new THREE.Vector3(x, 0, z)); const vehicle = new Vehicle(this.scene, kind, pose.position, color);
      vehicle.heading = Number.isFinite(pose.heading) ? pose.heading : heading; vehicle.group.rotation.y = vehicle.heading; this.vehicles.push(vehicle);
    }
    const kinds: VehicleKind[] = ['compact', 'sport', 'van'];
    for (let i = 0; i < 13; i++) {
      const routeIndex = (i * 5 + 3) % this.city.trafficRoutes.length; const route = this.city.trafficRoutes[routeIndex]; const point = route?.[(i * 7) % Math.max(1, route.length)]; if (!point) continue;
      const vehicle = new Vehicle(this.scene, kinds[i % kinds.length], new THREE.Vector3(point.x, 0, point.z), [0x5c88a8, 0xd28452, 0x8c9273, 0xc7c8c4][i % 4]);
      vehicle.occupied = true; this.vehicles.push(vehicle); this.traffic.push(vehicle); this.assignVehicleRoute(vehicle, true);
    }
  }

  private spawnPedestrians(): void {
    for (let i = 0; i < 28; i++) {
      const point = this.city.sidewalkPoints[(i * 17 + 4) % this.city.sidewalkPoints.length]; if (!point) continue;
      const ped = new Pedestrian(this.scene, new THREE.Vector3(point.x, 0, point.z), i); ped.pickDestination(this.city.sidewalkPoints); this.pedestrians.push(ped);
    }
    MISSIONS.forEach((mission, index) => {
      const contact = new Pedestrian(this.scene, mission.start.position.clone(), index + 70);
      contact.state = 'idle'; contact.idleTime = 999999; contact.contact = true; contact.group.name = mission.contact; this.pedestrians.push(contact);
    });
  }

  /** Advances the vehicle along its A* route; picks a fresh destination on arrival (budget permitting). */
  private followDrivePlan(vehicle: Vehicle): void {
    const plan = this.trafficPlans.get(vehicle);
    if (!plan) { this.assignVehicleRoute(vehicle, false); return; }
    if (vehicle.group.position.distanceToSquared(vehicle.aiTarget) >= 85) return;
    plan.index += 1;
    const point = plan.points[plan.index];
    if (point) vehicle.aiTarget.set(point.x, 0, point.z);
    else { this.trafficPlans.delete(vehicle); this.assignVehicleRoute(vehicle, false); }
  }

  private assignVehicleRoute(vehicle: Vehicle, free: boolean): void {
    const position = vehicle.group.position;
    const points = free ? this.vehiclePlanner.plan(position.x, position.z) : this.vehiclePlanner.tryPlan(position.x, position.z);
    if (!points?.length) return; // budget spent or destination unreachable: retry next frame
    this.trafficPlans.set(vehicle, { points, index: 0 });
    const first = points[0]; if (first) vehicle.aiTarget.set(first.x, 0, first.z);
    const next = points[1];
    if (next && Math.abs(vehicle.speed) < 1) { vehicle.heading = Math.atan2(next.x - position.x, next.z - position.z); vehicle.group.rotation.y = vehicle.heading; }
  }

  /** Snaps a lost/stuck vehicle back onto the nearest lane node and forces a replan. */
  private rehomeVehicle(vehicle: Vehicle): void {
    const node = this.vehiclePlanner.node(this.vehiclePlanner.nearest(vehicle.group.position.x, vehicle.group.position.z));
    if (node) { vehicle.reset(new THREE.Vector3(node.x, 0, node.z)); vehicle.aiTarget.set(node.x, 0, node.z); }
    vehicle.aiStuck = 0;
    this.trafficPlans.delete(vehicle);
  }

  private witnessBodies(dt: number): void {
    const bodies = this.pedestrians.filter((ped) => ped.state === 'down');
    if (!bodies.length) return;
    for (const ped of this.pedestrians) {
      if (ped.state === 'down') continue;
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
          const killed = ped.takeDamage(Math.abs(vehicle.speed) * 2.8); this.broadcastFear(ped.group.position, killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault); this.impacts.push({ position: ped.group.position.clone().add(new THREE.Vector3(0, 0.7, 0)), killed, vehicle });
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
