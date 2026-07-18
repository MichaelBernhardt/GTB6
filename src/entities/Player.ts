import * as THREE from 'three';
import { PLAYER, type VehicleKind, type WeaponId } from '../config';
import type { InputManager } from '../core/InputManager';
import { fallDamage, jumpVelocity, moveSpeed, stepVertical } from '../core/GameRules';
import { inebriationFraction } from '../core/DrinkRules';
import type { CheatSettings } from '../types';
import type { City } from '../world/City';
import {
  initialPlayerVisualState, RiggedPlayerVisual, type CharacterLoadStatus, type PlayerVisualState,
  type RiggedPlayerVisualOptions, type RideMode,
} from './RiggedPlayerVisual';

/** Game-computed cover pose: Game owns the cover position; the player only acts it out. */
export interface CoverPose { heading: number; peek: number; twist: number; moving: boolean; }

/** Freefall body tip about the visual rig's X axis. Both ends stay below pi/2 so the diver never inverts. */
export const FREEFALL_TIP = 1.22;
export const FREEFALL_TIP_RANGE = 0.28;

/** Ghost (free-fly) test mode tuning. */
export const GHOST_RUN_SPEED = 168;
export const GHOST_WHEEL_STEP = 4;

export class Player {
  group = new THREE.Group();
  health = PLAYER.maxHealth;
  maxHealth = PLAYER.maxHealth;
  velocityY = 0;
  onGround = true;
  ghost = false;
  private ghostRise = 0;
  inVehicle = false;
  heading = 0;
  moving = false;
  sprinting = false;
  /** 0..100 skinful. */
  inebriation = 0;
  cheats: Pick<CheatSettings, 'fastRun' | 'bigJump'> = { fastRun: false, bigJump: false };
  private staggerWander = 0;
  private swayPhase = 0;
  private tumbleTimer = 0;
  private tumbleDuration = 1;
  private tumbleDir: -1 | 1 = 1;
  private tumbleBaseY = 0;
  private fallOriginY = 0;
  private pendingFallDamage = 0;
  private weapon: WeaponId = 'pistol';
  private punchTimer = 0;
  private punchLeft = false;
  private landingTimer = 0;
  private canopy?: THREE.Group;
  private canopyPhase = 0;
  private bodyPitch = 0;
  private bodyRoll = 0;
  private visualState: PlayerVisualState = initialPlayerVisualState();
  private riggedVisual: RiggedPlayerVisual;

  constructor(scene: THREE.Scene, position = new THREE.Vector3(0, 0, 260), visualOptions: RiggedPlayerVisualOptions = {}) {
    this.group.position.copy(position); this.heading = Math.PI; this.group.rotation.y = this.heading; this.group.name = 'Player'; scene.add(this.group);
    this.riggedVisual = new RiggedPlayerVisual(this.group, visualOptions);
  }

  get characterStatus(): CharacterLoadStatus { return this.riggedVisual.status; }
  get characterError(): Error | undefined { return this.riggedVisual.error; }
  loadCharacter(): Promise<void> { return this.riggedVisual.load(); }
  retryCharacter(): Promise<void> { return this.riggedVisual.retry(); }

