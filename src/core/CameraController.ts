import * as THREE from 'three';
import type { InputManager } from './InputManager';
import type { City } from '../world/City';

export const CAMERA_VIEW_NAMES = ['First person', 'Near', 'Medium', 'Far'] as const;
export const DEFAULT_CAMERA_VIEW = 2; // Medium
export const FOOT_VIEW_DISTANCES = [0, 4.2, 6.35, 9.5] as const;
export const VEHICLE_VIEW_DISTANCES = [0, 7.5, 10.5, 15] as const;
export const VEHICLE_VIEW_HEIGHTS = [0, 2.1, 2.6, 3.4] as const;
const FP_EYE_FOOT = 1.62;
const FP_EYE_VEHICLE = 1.25; // driver eye above the vehicle origin in a normal-height car
const VEHICLE_EYE_REF_HEIGHT = 1.35; // spec height at/below which the base eye is used (a compact)
const VEHICLE_EYE_RISE = 1.2; // extra eye height per metre of vehicle height above the reference — taller cabs/vans seat the driver higher so the hood doesn't fill the view
const FP_PITCH_LIMIT = 1.2;
const FP_AIM_ZOOM = 8; // degrees of FOV tightening at full aim (60 -> 52)
const FP_VEHICLE_RECENTER_DELAY = 1.5; // seconds the mouse must sit still before a first-person driving glance eases back to forward (GTA-ish; tune by feel)
const FOOT_TRAIL_RATE = 1.2; // lazy on-foot auto-follow: how fast the boom swings behind the direction of travel when the player isn't actively looking (GTA-style; keeps keyboard/gamepad-only players oriented). Higher = snappier.

export function sanitizeView(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < CAMERA_VIEW_NAMES.length ? raw : DEFAULT_CAMERA_VIEW;
}
export function cycleView(view: number): number { return (sanitizeView(view) + 1) % CAMERA_VIEW_NAMES.length; }
export function viewDistance(view: number, vehicle: boolean): number { return (vehicle ? VEHICLE_VIEW_DISTANCES : FOOT_VIEW_DISTANCES)[sanitizeView(view)]; }
/** Aiming pulls Medium/Far in to the Near distance; Near and first person keep their base distance. */
export function aimedViewDistance(view: number, vehicle: boolean, aimBlend: number): number {
  const base = viewDistance(view, vehicle);
  return THREE.MathUtils.lerp(base, Math.min(base, viewDistance(1, vehicle)), aimBlend);
}

