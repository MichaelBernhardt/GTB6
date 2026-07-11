import { WEAPON_BY_ID, type WeaponId } from '../config';
import { ARMOUR_MAX } from './GameRules';

/** Sticker prices at Jozi Arms. Ammo refills cost ~15% of the weapon price. */
export const WEAPON_PRICES: Partial<Record<WeaponId, number>> = { pistol: 400, smg: 1200, shotgun: 900, rpg: 5000, sniper: 3500 };
export const AMMO_PRICE_FACTOR = 0.15;

export function weaponPrice(id: WeaponId): number { return WEAPON_PRICES[id] ?? 0; }
export function ammoPrice(id: WeaponId): number { return Math.round(weaponPrice(id) * AMMO_PRICE_FACTOR / 5) * 5; }
export function adjustedShopPrice(price: number, multiplier: number): number { return Math.max(0, Math.round(price * multiplier / 5) * 5); }

export type PurchaseDenial = 'no-price' | 'owned' | 'not-owned' | 'ammo-full' | 'armour-full' | 'funds';
export interface PurchaseResult { ok: boolean; price: number; reason?: PurchaseDenial; }

/** Resolves a shop transaction without applying it: weapons need to be unowned, ammo needs the weapon and reserve headroom, and both need cash. */
export function resolvePurchase(kind: 'weapon' | 'ammo', id: WeaponId, owned: boolean, balance: number, ammoFull = false, multiplier = 1): PurchaseResult {
  const price = adjustedShopPrice(kind === 'weapon' ? weaponPrice(id) : ammoPrice(id), multiplier);
  if (price <= 0) return { ok: false, price, reason: 'no-price' };
  if (kind === 'weapon' && owned) return { ok: false, price, reason: 'owned' };
  if (kind === 'ammo' && !owned) return { ok: false, price, reason: 'not-owned' };
  if (kind === 'ammo' && ammoFull) return { ok: false, price, reason: 'ammo-full' };
  if (balance < price) return { ok: false, price, reason: 'funds' };
  return { ok: true, price };
}

/** Reserve ammo is capped at three times the spec reserve, matching CombatSystem top-ups. */
export function reserveFull(id: WeaponId, reserve: number): boolean {
  const spec = WEAPON_BY_ID[id];
  return !spec || spec.melee || reserve >= spec.reserve * 3;
}

export const ARMOUR_PRICE = 350;
/** Body armour at Jozi Arms: one fitting tops the pool to full — no sale when already plated or broke. */
export function resolveArmourPurchase(armour: number, balance: number, multiplier = 1): PurchaseResult {
  const price = adjustedShopPrice(ARMOUR_PRICE, multiplier);
  if (armour >= ARMOUR_MAX) return { ok: false, price, reason: 'armour-full' };
  if (balance < price) return { ok: false, price, reason: 'funds' };
  return { ok: true, price };
}

export const DETAILER_RATE = 100;
/** Palm Spray charges $100 per wanted star with a $100 minimum service fee. */
export function detailerPrice(stars: number): number {
  return Math.max(1, Math.min(5, Math.round(stars))) * DETAILER_RATE;
}

export const HOTDOG_PRICE = 25;
export const HOTDOG_HEAL = 60;
/** Street food restores a chunk of health, clamped to the maximum. */
export function hotdogHeal(health: number, maxHealth: number, amount = HOTDOG_HEAL): number {
  return Math.min(maxHealth, Math.max(0, health) + Math.max(0, amount));
}