  update(dt: number, input: InputManager, cameraYaw: number, city: City, cover?: CoverPose): void {
    this.moving = false; this.sprinting = false;
    if (this.inVehicle || this.health <= 0) return;
    this.landingTimer = Math.max(0, this.landingTimer - dt);
    if (this.ghost) { this.updateGhost(dt, input, cameraYaw); return; }
    if (this.tumbleTimer > 0) { this.applyTumble(dt); this.setVisualState({ tumbleProgress: this.tumbleProgress, tumbleDirection: this.tumbleDir, onGround: true }); return; }
    const aimHeld = input.aiming && this.weapon !== 'fists';
    const aiming = aimHeld || (input.firing && this.weapon !== 'fists');
    if (cover) { this.updateCover(dt, cover, aiming, input.firing, city.supportHeight(this.group.position.x, this.group.position.z, this.group.position.y)); return; }
    const side = Number(input.down('KeyD')) - Number(input.down('KeyA'));
    const forward = Number(input.down('KeyW')) - Number(input.down('KeyS'));
    const move = new THREE.Vector3(side, 0, -forward); const moving = move.lengthSq() > 0; const sprinting = moving && input.down('ShiftLeft');
    const strolling = moving && !sprinting && input.down('AltLeft');
    this.moving = moving; this.sprinting = sprinting;
    const drunk = inebriationFraction(this.inebriation); const stagger = this.updateStagger(dt, drunk); let speed = 0;
    if (moving) {
      move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
      if (stagger) move.applyAxisAngle(new THREE.Vector3(0, 1, 0), stagger);
      speed = moveSpeed(sprinting, this.cheats.fastRun, aimHeld, strolling) * (1 - 0.28 * drunk);
      const desired = this.group.position.clone().addScaledVector(move, speed * dt);
      this.group.position.copy(city.clampMoveAt(this.group.position, desired, PLAYER.radius));
      this.turnToward(aimHeld ? cameraYaw + Math.PI : Math.atan2(move.x, move.z), dt, aimHeld ? 13 : sprinting ? 15 : 11);
    } else if (input.firing || aimHeld) this.turnToward(cameraYaw + Math.PI, dt, 13);
    else if (stagger && drunk > 0) this.turnToward(this.heading + stagger, dt, 4);
    this.group.rotation.x *= Math.exp(-dt * 12); this.group.rotation.z *= Math.exp(-dt * 12);
    this.applyPunch(dt);
    const jump = input.consume('Space') && this.onGround ? jumpVelocity(this.cheats.bigJump) : undefined;
    const support = city.supportHeight(this.group.position.x, this.group.position.z, this.group.position.y);
    const motion = { y: this.group.position.y, velocityY: this.velocityY, onGround: this.onGround, fallOriginY: this.fallOriginY };
    const landing = stepVertical(motion, dt, support, jump);
    this.group.position.y = motion.y; this.velocityY = motion.velocityY; this.onGround = motion.onGround; this.fallOriginY = motion.fallOriginY;
    if (landing.landed) {
      const damage = fallDamage(landing.drop); this.landingTimer = 0.18;
      if (damage > 0) { this.pendingFallDamage += damage; this.tumble(); }
    }
    this.setVisualState({
      locomotionSpeed: speed, aiming, firing: input.firing, moveSide: side, moveForward: forward,
      onGround: this.onGround, velocityY: this.velocityY, landing: this.landingTimer > 0, inebriation: drunk,
    });
  }

  private updateGhost(dt: number, input: InputManager, cameraYaw: number): void {
    const side = Number(input.down('KeyD')) - Number(input.down('KeyA')); const forward = Number(input.down('KeyW')) - Number(input.down('KeyS'));
    const move = new THREE.Vector3(side, 0, -forward); const sprinting = input.down('ShiftLeft'); let speed = 0;
    if (move.lengthSq() > 0) {
      this.moving = true; this.sprinting = sprinting; move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
      speed = sprinting ? GHOST_RUN_SPEED : moveSpeed(false, this.cheats.fastRun, false); this.group.position.addScaledVector(move, speed * dt); this.turnToward(Math.atan2(move.x, move.z), dt, 12);
    }
    this.group.position.y += this.ghostRise; this.ghostRise = 0; this.velocityY = 0; this.onGround = false; this.group.rotation.z *= Math.exp(-dt * 12);
    this.setVisualState({ locomotionSpeed: speed, aiming: false, firing: false, onGround: true, velocityY: 0 });
  }

  /** Aboard a moving platform (train corridor): the platform owns the position; this drives the walk/idle rig and the movement flags directly. */
  animateAboard(speed: number, side: number, forward: number): void {
    this.moving = speed > 0.1; this.sprinting = false; this.onGround = true; this.velocityY = 0;
    this.setVisualState({ locomotionSpeed: speed, aiming: false, firing: false, moveSide: side, moveForward: forward, onGround: true, velocityY: 0 });
  }

  toggleGhost(): boolean { this.ghost = !this.ghost; this.velocityY = 0; this.onGround = !this.ghost; this.ghostRise = 0; return this.ghost; }
  ghostAdjustAltitude(scroll: number): void { this.ghostRise += (scroll > 0 ? 1 : -1) * GHOST_WHEEL_STEP; }
  consumeFallDamage(): number { const amount = this.pendingFallDamage; this.pendingFallDamage = 0; return amount; }

