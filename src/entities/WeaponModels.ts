import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { WeaponId } from '../config';

// Models extend along -Y (hanging from the forearm pivot), matching the player rig.
export function buildWeaponModel(id: WeaponId): THREE.Group | undefined {
  const metal = new THREE.MeshStandardMaterial({ color: 0x252b2d, metalness: 0.76, roughness: 0.28 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x131719, roughness: 0.52 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5d4028, roughness: 0.68 });
  const olive = new THREE.MeshStandardMaterial({ color: 0x5a6b3f, roughness: 0.6, metalness: 0.12 });
  const group = new THREE.Group();
  if (id === 'pistol') {
    const slide = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.3, 0.095, 4, 0.025), metal); slide.position.set(0, -0.49, 0.015);
    const grip = new THREE.Mesh(new RoundedBoxGeometry(0.068, 0.16, 0.1, 3, 0.02), polymer); grip.position.set(0, -0.4, -0.015); grip.rotation.x = -0.18;
    group.add(slide, grip);
  } else if (id === 'smg') {
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.4, 0.11, 4, 0.02), metal); body.position.set(0, -0.54, 0.02);
    const grip = new THREE.Mesh(new RoundedBoxGeometry(0.065, 0.15, 0.09, 3, 0.02), polymer); grip.position.set(0, -0.4, -0.02); grip.rotation.x = -0.2;
    const magazine = new THREE.Mesh(new RoundedBoxGeometry(0.055, 0.22, 0.06, 3, 0.015), polymer); magazine.position.set(0, -0.52, -0.075); magazine.rotation.x = 0.25;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.14, 10), metal); barrel.position.set(0, -0.78, 0.035);
    group.add(body, grip, magazine, barrel);
  } else if (id === 'shotgun') {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.62, 12), metal); tube.position.set(0, -0.66, 0.03);
    const under = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.44, 10), metal); under.position.set(0, -0.71, -0.015);
    const pump = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.17, 0.08, 3, 0.02), wood); pump.position.set(0, -0.68, -0.01);
    const stock = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.22, 0.12, 3, 0.025), wood); stock.position.set(0, -0.32, -0.03); stock.rotation.x = -0.22;
    group.add(tube, under, pump, stock);
  } else if (id === 'sniper') {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.023, 0.8, 12), metal); barrel.position.set(0, -0.9, 0.03);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.1, 10), polymer); muzzle.position.set(0, -1.27, 0.03);
    const receiver = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.34, 0.1, 3, 0.02), metal); receiver.position.set(0, -0.46, 0.02);
    const scopeTube = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.28, 12), polymer); scopeTube.position.set(0, -0.5, 0.12);
    const scopeEye = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 12), polymer); scopeEye.position.set(0, -0.38, 0.12);
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.09, 8), metal); bolt.rotation.z = Math.PI / 2; bolt.position.set(0.06, -0.42, 0.02);
    const magazine = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.13, 0.07, 2, 0.015), polymer); magazine.position.set(0, -0.6, -0.045);
    const stock = new THREE.Mesh(new RoundedBoxGeometry(0.072, 0.3, 0.13, 3, 0.025), wood); stock.position.set(0, -0.24, -0.03); stock.rotation.x = -0.2;
    group.add(barrel, muzzle, receiver, scopeTube, scopeEye, bolt, magazine, stock);
  } else if (id === 'rpg') {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.05, 14, 1, true), olive); tube.position.y = -0.68; tube.material.side = THREE.DoubleSide;
    const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.075, 0.16, 14, 1, true), olive); flare.position.y = -0.12;
    const warhead = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.24, 12), olive); warhead.rotation.x = Math.PI; warhead.position.y = -1.3;
    const sight = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.12, 0.09, 2, 0.01), polymer); sight.position.set(0, -1.0, 0.11);
    const grip = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.14, 0.06, 2, 0.015), polymer); grip.position.set(0, -0.86, -0.11);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.06, 14), polymer); band.position.y = -0.45;
    group.add(tube, flare, warhead, sight, grip, band);
  } else {
    return undefined;
  }
  return group;
}

// A weapon model rotated to lie flat and centered around the origin (for ground pickups).
export function buildPickupWeaponModel(id: WeaponId): THREE.Group {
  const holder = new THREE.Group();
  const model = buildWeaponModel(id);
  if (!model) return holder;
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  const wrap = new THREE.Group(); wrap.add(model);
  wrap.rotation.x = Math.PI / 2; // lay along the ground
  holder.add(wrap);
  return holder;
}
