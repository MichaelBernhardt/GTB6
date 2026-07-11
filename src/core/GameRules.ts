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

export function calculateDamage(base: number, distance: number, armour = 0): number {
  const falloff = Math.max(0.35, 1 - Math.max(0, distance - 15) / 100);
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
    return { cash, weapon: roll < 0.12 ? 'rpg' : roll < 0.56 ? 'smg' : 'shotgun' };
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
/** Drive-by needs aim mode and a one-handed gun: no fists, no shoulder-launched rockets inside a Golf. */
export function canFireFromVehicle(aiming: boolean, melee: boolean, projectile = false): boolean { return aiming && !melee && !projectile; }

export function jumpVelocity(bigJump: boolean): number {
  return PLAYER.jumpSpeed * (bigJump ? CHEATS.jumpMultiplier : 1);
}

export function spreadOffset(spread: number, random: () => number = Math.random): [number, number] {
  const angle = random() * Math.PI * 2; const radius = Math.sqrt(random()) * spread;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}
