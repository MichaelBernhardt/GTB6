import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { VEHICLE_SPECS, type VehicleKind, type VehicleSpec } from '../config';
import type { InputManager } from '../core/InputManager';
import { rollBurnDuration } from '../systems/VehicleFireSystem';
import type { City } from '../world/City';

type VehicleMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial;

export class Vehicle {
  group = new THREE.Group();
  spec: VehicleSpec;
  speed = 0;
  health: number;
  maxHealth: number;
  heading = 0;
  steeringVisual = 0;
  playerControlled = false;
  occupied = false;
  police = false;
  disabled = false;
  onFire = false;
  wrecked = false;
  burnTimer = 0;
  aiTarget = new THREE.Vector3();
  aiStuck = 0;
  private wheels: THREE.Object3D[] = [];
  private brakeLights: THREE.Mesh[] = [];
  private cabinParts: THREE.Object3D[] = [];
  private lightPhase = 0;

  constructor(scene: THREE.Scene, kind: VehicleKind, position: THREE.Vector3, color?: number) {
    this.spec = { ...VEHICLE_SPECS[kind], color: color ?? VEHICLE_SPECS[kind].color };
    this.health = this.spec.health; this.maxHealth = this.spec.health; this.police = kind === 'police';
    this.group.position.copy(position); this.group.name = this.spec.name; this.group.userData.vehicle = this;
    scene.add(this.group); this.buildModel();
  }

  updatePlayer(dt: number, input: InputManager, city: City): number {
    if (this.disabled) return 0;
    const throttle = Number(input.down('KeyW')) - Number(input.down('KeyS'));
    const steer = Number(input.down('KeyA')) - Number(input.down('KeyD'));
    const handbrake = input.down('Space');
    if (throttle !== 0) {
      const sameDirection = this.speed === 0 || Math.sign(this.speed) === Math.sign(throttle);
      this.speed += throttle * (sameDirection ? this.spec.acceleration : this.spec.brake) * dt;
    } else this.speed *= Math.exp(-this.spec.drag * dt);
    if (handbrake) this.speed *= Math.exp(-4.8 * dt);
    this.speed = THREE.MathUtils.clamp(this.speed, -this.spec.maxSpeed * 0.38, this.spec.maxSpeed);
    const steeringScale = THREE.MathUtils.clamp(Math.abs(this.speed) / 6, 0, 1) * (1 - Math.min(Math.abs(this.speed) / 90, 0.38));
    this.heading += steer * this.spec.steering * steeringScale * Math.sign(this.speed || 1) * dt;
    this.steeringVisual = THREE.MathUtils.lerp(this.steeringVisual, steer * 0.48, 10 * dt);
    this.move(dt, city);
    this.updateVisuals(dt, throttle < 0 || (throttle === 0 && this.speed > 3));
    return Math.abs(this.speed);
  }