  private updateCover(dt: number, cover: CoverPose, aiming: boolean, firing: boolean, ground: number): void {
    this.turnToward(cover.heading, dt, 12); this.applyPunch(dt); this.group.position.y = ground; this.velocityY = 0; this.onGround = true;
    this.setVisualState({
      locomotionSpeed: cover.moving ? 2.6 : 0, aiming, firing, coverMode: aiming ? 'aim' : cover.moving ? 'move' : 'idle',
      coverTwist: cover.twist, onGround: true, velocityY: 0, inebriation: inebriationFraction(this.inebriation),
    });
  }

  takeDamage(amount: number): void { this.health = Math.max(0, this.health - Math.max(0, amount)); }
  heal(): void { this.health = this.maxHealth; this.inebriation = 0; this.setDead(false); }
  setVisible(visible: boolean): void { this.group.visible = visible; }
  setWeapon(id: WeaponId): void { if (id === this.weapon) return; this.weapon = id; this.riggedVisual.setWeapon(id); }
  /** Report one ranged shot accepted by CombatSystem so visual recoil can retrigger independently of the held trigger. */
  registerShot(): void { if (this.weapon !== 'fists') this.visualState.shotSequence += 1; }
  punch(): void { this.punchTimer = 0.6; this.punchLeft = !this.punchLeft; this.visualState.attack = this.punchLeft ? 'punch_left' : 'punch_right'; } // window matches the 0.6s punch clips, so a single swing plays out instead of cutting at two-thirds

  setDead(dead: boolean): void {
    this.visualState.dead = dead; this.visualState.attack = undefined;
    if (dead) Object.assign(this.visualState, { coverMode: 'none', rideMode: 'none', airMode: 'none', tumbleProgress: 0, firing: false });
  }

  updateVisual(dt: number): void { this.riggedVisual.setState(this.visualState); this.riggedVisual.update(dt); }
  setHeading(heading: number): void { this.heading = heading; this.group.rotation.y = heading; }
  tumble(duration = 1.15): void { this.tumbleTimer = duration; this.tumbleDuration = duration; this.tumbleDir = Math.random() < 0.5 ? -1 : 1; this.tumbleBaseY = this.group.position.y; this.velocityY = 0; this.onGround = true; }
  get tumbling(): boolean { return this.tumbleTimer > 0; }
  private get tumbleProgress(): number { return this.tumbleTimer > 0 ? 1 - this.tumbleTimer / this.tumbleDuration : 0; }

  private applyTumble(dt: number): void {
    this.tumbleTimer = Math.max(0, this.tumbleTimer - dt); const progress = this.tumbleProgress;
    const roll = Math.min(1, progress * 3.2) * (1 - THREE.MathUtils.smoothstep(progress, 0.72, 1));
    this.group.rotation.x = 0; this.group.rotation.z = 0; this.bodyRoll = this.tumbleDir * Math.PI / 2 * roll; this.group.position.y = this.tumbleBaseY + 0.36 * roll;
    if (this.tumbleTimer === 0) { this.bodyRoll = 0; this.group.position.y = this.tumbleBaseY; }
  }

  animateRiding(_dt: number, kind: VehicleKind, speed: number, aiming = false, firing = false): void {
    const rideMode: RideMode = kind === 'bicycle' ? 'bicycle' : kind === 'superbike' ? 'superbike' : 'motorbike';
    this.bodyPitch = 0; this.bodyRoll = 0;
    this.setVisualState({ locomotionSpeed: 0, aiming, firing, rideMode, rideSpeed: speed, driveBy: aiming, onGround: true, velocityY: 0 });
  }

  /** GTA-style canopy accessory; the humanoid itself is always the authored rig. */
  setCanopy(visible: boolean): void {
    if (visible && !this.canopy) this.canopy = this.buildCanopy();
    if (this.canopy) this.canopy.visible = visible;
  }

