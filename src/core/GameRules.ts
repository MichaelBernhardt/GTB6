import { WEAPONS, type WeaponId, type WeaponSpec } from '../config';

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

export function cycleWeapon(current: WeaponId, direction: 1 | -1): WeaponId {
  const index = WEAPONS.findIndex((spec) => spec.id === current);
  return WEAPONS[(index + direction + WEAPONS.length) % WEAPONS.length]?.id ?? current;
}

export function triggerPulled(spec: WeaponSpec, held: boolean, pressed: boolean): boolean {
  return spec.auto ? held : pressed;
}

export function outOfAmmo(spec: WeaponSpec, ammo: number, reserve: number): boolean {
  return !spec.melee && ammo <= 0 && reserve <= 0;
}

export function spreadOffset(spread: number, random: () => number = Math.random): [number, number] {
  const angle = random() * Math.PI * 2; const radius = Math.sqrt(random()) * spread;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}
