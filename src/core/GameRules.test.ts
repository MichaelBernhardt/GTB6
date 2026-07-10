import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID, WEAPONS } from '../config';
import { Economy, calculateDamage, cycleWeapon, outOfAmmo, spreadOffset, triggerPulled } from './GameRules';

describe('economy', () => {
  it('applies rounded rewards and rejects overspending', () => {
    const economy = new Economy(100);
    expect(economy.earn(49.6)).toBe(150);
    expect(economy.spend(40)).toBe(true);
    expect(economy.balance).toBe(110);
    expect(economy.spend(111)).toBe(false);
  });
});

describe('damage', () => {
  it('applies range falloff, armour, and a minimum falloff', () => {
    expect(calculateDamage(40, 10)).toBe(40);
    expect(calculateDamage(40, 55)).toBeLessThan(40);
    expect(calculateDamage(40, 500)).toBe(14);
    expect(calculateDamage(40, 10, 20)).toBe(31);
  });
});

describe('weapon rules', () => {
  it('cycles through the loadout in order and wraps both ways', () => {
    expect(cycleWeapon('fists', 1)).toBe('pistol');
    expect(cycleWeapon('pistol', 1)).toBe('smg');
    expect(cycleWeapon('smg', 1)).toBe('shotgun');
    expect(cycleWeapon('shotgun', 1)).toBe('fists');
    expect(cycleWeapon('fists', -1)).toBe('shotgun');
    let current = WEAPONS[0]!.id;
    for (let i = 0; i < WEAPONS.length; i++) current = cycleWeapon(current, 1);
    expect(current).toBe(WEAPONS[0]!.id);
  });

  it('gates semi-auto weapons on a fresh press and full-auto on hold', () => {
    expect(triggerPulled(WEAPON_BY_ID.pistol, true, false)).toBe(false);
    expect(triggerPulled(WEAPON_BY_ID.pistol, true, true)).toBe(true);
    expect(triggerPulled(WEAPON_BY_ID.shotgun, true, false)).toBe(false);
    expect(triggerPulled(WEAPON_BY_ID.smg, true, false)).toBe(true);
    expect(triggerPulled(WEAPON_BY_ID.smg, false, false)).toBe(false);
    expect(triggerPulled(WEAPON_BY_ID.fists, true, false)).toBe(false);
    expect(triggerPulled(WEAPON_BY_ID.fists, false, true)).toBe(true);
  });

  it('only guns run out of ammo', () => {
    expect(outOfAmmo(WEAPON_BY_ID.pistol, 0, 0)).toBe(true);
    expect(outOfAmmo(WEAPON_BY_ID.pistol, 0, 5)).toBe(false);
    expect(outOfAmmo(WEAPON_BY_ID.pistol, 3, 0)).toBe(false);
    expect(outOfAmmo(WEAPON_BY_ID.fists, 0, 0)).toBe(false);
  });

  it('keeps spread offsets inside the cone radius', () => {
    for (let i = 0; i < 200; i++) {
      const [x, y] = spreadOffset(0.05);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    const [zx, zy] = spreadOffset(0);
    expect(Math.hypot(zx, zy)).toBe(0);
  });
});
