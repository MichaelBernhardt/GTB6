import * as THREE from 'three';

/** Handheld torch (SA for flashlight): a steady warm-white beam that follows free-look — centre screen is where it points. */
export const TORCH_COLOR = 0xffe9c2; export const TORCH_INTENSITY = 150; export const TORCH_RANGE = 55; export const TORCH_DECAY = 2;
export const TORCH_INNER_DEG = 12; export const TORCH_OUTER_DEG = 22;
export const TORCH_PENUMBRA = 1 - TORCH_INNER_DEG / TORCH_OUTER_DEG; // three's penumbra is the softened fraction of the cone, so this yields a ~12° hot core inside the 22° cone
export const TORCH_CHEST_HEIGHT = 1.35; // beam origin above the carrier's feet in third person — reads as held at the chest/hand
export const TORCH_FP_FORWARD = 0.4; // first person: start just ahead of the eye so the cone never clips the near plane

const DIR = new THREE.Vector3();

export class TorchSystem {
  on = false; // never persisted — every session starts with the torch pocketed
  private light: THREE.SpotLight;

  constructor(scene: THREE.Scene) {
    this.light = new THREE.SpotLight(TORCH_COLOR, 0, TORCH_RANGE, THREE.MathUtils.degToRad(TORCH_OUTER_DEG), TORCH_PENUMBRA, TORCH_DECAY);
    this.light.castShadow = false; // matches every other dynamic light in the pool; a shadowed spot tanks low-end/SwiftShader
    this.light.name = 'Torch';
    scene.add(this.light, this.light.target);
  }

  toggle(): boolean { this.on = !this.on; return this.on; }

  /** Aim from the carrier's chest (or just ahead of the eye in first person) at the point the camera looks at, so the beam tracks free-look. */
  frame(camera: THREE.Camera, carrier: THREE.Vector3, firstPerson: boolean, enabled: boolean): void {
    const lit = this.on && enabled;
    this.light.intensity = lit ? TORCH_INTENSITY : 0;
    if (!lit) return;
    camera.getWorldDirection(DIR);
    if (firstPerson) this.light.position.copy(camera.position).addScaledVector(DIR, TORCH_FP_FORWARD);
    else this.light.position.set(carrier.x, carrier.y + TORCH_CHEST_HEIGHT, carrier.z);
    this.light.target.position.copy(camera.position).addScaledVector(DIR, TORCH_RANGE); // far aim point ≈ centre screen for everything past the carrier
  }

  /** Test/debug handle: the live spotlight. */
  get spot(): THREE.SpotLight { return this.light; }
}
