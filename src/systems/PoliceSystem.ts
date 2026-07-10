import * as THREE from 'three';
import type { AudioManager } from '../core/AudioManager';
import { Pedestrian } from '../entities/Pedestrian';
import { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import type { WantedSystem } from './WantedSystem';

export class PoliceSystem {
  vehicles: Vehicle[] = [];
  officers: Pedestrian[] = [];
  private spawnCooldown = 0;
  private attackCooldown = 0;

  constructor(private scene: THREE.Scene, private city: City, private audio: AudioManager) {}

  update(dt: number, playerPosition: THREE.Vector3, playerInVehicle: boolean, wanted: WantedSystem, damagePlayer: (amount: number) => void): void {
    this.spawnCooldown -= dt; this.attackCooldown -= dt;
    const desired = wanted.level === 0 ? 0 : Math.min(4, Math.ceil(wanted.level / 1.4));
    while (this.vehicles.length < desired && this.spawnCooldown <= 0) { this.spawnUnit(playerPosition); this.spawnCooldown = 4; }
    for (const vehicle of this.vehicles) {
      if (!wanted.isWanted) { vehicle.speed *= Math.exp(-dt); continue; }
      vehicle.updateAI(dt, this.city, playerPosition, 0.82 + wanted.level * 0.035);
      const distance = vehicle.group.position.distanceTo(playerPosition);
      if (distance < 70) wanted.reportSeen();
      if (distance < 5 && Math.abs(vehicle.speed) > 8 && this.attackCooldown <= 0) { damagePlayer(Math.min(24, Math.abs(vehicle.speed) * 0.8)); this.attackCooldown = 1.2; }
      if (!playerInVehicle && distance < 20 && this.attackCooldown <= 0) { damagePlayer(4 + wanted.level * 1.5); this.attackCooldown = 1.1; }
    }
    const nearest = this.vehicles.reduce<Vehicle | undefined>((best, vehicle) => !best || vehicle.group.position.distanceToSquared(playerPosition) < best.group.position.distanceToSquared(playerPosition) ? vehicle : best, undefined);
    this.audio.setSiren(Boolean(wanted.isWanted && nearest), nearest?.group.position.x, nearest?.group.position.z);
    if (!wanted.isWanted && this.vehicles.length > 0) this.despawnFar(playerPosition);
  }

  reset(): void { for (const vehicle of this.vehicles) this.scene.remove(vehicle.group); for (const officer of this.officers) this.scene.remove(officer.group); this.vehicles = []; this.officers = []; }

  private spawnUnit(player: THREE.Vector3): void {
    const pose = this.city.roadPoseAwayFrom(player, 105, 165);
    const vehicle = new Vehicle(this.scene, 'police', pose.position); vehicle.occupied = true; vehicle.heading = pose.heading; vehicle.group.rotation.y = pose.heading; this.vehicles.push(vehicle);
  }

  private despawnFar(player: THREE.Vector3): void {
    const index = this.vehicles.findIndex((vehicle) => vehicle.group.position.distanceTo(player) > 130);
    if (index >= 0) { const [vehicle] = this.vehicles.splice(index, 1); if (vehicle) this.scene.remove(vehicle.group); }
  }
}
