import * as THREE from 'three';
import type { InputManager } from './InputManager';
import type { City } from '../world/City';

export const CAMERA_VIEW_NAMES = ['First person', 'Near', 'Medium', 'Far'] as const;
export const DEFAULT_CAMERA_VIEW = 2; // Medium
export const FOOT_VIEW_DISTANCES = [0, 4.2, 6.35, 9.5] as const;
export const VEHICLE_VIEW_DISTANCES = [0, 7.5, 10.5, 15] as const;
export const VEHICLE_VIEW_HEIGHTS = [0, 2.1, 2.6, 3.4] as const;
const FP_EYE_FOOT = 1.62;
const FP_EYE_VEHICLE = 1.25;
const FP_PITCH_LIMIT = 1.2;
const FP_AIM_ZOOM = 8; // degrees of FOV tightening at full aim (60 -> 52)

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
  private recoilReturn = 0;
  private baseFov: number;
  private focus = new THREE.Vector3();
  private desired = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) { this.baseFov = camera.fov; }

  /** Firing kick: an instant upward pitch bump; a bit over half of it settles back over the next beats. */
  recoil(amount: number): void { this.pitch -= amount; this.recoilReturn += amount * 0.55; }

  update(dt: number, input: InputManager, target: THREE.Vector3, city: City, vehicle = false, sensitivity = 0.0025, view = DEFAULT_CAMERA_VIEW, vehicleHeading = 0, aimAllowed = true, coverLean = 0, scopeFov = 0): void {
    const scoped = scopeFov > 0 && !vehicle; // sniper scope: first-person eye regardless of the chosen view
    const firstPerson = sanitizeView(view) === 0 || scoped;
    if (firstPerson && vehicle) { this.lookOffset = (this.lookOffset - input.mouseDX * sensitivity) * Math.exp(-dt * 1.4); this.yaw = vehicleHeading + Math.PI + this.lookOffset; }
    else { this.lookOffset = 0; this.yaw -= input.mouseDX * sensitivity; }
    if (this.recoilReturn > 0) { const back = this.recoilReturn * (1 - Math.exp(-dt * 5)); this.pitch += back; this.recoilReturn -= back; }
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.mouseDY * sensitivity, firstPerson ? -FP_PITCH_LIMIT : -0.1, firstPerson ? FP_PITCH_LIMIT : 0.9);
    this.aiming = input.aiming && aimAllowed; // aim mode needs a ranged weapon in hand
    this.aimBlend += ((this.aiming ? 1 : 0) - this.aimBlend) * (1 - Math.exp(-dt * 10));
    if (firstPerson) { this.updateFirstPerson(target, vehicle, vehicleHeading, scoped ? scopeFov : 0); return; }
    this.setFov(this.baseFov);
    const distance = aimedViewDistance(view, vehicle, this.aimBlend);
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
      if (city.collides(probe.x, probe.z, 0.25)) break;
      valid.copy(probe);
    }
    const responsiveness = 1 - Math.exp(-dt * (vehicle ? 5 : 9));
    this.camera.position.lerp(valid, responsiveness);
    this.camera.lookAt(this.focus);
  }

  private updateFirstPerson(target: THREE.Vector3, vehicle: boolean, vehicleHeading: number, scopeFov = 0): void {
    this.focus.set(target.x, target.y + (vehicle ? FP_EYE_VEHICLE : FP_EYE_FOOT), target.z);
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
