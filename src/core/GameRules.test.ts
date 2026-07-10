import { describe, expect, it } from 'vitest';
import { Economy, calculateDamage } from './GameRules';

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
