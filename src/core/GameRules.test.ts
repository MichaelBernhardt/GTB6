import { describe, expect, it } from 'vitest';
import { CHEATS, PLAYER, WEAPON_BY_ID, WEAPONS, type WeaponId } from '../config';
import { BICYCLE_CRUISE_FACTOR, Economy, KNOCKOFF_IMPACT_SPEED, bicycleCap, calculateDamage, cycleWeapon, jumpVelocity, moveSpeed, outOfAmmo, riderImpactDamage, rollDrops, shouldKnockOff, splashDamage, spreadOffset, triggerPulled } from './GameRules';

const rng = (...values: number[]): (() => number) => { let i = 0; return () => values[i++] ?? 0; };

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
    expect(cycleWeapon('shotgun', 1)).toBe('rpg');
    expect(cycleWeapon('rpg', 1)).toBe('fists');
    expect(cycleWeapon('fists', -1)).toBe('rpg');
    let current = WEAPONS[0]!.id;
    for (let i = 0; i < WEAPONS.length; i++) current = cycleWeapon(current, 1);
    expect(current).toBe(WEAPONS[0]!.id);
  });

  it('skips weapons the player does not own while cycling', () => {
    const owned = new Set<WeaponId>(['fists', 'pistol', 'rpg']);
    const isOwned = (id: WeaponId) => owned.has(id);
    expect(cycleWeapon('pistol', 1, isOwned)).toBe('rpg');
    expect(cycleWeapon('rpg', 1, isOwned)).toBe('fists');
    expect(cycleWeapon('fists', -1, isOwned)).toBe('rpg');
    expect(cycleWeapon('pistol', 1, (id) => id === 'pistol')).toBe('pistol');
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

  it('applies linear splash falloff inside the blast radius', () => {
    expect(splashDamage(120, 0, 7)).toBe(120);
    expect(splashDamage(120, 3.5, 7)).toBe(60);
    expect(splashDamage(120, 7, 7)).toBe(0);
    expect(splashDamage(120, 30, 7)).toBe(0);
    expect(splashDamage(120, 1, 7)).toBeGreaterThan(splashDamage(120, 5, 7));
  });
});

describe('cheat multipliers', () => {
  it('scales walk and sprint speed with the fast run cheat', () => {
    expect(moveSpeed(false, false)).toBe(PLAYER.walkSpeed);
    expect(moveSpeed(true, false)).toBe(PLAYER.sprintSpeed);
    expect(moveSpeed(false, true)).toBeCloseTo(PLAYER.walkSpeed * CHEATS.runMultiplier);
    expect(moveSpeed(true, true)).toBeCloseTo(PLAYER.sprintSpeed * CHEATS.runMultiplier);
    expect(CHEATS.runMultiplier).toBeCloseTo(1.8);
  });

  it('scales jump velocity with the big jump cheat', () => {
    expect(jumpVelocity(false)).toBe(PLAYER.jumpSpeed);
    expect(jumpVelocity(true)).toBeCloseTo(PLAYER.jumpSpeed * CHEATS.jumpMultiplier);
    expect(CHEATS.jumpMultiplier).toBeCloseTo(2);
  });
});

describe('two-wheeler rules', () => {
  it('caps bicycle speed at a cruise unless the rider stands on the pedals', () => {
    expect(bicycleCap(26, true)).toBe(26);
    expect(bicycleCap(26, false)).toBeCloseTo(26 * BICYCLE_CRUISE_FACTOR);
    expect(BICYCLE_CRUISE_FACTOR).toBeGreaterThan(0.4);
    expect(BICYCLE_CRUISE_FACTOR).toBeLessThan(0.8);
  });

  it('throws the rider only past the knock-off impact threshold', () => {
    expect(shouldKnockOff(0)).toBe(false);
    expect(shouldKnockOff(KNOCKOFF_IMPACT_SPEED - 0.01)).toBe(false);
    expect(shouldKnockOff(KNOCKOFF_IMPACT_SPEED)).toBe(true);
    expect(shouldKnockOff(60)).toBe(true);
  });

  it('bruises the rider progressively with impact speed, ignoring taps', () => {
    expect(riderImpactDamage(0)).toBe(0);
    expect(riderImpactDamage(5)).toBe(0);
    expect(riderImpactDamage(KNOCKOFF_IMPACT_SPEED)).toBeGreaterThan(0);
    expect(riderImpactDamage(40)).toBeGreaterThan(riderImpactDamage(20));
    expect(riderImpactDamage(60)).toBeLessThanOrEqual(PLAYER.maxHealth); // a flat-out superbike wall hit hurts, not one-shots
  });
});

describe('drop tables', () => {
  it('guards always drop a heavy weapon and richer cash', () => {
    expect(rollDrops('guard', rng(0, 0))).toEqual({ cash: 40, weapon: 'rpg' });
    expect(rollDrops('guard', rng(0.5, 0.3))).toEqual({ cash: 80, weapon: 'smg' });
    expect(rollDrops('guard', rng(0.99, 0.9))).toEqual({ cash: 119, weapon: 'shotgun' });
  });

  it('police always drop their pistol and pocket change', () => {
    const drop = rollDrops('police', rng(0.5));
    expect(drop.weapon).toBe('pistol');
    expect(drop.cash).toBeGreaterThanOrEqual(5);
    expect(drop.cash).toBeLessThan(30);
  });

  it('civilians drop modest cash and occasionally a pistol or ammo', () => {
    expect(rollDrops('civilian', rng(0.5, 0.05))).toEqual({ cash: 35, weapon: 'pistol' });
    expect(rollDrops('civilian', rng(0.5, 0.2))).toEqual({ cash: 35, ammo: true });
    expect(rollDrops('civilian', rng(0.5, 0.8))).toEqual({ cash: 35 });
    for (let i = 0; i < 50; i++) {
      const drop = rollDrops('civilian');
      expect(drop.cash).toBeGreaterThanOrEqual(10);
      expect(drop.cash).toBeLessThan(60);
      if (drop.weapon) expect(drop.weapon).toBe('pistol');
    }
  });
});