  updateAI(dt: number, city: City, target?: THREE.Vector3, aggression = 0.65): void {
    if (this.playerControlled || this.disabled) return;
    const destination = target ?? this.aiTarget;
    const dx = destination.x - this.group.position.x; const dz = destination.z - this.group.position.z;
    const desired = Math.atan2(dx, dz); const delta = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading));
    this.heading += THREE.MathUtils.clamp(delta, -this.spec.steering * dt, this.spec.steering * dt);
    const turnFactor = THREE.MathUtils.clamp(1 - Math.abs(delta) * 0.58, 0.34, 1);
    const targetSpeed = this.spec.maxSpeed * aggression * turnFactor;
    this.speed = THREE.MathUtils.lerp(this.speed, targetSpeed, dt * this.spec.acceleration / 15);
    const old = this.group.position.clone(); this.move(dt, city);
    const intended = Math.abs(this.speed) * dt; // stuck = blocked, not merely slow: actual travel far below intended travel
    if (intended > 0.02 && old.distanceToSquared(this.group.position) < intended * intended * 0.09) { this.aiStuck += dt; this.speed = -4; this.heading += dt * 1.4; } else this.aiStuck = 0;
    this.updateVisuals(dt, false);
  }

  takeDamage(amount: number): void {
    if (this.wrecked) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health === 0) { this.disabled = true; this.speed *= 0.3; this.ignite(); }
  }

  ignite(random: () => number = Math.random): void {
    if (this.onFire || this.wrecked) return;
    this.onFire = true; this.disabled = true; this.health = 0; this.burnTimer = rollBurnDuration(random);
  }

  wreck(): void {
    if (this.wrecked) return;
    this.wrecked = true; this.onFire = false; this.disabled = true; this.health = 0; this.speed = 0; this.occupied = false; this.burnTimer = 0;
    const lightbar = this.group.getObjectByName('lightbar'); if (lightbar) lightbar.visible = false;
    this.forEachMaterial((material) => {
      if (material.userData.originalColor === undefined) {
        material.userData.originalColor = material.color.getHex();
        if ('emissiveIntensity' in material) material.userData.originalEmissive = material.emissiveIntensity;
      }
      material.color.lerp(new THREE.Color(0x0d0c0b), 0.88);
      if ('emissiveIntensity' in material) material.emissiveIntensity = 0;
    });
  }

  restore(): void {
    this.wrecked = false; this.onFire = false; this.disabled = false; this.burnTimer = 0; this.health = this.maxHealth;
    const lightbar = this.group.getObjectByName('lightbar'); if (lightbar) lightbar.visible = true;
    this.forEachMaterial((material) => {
      if (material.userData.originalColor !== undefined) material.color.setHex(material.userData.originalColor as number);
      if ('emissiveIntensity' in material && material.userData.originalEmissive !== undefined) material.emissiveIntensity = material.userData.originalEmissive as number;
    });
  }

  private forEachMaterial(apply: (material: VehicleMaterial) => void): void {
    const seen = new Set<VehicleMaterial>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.parent?.name === 'firefx') return;
      const material = object.material as VehicleMaterial;
      if (seen.has(material)) return;
      seen.add(material); apply(material);
    });
  }

  setFirstPerson(firstPerson: boolean): void { for (const part of this.cabinParts) part.visible = !firstPerson; } // hide cabin glass/roof so the driver view is unobstructed

  reset(position?: THREE.Vector3): void {
    if (position) this.group.position.copy(position);
    this.group.position.y = 0.02; this.group.rotation.set(0, this.heading, 0); this.speed = 0;
  }

  private move(dt: number, city: City): void {
    const old = this.group.position.clone();
    const next = old.clone(); next.x += Math.sin(this.heading) * this.speed * dt; next.z += Math.cos(this.heading) * this.speed * dt;
    const radius = Math.max(this.spec.size[0], this.spec.size[2]) * 0.34;
    const resolved = city.clampMove(old, next, radius);
    if (resolved.distanceToSquared(next) > 0.01) { const impact = Math.abs(this.speed); this.speed *= -0.16; this.takeDamage(Math.max(0, impact - 8) * 0.35); }
    this.group.position.copy(resolved); this.group.rotation.y = this.heading;
    if (this.group.position.y < 0) this.group.position.y = 0;
  }

  private updateVisuals(dt: number, braking: boolean): void {
    const spin = this.speed * dt / 0.36; this.wheels.forEach((wheel, index) => { wheel.rotation.x += spin; if (index < 2) wheel.rotation.y = this.steeringVisual; });
    this.brakeLights.forEach((light) => (light.material as THREE.MeshBasicMaterial).color.setHex(braking ? 0xff2018 : 0x5b0808));
    if (this.police) { this.lightPhase += dt * 11; const lights = this.group.getObjectByName('lightbar')?.children ?? []; lights.forEach((light: THREE.Object3D, i: number) => { light.visible = Math.sin(this.lightPhase + i * Math.PI) > 0; }); }
  }

  private buildModel(): void {
    const [width, height, length] = this.spec.size;
    const sport = this.spec.kind === 'sport'; const van = this.spec.kind === 'van';
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: this.spec.color, metalness: 0.32, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.13 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x151a1c, metalness: 0.52, roughness: 0.32 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xa9b0b0, metalness: 0.9, roughness: 0.18 });
    const glass = new THREE.MeshPhysicalMaterial({ color: this.police ? 0x263e4a : 0x213e49, roughness: 0.08, metalness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05 });
    const bodyHeight = height * (van ? 0.7 : sport ? 0.42 : 0.5);
    const body = new THREE.Mesh(new RoundedBoxGeometry(width, bodyHeight, length, 4, Math.min(0.18, bodyHeight * 0.28)), bodyMat); body.position.y = 0.38 + bodyHeight / 2; body.castShadow = true; body.receiveShadow = true;
    const hoodLength = van ? length * 0.18 : length * 0.34;
    const hood = new THREE.Mesh(new RoundedBoxGeometry(width * 0.94, sport ? 0.24 : 0.34, hoodLength, 3, 0.09), bodyMat); hood.position.set(0, body.position.y + bodyHeight * 0.45, length * 0.34); hood.castShadow = true;
    const cabinHeight = van ? height * 0.72 : height * (sport ? 0.48 : 0.56);
    const cabinLength = van ? length * 0.64 : length * 0.48;
    const cabin = new THREE.Mesh(new RoundedBoxGeometry(width * 0.82, cabinHeight, cabinLength, 4, 0.14), glass); cabin.position.set(0, body.position.y + bodyHeight * 0.45 + cabinHeight / 2, van ? -length * 0.05 : -length * 0.05); cabin.castShadow = true;
    const roof = new THREE.Mesh(new RoundedBoxGeometry(width * 0.84, 0.13, cabinLength * 0.9, 3, 0.05), bodyMat); roof.position.set(0, cabin.position.y + cabinHeight / 2 + 0.02, cabin.position.z); roof.castShadow = true;
    const frontBumper = new THREE.Mesh(new RoundedBoxGeometry(width * 0.9, 0.16, 0.16, 2, 0.05), trimMat); frontBumper.position.set(0, 0.43, length / 2 + 0.08);
    const rearBumper = frontBumper.clone(); rearBumper.position.z = -length / 2 - 0.08;
    const grille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.42, 0.25, 0.035), trimMat); grille.position.set(0, 0.64, length / 2 + 0.095);
    const lowerGrille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.28, 0.07, 0.042), chrome); lowerGrille.position.set(0, 0.63, length / 2 + 0.116);
    this.group.add(body, hood, cabin, roof, frontBumper, rearBumper, grille, lowerGrille);
    this.cabinParts.push(cabin, roof);
    for (const side of [-1, 1]) {
      const skirt = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.15, length * 0.68, 2, 0.04), trimMat); skirt.position.set(side * width * 0.49, 0.4, 0); this.group.add(skirt);
      const mirror = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.15, 0.34, 3, 0.07), bodyMat); mirror.position.set(side * width * 0.56, cabin.position.y + 0.08, cabin.position.z + cabinLength * 0.32); mirror.castShadow = true; this.group.add(mirror);
    }
    const wheelRadius = van ? 0.41 : sport ? 0.38 : 0.37;
    const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.27, 24); wheelGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(wheelRadius * 0.52, wheelRadius * 0.52, 0.285, 12); rimGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x101315, roughness: 0.76 });
    for (const z of [length * 0.31, -length * 0.31]) for (const x of [-width * 0.52, width * 0.52]) {
      const assembly = new THREE.Group(); assembly.position.set(x, wheelRadius, z);
      const wheel = new THREE.Mesh(wheelGeo, wheelMat); wheel.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, chrome); assembly.add(wheel, rim); this.group.add(assembly); this.wheels.push(assembly);
    }
    const lightGeo = new RoundedBoxGeometry(0.38, 0.17, 0.07, 2, 0.03);
    for (const x of [-width * 0.29, width * 0.29]) {
      const rear = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({ color: 0x5b0808, emissive: 0x390000, emissiveIntensity: 1.8, roughness: 0.22 })); rear.position.set(x, 0.65, -length / 2 - 0.1); this.group.add(rear); this.brakeLights.push(rear);
      const front = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({ color: 0xf4edc5, emissive: 0xffe7a0, emissiveIntensity: 1.15, roughness: 0.12 })); front.position.set(x, 0.65, length / 2 + 0.1); this.group.add(front);
    }
    const plateMaterial = new THREE.MeshStandardMaterial({ color: 0xe7e4cf, roughness: 0.5 });
    const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.18, 0.035), plateMaterial); frontPlate.position.set(0, 0.39, length / 2 + 0.18);
    const rearPlate = frontPlate.clone(); rearPlate.position.z = -length / 2 - 0.18; this.group.add(frontPlate, rearPlate);
    if (sport) { const spoiler = new THREE.Mesh(new RoundedBoxGeometry(width * 0.62, 0.09, 0.2, 2, 0.03), bodyMat); spoiler.position.set(0, 1.02, -length * 0.43); this.group.add(spoiler); }
    if (this.police) {
      const bar = new THREE.Group(); bar.name = 'lightbar'; bar.position.y = roof.position.y + 0.17;
      const mount = new THREE.Mesh(new RoundedBoxGeometry(0.98, 0.07, 0.17, 2, 0.02), trimMat); bar.add(mount);
      for (const [x, color] of [[-0.28, 0x226dff], [0.28, 0xff3028]] as const) { const light = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.14, 0.18, 2, 0.03), new THREE.MeshBasicMaterial({ color })); light.position.x = x; bar.add(light); }
      this.group.add(bar); this.cabinParts.push(bar);
    }
    this.group.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.frustumCulled = false; } });
  }
}
