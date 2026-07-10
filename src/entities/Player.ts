import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PLAYER } from '../config';
import type { InputManager } from '../core/InputManager';
import type { City } from '../world/City';

export class Player {
  group = new THREE.Group();
  health = PLAYER.maxHealth;
  maxHealth = PLAYER.maxHealth;
  velocityY = 0;
  onGround = true;
  inVehicle = false;
  heading = 0;
  private leftArm = new THREE.Group();
  private rightArm = new THREE.Group();
  private leftLeg = new THREE.Group();
  private rightLeg = new THREE.Group();
  private walkPhase = 0;

  constructor(scene: THREE.Scene, position = new THREE.Vector3(0, 0, 260)) {
    this.group.position.copy(position); this.heading = Math.PI; this.group.rotation.y = this.heading; this.group.name = 'Player'; scene.add(this.group); this.buildModel();
  }

  update(dt: number, input: InputManager, cameraYaw: number, city: City): void {
    if (this.inVehicle || this.health <= 0) return;
    const side = Number(input.down('KeyD')) - Number(input.down('KeyA'));
    const forward = Number(input.down('KeyW')) - Number(input.down('KeyS'));
    const move = new THREE.Vector3(side, 0, -forward);
    if (move.lengthSq() > 0) {
      move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
      const speed = input.down('ShiftLeft') ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
      const desired = this.group.position.clone().addScaledVector(move, speed * dt);
      this.group.position.copy(city.clampMove(this.group.position, desired, PLAYER.radius));
      this.heading = Math.atan2(move.x, move.z); this.group.rotation.y = this.heading;
      this.walkPhase += dt * speed * 1.4;
      const swing = Math.sin(this.walkPhase) * (input.down('ShiftLeft') ? 0.75 : 0.52);
      this.leftArm.rotation.x = swing; this.rightArm.rotation.x = -swing; this.leftLeg.rotation.x = -swing; this.rightLeg.rotation.x = swing;
    } else {
      this.leftArm.rotation.x *= 0.8; this.rightArm.rotation.x *= 0.8; this.leftLeg.rotation.x *= 0.8; this.rightLeg.rotation.x *= 0.8;
    }
    if (input.consume('Space') && this.onGround) { this.velocityY = PLAYER.jumpSpeed; this.onGround = false; }
    this.velocityY -= PLAYER.gravity * dt; this.group.position.y += this.velocityY * dt;
    if (this.group.position.y <= 0) { this.group.position.y = 0; this.velocityY = 0; this.onGround = true; }
  }

  takeDamage(amount: number): void { this.health = Math.max(0, this.health - Math.max(0, amount)); }
  heal(): void { this.health = this.maxHealth; }
  setVisible(visible: boolean): void { this.group.visible = visible; }

  private buildModel(): void {
    const skin = new THREE.MeshStandardMaterial({ color: 0x9a654b, roughness: 0.78 });
    const jacket = new THREE.MeshStandardMaterial({ color: 0x286c69, roughness: 0.62 });
    const trousers = new THREE.MeshStandardMaterial({ color: 0x252b37, roughness: 0.82 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 14), skin); head.position.y = 1.63; head.scale.set(0.9, 1.08, 0.94);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.225, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), new THREE.MeshStandardMaterial({ color: 0x1b1715, roughness: 0.95 })); hair.position.set(0, 1.7, 0);
    const torso = new THREE.Mesh(new RoundedBoxGeometry(0.58, 0.72, 0.32, 4, 0.1), jacket); torso.position.y = 1.08;
    const shirt = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.5), new THREE.MeshStandardMaterial({ color: 0xd4d0be, roughness: 0.8 })); shirt.position.set(0, 1.12, 0.166);
    this.addLimb(this.leftArm, -0.39, 1.28, skin, 0.16, 0.68); this.addLimb(this.rightArm, 0.39, 1.28, skin, 0.16, 0.68);
    this.addLimb(this.leftLeg, -0.18, 0.7, trousers, 0.21, 0.76); this.addLimb(this.rightLeg, 0.18, 0.7, trousers, 0.21, 0.76);
    for (const x of [-0.08, 0.08]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshBasicMaterial({ color: 0x171b1c })); eye.position.set(x, 1.66, 0.222); this.group.add(eye); }
    for (const x of [-0.18, 0.18]) { const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.13, 0.36, 3, 0.05), new THREE.MeshStandardMaterial({ color: 0x121719, roughness: 0.62 })); shoe.position.set(x, 0.12, 0.08); this.group.add(shoe); }
    const pistol = new THREE.Mesh(new RoundedBoxGeometry(0.09, 0.13, 0.34, 2, 0.02), new THREE.MeshStandardMaterial({ color: 0x252b2d, metalness: 0.72, roughness: 0.3 })); pistol.position.set(0, -0.58, 0.14); this.rightArm.add(pistol);
    this.group.add(head, hair, torso, shirt, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);
    this.group.traverse((object: THREE.Object3D) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
  }

  private addLimb(group: THREE.Group, x: number, y: number, material: THREE.Material, width: number, height: number): void {
    group.position.set(x, y, 0); const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(width / 2, Math.max(0.1, height - width), 5, 10), material); mesh.position.y = -height / 2; group.add(mesh);
  }
}
