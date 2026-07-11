import { CHEATS, PLAYER, WEAPONS, type WeaponId, type WeaponSpec } from '../config';

export class Economy {
  constructor(public balance = 750) {}
  earn(amount: number): number {
    if (amount < 0) throw new Error('Reward cannot be negative');
    this.balance += Math.round(amount);
    return this.balance;
  }
  spend(amount: number): boolean {
    if (amount < 0 || amount > this.balance) return false;
    this.balance -= Math.round(amount);
    return true;
  }
}

export function calculateDamage(base: number, distance: number, armour = 0, falloffFloor = 0.35): number {
  const falloff = Math.max(falloffFloor, 1 - Math.max(0, distance - 15) / 100);
  return Math.max(0, Math.round(base * falloff - armour * 0.45));
}

export function cycleWeapon(current: WeaponId, direction: 1 | -1, isOwned: (id: WeaponId) => boolean = () => true): WeaponId {
  const index = WEAPONS.findIndex((spec) => spec.id === current);
  for (let step = 1; step <= WEAPONS.length; step++) {
    const next = WEAPONS[(index + direction * step + WEAPONS.length * step) % WEAPONS.length];
    if (next && next.id !== current && isOwned(next.id)) return next.id;
  }
  return current;
}

export function splashDamage(base: number, distance: number, radius: number): number {
  if (distance >= radius) return 0;
  return Math.round(base * (1 - distance / radius));
}

export type PedKind = 'civilian' | 'guard' | 'police';
export interface DropRoll { cash: number; weapon?: WeaponId; ammo?: boolean; }

export function rollDrops(kind: PedKind, random: () => number = Math.random): DropRoll {
  if (kind === 'guard') {
    const cash = 40 + Math.floor(random() * 80); const roll = random();
    return { cash, weapon: roll < 0.12 ? 'rpg' : roll < 0.56 ? 'smg' : roll < 0.95 ? 'shotgun' : 'sniper' }; // sniper is the rare 5% prize; rpg/smg odds untouched
  }
  if (kind === 'police') return { cash: 5 + Math.floor(random() * 25), weapon: 'pistol' };
  const cash = 10 + Math.floor(random() * 50); const roll = random();
  if (roll < 0.1) return { cash, weapon: 'pistol' };
  if (roll < 0.25) return { cash, ammo: true };
  return { cash };
}

export function triggerPulled(spec: WeaponSpec, held: boolean, pressed: boolean): boolean {
  return spec.auto ? held : pressed;
}

export function outOfAmmo(spec: WeaponSpec, ammo: number, reserve: number): boolean {
  return !spec.melee && ammo <= 0 && reserve <= 0;
}

export const AIM_SPEED_MULTIPLIER = 0.5;
export const DRIVEBY_COOLDOWN_SCALE = 1.5; // one-handed out the window: slower than planted feet

export function moveSpeed(sprinting: boolean, fastRun: boolean, aiming = false): number {
  return (sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * (fastRun ? CHEATS.runMultiplier : 1) * (aiming ? AIM_SPEED_MULTIPLIER : 1);
}

export function crosshairVisible(aiming: boolean, melee: boolean): boolean { return aiming && !melee; }
/** Drive-by needs aim mode and a one-handed gun: no fists, no shoulder-launched rockets and no scoped rifles inside a Golf. */
export function canFireFromVehicle(aiming: boolean, melee: boolean, projectile = false, scopedWeapon = false): boolean { return aiming && !melee && !projectile && !scopedWeapon; }

export function jumpVelocity(bigJump: boolean): number {
  return PLAYER.jumpSpeed * (bigJump ? CHEATS.jumpMultiplier : 1);
}

/** GTA-style fall damage: drops within the safe height are free, then every unit costs health; ~32u is lethal.
 *  The drop is measured from the fall origin (jump take-off or the edge walked off), which naturally exempts
 *  big-jump landings back at their own launch height. */
export const FALL_SAFE_DROP = 12;
export const FALL_DAMAGE_PER_UNIT = 5;
export function fallDamage(drop: number): number {
  return drop <= FALL_SAFE_DROP ? 0 : Math.min(100, Math.round((drop - FALL_SAFE_DROP) * FALL_DAMAGE_PER_UNIT));
}

export interface VerticalMotion { y: number; velocityY: number; onGround: boolean; fallOriginY: number; }
/** One tick of the player's vertical life against the highest standable support underfoot: step-up/step-down
 *  snapping while grounded, gravity while airborne (walking off an edge starts a fall), and a landing report
 *  whose drop is measured from the recorded fall origin. Pure, so headless sims can run the same physics. */
export function stepVertical(motion: VerticalMotion, dt: number, support: number, jump?: number, stepUp = PLAYER.stepUp, gravity = PLAYER.gravity): { landed: boolean; drop: number } {
  if (motion.onGround) {
    if (jump !== undefined) { motion.velocityY = jump; motion.onGround = false; motion.fallOriginY = motion.y; }
    else if (motion.y - support <= stepUp) { motion.y = support; motion.velocityY = 0; return { landed: false, drop: 0 }; }
    else { motion.onGround = false; motion.velocityY = 0; motion.fallOriginY = motion.y; } // walked off an edge
  }
  motion.velocityY -= gravity * dt; motion.y += motion.velocityY * dt;
  if (motion.velocityY <= 0 && motion.y <= support) {
    const drop = motion.fallOriginY - support;
    motion.y = support; motion.velocityY = 0; motion.onGround = true;
    return { landed: true, drop };
  }
  return { landed: false, drop: 0 };
}

/** Bicycles have no throttle: W turns the cranks at a cruise, Shift (the sprint key) stands on the pedals. */
export const BICYCLE_CRUISE_FACTOR = 0.6;
export function bicycleCap(maxSpeed: number, pedalHard: boolean): number {
  return maxSpeed * (pedalHard ? 1 : BICYCLE_CRUISE_FACTOR);
}

/** Losing this much speed in a single hit throws the rider off a two-wheeler (bicycle flat-out just clears it). */
export const KNOCKOFF_IMPACT_SPEED = 13;
export function shouldKnockOff(impact: number): boolean { return impact >= KNOCKOFF_IMPACT_SPEED; }
/** Riders wear no cocoon: collision energy above a bruising floor lands on the player's health bar. */
export function riderImpactDamage(impact: number): number { return Math.max(0, Math.round((impact - 6) * 1.4)); }

/** Carry caps for the item inventory. */
export const ARMOUR_MAX = 100;
export const STIM_MAX = 5;
export const STIM_HEAL = 50;
export const PARACHUTE_MAX = 3;

/** Classic GTA body armour: the vest soaks damage point-for-point before health takes the remainder. */
export function absorbDamage(armour: number, amount: number): { armour: number; through: number } {
  const soaked = Math.min(Math.max(0, armour), Math.max(0, amount));
  return { armour: Math.max(0, armour) - soaked, through: Math.max(0, amount) - soaked };
}

/** One stim pack: +50 health, clamped to the maximum. */
export function stimHeal(health: number, maxHealth: number, amount = STIM_HEAL): number {
  return Math.min(maxHealth, Math.max(0, health) + amount);
}

export function spreadOffset(spread: number, random: () => number = Math.random): [number, number] {
  const angle = random() * Math.PI * 2; const radius = Math.sqrt(random()) * spread;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}
