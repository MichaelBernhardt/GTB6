import * as THREE from 'three';

/**
 * Shared muzzle-flash pool for NPC gunfire — JMPD and armed civilians alike. NPC fire is
 * probabilistic hitscan with no projectile, so a brief additive glow at the muzzle (plus the
 * report) is the entire visible event. MESHES, never lights: adding/removing a scene light
 * re-keys every lit material against the changed light count (the shader-recompile bug
 * EffectLightPool exists to kill), while an additive unlit mesh costs nothing to toggle.
 * Pooled: the high-water mark is the number of simultaneous unexpired flashes — a handful
 * at worst. Extracted from PoliceSystem so armed-civilian fire reuses the one gun path
 * instead of growing a second.
 */
export const FLASH_SECONDS = 0.07;
const FLASH_GEOMETRY = new THREE.SphereGeometry(0.13, 8, 6);
const FLASH_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
interface MuzzleFlash { mesh: THREE.Mesh; ttl: number; }

export class MuzzleFlashPool {
  private flashes: MuzzleFlash[] = [];

  constructor(private scene: THREE.Scene) {}

  /** A briefly-lit muzzle glow at the shot origin, nudged toward the target. */
  flashAt(x: number, y: number, z: number, towardX: number, towardZ: number): void {
    const dx = towardX - x; const dz = towardZ - z; const length = Math.hypot(dx, dz) || 1;
    let flash = this.flashes.find((candidate) => candidate.ttl <= 0);
    if (!flash) { flash = { mesh: new THREE.Mesh(FLASH_GEOMETRY, FLASH_MATERIAL), ttl: 0 }; this.flashes.push(flash); this.scene.add(flash.mesh); }
    flash.mesh.position.set(x + (dx / length) * 0.5, y, z + (dz / length) * 0.5);
    flash.mesh.visible = true; flash.ttl = FLASH_SECONDS;
  }

  update(dt: number): void {
    for (const flash of this.flashes) if (flash.ttl > 0) { flash.ttl -= dt; if (flash.ttl <= 0) flash.mesh.visible = false; }
  }

  /** Remove every pooled mesh from the scene (system reset). Geometry/material are module-shared. */
  reset(): void {
    for (const flash of this.flashes) this.scene.remove(flash.mesh);
    this.flashes = [];
  }
}
