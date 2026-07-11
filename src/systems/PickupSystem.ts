import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { WeaponId } from '../config';
import { buildPickupWeaponModel } from '../entities/WeaponModels';

export type PickupKind = 'cash' | 'weapon' | 'ammo';
export interface Pickup { kind: PickupKind; amount: number; weapon?: WeaponId; group: THREE.Group; age: number; phase: number; baseY: number; }
export const PICKUP_LIFETIME = 30;
export const PICKUP_BLINK_AT = 25;
export const PICKUP_RADIUS = 1.2;

const GLOW: Record<PickupKind, number> = { cash: 0x6fdd7f, weapon: 0xf0a43a, ammo: 0x65d8ff };

export class PickupSystem {
  pickups: Pickup[] = [];
  constructor(private scene: THREE.Scene) {}

  spawnCash(position: THREE.Vector3, amount: number): void { this.spawn('cash', position, amount); }
  spawnWeapon(position: THREE.Vector3, weapon: WeaponId): void { this.spawn('weapon', position, 0, weapon); }
  spawnAmmo(position: THREE.Vector3): void { this.spawn('ammo', position, 0); }

  update(dt: number, player: THREE.Vector3, canCollect: boolean): Pickup[] {
    const collected: Pickup[] = [];
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const item = this.pickups[i]; if (!item) continue;
      item.age += dt; item.phase += dt;
      item.group.rotation.y += dt * 1.7;
      item.group.position.y = item.baseY + Math.sin(item.phase * 2.4) * 0.07;
      item.group.visible = item.age < PICKUP_BLINK_AT || Math.sin(item.age * 14) > -0.25;
      if (item.age >= PICKUP_LIFETIME) { this.remove(i); continue; }
      if (canCollect && Math.hypot(item.group.position.x - player.x, item.group.position.z - player.z) < PICKUP_RADIUS && Math.abs(player.y - (item.baseY - 0.42)) < 1.4) { collected.push(item); this.remove(i); }
    }
    return collected;
  }

  private spawn(kind: PickupKind, position: THREE.Vector3, amount: number, weapon?: WeaponId): void {
    const group = new THREE.Group();
    if (kind === 'cash') {
      const stack = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.11, 0.19, 3, 0.02), new THREE.MeshStandardMaterial({ color: 0x3fae57, emissive: 0x1d5c2c, emissiveIntensity: 0.6, roughness: 0.6 }));
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.045, 0.2), new THREE.MeshStandardMaterial({ color: 0xe8eadf, roughness: 0.8 }));
      group.add(stack, band);
    } else if (kind === 'ammo') {
      const box = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.15, 0.16, 3, 0.02), new THREE.MeshStandardMaterial({ color: 0x3a4046, emissive: 0x24404d, emissiveIntensity: 0.5, roughness: 0.5, metalness: 0.3 }));
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.04, 0.17), new THREE.MeshStandardMaterial({ color: 0xf0a43a, emissive: 0x8a5510, emissiveIntensity: 0.5 }));
      group.add(box, stripe);
    } else if (weapon) {
      group.add(buildPickupWeaponModel(weapon));
    }
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ color: GLOW[kind], transparent: true, opacity: 0.26, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = -0.36; group.add(glow);
    const baseY = position.y + 0.42; group.position.set(position.x, baseY, position.z);
    this.scene.add(group);
    this.pickups.push({ kind, amount, weapon, group, age: 0, phase: Math.random() * Math.PI * 2, baseY });
  }

  private remove(index: number): void {
    const item = this.pickups[index];
    if (item) this.scene.remove(item.group);
    this.pickups.splice(index, 1);
  }
}
