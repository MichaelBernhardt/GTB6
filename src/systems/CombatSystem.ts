import * as THREE from 'three';
import type { AudioManager } from '../core/AudioManager';
import type { InputManager } from '../core/InputManager';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { PopulationSystem } from './PopulationSystem';
import { calculateDamage } from '../core/GameRules';

export interface ShotResult { fired: boolean; victim?: Pedestrian; killed?: boolean; policeHit?: boolean; hitPoint?: THREE.Vector3; }

export class CombatSystem {
  ammo = 12;
  reserve = 84;
  reloading = 0;
  cooldown = 0;
  shotsFired = 0;
  private raycaster = new THREE.Raycaster();
  private effects: Array<{ mesh: THREE.Mesh; life: number }> = [];
  private muzzle?: THREE.PointLight;

  constructor(private scene: THREE.Scene, private audio: AudioManager) {}

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { const count = Math.min(12 - this.ammo, this.reserve); this.ammo += count; this.reserve -= count; }
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]; if (!effect) continue; effect.life -= dt;
      effect.mesh.scale.multiplyScalar(1 + dt * 4); (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, effect.life * 4);
      if (effect.life <= 0) { this.scene.remove(effect.mesh); this.effects.splice(i, 1); }
    }
    if (this.muzzle) { this.muzzle.intensity *= 0.72; if (this.muzzle.intensity < 0.05) { this.scene.remove(this.muzzle); this.muzzle = undefined; } }
  }

  tryReload(input: InputManager): void {
    if (input.consume('KeyR') && this.reloading <= 0 && this.ammo < 12 && this.reserve > 0) { this.reloading = 1.05; this.audio.reload(); }
  }

  fire(input: InputManager, camera: THREE.Camera, origin: THREE.Vector3, population: PopulationSystem, policeVehicles: Vehicle[] = []): ShotResult {
    if (!input.firing || this.cooldown > 0 || this.reloading > 0) return { fired: false };
    if (this.ammo <= 0) { this.cooldown = 0.25; this.audio.tone(160, 0.05, 0.05, 'square'); return { fired: false }; }
    this.ammo -= 1; this.cooldown = 0.19; this.shotsFired += 1; this.audio.gunshot();
    this.muzzle = new THREE.PointLight(0xffb43b, 3, 7); this.muzzle.position.copy(origin).add(new THREE.Vector3(0, 1.3, 0)); this.scene.add(this.muzzle);
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const meshes: THREE.Object3D[] = [];
    for (const ped of population.pedestrians) if (ped.state !== 'down') meshes.push(ped.group);
    for (const vehicle of population.vehicles) meshes.push(vehicle.group);
    for (const vehicle of policeVehicles) meshes.push(vehicle.group);
    const hit = this.raycaster.intersectObjects(meshes, true)[0];
    if (!hit || hit.distance > 130) { this.impact(this.raycaster.ray.at(90, new THREE.Vector3()), 0xa9c0c4); return { fired: true }; }
    this.impact(hit.point, 0xffcc72);
    let root: THREE.Object3D | null = hit.object;
    while (root && !root.userData.pedestrian && !root.userData.vehicle) root = root.parent;
    if (root?.userData.pedestrian) {
      const victim = root.userData.pedestrian as Pedestrian;
      const killed = victim.takeDamage(calculateDamage(38, hit.distance));
      return { fired: true, victim, killed, policeHit: victim.police, hitPoint: hit.point.clone() };
    }
    if (root?.userData.vehicle) {
      const vehicle = root.userData.vehicle as Vehicle; vehicle.takeDamage(calculateDamage(22, hit.distance));
      return { fired: true, policeHit: vehicle.police };
    }
    return { fired: true };
  }

  private impact(position: THREE.Vector3, color: number): void {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), new THREE.MeshBasicMaterial({ color, transparent: true }));
    mesh.position.copy(position); this.scene.add(mesh); this.effects.push({ mesh, life: 0.24 });
  }
}