export class CameraController {
  yaw = 0;
  pitch = 0.35;
  aiming = false;
  private aimBlend = 0;
  private lookOffset = 0;
  private lookIdle = 0; // seconds the mouse has been still, gating the first-person driving recenter (no tug-of-war mid-glance)
  private recoilReturn = 0;
  private baseFov: number;
  private focus = new THREE.Vector3();
  private desired = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) { this.baseFov = camera.fov; }

  /** Firing kick: an instant upward pitch bump; a bit over half of it settles back over the next beats. */
  recoil(amount: number): void { this.pitch -= amount; this.recoilReturn += amount * 0.55; }

  /** After a teleport: parks the boom straight behind the target so the camera doesn't fly across town. */
  snapBehind(target: THREE.Vector3, distance = 6): void {
    const horizontal = Math.cos(this.pitch) * distance;
    this.camera.position.set(target.x + Math.sin(this.yaw) * horizontal, target.y + 1.45 + Math.sin(this.pitch) * distance, target.z + Math.cos(this.yaw) * horizontal);
  }

  update(dt: number, input: InputManager, target: THREE.Vector3, city: City, vehicle = false, sensitivity = 0.0025, view = DEFAULT_CAMERA_VIEW, vehicleHeading = 0, aimAllowed = true, coverLean = 0, scopeFov = 0, extraDistance = 0, steerLock = false, vehicleHeight = 0, footTrailHeading = 0, footTrail = false): void {
    const scoped = scopeFov > 0 && !vehicle; // sniper scope: first-person eye regardless of the chosen view
    const firstPerson = sanitizeView(view) === 0 || scoped;
    if (firstPerson && vehicle) {
      if (steerLock) { this.lookIdle = 0; this.lookOffset *= Math.exp(-dt * 1.4); } // mouse-steering holds the view forward — the drag turns the wheel, not the head
      else {
        this.lookOffset = THREE.MathUtils.clamp(this.lookOffset - input.mouseDX * sensitivity, -Math.PI, Math.PI); // glance accumulates freely while the mouse moves (can look full left/right/behind, never winds up past it)
        this.lookIdle = input.mouseDX === 0 && input.mouseDY === 0 ? this.lookIdle + dt : 0;
        if (this.lookIdle > FP_VEHICLE_RECENTER_DELAY) this.lookOffset *= Math.exp(-dt * 1.4); // only ease back to forward after the mouse has been still — no fighting the player mid-glance
      }
      this.yaw = vehicleHeading + Math.PI + this.lookOffset;
    }
    else if (steerLock && vehicle) { this.lookOffset = 0; const behind = vehicleHeading + Math.PI; this.yaw += Math.atan2(Math.sin(behind - this.yaw), Math.cos(behind - this.yaw)) * (1 - Math.exp(-dt * 6)); } // mouse-steering: the drag turns the vehicle, so tail behind the heading instead of letting mouseDX orbit
    else {
      this.lookOffset = 0; this.yaw -= input.mouseDX * sensitivity;
      if (footTrail && !vehicle && input.mouseDX === 0) { const behind = footTrailHeading + Math.PI; this.yaw += Math.atan2(Math.sin(behind - this.yaw), Math.cos(behind - this.yaw)) * (1 - Math.exp(-dt * FOOT_TRAIL_RATE)); } // lazy GTA follow: ease behind the direction of travel while the player isn't actively looking (mouse motion this frame suppresses it, so it never fights a mouse player)
    }
    if (this.recoilReturn > 0) { const back = this.recoilReturn * (1 - Math.exp(-dt * 5)); this.pitch += back; this.recoilReturn -= back; }
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.mouseDY * sensitivity, firstPerson ? -FP_PITCH_LIMIT : -0.1, firstPerson ? FP_PITCH_LIMIT : 0.9);
    this.aiming = input.aiming && aimAllowed; // aim mode needs a ranged weapon in hand
    this.aimBlend += ((this.aiming ? 1 : 0) - this.aimBlend) * (1 - Math.exp(-dt * 10));
    if (firstPerson) { this.updateFirstPerson(target, vehicle, vehicleHeading, scoped ? scopeFov : 0, vehicleHeight); return; }
    this.setFov(this.baseFov);
    const distance = aimedViewDistance(view, vehicle, this.aimBlend) + extraDistance; // skydives pull the boom further back
    const baseHeight = VEHICLE_VIEW_HEIGHTS[sanitizeView(view)];
    const height = vehicle ? THREE.MathUtils.lerp(baseHeight, Math.min(baseHeight, VEHICLE_VIEW_HEIGHTS[1]), this.aimBlend) : THREE.MathUtils.lerp(1.45, 1.78, this.aimBlend);
    this.focus.set(target.x, target.y + height, target.z);
    if (!vehicle) {
      const shoulder = 0.98 * this.aimBlend + coverLean; // centered when relaxed, over the right shoulder while aiming; cover pulls toward the exposed corner
      this.focus.x += Math.cos(this.yaw) * shoulder;
      this.focus.z -= Math.sin(this.yaw) * shoulder;
    }
    const horizontal = Math.cos(this.pitch) * distance;
    this.desired.set(
      this.focus.x + Math.sin(this.yaw) * horizontal,
      this.focus.y + Math.sin(this.pitch) * distance,
      this.focus.z + Math.cos(this.yaw) * horizontal,
    );
    const direction = this.desired.clone().sub(this.focus);
    const steps = 10;
    const valid = this.focus.clone();
    for (let i = 1; i <= steps; i++) {
      const probe = this.focus.clone().addScaledVector(direction, i / steps);
      if (city.collidesAt(probe.x, probe.z, 0.25, probe.y - 0.2, probe.y + 0.2)) break; // y-aware: a roof below the boom arm is not an obstruction
      valid.copy(probe);
    }
    const responsiveness = 1 - Math.exp(-dt * (vehicle ? 5 : 9));
    this.camera.position.lerp(valid, responsiveness);
    this.camera.lookAt(this.focus);
  }

  private updateFirstPerson(target: THREE.Vector3, vehicle: boolean, vehicleHeading: number, scopeFov = 0, vehicleHeight = 0): void {
    const vehicleEye = FP_EYE_VEHICLE + Math.max(0, vehicleHeight - VEHICLE_EYE_REF_HEIGHT) * VEHICLE_EYE_RISE; // sit higher in a taller vehicle so the bonnet clears the view
    this.focus.set(target.x, target.y + (vehicle ? vehicleEye : FP_EYE_FOOT), target.z);
    if (vehicle) { this.focus.x += Math.sin(vehicleHeading) * 0.25 + Math.cos(vehicleHeading) * 0.33; this.focus.z += Math.cos(vehicleHeading) * 0.25 - Math.sin(vehicleHeading) * 0.33; } // driver seat: forward + door side
    this.camera.position.copy(this.focus);
    const cosPitch = Math.cos(this.pitch);
    this.camera.lookAt(this.focus.x - Math.sin(this.yaw) * cosPitch, this.focus.y - Math.sin(this.pitch), this.focus.z - Math.cos(this.yaw) * cosPitch);
    this.setFov(scopeFov > 0 ? scopeFov : this.baseFov - (vehicle ? 0 : FP_AIM_ZOOM * this.aimBlend));
  }

  private setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) < 0.01) return;
    this.camera.fov = fov; this.camera.updateProjectionMatrix();
  }

  forward(): THREE.Vector3 { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize(); }
}
