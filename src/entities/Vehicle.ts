import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { VEHICLE_SPECS, type VehicleKind, type VehicleSpec, type VehicleVisualLod } from '../config';
import { bicycleCap, riderImpactDamage } from '../core/GameRules';
import type { InputManager } from '../core/InputManager';
import { KNOCKOVER_SPEED_KEEP, knockoverDamage, solidImpactDamage, type PropRegistry } from '../systems/PropSystem';
import { rollBurnDuration } from '../systems/VehicleFireSystem';
import type { City } from '../world/City';
import { instantiateBikeModel, type TwoWheelerKind } from './BikeAssets';
import { instantiateRoadVehicleModel, isRoadVehicleKind, onRoadVehicleLibraryReady, type RoadVehicleModelInstance } from './RoadVehicleAssets';
import { instantiateTaxiModel, onTaxiLibraryReady, type TaxiModelInstance } from './TaxiAsset';
import { instantiateVehicleLodProxy } from './VehicleLodProxy';

type VehicleMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial;

const FORWARD_AXIS = new THREE.Vector3(0, 0, 1); // bikes face +Z; the lean is a roll about this local axis
export const MAX_BIKE_LEAN = 0.6; // rad (~34deg): a spirited motorbike lean, never anywhere near lying on its side

/** Two-wheeler roll toward a turn: banks with steer and speed, or a gentle kickstand tilt when parked/disabled. */
export function bikeLeanTarget(steeringVisual: number, speed: number, maxSpeed: number, resting: boolean): number {
  if (resting) return 0.15;
  return THREE.MathUtils.clamp(-steeringVisual * Math.min(Math.abs(speed) / maxSpeed, 1) * 0.85, -MAX_BIKE_LEAN, MAX_BIKE_LEAN);
}

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
  sirenOn = false; // police only: JMPD units run hot; a stolen cruiser starts silent and toggles via G
  disabled = false;
  onFire = false;
  wrecked = false;
  burnTimer = 0;
  aiTarget = new THREE.Vector3();
  aiStuck = 0;
  collided = false; // set on a solid (wall/prop) impact in move(); PopulationSystem reads it to reroute an NPC out of a jam
  routeCooldown = 0; // seconds until this car may ask the planner again — set when a plan request comes back empty, so an unplanned car can't re-solve A* every frame
  frozen = false; // set by PopulationSystem distance culling: frozen traffic gets no plan/AI/visual updates
  bounce = 0;
  riderDamage = 0; // pending player damage while a two-wheeler is player-ridden: no vehicle health cocoon
  riderImpact = 0; // hardest single hit since the last consume; past KNOCKOFF_IMPACT_SPEED the rider is thrown
  private bouncePhase = 0;
  private wheels: THREE.Object3D[] = [];
  private brakeLights: THREE.Mesh[] = [];
  private headLights: THREE.Mesh[] = [];
  private cabinParts: THREE.Object3D[] = [];
  private lightPhase = 0;
  private steerGroup?: THREE.Group;
  private cranks: THREE.Object3D[] = [];
  private rider?: THREE.Group;
  private groundY = 0.02;
  private bikeLean = 0; // smoothed two-wheeler roll, applied as a clean forward-axis bank in alignToRoad (never poked into Euler.z)
  private rollRadius = 0.36; // metres of travel per radian of wheel spin; per-kind for two-wheelers
  private taxiPlaceholder?: THREE.Group;
  private taxiReadyUnsubscribe?: () => void;
  private roadPlaceholder?: THREE.Group;
  private roadReadyUnsubscribe?: () => void;
  private detailRoot?: THREE.Object3D;
  private lodProxy?: THREE.Mesh;
  visualLod: VehicleVisualLod = 'detail';
  /** Library geometry this vehicle only borrows, and the materials it genuinely owns — dispose() reads both. */
  private sharedGeometries = new Set<THREE.BufferGeometry>();
  private ownedMaterials = new Set<THREE.Material>();
  private firstPerson = false;
  private headlightFactor = 0;
  private braking = false;
  private disposed = false;

  constructor(scene: THREE.Scene, kind: VehicleKind, position: THREE.Vector3, color?: number) {
    this.spec = { ...VEHICLE_SPECS[kind], color: color ?? VEHICLE_SPECS[kind].color };
    this.health = this.spec.health; this.maxHealth = this.spec.health; this.police = kind === 'police';
    this.groundY = position.y + 0.02; this.group.position.copy(position).setY(this.groundY); this.group.name = this.spec.name; this.group.userData.vehicle = this;
    scene.add(this.group); this.buildModel(); this.buildLodProxy();
  }

  private buildLodProxy(): void {
    const proxy = instantiateVehicleLodProxy(this.spec);
    this.lodProxy = proxy.mesh; this.sharedGeometries.add(proxy.sharedGeometry); this.group.add(proxy.mesh);
  }

  /** Swap presentation only; physics, collision and route state stay live at every tier. */
  setVisualLod(lod: VehicleVisualLod): void {
    if (this.visualLod === lod) return;
    this.visualLod = lod; this.group.visible = lod !== 'hidden';
    if (this.detailRoot) this.detailRoot.visible = lod === 'detail';
    if (this.lodProxy) this.lodProxy.visible = lod === 'proxy';
  }

  /** Free only per-vehicle resources. Authored fleet geometry/textures stay in the session cache across traffic churn. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.taxiReadyUnsubscribe?.(); this.roadReadyUnsubscribe?.();
    const disposedMaterials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const shared = this.sharedGeometries.has(object.geometry);
      if (!shared) object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        // Library geometry implies a library material unless this vehicle cloned it — which keeps the
        // courier's citywide sign-atlas material out of dispose()'s hands on every ambient despawn.
        const owned = !shared || this.ownedMaterials.has(material);
        if (owned && !disposedMaterials.has(material)) { disposedMaterials.add(material); material.dispose(); }
      }
    });
  }

  updatePlayer(dt: number, input: InputManager, city: City, mouseSteer = 0): number {
    this.setVisualLod('detail'); // entering a previously distant/parked car must restore its authored cockpit immediately
    if (this.disabled) return 0;
    const throttle = Number(input.down('KeyW')) - Number(input.down('KeyS'));
    const steer = THREE.MathUtils.clamp(Number(input.down('KeyA')) - Number(input.down('KeyD')) + mouseSteer, -1, 1); // A/D keys and the LMB-drag mouse wheel share one clamped steer input
    const handbrake = input.down('Space');
    if (throttle !== 0) {
      const sameDirection = this.speed === 0 || Math.sign(this.speed) === Math.sign(throttle);
      this.speed += throttle * (sameDirection ? this.spec.acceleration : this.spec.brake) * dt;
    } else this.speed *= Math.exp(-this.spec.drag * dt);
    if (handbrake) this.speed *= Math.exp(-4.8 * dt);
    const cap = this.spec.kind === 'bicycle' ? bicycleCap(this.spec.maxSpeed, input.down('ShiftLeft')) : this.spec.maxSpeed; // Shift = pedal hard
    this.speed = THREE.MathUtils.clamp(this.speed, -cap * 0.38, cap);
    const steeringScale = THREE.MathUtils.clamp(Math.abs(this.speed) / 6, 0, 1) * (1 - Math.min(Math.abs(this.speed) / 90, 0.38));
    this.heading += steer * this.spec.steering * steeringScale * Math.sign(this.speed || 1) * dt;
    this.steeringVisual = THREE.MathUtils.lerp(this.steeringVisual, steer * 0.48, 10 * dt);
    this.move(dt, city);
    this.updateVisuals(dt, throttle < 0 || (throttle === 0 && this.speed > 3));
    return Math.abs(this.speed);
  }

  updateAI(dt: number, city: City, target?: THREE.Vector3, aggression = 0.65): void {
    if (this.playerControlled || this.disabled || !this.occupied) return; // an empty vehicle has no driver to steer it
    const destination = target ?? this.aiTarget;
    const dx = destination.x - this.group.position.x; const dz = destination.z - this.group.position.z;
    const desired = Math.atan2(dx, dz); const delta = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading));
    this.heading += THREE.MathUtils.clamp(delta, -this.spec.steering * dt, this.spec.steering * dt);
    const turnFactor = THREE.MathUtils.clamp(1 - Math.abs(delta) * 0.58, 0.34, 1);
    const targetSpeed = this.spec.maxSpeed * aggression * turnFactor;
    const responsiveness = targetSpeed < this.speed ? this.spec.brake : this.spec.acceleration; // brake firmly for reds/corners instead of coasting down — a gentle roll-off can't stop before the box
    this.speed = THREE.MathUtils.lerp(this.speed, targetSpeed, dt * responsiveness / 15);
    const old = this.group.position.clone(); this.move(dt, city);
    const intended = Math.abs(this.speed) * dt; // stuck = blocked, not merely slow: actual travel far below intended travel
    if (intended > 0.02 && old.distanceToSquared(this.group.position) < intended * intended * 0.09) { this.aiStuck += dt; this.speed = -4; this.heading += dt * 1.4; }
    else this.aiStuck = Math.max(0, this.aiStuck - dt * 0.5); // decay, don't clear: bump-reverse-bump oscillation must still accumulate toward rehome
    this.updateVisuals(dt, false);
  }

  /** Watchdog escape: back straight out for a moment so the next plan doesn't immediately re-wedge. */
  reverse(dt: number, city: City): void {
    if (this.playerControlled || this.disabled) return;
    this.speed = THREE.MathUtils.lerp(this.speed, -7, dt * 4);
    this.move(dt, city);
    this.updateVisuals(dt, true);
  }

  takeDamage(amount: number): void {
    if (this.wrecked) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health === 0) { this.disabled = true; this.speed *= 0.3; this.ignite(); }
  }

  /** Collision damage router: a player-ridden two-wheeler passes the hit to the rider instead of the frame. */
  private impactHurt(vehicleDamage: number, riderDamage: number, impact: number): void {
    if (this.spec.twoWheeler && this.playerControlled) { this.riderDamage += riderDamage; this.riderImpact = Math.max(this.riderImpact, impact); }
    else this.takeDamage(vehicleDamage);
  }

  consumeRiderHit(): { damage: number; impact: number } {
    const hit = { damage: this.riderDamage, impact: this.riderImpact };
    this.riderDamage = 0; this.riderImpact = 0; return hit;
  }

  ignite(random: () => number = Math.random): void {
    if (this.onFire || this.wrecked) return;
    this.onFire = true; this.disabled = true; this.health = 0; this.burnTimer = rollBurnDuration(random);
  }

  wreck(): void {
    if (this.wrecked) return;
    this.wrecked = true; this.onFire = false; this.disabled = true; this.health = 0; this.speed = 0; this.occupied = false; this.burnTimer = 0;
    if (this.spec.twoWheeler) { this.group.rotation.z = Math.PI * 0.42; if (this.rider) this.rider.visible = false; } // a dead bike falls over
    const lightbar = this.group.getObjectByName('lightbar'); if (lightbar) lightbar.visible = false;
    this.applyWreckAppearance();
  }

  private applyWreckAppearance(): void {
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
    if (this.spec.twoWheeler) this.group.rotation.z = 0;
    const lightbar = this.group.getObjectByName('lightbar'); if (lightbar) lightbar.visible = true;
    this.forEachMaterial((material) => {
      if (material.userData.originalColor !== undefined) material.color.setHex(material.userData.originalColor as number);
      if ('emissiveIntensity' in material && material.userData.originalEmissive !== undefined) material.emissiveIntensity = material.userData.originalEmissive as number;
    });
    this.setHeadlightGlow(this.headlightFactor); this.applyBrakeLights();
  }

  private forEachMaterial(apply: (material: VehicleMaterial) => void): void {
    const seen = new Set<VehicleMaterial>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.parent?.name === 'firefx' || object.name === 'sign') return; // sign meshes share the atlas material with the whole city
      const material = object.material as VehicleMaterial;
      if (seen.has(material)) return;
      seen.add(material); apply(material);
    });
  }

  setFirstPerson(firstPerson: boolean): void { this.firstPerson = firstPerson; for (const part of this.cabinParts) part.visible = !firstPerson; } // hide cabin glass/roof so the driver view is unobstructed

  /** Kept for the public driving API; the uniform minibus fleet has no roof-mounted duty light. */
  setTaxiLight(available: boolean): void { void available; /* taxi duty remains visible in the HUD */ }

  /** Are this vehicle's headlights actually throwing light? Night glow past half, not a wreck, and not a
   *  bicycle (no lamp — the same exclusion DayNight's beam pool applies). Blackout stealth reads this. */
  get headlightsOn(): boolean { return !this.wrecked && this.headlightFactor > 0.5 && this.spec.kind !== 'bicycle'; }

  /** 0 = day (subtle lens glow), 1 = night: headlight lenses go HDR-bright so they bloom. Brake lights are untouched. */
  setHeadlightGlow(factor: number): void {
    this.headlightFactor = factor;
    if (this.wrecked) return;
    const intensity = 1.15 + factor * 4.6;
    for (const light of this.headLights) (light.material as THREE.MeshStandardMaterial).emissiveIntensity = intensity;
  }

  reset(position?: THREE.Vector3, city?: City): void {
    if (position) this.group.position.copy(position);
    this.groundY = (city ? city.roadHeightAt(this.group.position.x, this.group.position.z) : this.group.position.y) + 0.02;
    this.group.position.y = this.groundY; this.group.rotation.set(0, this.heading, 0); this.speed = 0;
  }

  /** Network/replay presentation hook: animate the authored wheels, steering and lamps from an
   *  authoritative pose without running local vehicle physics. */
  updatePresentation(dt: number, braking: boolean): void { this.updateVisuals(dt, braking); }

  private move(dt: number, city: City): void {
    const old = this.group.position.clone();
    const next = old.clone(); next.x += Math.sin(this.heading) * this.speed * dt; next.z += Math.cos(this.heading) * this.speed * dt;
    const radius = Math.max(this.spec.size[0], this.spec.size[2]) * 0.34;
    const props = city.props as PropRegistry | undefined; // sim tests mock City without a prop registry
    const direction = Math.sign(this.speed || 1);
    const felled = props?.tryKnockdown(next.x, next.z, radius, this.speed, Math.sin(this.heading) * direction, Math.cos(this.heading) * direction) ?? 0;
    if (felled > 0) { this.impactHurt(knockoverDamage(this.speed) * felled, knockoverDamage(this.speed) * felled * 0.5, 0); this.speed *= KNOCKOVER_SPEED_KEEP ** felled; } // fast enough: props tip, car ploughs on
    const resolved = city.clampMove(old, next, radius);
    if (resolved.distanceToSquared(next) > 0.01) {
      const impact = Math.abs(this.speed); this.speed *= -0.16; this.collided = true;
      this.impactHurt(props?.solidBlocked(next.x, next.z, radius) ? solidImpactDamage(impact) : Math.max(0, impact - 8) * 0.35, riderImpactDamage(impact), impact); // trees hit back harder than walls
    }
    this.groundY = city.roadHeightAt(resolved.x, resolved.z) + 0.02;
    this.group.position.copy(resolved).setY(this.groundY); this.alignToRoad(city, dt);
  }

  private alignToRoad(city: City, dt: number): void {
    const normal = city.surfaceNormalAt(this.group.position.x, this.group.position.z, 'road');
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)).projectOnPlane(normal).normalize();
    const right = new THREE.Vector3().crossVectors(normal, forward).normalize();
    const target = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, normal, forward));
    // Two-wheelers bank by rolling about their own forward axis ON TOP of the road alignment — never by poking Euler.z,
    // which cross-couples with terrain pitch in the XYZ decomposition and can snap the whole bike onto its side mid-turn.
    if (this.spec.twoWheeler && !this.wrecked) target.multiply(new THREE.Quaternion().setFromAxisAngle(FORWARD_AXIS, this.bikeLean));
    this.group.quaternion.slerp(target, 1 - Math.exp(-dt * 10));
  }

  private updateVisuals(dt: number, braking: boolean): void {
    this.braking = braking;
    const spin = this.speed * dt / this.rollRadius; // per-kind rolling radius: bike wheels are not 0.36 m
    if (this.spec.twoWheeler) {
      for (const wheel of this.wheels) wheel.rotation.x += spin;
      // 0.2232 = 0.62 * 0.36, the factor that puts the crank on the same clock as RiggedPlayerVisual's
      // pedalPhase (dt * speed * 0.62) — before this the chainring spun 1.88x faster than the rider's legs.
      for (const crank of this.cranks) crank.rotation.x += this.speed * dt * 0.62;
      if (this.steerGroup) this.steerGroup.rotation.y = this.steeringVisual * 0.7;
      if (this.rider) this.rider.visible = this.occupied && !this.playerControlled && !this.wrecked;
      const parked = !this.playerControlled && !this.occupied && Math.abs(this.speed) < 0.5;
      const target = bikeLeanTarget(this.steeringVisual, this.speed, this.spec.maxSpeed, parked || this.disabled); // kickstand tilt, or lean into the turn
      this.bikeLean = THREE.MathUtils.lerp(this.bikeLean, target, Math.min(1, dt * 7)); // alignToRoad banks by this about the forward axis
    } else this.wheels.forEach((wheel, index) => { wheel.rotation.x += spin; if (index < 2) wheel.rotation.y = this.steeringVisual; });
    if (this.bounce > 0.001) {
      this.bouncePhase += dt * 34;
      this.group.position.y = this.groundY + this.bounce * Math.abs(Math.sin(this.bouncePhase));
      this.bounce *= Math.exp(-7 * dt);
      if (this.bounce <= 0.001) { this.bounce = 0; this.group.position.y = this.groundY; }
    }
    this.applyBrakeLights();
    if (this.police) {
      const lights = this.group.getObjectByName('lightbar')?.children ?? [];
      if (this.sirenOn) { this.lightPhase += dt * 11; lights.forEach((light: THREE.Object3D, i: number) => { light.visible = Math.sin(this.lightPhase + i * Math.PI) > 0; }); }
      else lights.forEach((light: THREE.Object3D) => { light.visible = true; }); // siren off: lightbar steady
    }
  }

  private applyBrakeLights(): void {
    this.brakeLights.forEach((light) => (light.material as THREE.MeshStandardMaterial).color.setHex(this.braking ? 0xff2018 : 0x5b0808));
  }

  /** Loading-menu fallback only; the required startup gate prevents this neutral shell reaching gameplay. */
  private buildTaxiPlaceholder(): void {
    const placeholder = new THREE.Group(); placeholder.name = 'taxi-loading-placeholder'; this.taxiPlaceholder = placeholder;
    const body = new THREE.MeshStandardMaterial({ color: 0xe8e9e4, roughness: 0.62 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x20282b, roughness: 0.7 });
    const lower = new THREE.Mesh(new RoundedBoxGeometry(2.04, 0.82, 5.04, 2, 0.09), body); lower.position.y = 0.82;
    const cabin = new THREE.Mesh(new RoundedBoxGeometry(1.96, 1.32, 4.42, 2, 0.1), body); cabin.position.set(0, 1.52, -0.02); cabin.name = 'taxi-loading-cabin';
    placeholder.add(lower, cabin); this.cabinParts.push(cabin);
    const wheelGeometry = new THREE.CylinderGeometry(0.405, 0.405, 0.24, 16); wheelGeometry.rotateZ(Math.PI / 2);
    for (const z of [1.6, -1.6]) for (const x of [-0.9, 0.9]) {
      const pivot = new THREE.Group(); pivot.position.set(x, 0.405, z); if (z > 0) pivot.rotation.order = 'YXZ';
      const wheel = new THREE.Mesh(wheelGeometry, dark); pivot.add(wheel); placeholder.add(pivot); this.wheels.push(pivot);
    }
    const lightGeometry = new THREE.BoxGeometry(0.4, 0.18, 0.05);
    for (const x of [-0.55, 0.55]) {
      const front = new THREE.Mesh(lightGeometry, new THREE.MeshStandardMaterial({ color: 0xf4edc5, emissive: 0xffe7a0, emissiveIntensity: 1.15 })); front.position.set(x, 0.82, 2.55);
      const rear = new THREE.Mesh(lightGeometry, new THREE.MeshStandardMaterial({ color: 0x5b0808, emissive: 0x390000, emissiveIntensity: 1.8 })); rear.position.set(x, 0.82, -2.55);
      placeholder.add(front, rear); this.headLights.push(front); this.brakeLights.push(rear);
    }
    placeholder.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
    this.detailRoot = placeholder; this.group.add(placeholder);
  }

  private releaseTaxiPlaceholder(): void {
    const placeholder = this.taxiPlaceholder; if (!placeholder) return;
    placeholder.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    });
    placeholder.removeFromParent(); this.taxiPlaceholder = undefined;
  }

  private mountTaxiModel(instance: TaxiModelInstance): void {
    if (this.disposed) return;
    this.releaseTaxiPlaceholder();
    this.wheels = [...instance.wheels]; this.headLights = [...instance.headLights]; this.brakeLights = [...instance.brakeLights]; this.cabinParts = [...instance.cabinParts];
    this.wheels[0]!.rotation.order = 'YXZ'; this.wheels[1]!.rotation.order = 'YXZ';
    this.sharedGeometries = new Set(instance.sharedGeometries);
    if (this.lodProxy) this.sharedGeometries.add(this.lodProxy.geometry);
    this.ownedMaterials = new Set(instance.ownedMaterials);
    this.detailRoot = instance.root; instance.root.visible = this.visualLod === 'detail';
    this.group.add(instance.root); instance.root.userData.vehicleVisual = 'quantum-express';
    this.setFirstPerson(this.firstPerson); this.setHeadlightGlow(this.headlightFactor); this.applyBrakeLights();
    if (this.wrecked) this.applyWreckAppearance();
  }

  private buildTaxiModel(): void {
    const instance = instantiateTaxiModel();
    if (instance) { this.mountTaxiModel(instance); return; }
    this.buildTaxiPlaceholder();
    this.taxiReadyUnsubscribe = onTaxiLibraryReady(() => {
      const loaded = instantiateTaxiModel(); if (loaded) this.mountTaxiModel(loaded);
      this.taxiReadyUnsubscribe = undefined;
    });
  }

  private releaseRoadPlaceholder(): void {
    const placeholder = this.roadPlaceholder; if (!placeholder) return;
    const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>();
    placeholder.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose();
    placeholder.removeFromParent(); this.roadPlaceholder = undefined;
  }

  private mountRoadModel(instance: RoadVehicleModelInstance): void {
    if (this.disposed) return;
    this.releaseRoadPlaceholder();
    this.wheels = [...instance.wheels]; this.headLights = [...instance.headLights]; this.brakeLights = [...instance.brakeLights]; this.cabinParts = [...instance.cabinParts];
    this.wheels[0]!.rotation.order = 'YXZ'; this.wheels[1]!.rotation.order = 'YXZ';
    this.sharedGeometries = new Set(instance.sharedGeometries);
    if (this.lodProxy) this.sharedGeometries.add(this.lodProxy.geometry);
    this.ownedMaterials = new Set(instance.ownedMaterials);
    this.detailRoot = instance.root; instance.root.visible = this.visualLod === 'detail';
    this.group.add(instance.root); instance.root.userData.vehicleVisual = this.spec.kind;
    this.setFirstPerson(this.firstPerson); this.setHeadlightGlow(this.headlightFactor); this.applyBrakeLights();
    if (this.wrecked) this.applyWreckAppearance();
  }

  private buildModel(): void {
    if (this.spec.twoWheeler) { this.buildTwoWheeler(); return; }
    if (this.spec.kind === 'taxi') { this.buildTaxiModel(); return; }
    if (!isRoadVehicleKind(this.spec.kind)) return;
    const kind = this.spec.kind;
    const authored = instantiateRoadVehicleModel(kind, this.spec.color);
    if (authored) { this.mountRoadModel(authored); return; }
    const placeholder = new THREE.Group(); placeholder.name = 'road-car-loading-placeholder'; this.roadPlaceholder = placeholder;
    const [width, height, length] = this.spec.size;
    const sport = this.spec.kind === 'sport'; const van = this.spec.kind === 'van';
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: this.spec.color, metalness: 0.32, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.13 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x151a1c, metalness: 0.52, roughness: 0.32 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xa9b0b0, metalness: 0.9, roughness: 0.18 });
    const glass = new THREE.MeshPhysicalMaterial({ color: this.police ? 0x263e4a : 0x213e49, roughness: 0.08, metalness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05 });
    const bodyHeight = height * (van ? 0.32 : sport ? 0.42 : 0.5);
    const body = new THREE.Mesh(new RoundedBoxGeometry(width, bodyHeight, length, 4, Math.min(0.18, bodyHeight * 0.28)), bodyMat); body.name = 'body'; body.position.y = 0.38 + bodyHeight / 2; body.castShadow = true; body.receiveShadow = true;
    const hoodLength = van ? length * 0.24 : length * 0.34;
    const hood = new THREE.Mesh(new RoundedBoxGeometry(width * 0.94, van ? 0.42 : sport ? 0.24 : 0.34, hoodLength, 3, 0.09), bodyMat); hood.position.set(0, body.position.y + bodyHeight * 0.45, van ? length * 0.37 : length * 0.34); hood.castShadow = true;
    const cabinHeight = van ? height * 0.58 : height * (sport ? 0.48 : 0.56);
    const cabinLength = van ? length * 0.36 : length * 0.48;
    const cabin = new THREE.Mesh(new RoundedBoxGeometry(width * 0.82, cabinHeight, cabinLength, 4, 0.14), glass); cabin.position.set(0, body.position.y + bodyHeight * 0.45 + cabinHeight / 2, van ? length * 0.1 : -length * 0.05); cabin.castShadow = true;
    const roof = new THREE.Mesh(new RoundedBoxGeometry(width * 0.84, 0.13, cabinLength * 0.9, 3, 0.05), bodyMat); roof.position.set(0, cabin.position.y + cabinHeight / 2 + 0.02, cabin.position.z); roof.castShadow = true;
    const frontBumper = new THREE.Mesh(new RoundedBoxGeometry(width * 0.9, 0.16, 0.16, 2, 0.05), trimMat); frontBumper.position.set(0, 0.43, length / 2 + 0.08);
    const rearBumper = frontBumper.clone(); rearBumper.position.z = -length / 2 - 0.08;
    const grille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.42, 0.25, 0.035), trimMat); grille.position.set(0, 0.64, length / 2 + 0.095);
    const lowerGrille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.28, 0.07, 0.042), chrome); lowerGrille.position.set(0, 0.63, length / 2 + 0.116);
    placeholder.add(body, hood, cabin, roof, frontBumper, rearBumper, grille, lowerGrille);
    this.cabinParts.push(cabin, roof);
    if (van) {
      const bed = new THREE.Group(); bed.name = 'bakkie-bed'; bed.position.z = -length * 0.29;
      const floor = new THREE.Mesh(new RoundedBoxGeometry(width * 0.9, 0.14, length * 0.39, 2, 0.04), bodyMat); floor.position.y = 0.82;
      const frontWall = new THREE.Mesh(new RoundedBoxGeometry(width * 0.9, 0.54, 0.12, 2, 0.035), bodyMat); frontWall.position.set(0, 1.04, length * 0.19);
      const tailgate = frontWall.clone(); tailgate.position.z = -length * 0.19;
      bed.add(floor, frontWall, tailgate);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.54, length * 0.39, 2, 0.035), bodyMat); rail.position.set(side * width * 0.43, 1.04, 0); bed.add(rail);
      }
      placeholder.add(bed);
    }
    for (const side of [-1, 1]) {
      const skirt = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.15, length * 0.68, 2, 0.04), trimMat); skirt.position.set(side * width * 0.49, 0.4, 0); placeholder.add(skirt);
      const mirror = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.15, 0.34, 3, 0.07), bodyMat); mirror.position.set(side * width * 0.56, cabin.position.y + 0.08, cabin.position.z + cabinLength * 0.32); mirror.castShadow = true; placeholder.add(mirror);
    }
    const wheelRadius = van ? 0.41 : sport ? 0.38 : 0.37;
    const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.27, 24); wheelGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(wheelRadius * 0.52, wheelRadius * 0.52, 0.285, 12); rimGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x101315, roughness: 0.76 });
    for (const z of [length * 0.31, -length * 0.31]) for (const x of [-width * 0.52, width * 0.52]) {
      const assembly = new THREE.Group(); assembly.position.set(x, wheelRadius, z);
      if (z > 0) assembly.rotation.order = 'YXZ'; // front (steered) wheels: apply steer (Y) before roll (X) so the roll spins about the steered axle — default XYZ rolls about the original axle and the turned wheel wobbles
      const wheel = new THREE.Mesh(wheelGeo, wheelMat); wheel.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, chrome); assembly.add(wheel, rim); placeholder.add(assembly); this.wheels.push(assembly);
    }
    const lightGeo = new RoundedBoxGeometry(0.38, 0.17, 0.07, 2, 0.03);
    for (const x of [-width * 0.29, width * 0.29]) {
      const rear = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({ color: 0x5b0808, emissive: 0x390000, emissiveIntensity: 1.8, roughness: 0.22 })); rear.position.set(x, 0.65, -length / 2 - 0.1); placeholder.add(rear); this.brakeLights.push(rear);
      const front = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({ color: 0xf4edc5, emissive: 0xffe7a0, emissiveIntensity: 1.15, roughness: 0.12 })); front.position.set(x, 0.65, length / 2 + 0.1); placeholder.add(front); this.headLights.push(front);
    }
    const plateMaterial = new THREE.MeshStandardMaterial({ color: 0xe7e4cf, roughness: 0.5 });
    const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.18, 0.035), plateMaterial); frontPlate.position.set(0, 0.39, length / 2 + 0.18);
    const rearPlate = frontPlate.clone(); rearPlate.position.z = -length / 2 - 0.18; placeholder.add(frontPlate, rearPlate);
    if (sport) { const spoiler = new THREE.Mesh(new RoundedBoxGeometry(width * 0.62, 0.09, 0.2, 2, 0.03), bodyMat); spoiler.position.set(0, 1.02, -length * 0.43); placeholder.add(spoiler); }
    if (this.police) {
      const bar = new THREE.Group(); bar.name = 'lightbar'; bar.position.y = roof.position.y + 0.17;
      const mount = new THREE.Mesh(new RoundedBoxGeometry(0.98, 0.07, 0.17, 2, 0.02), trimMat); bar.add(mount);
      for (const [x, color] of [[-0.28, 0x226dff], [0.28, 0xff3028]] as const) { const light = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.14, 0.18, 2, 0.03), new THREE.MeshBasicMaterial({ color })); light.position.x = x; bar.add(light); }
      placeholder.add(bar); this.cabinParts.push(bar);
    }
    placeholder.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; } }); // frustumCulled left default (true): an off-screen bakkie must not render in the main AND shadow pass
    this.detailRoot = placeholder; this.group.add(placeholder);
    this.roadReadyUnsubscribe = onRoadVehicleLibraryReady(kind, () => {
      const loaded = instantiateRoadVehicleModel(kind, this.spec.color); if (loaded) this.mountRoadModel(loaded);
      this.roadReadyUnsubscribe = undefined;
    });
  }

  /**
   * Two-wheelers come from the shared code-built library: geometry is cached per kind for the whole
   * session and only materials are cloned, so a street full of couriers costs one geometry upload
   * rather than thirty-four per bike. Handles are resolved by name out of the clone.
   */
  private buildTwoWheeler(): void {
    const instance = instantiateBikeModel(this.spec.kind as TwoWheelerKind, this.spec.color);
    this.wheels = [...instance.wheels]; this.steerGroup = instance.steerGroup; this.cranks = [...instance.cranks];
    this.rider = instance.rider; this.headLights = [...instance.headLights]; this.brakeLights = [...instance.brakeLights];
    this.rollRadius = instance.rollRadius;
    this.sharedGeometries = new Set(instance.sharedGeometries); this.ownedMaterials = new Set(instance.ownedMaterials);
    this.detailRoot = instance.root; instance.root.visible = this.visualLod === 'detail'; this.group.add(instance.root);
    this.group.rotation.z = 0.15; // spawn resting on the kickstand; updateVisuals takes over once ridden
    this.setHeadlightGlow(this.headlightFactor); this.applyBrakeLights();
  }
}
