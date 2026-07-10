import * as THREE from 'three';
import type { InputManager } from './InputManager';
import type { City } from '../world/City';

export class CameraController {
  yaw = 0;
  pitch = 0.35;
  aiming = false;
  private aimBlend = 0;
  private focus = new THREE.Vector3();
  private desired = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {}

  update(dt: number, input: InputManager, target: THREE.Vector3, city: City, vehicle = false, sensitivity = 0.0025): void {
    this.yaw -= input.mouseDX * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.mouseDY * sensitivity, -0.1, 0.9);
    this.aiming = input.firing && !vehicle;
    this.aimBlend += ((this.aiming ? 1 : 0) - this.aimBlend) * (1 - Math.exp(-dt * 10));
    const distance = vehicle ? 10.5 : THREE.MathUtils.lerp(6.35, 4.4, this.aimBlend);
    const height = vehicle ? 2.6 : THREE.MathUtils.lerp(1.45, 1.78, this.aimBlend);
    this.focus.set(target.x, target.y + height, target.z);
    if (!vehicle) {
      const shoulder = THREE.MathUtils.lerp(0.62, 0.98, this.aimBlend);
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

  forward(): THREE.Vector3 { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize(); }
}
