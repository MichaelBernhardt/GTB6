import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PLAYER, type VehicleKind, type WeaponId } from '../config';
import type { InputManager } from '../core/InputManager';
import { fallDamage, jumpVelocity, moveSpeed, stepVertical } from '../core/GameRules';
import type { CheatSettings } from '../types';
import type { City } from '../world/City';
import { buildWeaponModel } from './WeaponModels';

/** Game-computed cover pose: Game owns the cover position; the player only acts it out. */
export interface CoverPose { heading: number; peek: number; twist: number; moving: boolean; }

/** Freefall body tip about the model's X axis: FREEFALL_TIP is the neutral belly-to-earth arch, the dive trim
 *  swings it +/- FREEFALL_TIP_RANGE. Both stay well under pi/2 so the diver is always face-down, never inverted. */
export const FREEFALL_TIP = 1.22;
export const FREEFALL_TIP_RANGE = 0.28;

export class Player {
  group = new THREE.Group();
  health = PLAYER.maxHealth;
  maxHealth = PLAYER.maxHealth;
  velocityY = 0;
  onGround = true;
  inVehicle = false;
  heading = 0;
  moving = false;
  sprinting = false;
  cheats: Pick<CheatSettings, 'fastRun' | 'bigJump'> = { fastRun: false, bigJump: false };
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
  private pedalPhase = 0;
  private tumbleTimer = 0;
  private tumbleDuration = 1;
  private tumbleDir = 1;
  private tumbleBaseY = 0;
  private fallOriginY = 0;
  private pendingFallDamage = 0;
  private weapon: WeaponId = 'pistol';
  private weaponMeshes = new Map<WeaponId, THREE.Group>();
  private punchTimer = 0;
  private punchLeft = false;
  private canopy?: THREE.Group;
  private canopyPhase = 0;

  constructor(scene: THREE.Scene, position = new THREE.Vector3(0, 0, 260)) {
    this.group.position.copy(position); this.heading = Math.PI; this.group.rotation.y = this.heading; this.group.name = 'Player'; scene.add(this.group); this.buildModel();
  }

