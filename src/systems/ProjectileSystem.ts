import * as THREE from 'three';
import type { ProjectileSpec } from '../config';
import { splashDamage } from '../core/GameRules';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { PopulationSystem } from './PopulationSystem';
import type { City } from '../world/City';

interface Rocket { group: THREE.Group; direction: THREE.Vector3; speed: number; radius: number; damage: number; range: number; traveled: number; trailTimer: number; }
interface Effect { mesh: THREE.Mesh; life: number; maxLife: number; grow: number; opacity: number; }
export interface ExplosionVictim { ped: Pedestrian; killed: boolean; position: THREE.Vector3; }
export interface Explosion { position: THREE.Vector3; victims: ExplosionVictim[]; policeHit: boolean; playerDamage: number; }

export class ProjectileSystem {
  rockets: Rocket[] = [];
  private effects: Effect[] = [];
  private flashes: THREE.PointLight[] = [];

  constructor(private scene: THREE.Scene) {}

  spawn(origin: THREE.Vector3, direction: THREE.Vector3, spec: ProjectileSpec, range: number): void {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0x6e7f4a, roughness: 0.55 }));
    body.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 10), new THREE.MeshStandardMaterial({ color: 0x2c3236, metalness: 0.5, roughness: 0.4 }));
    nose.rotation.x = Math.PI / 2; nose.position.z = 0.29;
    const exhaust = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb04d, transparent: true, opacity: 0.95 }));
    exhaust.position.z = -0.26;
    const flame = new THREE.PointLight(0xffa53d, 2.2, 7);
    flame.position.z = -0.3;
    group.add(body, nose, exhaust, flame);
    group.position.copy(origin); group.lookAt(origin.clone().add(direction));
    this.scene.add(group);
    this.rockets.push({ group, direction: direction.clone().normalize(), speed: spec.speed, radius: spec.radius, damage: spec.damage, range, traveled: 0, trailTimer: 0 });
  }

  update(dt: number, city: City, population: PopulationSystem, policeVehicles: Vehicle[], playerPosition: THREE.Vector3): Explosion[] {
    const explosions: Explosion[] = [];
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rocket = this.rockets[i]; if (!rocket) continue;
      const step = rocket.speed * dt;
      rocket.group.position.addScaledVector(rocket.direction, step); rocket.traveled += step;
      rocket.trailTimer -= dt;
      if (rocket.trailTimer <= 0) { rocket.trailTimer = 0.035; this.puff(rocket.group.position, 0x9aa0a3, 0.12, 0.55, 2.6, 0.55); }
      const position = rocket.group.position;
      let hit = rocket.traveled >= rocket.range || position.y <= city.terrainHeightAt(position.x, position.z) + 0.05 || city.collidesAt(position.x, position.z, 0.3, position.y, position.y); // 3D: rockets clear low walls and rooftop parapets they fly over
      if (!hit) for (const ped of population.pedestrians) { if (ped.state !== 'down' && position.distanceToSquared(ped.group.position.clone().setY(position.y > 2 ? position.y : 1)) < 1.8) { hit = true; break; } }
      if (!hit) for (const vehicle of [...population.vehicles, ...policeVehicles]) { if (position.distanceToSquared(vehicle.group.position.clone().setY(position.y > 2.6 ? position.y : 0.9)) < 5.3) { hit = true; break; } }
      if (hit) {
        explosions.push(this.explode(position.clone(), rocket, population, policeVehicles, playerPosition));
        this.scene.remove(rocket.group); this.rockets.splice(i, 1);
      }
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]; if (!effect) continue; effect.life -= dt;
      effect.mesh.scale.multiplyScalar(1 + effect.grow * dt);
      (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (effect.life / effect.maxLife) * effect.opacity);
      if (effect.life <= 0) { this.scene.remove(effect.mesh); this.effects.splice(i, 1); }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i]; if (!flash) continue; flash.intensity *= Math.exp(-dt * 7);
      if (flash.intensity < 0.08) { this.scene.remove(flash); this.flashes.splice(i, 1); }
    }
    return explosions;
  }

  private explode(position: THREE.Vector3, rocket: Rocket, population: PopulationSystem, policeVehicles: Vehicle[], playerPosition: THREE.Vector3): Explosion {
    this.puff(position, 0xfff0b8, 0.9, 0.3, 12, 0.95);
    this.puff(position, 0xffc45e, 1.3, 0.42, 9, 0.9);
    this.puff(position, 0xff7a30, 1.7, 0.55, 7, 0.8);
    for (let i = 0; i < 4; i++) {
      const offset = new THREE.Vector3((Math.random() - 0.5) * 2.4, Math.random() * 1.8, (Math.random() - 0.5) * 2.4);
      this.puff(position.clone().add(offset), 0x555b5e, 1.1, 1.3, 2.2, 0.5);
    }
    const flash = new THREE.PointLight(0xffa53d, 9, rocket.radius * 4.5);
    flash.position.copy(position).setY(Math.max(1.4, position.y)); this.scene.add(flash); this.flashes.push(flash);
    const victims: ExplosionVictim[] = []; let policeHit = false;
    for (const ped of population.pedestrians) {
      if (ped.state === 'down') continue;
      const damage = splashDamage(rocket.damage, ped.group.position.distanceTo(position), rocket.radius);
      if (damage <= 0) continue;
      const killed = ped.takeDamage(damage);
      victims.push({ ped, killed, position: ped.group.position.clone().add(new THREE.Vector3(0, 1.05, 0)) });
      policeHit ||= ped.police;
    }
    for (const vehicle of [...population.vehicles, ...policeVehicles]) {
      const damage = splashDamage(rocket.damage * 1.4, vehicle.group.position.distanceTo(position), rocket.radius + 1.5);
      if (damage <= 0) continue;
      vehicle.takeDamage(damage); policeHit ||= vehicle.police;
    }
    const playerDamage = splashDamage(rocket.damage * 0.75, playerPosition.clone().add(new THREE.Vector3(0, 1, 0)).distanceTo(position), rocket.radius);
    return { position, victims, policeHit, playerDamage };
  }

  private puff(position: THREE.Vector3, color: number, scale: number, life: number, grow: number, opacity: number): void {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    mesh.position.copy(position); mesh.scale.setScalar(scale);
    this.scene.add(mesh); this.effects.push({ mesh, life, maxLife: life, grow, opacity });
  }
}