  private buildCanopy(): THREE.Group {
    const canopy = new THREE.Group(); canopy.name = 'Parachute';
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.7, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), new THREE.MeshStandardMaterial({ color: 0xd75844, roughness: 0.85, side: THREE.DoubleSide }));
    dome.scale.set(1, 0.52, 0.78); dome.position.y = 4.7; dome.castShadow = true;
    const stripe = new THREE.Mesh(new THREE.SphereGeometry(2.71, 20, 6, -Math.PI / 7, Math.PI * 2 / 7, 0, Math.PI * 0.5), new THREE.MeshStandardMaterial({ color: 0xf2edda, roughness: 0.85, side: THREE.DoubleSide }));
    stripe.scale.copy(dome.scale); stripe.position.copy(dome.position); canopy.add(dome, stripe);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xd8d4c5 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const from = new THREE.Vector3(sx * 0.32, 1.5, sz * 0.1); const to = new THREE.Vector3(sx * 1.95, 4.35, sz * 1.15); const delta = to.clone().sub(from);
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, delta.length(), 4), lineMaterial); line.position.copy(from).addScaledVector(delta, 0.5); line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); canopy.add(line);
    }
    canopy.visible = false; this.group.add(canopy); return canopy;
  }

  startSkydive(): void {
    this.group.rotation.x = 0; this.group.rotation.z = 0; this.bodyPitch = FREEFALL_TIP; this.bodyRoll = 0;
    this.setVisualState({ airMode: 'freefall', airPitch: 0, airBank: 0, onGround: false, velocityY: -1 });
  }

  resetAirbornePose(): void {
    this.group.rotation.x = 0; this.group.rotation.z = 0; this.bodyPitch = 0; this.bodyRoll = 0;
    if (this.canopy) this.canopy.rotation.set(0, 0, 0);
    this.setVisualState({ airMode: 'none', airPitch: 0, airBank: 0, onGround: true, velocityY: 0 });
  }

  /** World-space body up composed from gameplay heading plus the visual-only air/tumble offsets. */
  bodyUp(): THREE.Vector3 {
    const local = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.bodyPitch, 0, this.bodyRoll));
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.group.quaternion.clone().multiply(local));
  }

  animateAirborne(dt: number, mode: 'freefall' | 'parachute', pitch: number, bank: number): void {
    this.bodyPitch = mode === 'freefall' ? THREE.MathUtils.clamp(FREEFALL_TIP + pitch * FREEFALL_TIP_RANGE, 0.5, Math.PI / 2 - 0.06) : 0.08 + pitch * 0.14;
    this.bodyRoll = -bank * 0.55;
    if (mode === 'parachute') { this.canopyPhase += dt; if (this.canopy) { this.canopy.rotation.x = Math.sin(this.canopyPhase * 1.3) * 0.05; this.canopy.rotation.z = Math.cos(this.canopyPhase * 1.1) * 0.06; } }
    this.setVisualState({ airMode: mode, airPitch: pitch, airBank: bank, onGround: false, velocityY: mode === 'freefall' ? -1 : -0.25 });
  }

  private applyPunch(dt: number): void {
    if (this.punchTimer <= 0) { this.visualState.attack = undefined; return; }
    this.punchTimer = Math.max(0, this.punchTimer - dt); if (this.punchTimer === 0) this.visualState.attack = undefined;
  }

  private turnToward(target: number, dt: number, rate: number): void {
    const delta = Math.atan2(Math.sin(target - this.heading), Math.cos(target - this.heading)); this.heading += delta * Math.min(1, dt * rate); this.group.rotation.y = this.heading;
  }

  private updateStagger(dt: number, drunk: number): number {
    this.staggerWander += (Math.random() - 0.5) * dt * 7; this.staggerWander -= this.staggerWander * dt * 2.4;
    this.staggerWander = THREE.MathUtils.clamp(this.staggerWander, -1, 1); this.swayPhase += dt * (1.4 + drunk * 2.2);
    return drunk <= 0 ? 0 : (this.staggerWander + Math.sin(this.swayPhase) * 0.35) * drunk * 0.62;
  }

  private setVisualState(next: Partial<PlayerVisualState>): void {
    const dead = this.visualState.dead;
    Object.assign(this.visualState, {
      coverMode: 'none', coverTwist: 0, rideMode: 'none', rideSpeed: 0, driveBy: false,
      airMode: 'none', airPitch: 0, airBank: 0, tumbleProgress: 0,
      moveSide: 0, moveForward: 0, landing: this.landingTimer > 0, inebriation: inebriationFraction(this.inebriation),
    }, next);
    this.visualState.dead = dead;
  }
}
