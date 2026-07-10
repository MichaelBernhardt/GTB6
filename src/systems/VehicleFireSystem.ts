import * as THREE from 'three';
import { splashDamage } from '../core/GameRules';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';

export type FireStage = 'none' | 'smoke' | 'critical';

export const SMOKE_THRESHOLD = 0.5;
export const CRITICAL_THRESHOLD = 0.25;
export const BURN_DURATION_MIN = 4;
export const BURN_DURATION_MAX = 6;
export const BURN_DPS = 10;
export const BURNOUT_RADIUS = 4;
export const BURNOUT_PED_DAMAGE = 85;
export const BURNOUT_VEHICLE_DAMAGE = 48;
export const BURNOUT_PLAYER_DAMAGE = 45;
export const OCCUPANT_BURNOUT_DAMAGE = 70;
export const POLICE_WRECK_HEAT = 30;
export const CHAIN_CAP = 4;

export function fireStage(health: number, maxHealth: number): FireStage {
  const fraction = maxHealth > 0 ? health / maxHealth : 0;
  if (fraction < CRITICAL_THRESHOLD) return 'critical';
  if (fraction < SMOKE_THRESHOLD) return 'smoke';
  return 'none';
}

export function rollBurnDuration(random: () => number = Math.random): number {
  return BURN_DURATION_MIN + random() * (BURN_DURATION_MAX - BURN_DURATION_MIN);
}

export interface BurnVictim { ped: Pedestrian; killed: boolean; position: THREE.Vector3; }
export interface Burnout { vehicle: Vehicle; position: THREE.Vector3; victims: BurnVictim[]; playerDamage: number; }
export interface FireEvents { ignitions: Vehicle[]; burnouts: Burnout[]; }

interface FireFx { cones: THREE.Mesh[]; rig?: THREE.Group; light?: THREE.PointLight; smokeTimer: number; wasOnFire: boolean; burnDuration: number; }
interface Particle { mesh: THREE.Mesh; life: number; maxLife: number; rise: number; grow: number; opacity: number; }

const FLAME_COLORS = [0xffc23d, 0xff8c2a, 0xff6a1f];

export class VehicleFireSystem {
  private states = new Map<Vehicle, FireFx>();
  private particles: Particle[] = [];
  private flashes: THREE.PointLight[] = [];
  private puffGeometry = new THREE.SphereGeometry(0.5, 10, 8);
  private coneGeometry = new THREE.ConeGeometry(0.34, 1.05, 7);

  constructor(private scene: THREE.Scene) {}