  update(dt: number, input: InputManager, cameraYaw: number, city: City, cover?: CoverPose): void {
    this.moving = false; this.sprinting = false;
    if (this.inVehicle || this.health <= 0) return;
    if (this.tumbleTimer > 0) { this.applyTumble(dt); return; }
    const aimHeld = input.aiming && this.weapon !== 'fists'; // Ctrl: aim mode — raised gun, half speed, camera-facing
    const aiming = aimHeld || (input.firing && this.weapon !== 'fists'); // hip fire still raises the gun while the trigger is down
    if (cover) { this.updateCover(dt, cover, aiming, city.supportHeight(this.group.position.x, this.group.position.z, this.group.position.y)); return; }
    this.torso.rotation.y *= Math.exp(-dt * 8); // unwind any leftover cover twist
    const side = Number(input.down('KeyD')) - Number(input.down('KeyA'));
    const forward = Number(input.down('KeyW')) - Number(input.down('KeyS'));
    const move = new THREE.Vector3(side, 0, -forward);
    const moving = move.lengthSq() > 0;
    const sprinting = moving && input.down('ShiftLeft');
    this.moving = moving; this.sprinting = sprinting;
    if (moving) {
      move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
      const speed = moveSpeed(sprinting, this.cheats.fastRun, aimHeld);
      const desired = this.group.position.clone().addScaledVector(move, speed * dt);
      this.group.position.copy(city.clampMoveAt(this.group.position, desired, PLAYER.radius)); // y-aware: walls above the head or below the feet don't block
      this.turnToward(aimHeld ? cameraYaw + Math.PI : Math.atan2(move.x, move.z), dt, aimHeld ? 13 : sprinting ? 15 : 11);
      this.walkPhase += dt * speed * 1.05;
      this.animateLocomotion(dt, sprinting, aiming);
    } else {
      if (input.firing || aimHeld) this.turnToward(cameraYaw + Math.PI, dt, 13);
      this.animateIdle(dt, aiming);
    }
    this.leftLeg.rotation.z *= Math.exp(-dt * 8); this.rightLeg.rotation.z *= Math.exp(-dt * 8); // legs close after riding astride
    this.group.rotation.z *= Math.exp(-dt * 12); // shed any leftover bike lean
    this.applyPunch(dt);
    const jump = input.consume('Space') && this.onGround ? jumpVelocity(this.cheats.bigJump) : undefined;
    const support = city.supportHeight(this.group.position.x, this.group.position.z, this.group.position.y);
    const motion = { y: this.group.position.y, velocityY: this.velocityY, onGround: this.onGround, fallOriginY: this.fallOriginY };
    const landing = stepVertical(motion, dt, support, jump);
    this.group.position.y = motion.y; this.velocityY = motion.velocityY; this.onGround = motion.onGround; this.fallOriginY = motion.fallOriginY;
    if (!this.onGround) {
      this.leftLeg.rotation.x = THREE.MathUtils.lerp(this.leftLeg.rotation.x, -0.28, dt * 9); this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, 0.22, dt * 9);
      this.leftShin.rotation.x = THREE.MathUtils.lerp(this.leftShin.rotation.x, 0.65, dt * 9); this.rightShin.rotation.x = THREE.MathUtils.lerp(this.rightShin.rotation.x, 0.48, dt * 9);
    }
    if (landing.landed) {
      const damage = fallDamage(landing.drop);
      if (damage > 0) { this.pendingFallDamage += damage; this.tumble(); } // hard landing: eat tar, Game settles the bill
    }
  }

  /** Landing bill accrued since the last query; Game routes it through the usual damage path (cheats respected). */
  consumeFallDamage(): number { const amount = this.pendingFallDamage; this.pendingFallDamage = 0; return amount; }

  /** Back against the wall: Game moves the group; this leans the body, twists the torso for the peek and keeps
   *  feet planted on whatever surface holds the cover — street or podium roof alike. */
  private updateCover(dt: number, cover: CoverPose, aiming: boolean, ground: number): void {
    this.turnToward(cover.heading, dt, 12);
    this.leftLeg.rotation.z *= Math.exp(-dt * 8); this.rightLeg.rotation.z *= Math.exp(-dt * 8); // legs close after riding astride
    if (cover.moving) { this.walkPhase += dt * 5.5; this.animateLocomotion(dt, false, aiming); }
    else this.animateIdle(dt, aiming);
    this.torso.rotation.y = THREE.MathUtils.lerp(this.torso.rotation.y, cover.twist, dt * 10);
    this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, -0.085 * (1 - cover.peek), dt * 8); // shoulder-blades-to-brick lean, straightening as the peek comes out
    this.applyPunch(dt);
    this.group.position.y = ground; this.velocityY = 0; this.onGround = true;
  }

  takeDamage(amount: number): void { this.health = Math.max(0, this.health - Math.max(0, amount)); }
  heal(): void { this.health = this.maxHealth; }
  setVisible(visible: boolean): void { this.group.visible = visible; }

  setWeapon(id: WeaponId): void {
    if (id === this.weapon) return;
    this.weapon = id;
    for (const [meshId, mesh] of this.weaponMeshes) mesh.visible = meshId === id;
  }

  punch(): void { this.punchTimer = 0.3; this.punchLeft = !this.punchLeft; }

  /** Knocked off a two-wheeler: borrow the pedestrian down-pose (rolled onto the side) for a beat, then get up. */
  tumble(duration = 1.15): void { this.tumbleTimer = duration; this.tumbleDuration = duration; this.tumbleDir = Math.random() < 0.5 ? -1 : 1; this.tumbleBaseY = this.group.position.y; this.velocityY = 0; this.onGround = true; }
  get tumbling(): boolean { return this.tumbleTimer > 0; }

  private applyTumble(dt: number): void {
    this.tumbleTimer = Math.max(0, this.tumbleTimer - dt);
    const progress = 1 - this.tumbleTimer / this.tumbleDuration;
    const roll = Math.min(1, progress * 3.2) * (1 - THREE.MathUtils.smoothstep(progress, 0.72, 1)); // slam down fast, get up late
    this.group.rotation.x = 0; // the tumble is a pure side-roll about z: never let an inherited pitch survive into an upside-down landing
    this.group.rotation.z = this.tumbleDir * (Math.PI / 2) * roll;
    this.group.position.y = this.tumbleBaseY + 0.36 * roll; // rolled on whatever surface the tumble started on
    this.leftArm.rotation.x = -2.3 * roll; this.rightArm.rotation.x = -2.1 * roll;
    this.leftLeg.rotation.x = -0.5 * roll; this.rightLeg.rotation.x = 0.4 * roll;
    if (this.tumbleTimer === 0) { this.group.rotation.z = 0; this.group.position.y = this.tumbleBaseY; }
  }

  /** Seated riding pose, driven from Game while on a two-wheeler: legs astride, hands to the bars.
   *  Bicycle legs turn the cranks with road speed; the superbike stance is a full tuck.
   *  While aiming a drive-by the right (gun) arm leaves the bars and levels the weapon one-handed. */
  animateRiding(dt: number, kind: VehicleKind, speed: number, aiming = false): void {
    const bicycle = kind === 'bicycle'; const superbike = kind === 'superbike';
    const blend = Math.min(1, dt * 10);
    const pose = (part: THREE.Group, x: number, z?: number): void => { part.rotation.x = THREE.MathUtils.lerp(part.rotation.x, x, blend); if (z !== undefined) part.rotation.z = THREE.MathUtils.lerp(part.rotation.z, z, blend); };
    this.pedalPhase += dt * speed * (bicycle ? 0.62 : 0);
    const pedal = bicycle ? Math.sin(this.pedalPhase) : 0;
    pose(this.leftArm, superbike ? -1.3 : bicycle ? -0.8 : -1, -0.14); // arms mirrored with the right-hand weapon rig: left is +x, so inward is -z
    if (aiming) { pose(this.rightArm, -1.46, 0.09); pose(this.rightForearm, -0.06); }
    else { pose(this.rightArm, superbike ? -1.3 : bicycle ? -0.8 : -1, 0.14); pose(this.rightForearm, superbike ? -0.12 : -0.3); }
    pose(this.leftForearm, superbike ? -0.12 : -0.3);
    pose(this.leftLeg, bicycle ? -0.95 + pedal * 0.42 : superbike ? -1.15 : -1.3, -0.16); pose(this.rightLeg, bicycle ? -0.95 - pedal * 0.42 : superbike ? -1.15 : -1.3, 0.16);
    pose(this.leftShin, bicycle ? Math.max(0.2, 0.8 - pedal * 0.38) : superbike ? 1.6 : 1.35); pose(this.rightShin, bicycle ? Math.max(0.2, 0.8 + pedal * 0.38) : superbike ? 1.6 : 1.35);
    this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, superbike ? 0.5 : bicycle ? 0.12 : 0.2, blend);
    this.model.rotation.y *= Math.exp(-dt * 10); this.model.position.y = 0;
    this.torso.rotation.z *= Math.exp(-dt * 8); this.torso.scale.y = THREE.MathUtils.lerp(this.torso.scale.y, 1, blend);
    this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, 0, blend);
  }

  /** GTA-style canopy over the shoulders: a squashed half-dome on simple suspension lines, built lazily. */
  setCanopy(visible: boolean): void {
    if (visible && !this.canopy) this.canopy = this.buildCanopy();
    if (this.canopy) this.canopy.visible = visible;
  }

  private buildCanopy(): THREE.Group {
    const canopy = new THREE.Group(); canopy.name = 'Parachute';
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(2.7, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0xd75844, roughness: 0.85, side: THREE.DoubleSide }));
    dome.scale.set(1, 0.52, 0.78); dome.position.y = 4.7; dome.castShadow = true;
    const stripe = new THREE.Mesh(
      new THREE.SphereGeometry(2.71, 20, 6, -Math.PI / 7, Math.PI * 2 / 7, 0, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0xf2edda, roughness: 0.85, side: THREE.DoubleSide }));
    stripe.scale.copy(dome.scale); stripe.position.copy(dome.position);
    canopy.add(dome, stripe);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xd8d4c5 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const from = new THREE.Vector3(sx * 0.32, 1.5, sz * 0.1); const to = new THREE.Vector3(sx * 1.95, 4.35, sz * 1.15);
      const delta = to.clone().sub(from);
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, delta.length(), 4), lineMaterial);
      line.position.copy(from).addScaledVector(delta, 0.5);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
      canopy.add(line);
    }
    canopy.visible = false; this.group.add(canopy);
    return canopy;
  }

  /** Snap into the skydiver pose the instant a skyfall begins, so the very first frame reads belly-to-earth
   *  face-down rather than the standing pose tipping over across the next few frames (which flashed feet-down /
   *  "facing up"). Also clears any leftover body roll/tip from a previous state so the dive starts clean. */
  startSkydive(): void {
    this.group.rotation.x = 0; this.group.rotation.z = 0;
    this.model.rotation.set(FREEFALL_TIP, 0, 0); this.model.position.y = 0;
    this.torso.rotation.set(0, 0, 0);
  }

  /** Touchdown / bail-out: wipe every airborne rotation so the grounded player is upright and controllable.
   *  landSkyfall (and the teleport/death clears) call this — without it the forward dive tip and turn bank
   *  survive the landing and, compounded with a hard-landing tumble roll, leave the player stuck inverted. */
  resetAirbornePose(): void {
    this.group.rotation.x = 0; this.group.rotation.z = 0;
    this.model.rotation.set(0, 0, 0); this.model.position.y = 0;
    this.torso.rotation.set(0, 0, 0);
    if (this.canopy) { this.canopy.rotation.set(0, 0, 0); }
  }

  /** World-space "up" of the body, composed through both the group (heading/bank) and the model (dive tip).
   *  A grounded, upright player reads ~ (0,1,0); a belly-to-earth diver tips it toward horizontal but never
   *  past it (y stays >= 0 — the diver is never on their back). Exposed for headless pose tests. */
  bodyUp(): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion()));
  }

  /** Airborne pose, driven from Game during a skyfall: freefall spread-eagle tipping with the dive trim, or
   *  hanging in the harness under a gently swaying canopy. Bank rolls the whole body into the turn. */
  animateAirborne(dt: number, mode: 'freefall' | 'parachute', pitch: number, bank: number): void {
    const blend = Math.min(1, dt * 8);
    const pose = (part: THREE.Group, x: number, z?: number): void => { part.rotation.x = THREE.MathUtils.lerp(part.rotation.x, x, blend); if (z !== undefined) part.rotation.z = THREE.MathUtils.lerp(part.rotation.z, z, blend); };
    if (mode === 'freefall') {
      // Belly-to-earth, tipping head-down as W steepens the dive — but CLAMPED below vertical (pi/2) so the
      // diver can never tumble past horizontal onto their back. pitch is already [-1,1] from the pure step.
      const tip = THREE.MathUtils.clamp(FREEFALL_TIP + pitch * FREEFALL_TIP_RANGE, 0.5, Math.PI / 2 - 0.06);
      this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, tip, blend);
      pose(this.leftArm, -0.5, 1.15); pose(this.rightArm, -0.5, -1.15); // arms mirrored: left is +x, outward is +z
      pose(this.leftForearm, -0.3); pose(this.rightForearm, -0.3);
      pose(this.leftLeg, 0.25, 0.35); pose(this.rightLeg, 0.25, -0.35);
      pose(this.leftShin, 0.5); pose(this.rightShin, 0.5);
    } else {
      this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, 0.08 + pitch * 0.14, blend); // upright in the harness
      pose(this.leftArm, -2.5, 0.35); pose(this.rightArm, -2.5, -0.35); // hands up on the risers
      pose(this.leftForearm, -0.15); pose(this.rightForearm, -0.15);
      pose(this.leftLeg, -0.35, 0.08); pose(this.rightLeg, -0.35, -0.08); // legs dangling, knees soft
      pose(this.leftShin, 0.55); pose(this.rightShin, 0.55);
      this.canopyPhase += dt;
      if (this.canopy) { this.canopy.rotation.x = Math.sin(this.canopyPhase * 1.3) * 0.05; this.canopy.rotation.z = Math.cos(this.canopyPhase * 1.1) * 0.06; }
    }
    this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, -bank * 0.55, blend);
    this.torso.rotation.y *= Math.exp(-dt * 8); this.torso.rotation.z *= Math.exp(-dt * 8);
    this.model.position.y = 0; this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, 0, blend);
  }

  private applyPunch(dt: number): void {
    if (this.punchTimer <= 0) { this.model.rotation.y *= Math.exp(-dt * 10); return; }
    this.punchTimer = Math.max(0, this.punchTimer - dt);
    const phase = 1 - this.punchTimer / 0.3; const thrust = Math.sin(Math.min(1, phase) * Math.PI);
    const arm = this.punchLeft ? this.leftArm : this.rightArm;
    const forearm = this.punchLeft ? this.leftForearm : this.rightForearm;
    arm.rotation.x = -1.44 * thrust; arm.rotation.z = (this.punchLeft ? -0.14 : 0.14) * thrust;
    forearm.rotation.x = -1.1 * (1 - thrust) - 0.08;
    this.model.rotation.y = (this.punchLeft ? 0.2 : -0.2) * thrust;
  }

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
    if (this.weapon === 'rpg') {
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, -1.9, dt * 14); this.rightArm.rotation.z = THREE.MathUtils.lerp(this.rightArm.rotation.z, 0.32, dt * 12);
      this.leftArm.rotation.x = THREE.MathUtils.lerp(this.leftArm.rotation.x, -0.55, dt * 14); this.leftArm.rotation.z = THREE.MathUtils.lerp(this.leftArm.rotation.z, -0.4, dt * 12);
      this.rightForearm.rotation.x = THREE.MathUtils.lerp(this.rightForearm.rotation.x, -0.55, dt * 14); this.leftForearm.rotation.x = THREE.MathUtils.lerp(this.leftForearm.rotation.x, -0.8, dt * 14);
      this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, 0.08, dt * 10);
      return;
    }
    this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, -1.46, dt * 14); this.rightArm.rotation.z = THREE.MathUtils.lerp(this.rightArm.rotation.z, 0.09, dt * 12);
    this.leftArm.rotation.x = THREE.MathUtils.lerp(this.leftArm.rotation.x, -1.28, dt * 14); this.leftArm.rotation.z = THREE.MathUtils.lerp(this.leftArm.rotation.z, -0.28, dt * 12);
    this.rightForearm.rotation.x = THREE.MathUtils.lerp(this.rightForearm.rotation.x, -0.06, dt * 14); this.leftForearm.rotation.x = THREE.MathUtils.lerp(this.leftForearm.rotation.x, -0.16, dt * 14);
    this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, -0.06, dt * 10);
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
    this.buildArm(this.leftArm, this.leftForearm, 0.355, jacket, skin); // model faces +z, so anatomical left is +x
    this.buildArm(this.rightArm, this.rightForearm, -0.355, jacket, skin); // weapon hand: true right, the camera's shoulder side
    this.buildWeapons();
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

  private buildArm(arm: THREE.Group, forearm: THREE.Group, x: number, jacket: THREE.Material, skin: THREE.Material): void {
    arm.position.set(x, 1.43, 0); const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.22, 7, 16), jacket); upper.position.y = -0.17; arm.add(upper);
    forearm.position.y = -0.34; const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.056, 0.2, 7, 16), jacket); lower.position.y = -0.16;
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.057, 0.066, 16), jacket); cuff.position.y = -0.31;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), skin); hand.position.y = -0.37; hand.scale.set(0.86, 1.18, 0.74); forearm.add(lower, cuff, hand); arm.add(forearm);
  }

  private buildWeapons(): void {
    for (const id of ['pistol', 'smg', 'shotgun', 'sniper'] as const) { const mesh = buildWeaponModel(id); if (mesh) this.weaponMeshes.set(id, mesh); }
    const rpg = buildWeaponModel('rpg');
    if (rpg) { rpg.rotation.x = -Math.PI / 2; rpg.position.set(-0.3, 1.56, -0.28); this.weaponMeshes.set('rpg', rpg); }
    for (const [id, mesh] of this.weaponMeshes) { mesh.visible = id === this.weapon; (id === 'rpg' ? this.torso : this.rightForearm).add(mesh); }
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
