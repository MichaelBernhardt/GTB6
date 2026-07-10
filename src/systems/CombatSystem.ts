import * as THREE from 'three';
import { WEAPONS, WEAPON_BY_ID, type WeaponId, type WeaponSpec } from '../config';
import type { AudioManager } from '../core/AudioManager';
import type { InputManager } from '../core/InputManager';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { PopulationSystem } from './PopulationSystem';
import { calculateDamage, cycleWeapon, spreadOffset, triggerPulled } from '../core/GameRules';
import { defaultWeapons } from '../core/SaveManager';
import type { SavedWeapons } from '../types';

export interface ShotResult { fired: boolean; melee?: boolean; victim?: Pedestrian; killed?: boolean; policeHit?: boolean; hitPoint?: THREE.Vector3; }

export class CombatSystem {
  current: WeaponId = 'pistol';
  loadout = defaultWeapons().loadout;
  reloading = 0;
  cooldown = 0;
  shotsFired = 0;
  private raycaster = new THREE.Raycaster();
  private effects: Array<{ mesh: THREE.Mesh; life: number }> = [];
  private muzzle?: THREE.PointLight;

  constructor(private scene: THREE.Scene, private audio: AudioManager) {}

  get spec(): WeaponSpec { return WEAPON_BY_ID[this.current]; }
  get state(): { ammo: number; reserve: number } { return this.loadout[this.current]; }

  restore(saved: SavedWeapons): void {
    this.current = saved.current; this.reloading = 0; this.cooldown = 0;
    for (const spec of WEAPONS) { const entry = saved.loadout[spec.id]; if (entry) this.loadout[spec.id] = { ...entry }; }
  }

  serialize(): SavedWeapons { return { current: this.current, loadout: structuredClone(this.loadout) }; }

  select(id: WeaponId): boolean {
    if (id === this.current || !WEAPON_BY_ID[id]) return false;
    this.current = id; this.reloading = 0; this.cooldown = Math.max(this.cooldown, 0.16);
    this.audio.tone(520, 0.045, 0.06, 'square');
    return true;
  }

  cycle(direction: 1 | -1): void { this.select(cycleWeapon(this.current, direction)); }

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { const state = this.state; const count = Math.min(this.spec.magazine - state.ammo, state.reserve); state.ammo += count; state.reserve -= count; }
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]; if (!effect) continue; effect.life -= dt;
      effect.mesh.scale.multiplyScalar(1 + dt * 4); (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, effect.life * 4);
      if (effect.life <= 0) { this.scene.remove(effect.mesh); this.effects.splice(i, 1); }
    }
    if (this.muzzle) { this.muzzle.intensity *= 0.72; if (this.muzzle.intensity < 0.05) { this.scene.remove(this.muzzle); this.muzzle = undefined; } }
  }

  tryReload(input: InputManager): void {
    if (input.consume('KeyR') && !this.spec.melee && this.reloading <= 0 && this.state.ammo < this.spec.magazine && this.state.reserve > 0) this.startReload();
  }

  fire(input: InputManager, camera: THREE.Camera, origin: THREE.Vector3, population: PopulationSystem, policeVehicles: Vehicle[] = []): ShotResult {
    const spec = this.spec;
    if (!triggerPulled(spec, input.firing, input.firePressed) || this.cooldown > 0 || this.reloading > 0) return { fired: false };
    if (spec.melee) return this.punch(spec, origin, population);
    const state = this.state;
    if (state.ammo <= 0) {
      if (state.reserve <= 0) { this.select('fists'); return { fired: false }; }
      this.cooldown = 0.25; this.audio.tone(160, 0.05, 0.05, 'square'); this.startReload(); return { fired: false };
    }
    state.ammo -= 1; this.cooldown = spec.cooldown; this.shotsFired += 1;
    for (const tone of spec.sound) this.audio.tone(tone.freq, tone.duration, tone.volume, tone.type);
    if (this.muzzle) this.scene.remove(this.muzzle);
    this.muzzle = new THREE.PointLight(0xffb43b, 3, 7); this.muzzle.position.copy(origin).add(new THREE.Vector3(0, 1.3, 0)); this.scene.add(this.muzzle);
    const meshes: THREE.Object3D[] = [];
    for (const ped of population.pedestrians) if (ped.state !== 'down') meshes.push(ped.group);
    for (const vehicle of population.vehicles) meshes.push(vehicle.group);
    for (const vehicle of policeVehicles) meshes.push(vehicle.group);
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const rayOrigin = this.raycaster.ray.origin.clone(); const baseDirection = this.raycaster.ray.direction.clone();
    const up = new THREE.Vector3(0, 1, 0).projectOnPlane(baseDirection).normalize();
    const side = new THREE.Vector3().crossVectors(baseDirection, up).normalize();
    let victim: Pedestrian | undefined; let killed = false; let policeHit = false; let hitPoint: THREE.Vector3 | undefined;
    const hitVehicles = new Set<Vehicle>();
    for (let pellet = 0; pellet < spec.pellets; pellet++) {
      const [sx, sy] = spreadOffset(spec.spread);
      const direction = baseDirection.clone().addScaledVector(side, sx).addScaledVector(up, sy).normalize();
      this.raycaster.set(rayOrigin, direction);
      const hit = this.raycaster.intersectObjects(meshes, true)[0];
      if (!hit || hit.distance > spec.range) { if (pellet === 0) this.impact(this.raycaster.ray.at(Math.min(90, spec.range), new THREE.Vector3()), 0xa9c0c4); continue; }
      this.impact(hit.point, 0xffcc72);
      let root: THREE.Object3D | null = hit.object;
      while (root && !root.userData.pedestrian && !root.userData.vehicle) root = root.parent;
      if (root?.userData.pedestrian) {
        const ped = root.userData.pedestrian as Pedestrian;
        const dead = ped.takeDamage(calculateDamage(spec.damage, hit.distance));
        policeHit ||= ped.police;
        if (!victim || ped === victim) { victim = ped; killed ||= dead; hitPoint ??= hit.point.clone(); }
      } else if (root?.userData.vehicle) {
        const vehicle = root.userData.vehicle as Vehicle;
        if (!hitVehicles.has(vehicle)) { hitVehicles.add(vehicle); vehicle.takeDamage(calculateDamage(spec.damage * 0.6, hit.distance)); policeHit ||= vehicle.police; }
      }
    }
    return { fired: true, victim, killed, policeHit, hitPoint };
  }

  private punch(spec: WeaponSpec, origin: THREE.Vector3, population: PopulationSystem): ShotResult {
    this.cooldown = spec.cooldown;
    const victim = population.nearestPedestrian(origin, spec.range);
    if (!victim) { this.audio.tone(260, 0.05, 0.045, 'sine'); return { fired: true, melee: true }; }
    const killed = victim.takeDamage(spec.damage);
    for (const tone of spec.sound) this.audio.tone(tone.freq, tone.duration, tone.volume, tone.type);
    return { fired: true, melee: true, victim, killed, policeHit: victim.police, hitPoint: victim.group.position.clone().add(new THREE.Vector3(0, 1.05, 0)) };
  }

  private startReload(): void { this.reloading = this.spec.reloadTime; this.audio.reload(); }

  private impact(position: THREE.Vector3, color: number): void {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), new THREE.MeshBasicMaterial({ color, transparent: true }));
    mesh.position.copy(position); this.scene.add(mesh); this.effects.push({ mesh, life: 0.24 });
  }
}