  update(dt: number, vehicles: Vehicle[], pedestrians: Pedestrian[], playerPosition: THREE.Vector3): FireEvents {
    const events: FireEvents = { ignitions: [], burnouts: [] };
    const burningCount = vehicles.filter((vehicle) => vehicle.onFire).length;
    for (const vehicle of vehicles) {
      const fx = this.ensureFx(vehicle);
      if (vehicle.onFire && !fx.wasOnFire) { fx.wasOnFire = true; fx.burnDuration = Math.max(vehicle.burnTimer, 0.01); events.ignitions.push(vehicle); }
      else if (!vehicle.onFire) fx.wasOnFire = false;
      const stage: FireStage = vehicle.wrecked ? 'none' : fireStage(vehicle.health, vehicle.maxHealth);
      this.updateFlames(vehicle, fx, stage);
      this.emitSmoke(dt, vehicle, fx, stage);
      if (vehicle.onFire) {
        vehicle.burnTimer -= dt;
        if (vehicle.burnTimer <= 0) { vehicle.wreck(); events.burnouts.push(this.explode(vehicle, vehicles, pedestrians, playerPosition, burningCount)); }
      }
    }
    this.cleanup(vehicles);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]; if (!particle) continue; particle.life -= dt;
      particle.mesh.position.y += particle.rise * dt; particle.mesh.scale.multiplyScalar(1 + particle.grow * dt);
      (particle.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (particle.life / particle.maxLife) * particle.opacity);
      if (particle.life <= 0) { this.scene.remove(particle.mesh); this.particles.splice(i, 1); }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i]; if (!flash) continue; flash.intensity *= Math.exp(-dt * 7);
      if (flash.intensity < 0.08) { this.scene.remove(flash); this.flashes.splice(i, 1); }
    }
    return events;
  }

  private ensureFx(vehicle: Vehicle): FireFx {
    let fx = this.states.get(vehicle);
    if (!fx) { fx = { cones: [], smokeTimer: 0, wasOnFire: false, burnDuration: BURN_DURATION_MIN }; this.states.set(vehicle, fx); }
    return fx;
  }

  private updateFlames(vehicle: Vehicle, fx: FireFx, stage: FireStage): void {
    const flaming = !vehicle.wrecked && (vehicle.onFire || stage === 'critical');
    if (!flaming) { if (fx.rig) fx.rig.visible = false; if (fx.light) fx.light.intensity = 0; return; }
    if (!fx.rig) {
      fx.rig = new THREE.Group(); fx.rig.name = 'firefx';
      const length = vehicle.spec.size[2];
      for (const [y, z] of [[0.95, length * 0.3], [1.15, -length * 0.05], [0.9, -length * 0.3]] as const) {
        const cone = new THREE.Mesh(this.coneGeometry, new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.85, depthWrite: false }));
        cone.position.set(0, y, z); fx.rig.add(cone); fx.cones.push(cone);
      }
      vehicle.group.add(fx.rig);
    }
    fx.rig.visible = true;
    const progress = vehicle.onFire ? 1 - THREE.MathUtils.clamp(vehicle.burnTimer / fx.burnDuration, 0, 1) : 0;
    const base = vehicle.onFire ? 1 + progress * 0.7 : 0.5;
    fx.cones.forEach((cone, index) => {
      cone.visible = vehicle.onFire || index === 0;
      cone.scale.set(base * (0.8 + Math.random() * 0.3), base * (0.72 + Math.random() * 0.55), base * (0.8 + Math.random() * 0.3));
      cone.position.x = (Math.random() - 0.5) * 0.14;
      (cone.material as THREE.MeshBasicMaterial).color.setHex(FLAME_COLORS[Math.floor(Math.random() * FLAME_COLORS.length)] ?? 0xffa030);
    });
    if (vehicle.onFire) {
      if (!fx.light) { fx.light = new THREE.PointLight(0xff8c2d, 0, 9); fx.light.position.set(0, 1.4, 0); vehicle.group.add(fx.light); }
      fx.light.intensity = 2.2 + progress * 1.6 + Math.random() * 0.9;
    } else if (fx.light) fx.light.intensity = 0;
  }

  private emitSmoke(dt: number, vehicle: Vehicle, fx: FireFx, stage: FireStage): void {
    let interval: number; let color: number; let scale: number; let life: number; let rise: number; let grow: number; let opacity: number;
    if (vehicle.wrecked) { interval = 1.1; color = 0x565a5d; scale = 0.3; life = 1.8; rise = 1.1; grow = 0.7; opacity = 0.3; }
    else if (vehicle.onFire) { interval = 0.08; color = 0x1d1f21; scale = 0.55; life = 2; rise = 2.6; grow = 1.9; opacity = 0.6; }
    else if (stage === 'critical') { interval = 0.16; color = 0x2f3336; scale = 0.42; life = 1.7; rise = 2.1; grow = 1.5; opacity = 0.55; }
    else if (stage === 'smoke') { interval = 0.3; color = 0x9aa0a3; scale = 0.3; life = 1.3; rise = 1.6; grow = 1.1; opacity = 0.42; }
    else { fx.smokeTimer = 0; return; }
    fx.smokeTimer -= dt;
    if (fx.smokeTimer > 0) return;
    fx.smokeTimer = interval * (0.75 + Math.random() * 0.5);
    const length = vehicle.spec.size[2];
    const hood = vehicle.group.position.clone().add(new THREE.Vector3(Math.sin(vehicle.heading) * length * 0.3, 0.95, Math.cos(vehicle.heading) * length * 0.3));
    hood.x += (Math.random() - 0.5) * 0.5; hood.z += (Math.random() - 0.5) * 0.5;
    this.puff(hood, color, scale * (0.8 + Math.random() * 0.5), life, rise, grow, opacity);
  }

  private explode(vehicle: Vehicle, vehicles: Vehicle[], pedestrians: Pedestrian[], playerPosition: THREE.Vector3, burningCount: number): Burnout {
    const position = vehicle.group.position.clone().setY(0.9);
    this.puff(position, 0xfff0b8, 0.7, 0.28, 0.6, 10, 0.95);
    this.puff(position, 0xffc45e, 1.05, 0.38, 0.8, 8, 0.9);
    this.puff(position, 0xff7a30, 1.35, 0.5, 1, 6.5, 0.8);
    for (let i = 0; i < 4; i++) {
      const offset = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.4, (Math.random() - 0.5) * 2);
      this.puff(position.clone().add(offset), 0x555b5e, 0.9, 1.2, 1.4, 2.1, 0.5);
    }
    const flash = new THREE.PointLight(0xffa53d, 7, BURNOUT_RADIUS * 4);
    flash.position.copy(position).setY(1.4); this.scene.add(flash); this.flashes.push(flash);
    const victims: BurnVictim[] = [];
    for (const ped of pedestrians) {
      if (ped.state === 'down') continue;
      const damage = splashDamage(BURNOUT_PED_DAMAGE, ped.group.position.distanceTo(position), BURNOUT_RADIUS);
      if (damage <= 0) continue;
      const killed = ped.takeDamage(damage);
      victims.push({ ped, killed, position: ped.group.position.clone().add(new THREE.Vector3(0, 1.05, 0)) });
    }
    if (burningCount < CHAIN_CAP) for (const other of vehicles) {
      if (other === vehicle || other.wrecked) continue;
      const damage = splashDamage(BURNOUT_VEHICLE_DAMAGE, other.group.position.distanceTo(position), BURNOUT_RADIUS + 1.5);
      if (damage > 0) other.takeDamage(damage);
    }
    const playerDamage = splashDamage(BURNOUT_PLAYER_DAMAGE, playerPosition.clone().add(new THREE.Vector3(0, 1, 0)).distanceTo(position), BURNOUT_RADIUS);
    return { vehicle, position, victims, playerDamage };
  }

  private cleanup(vehicles: Vehicle[]): void {
    if (this.states.size <= vehicles.length) return;
    const seen = new Set(vehicles);
    for (const [vehicle, fx] of this.states) {
      if (seen.has(vehicle)) continue;
      fx.rig?.removeFromParent(); fx.light?.removeFromParent(); this.states.delete(vehicle);
    }
  }

  private puff(position: THREE.Vector3, color: number, scale: number, life: number, rise: number, grow: number, opacity: number): void {
    const mesh = new THREE.Mesh(this.puffGeometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    mesh.position.copy(position); mesh.scale.setScalar(scale);
    this.scene.add(mesh); this.particles.push({ mesh, life, maxLife: life, rise, grow, opacity });
    while (this.particles.length > 260) { const oldest = this.particles.shift(); if (oldest) this.scene.remove(oldest.mesh); }
  }
}
