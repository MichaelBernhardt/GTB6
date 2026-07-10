import * as THREE from 'three';
import { WORLD_SIZE, type VehicleKind } from '../config';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import { MISSIONS } from './MissionSystem';
import type { City } from '../world/City';

interface TrafficState { route: number; waypoint: number; direction: 1 | -1; }

export class PopulationSystem {
  pedestrians: Pedestrian[] = [];
  vehicles: Vehicle[] = [];
  traffic: Vehicle[] = [];
  hostiles: Pedestrian[] = [];
  private dangerTime = 0;
  private hostileAttackCooldown = 0;
  private impacts: Array<{ position: THREE.Vector3; killed: boolean; vehicle: Vehicle }> = [];
  private pedestrianImpactCooldown = new WeakMap<Pedestrian, number>();
  private trafficState = new WeakMap<Vehicle, TrafficState>();

  constructor(private scene: THREE.Scene, private city: City) {
    this.spawnVehicles(); this.spawnPedestrians();
  }

  update(dt: number, player: THREE.Vector3, damagePlayer?: (amount: number) => void): void {
    this.dangerTime = Math.max(0, this.dangerTime - dt);
    this.hostileAttackCooldown = Math.max(0, this.hostileAttackCooldown - dt);
    for (const ped of this.pedestrians) {
      ped.update(dt, this.city, this.city.sidewalkPoints, player, this.dangerTime > 0);
      this.pedestrianImpactCooldown.set(ped, Math.max(0, (this.pedestrianImpactCooldown.get(ped) ?? 0) - dt));
    }
    for (const vehicle of this.traffic) {
      if (vehicle.group.position.distanceToSquared(vehicle.aiTarget) < 85) this.advanceTrafficTarget(vehicle);
      const forward = new THREE.Vector3(Math.sin(vehicle.heading), 0, Math.cos(vehicle.heading));
      const blocked = this.vehicles.some((other) => other !== vehicle && other.group.position.distanceToSquared(vehicle.group.position) < 70 && other.group.position.clone().sub(vehicle.group.position).dot(forward) > 0);
      if (vehicle.group.position.distanceToSquared(player) < 320 * 320) vehicle.updateAI(dt, this.city, undefined, blocked ? 0.08 : 0.65);
      if (Math.abs(vehicle.group.position.x) > WORLD_SIZE / 2 || Math.abs(vehicle.group.position.z) > WORLD_SIZE / 2 || vehicle.aiStuck > 5) {
        this.placeOnRoute(vehicle, Math.floor(Math.random() * this.city.trafficRoutes.length));
      }
    }
    this.handleVehiclePedestrianImpacts();
    this.handleTrafficSeparation();
    if (damagePlayer && this.hostileAttackCooldown <= 0 && this.pedestrians.some((ped) => ped.state === 'hostile' && ped.group.position.distanceTo(player) < 2.3)) {
      damagePlayer(7); this.hostileAttackCooldown = 0.9;
    }
  }

  alertDanger(): void { this.dangerTime = 5; }

  consumeImpacts(): Array<{ position: THREE.Vector3; killed: boolean; vehicle: Vehicle }> { return this.impacts.splice(0); }

  nearestPedestrian(position: THREE.Vector3, maxDistance = 3.2): Pedestrian | undefined {
    const nearest = this.pedestrians.filter((ped) => !ped.contact && ped.state !== 'down').sort((a, b) => a.group.position.distanceToSquared(position) - b.group.position.distanceToSquared(position))[0];
    return nearest && nearest.group.position.distanceTo(position) <= maxDistance ? nearest : undefined;
  }

  ejectDriver(vehicle: Vehicle, player: THREE.Vector3): Pedestrian {
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading));
    const driver = new Pedestrian(this.scene, vehicle.group.position.clone().addScaledVector(side, -2.1), 120 + this.pedestrians.length);
    driver.state = 'flee'; driver.destination.copy(driver.group.position).add(driver.group.position.clone().sub(player).normalize().multiplyScalar(55)); this.pedestrians.push(driver); this.dangerTime = 6; return driver;
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
      vehicle.occupied = true; this.vehicles.push(vehicle); this.traffic.push(vehicle); this.placeOnRoute(vehicle, routeIndex, (i * 7) % route.length);
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

  private placeOnRoute(vehicle: Vehicle, routeIndex: number, waypoint?: number): void {
    const route = this.city.trafficRoutes[routeIndex] ?? this.city.trafficRoutes[0]; if (!route?.length) return;
    const index = waypoint ?? Math.floor(Math.random() * Math.max(1, route.length - 1)); const nextIndex = Math.min(route.length - 1, index + 1);
    const point = route[index]; const next = route[nextIndex]; if (!point || !next) return;
    vehicle.reset(new THREE.Vector3(point.x, 0, point.z)); vehicle.heading = Math.atan2(next.x - point.x, next.z - point.z); vehicle.group.rotation.y = vehicle.heading;
    this.trafficState.set(vehicle, { route: routeIndex, waypoint: nextIndex, direction: 1 }); vehicle.aiTarget.set(next.x, 0, next.z);
  }

  private advanceTrafficTarget(vehicle: Vehicle): void {
    const state = this.trafficState.get(vehicle); if (!state) { this.placeOnRoute(vehicle, Math.floor(Math.random() * this.city.trafficRoutes.length)); return; }
    const route = this.city.trafficRoutes[state.route]; if (!route?.length) return;
    let waypoint = state.waypoint + state.direction;
    if (waypoint >= route.length || waypoint < 0) { state.direction = state.direction === 1 ? -1 : 1; waypoint = THREE.MathUtils.clamp(state.waypoint + state.direction, 0, route.length - 1); }
    state.waypoint = waypoint; const point = route[waypoint]; if (point) vehicle.aiTarget.set(point.x, 0, point.z);
  }

  private handleVehiclePedestrianImpacts(): void {
    for (const vehicle of this.vehicles) {
      if (Math.abs(vehicle.speed) < 7) continue;
      for (const ped of this.pedestrians) if (ped.state !== 'down' && (this.pedestrianImpactCooldown.get(ped) ?? 0) <= 0 && vehicle.group.position.distanceToSquared(ped.group.position) < 5) {
        const killed = ped.takeDamage(Math.abs(vehicle.speed) * 2.8); this.dangerTime = 5; this.impacts.push({ position: ped.group.position.clone().add(new THREE.Vector3(0, 0.7, 0)), killed, vehicle });
        this.pedestrianImpactCooldown.set(ped, 1);
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
