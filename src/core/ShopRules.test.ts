import { describe, expect, it } from 'vitest';
import { WEAPONS, WEAPON_BY_ID } from '../config';
import { adjustedShopPrice, ammoPrice, ARMOUR_PRICE, detailerPrice, HOTDOG_HEAL, hotdogHeal, reserveFull, resolveArmourPurchase, resolvePurchase, weaponPrice, WEAPON_PRICES } from './ShopRules';

describe('Cordova Arms purchase resolution', () => {
  it('prices every non-melee weapon and never the fists', () => {
    for (const spec of WEAPONS.filter((weapon) => !weapon.melee)) expect(weaponPrice(spec.id)).toBeGreaterThan(0);
    expect(weaponPrice('fists')).toBe(0);
    expect(resolvePurchase('weapon', 'fists', false, 99999)).toEqual({ ok: false, price: 0, reason: 'no-price' });
  });

  it('keeps ammo refills at 10-20% of the weapon price', () => {
    for (const id of Object.keys(WEAPON_PRICES) as Array<keyof typeof WEAPON_PRICES>) {
      const ratio = ammoPrice(id) / weaponPrice(id);
      expect(ratio).toBeGreaterThanOrEqual(0.1);
      expect(ratio).toBeLessThanOrEqual(0.2);
    }
  });

  it('sells a weapon you can afford and do not own', () => {
    expect(resolvePurchase('weapon', 'pistol', false, 400)).toEqual({ ok: true, price: 400 });
    expect(resolvePurchase('weapon', 'rpg', false, 5000)).toEqual({ ok: true, price: 5000 });
  });

  it('stocks the sniper below the rpg with a consistent ammo refill', () => {
    expect(weaponPrice('sniper')).toBe(3500);
    expect(weaponPrice('sniper')).toBeLessThan(weaponPrice('rpg'));
    expect(ammoPrice('sniper')).toBe(525); // the standard 15% refill, in five-rand increments
    expect(resolvePurchase('weapon', 'sniper', false, 3500)).toEqual({ ok: true, price: 3500 });
    expect(resolvePurchase('ammo', 'sniper', true, 525)).toEqual({ ok: true, price: 525 });
  });

  it('refuses weapons already owned or beyond your means', () => {
    expect(resolvePurchase('weapon', 'smg', true, 99999)).toEqual({ ok: false, price: 1200, reason: 'owned' });
    expect(resolvePurchase('weapon', 'shotgun', false, 899)).toEqual({ ok: false, price: 900, reason: 'funds' });
  });

  it('only refills ammo for owned weapons with reserve headroom and cash', () => {
    expect(resolvePurchase('ammo', 'smg', true, 500)).toEqual({ ok: true, price: 180 });
    expect(resolvePurchase('ammo', 'smg', false, 500)).toEqual({ ok: false, price: 180, reason: 'not-owned' });
    expect(resolvePurchase('ammo', 'smg', true, 500, true)).toEqual({ ok: false, price: 180, reason: 'ammo-full' });
    expect(resolvePurchase('ammo', 'smg', true, 179)).toEqual({ ok: false, price: 180, reason: 'funds' });
  });

  it('applies reputation pricing in five-rand increments', () => {
    expect(adjustedShopPrice(900, 0.8)).toBe(720);
    expect(resolvePurchase('weapon', 'shotgun', false, 720, false, 0.8)).toEqual({ ok: true, price: 720 });
    expect(resolvePurchase('weapon', 'shotgun', false, 719, false, 0.8)).toMatchObject({ ok: false, reason: 'funds', price: 720 });
  });

  it('reports a full reserve at triple the spec reserve, matching top-up caps', () => {
    expect(reserveFull('pistol', WEAPON_BY_ID.pistol.reserve * 3 - 1)).toBe(false);
    expect(reserveFull('pistol', WEAPON_BY_ID.pistol.reserve * 3)).toBe(true);
    expect(reserveFull('fists', 0)).toBe(true);
  });
});

describe('Palm Spray detailer pricing', () => {
  it('charges $100 per wanted star', () => {
    expect(detailerPrice(1)).toBe(100);
    expect(detailerPrice(3)).toBe(300);
    expect(detailerPrice(5)).toBe(500);
  });

  it('applies the minimum fee and clamps out-of-range star counts', () => {
    expect(detailerPrice(0)).toBe(100);
    expect(detailerPrice(-2)).toBe(100);
    expect(detailerPrice(9)).toBe(500);
    expect(detailerPrice(2.4)).toBe(200);
  });
});

describe('hot dog vendor healing', () => {
  it('restores a fixed chunk of health', () => {
    expect(hotdogHeal(20, 100)).toBe(20 + HOTDOG_HEAL);
  });

  it('clamps at maximum health and never heals negative amounts', () => {
    expect(hotdogHeal(80, 100)).toBe(100);
    expect(hotdogHeal(100, 100)).toBe(100);
    expect(hotdogHeal(-10, 100)).toBe(HOTDOG_HEAL);
    expect(hotdogHeal(50, 100, -30)).toBe(50);
  });
});

describe('body armour purchases', () => {
  it('sells a full plate when there is headroom and cash', () => {
    expect(resolveArmourPurchase(0, 1000)).toEqual({ ok: true, price: ARMOUR_PRICE });
    expect(resolveArmourPurchase(99, ARMOUR_PRICE)).toEqual({ ok: true, price: ARMOUR_PRICE });
  });

  it('refuses when already plated or broke', () => {
    expect(resolveArmourPurchase(100, 99999)).toEqual({ ok: false, price: ARMOUR_PRICE, reason: 'armour-full' });
    expect(resolveArmourPurchase(0, ARMOUR_PRICE - 1)).toEqual({ ok: false, price: ARMOUR_PRICE, reason: 'funds' });
  });

  it('applies the district price multiplier with R5 rounding', () => {
    const discounted = resolveArmourPurchase(0, 99999, 0.8);
    expect(discounted.ok).toBe(true);
    expect(discounted.price).toBe(Math.round(ARMOUR_PRICE * 0.8 / 5) * 5);
  });
});
