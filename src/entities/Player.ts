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
  private model = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private leftArm = new THREE.Group();
  private rightArm = new THREE.Group();
  private leftForearm = new THREE.Group();
  private rightForearm = new THREE.Group();
  private leftLeg = new THREE.Group();
  private rightLeg = new THREE.Group();
  private leftShin = new THREE.Group();
  private rightShin = new THREE.Group();
  private walkPhase = 0;

  constructor(scene: THREE.Scene, position = new THREE.Vector3(0, 0, 260)) {
    this.group.position.copy(position); this.heading = Math.PI; this.group.rotation.y = this.heading; this.group.name = 'Player'; scene.add(this.group); this.buildModel();
  }

  update(dt: number, input: InputManager, cameraYaw: number, city: City): void {
    if (this.inVehicle || this.health <= 0) return;
    const side = Number(input.down('KeyD')) - Number(input.down('KeyA'));
    const forward = Number(input.down('KeyW')) - Number(input.down('KeyS'));
    const move = new THREE.Vector3(side, 0, -forward);
    const moving = move.lengthSq() > 0;
    const sprinting = moving && input.down('ShiftLeft');
    if (moving) {
      move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
      const speed = sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
      const desired = this.group.position.clone().addScaledVector(move, speed * dt);
      this.group.position.copy(city.clampMove(this.group.position, desired, PLAYER.radius));
      this.turnToward(Math.atan2(move.x, move.z), dt, sprinting ? 15 : 11);
      this.walkPhase += dt * speed * 1.05;
      this.animateLocomotion(dt, sprinting, input.firing);
    } else {
      if (input.firing) this.turnToward(cameraYaw + Math.PI, dt, 13);
      this.animateIdle(dt, input.firing);
    }
    if (input.consume('Space') && this.onGround) { this.velocityY = PLAYER.jumpSpeed; this.onGround = false; }
    this.velocityY -= PLAYER.gravity * dt; this.group.position.y += this.velocityY * dt;
    if (!this.onGround) {
      this.leftLeg.rotation.x = THREE.MathUtils.lerp(this.leftLeg.rotation.x, -0.28, dt * 9); this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, 0.22, dt * 9);
      this.leftShin.rotation.x = THREE.MathUtils.lerp(this.leftShin.rotation.x, 0.65, dt * 9); this.rightShin.rotation.x = THREE.MathUtils.lerp(this.rightShin.rotation.x, 0.48, dt * 9);
    }
    if (this.group.position.y <= 0) { this.group.position.y = 0; this.velocityY = 0; this.onGround = true; }
  }

  takeDamage(amount: number): void { this.health = Math.max(0, this.health - Math.max(0, amount)); }
  heal(): void { this.health = this.maxHealth; }
  setVisible(visible: boolean): void { this.group.visible = visible; }

  private turnToward(target: number, dt: number, rate: number): void {
    const delta = Math.atan2(Math.sin(target - this.heading), Math.cos(target - this.heading));
    this.heading += delta * Math.min(1, dt * rate); this.group.rotation.y = this.heading;
  }

  private animateLocomotion(dt: number, sprinting: boolean, aiming: boolean): void {
    const cycle = Math.sin(this.walkPhase); const stride = sprinting ? 0.82 : 0.58;
    this.leftLeg.rotation.x = THREE.MathUtils.lerp(this.leftLeg.rotation.x, cycle * stride, dt * 14);
    this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, -cycle * stride, dt * 14);
    this.leftShin.rotation.x = THREE.MathUtils.lerp(this.leftShin.rotation.x, Math.max(0, -cycle) * (sprinting ? 1.05 : 0.72), dt * 15);
    this.rightShin.rotation.x = THREE.MathUtils.lerp(this.rightShin.rotation.x, Math.max(0, cycle) * (sprinting ? 1.05 : 0.72), dt * 15);
    if (aiming) this.animateAim(dt);
    else {
      this.leftArm.rotation.x = THREE.MathUtils.lerp(this.leftArm.rotation.x, -cycle * stride * 0.78, dt * 13);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, cycle * stride * 0.78, dt * 13);
      this.leftArm.rotation.z = THREE.MathUtils.lerp(this.leftArm.rotation.z, 0, dt * 11); this.rightArm.rotation.z = THREE.MathUtils.lerp(this.rightArm.rotation.z, 0, dt * 11);
      this.leftForearm.rotation.x = THREE.MathUtils.lerp(this.leftForearm.rotation.x, sprinting ? -0.42 : -0.15, dt * 11);
      this.rightForearm.rotation.x = THREE.MathUtils.lerp(this.rightForearm.rotation.x, sprinting ? -0.42 : -0.15, dt * 11);
    }
    this.model.position.y = Math.abs(Math.sin(this.walkPhase * 2)) * (sprinting ? 0.035 : 0.018);
    this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, sprinting ? 0.08 : 0.018, dt * 8);
    this.torso.rotation.z = Math.sin(this.walkPhase) * (sprinting ? 0.045 : 0.022);
    this.torso.scale.y = THREE.MathUtils.lerp(this.torso.scale.y, 1, dt * 8);
    this.head.rotation.y = Math.sin(this.walkPhase * 0.5) * 0.035;
  }

  private animateIdle(dt: number, aiming: boolean): void {
    const breathe = Math.sin(performance.now() * 0.0018);
    this.leftLeg.rotation.x *= Math.exp(-dt * 9); this.rightLeg.rotation.x *= Math.exp(-dt * 9);
    this.leftShin.rotation.x *= Math.exp(-dt * 10); this.rightShin.rotation.x *= Math.exp(-dt * 10);
    if (aiming) this.animateAim(dt);
    else {
      this.leftArm.rotation.x = THREE.MathUtils.lerp(this.leftArm.rotation.x, 0.035 + breathe * 0.018, dt * 8);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, -0.035 - breathe * 0.018, dt * 8);
      this.leftArm.rotation.z = THREE.MathUtils.lerp(this.leftArm.rotation.z, 0, dt * 8); this.rightArm.rotation.z = THREE.MathUtils.lerp(this.rightArm.rotation.z, 0, dt * 8);
      this.leftForearm.rotation.x = THREE.MathUtils.lerp(this.leftForearm.rotation.x, -0.12, dt * 8);
      this.rightForearm.rotation.x = THREE.MathUtils.lerp(this.rightForearm.rotation.x, -0.12, dt * 8);
    }
    this.model.position.y = breathe * 0.004; this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, 0, dt * 8); this.torso.rotation.z *= Math.exp(-dt * 8); this.head.rotation.y = Math.sin(performance.now() * 0.00055) * 0.045;
    this.torso.scale.y = 1 + breathe * 0.004;
  }

  private animateAim(dt: number): void {
    this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, -1.46, dt * 14); this.rightArm.rotation.z = THREE.MathUtils.lerp(this.rightArm.rotation.z, -0.09, dt * 12);
    this.leftArm.rotation.x = THREE.MathUtils.lerp(this.leftArm.rotation.x, -1.28, dt * 14); this.leftArm.rotation.z = THREE.MathUtils.lerp(this.leftArm.rotation.z, 0.28, dt * 12);
    this.rightForearm.rotation.x = THREE.MathUtils.lerp(this.rightForearm.rotation.x, -0.06, dt * 14); this.leftForearm.rotation.x = THREE.MathUtils.lerp(this.leftForearm.rotation.x, -0.16, dt * 14);
    this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, 0.06, dt * 10);
  }

  private buildModel(): void {
    const jacketTexture = this.loadTexture('/textures/character/teal-jacket-gpt.jpg', 1.6);
    const denimTexture = this.loadTexture('/textures/character/charcoal-denim-gpt.jpg', 1.8);
    const skin = new THREE.MeshPhysicalMaterial({ color: 0xa66f52, roughness: 0.73, clearcoat: 0.08, clearcoatRoughness: 0.8 });
    const jacket = new THREE.MeshStandardMaterial({ color: 0xffffff, map: jacketTexture, roughness: 0.64, metalness: 0.03, emissive: 0x0b3538, emissiveIntensity: 0.38 });
    const denim = new THREE.MeshStandardMaterial({ color: 0xd8dce0, map: denimTexture, roughness: 0.82, emissive: 0x111319, emissiveIntensity: 0.16 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0xe2dfd2, roughness: 0.88 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x171311, roughness: 0.96 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x111518, roughness: 0.42, metalness: 0.08 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x252b2d, metalness: 0.76, roughness: 0.28 });

    this.buildTorso(jacket, shirt, leather, metal);
    this.buildHead(skin, hair);
    this.buildArm(this.leftArm, this.leftForearm, -0.355, jacket, skin, false, metal);
    this.buildArm(this.rightArm, this.rightForearm, 0.355, jacket, skin, true, metal);
    this.buildLeg(this.leftLeg, this.leftShin, -0.14, denim, leather);
    this.buildLeg(this.rightLeg, this.rightShin, 0.14, denim, leather);
    this.model.add(this.torso, this.head, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg); this.group.add(this.model);
    this.group.traverse((object: THREE.Object3D) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; } });
  }

  private buildTorso(jacket: THREE.Material, shirt: THREE.Material, leather: THREE.Material, metal: THREE.Material): void {
    const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.235, 0.27, 10, 24), jacket); chest.position.y = 1.22; chest.scale.set(1.28, 1, 0.76); this.torso.add(chest);
    const waist = new THREE.Mesh(new RoundedBoxGeometry(0.43, 0.2, 0.27, 5, 0.07), jacket); waist.position.y = 0.91; this.torso.add(waist);
    const undershirt = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.43, 0.025, 3, 0.01), shirt); undershirt.position.set(0, 1.24, 0.184); this.torso.add(undershirt);
    const zipper = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.5, 0.012), metal); zipper.position.set(0, 1.22, 0.205); this.torso.add(zipper);
    for (const side of [-1, 1]) {
      const collar = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.24, 0.045, 3, 0.015), jacket); collar.position.set(side * 0.09, 1.48, 0.17); collar.rotation.z = side * 0.42; this.torso.add(collar);
      const pocket = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.08, 0.022, 2, 0.008), leather); pocket.position.set(side * 0.17, 1.14, 0.183); this.torso.add(pocket);
    }
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.055, 0.285), leather); belt.position.y = 0.86; this.torso.add(belt);
    const buckle = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.065, 0.026, 2, 0.01), metal); buckle.position.set(0, 0.86, 0.16); this.torso.add(buckle);
  }

  private buildHead(skin: THREE.Material, hair: THREE.Material): void {
    this.head.position.y = 1.68;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.16, 18), skin); neck.position.y = -0.21;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.165, 32, 24), skin); face.scale.set(0.84, 1.08, 0.94);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.162, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.56), hair); hairCap.position.y = 0.042; hairCap.scale.set(0.86, 1.02, 0.95);
    this.head.add(neck, face, hairCap);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 9), skin); ear.position.set(side * 0.142, 0, 0); ear.scale.set(0.55, 1, 0.65); this.head.add(ear);
      const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 9), new THREE.MeshPhysicalMaterial({ color: 0xf2eee4, roughness: 0.28 })); eyeWhite.position.set(side * 0.056, 0.02, 0.153); eyeWhite.scale.set(1.2, 0.72, 0.45);
      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), new THREE.MeshBasicMaterial({ color: 0x202b26 })); iris.position.set(side * 0.056, 0.02, 0.171);
      const brow = new THREE.Mesh(new RoundedBoxGeometry(0.057, 0.011, 0.009, 2, 0.003), hair); brow.position.set(side * 0.056, 0.059, 0.157); brow.rotation.z = side * -0.08; this.head.add(eyeWhite, iris, brow);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.056, 12), skin); nose.rotation.x = Math.PI / 2; nose.position.set(0, -0.012, 0.174); this.head.add(nose);
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.029, 0.0045, 6, 16, Math.PI), new THREE.MeshStandardMaterial({ color: 0x66372e, roughness: 0.75 })); mouth.position.set(0, -0.063, 0.154); mouth.rotation.z = Math.PI; this.head.add(mouth);
  }

  private buildArm(arm: THREE.Group, forearm: THREE.Group, x: number, jacket: THREE.Material, skin: THREE.Material, armed: boolean, metal: THREE.Material): void {
    arm.position.set(x, 1.43, 0); const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.22, 7, 16), jacket); upper.position.y = -0.17; arm.add(upper);
    forearm.position.y = -0.34; const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.056, 0.2, 7, 16), jacket); lower.position.y = -0.16;
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.057, 0.066, 16), jacket); cuff.position.y = -0.31;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), skin); hand.position.y = -0.37; hand.scale.set(0.86, 1.18, 0.74); forearm.add(lower, cuff, hand); arm.add(forearm);
    if (armed) {
      const slide = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.3, 0.095, 4, 0.025), metal); slide.position.set(0, -0.49, 0.015);
      const grip = new THREE.Mesh(new RoundedBoxGeometry(0.068, 0.16, 0.1, 3, 0.02), new THREE.MeshStandardMaterial({ color: 0x131719, roughness: 0.52 })); grip.position.set(0, -0.4, -0.015); grip.rotation.x = -0.18; forearm.add(slide, grip);
    }
  }

  private buildLeg(leg: THREE.Group, shin: THREE.Group, x: number, denim: THREE.Material, leather: THREE.Material): void {
    leg.position.set(x, 0.88, 0); const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.091, 0.22, 8, 18), denim); thigh.position.y = -0.2; leg.add(thigh);
    shin.position.y = -0.4; const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.082, 0.21, 8, 18), denim); lower.position.y = -0.19;
    const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.19, 0.13, 0.34, 5, 0.055), leather); shoe.position.set(0, -0.4, 0.075); shin.add(lower, shoe); leg.add(shin);
  }

  private loadTexture(url: string, repeat: number): THREE.Texture {
    const texture = new THREE.TextureLoader().load(url); texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(repeat, repeat); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8; return texture;
  }
}
