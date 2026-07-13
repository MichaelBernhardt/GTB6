import { describe, expect, it } from 'vitest';
import {
  applyDrink, BLACKOUT, BUZZ_MIN, decayInebriation, DRINK_BY_ID, DRINKS, drunkHealthDelta,
  inebriationFraction, inebriationLabel, INEBRIATION_MAX, POISON_HEALTH_FLOOR, resolveDrinkPurchase,
} from './DrinkRules';

describe('Tops-ish Bottle Store stock', () => {
  it('prices every drink and gives each a shelf note', () => {
    for (const drink of DRINKS) { expect(drink.price).toBeGreaterThan(0); expect(drink.note.length).toBeGreaterThan(0); }
  });

  it('indexes drinks by id', () => {
    for (const drink of DRINKS) expect(DRINK_BY_ID[drink.id]).toBe(drink);
  });

  it('ships exactly one non-alcoholic sober-up option', () => {
    const soberUps = DRINKS.filter((drink) => drink.potency < 0);
    expect(soberUps).toHaveLength(1);
    expect(soberUps[0]!.id).toBe('stoney');
  });
});

describe('drink purchase resolution', () => {
  it('sells a booze you can afford', () => {
    expect(resolveDrinkPurchase(DRINK_BY_ID.klippies, 500, 0)).toEqual({ ok: true, price: 45 });
  });

  it('refuses when the wallet is short', () => {
    expect(resolveDrinkPurchase(DRINK_BY_ID.mampoer, 10, 0)).toEqual({ ok: false, price: 95, reason: 'funds' });
  });

  it('only sells the ginger beer while there is a buzz to cut', () => {
    expect(resolveDrinkPurchase(DRINK_BY_ID.stoney, 500, 0)).toEqual({ ok: false, price: 15, reason: 'sober-already' });
    expect(resolveDrinkPurchase(DRINK_BY_ID.stoney, 500, 40).ok).toBe(true);
  });
});

describe('inebriation maths', () => {
  it('adds a serving and clamps at the ceiling', () => {
    expect(applyDrink(0, DRINK_BY_ID.zamalek)).toBe(10);
    expect(applyDrink(95, DRINK_BY_ID.mampoer)).toBe(INEBRIATION_MAX);
  });

  it('sobers up with a ginger beer, never below zero', () => {
    expect(applyDrink(30, DRINK_BY_ID.stoney)).toBe(0);
    expect(applyDrink(0, DRINK_BY_ID.stoney)).toBe(0);
  });

  it('bleeds inebriation away over time, flooring at zero', () => {
    expect(decayInebriation(100, 1)).toBeCloseTo(99.3);
    expect(decayInebriation(0.2, 1)).toBe(0);
  });

  it('eases the stagger fraction from sober to legless', () => {
    expect(inebriationFraction(0)).toBe(0);
    expect(inebriationFraction(BUZZ_MIN)).toBe(0);
    expect(inebriationFraction(INEBRIATION_MAX)).toBe(1);
    expect(inebriationFraction(50)).toBeGreaterThan(0);
    expect(inebriationFraction(50)).toBeLessThan(1);
  });
});

describe('the drunk health advantage', () => {
  it('gives nothing while sober', () => {
    expect(drunkHealthDelta(BUZZ_MIN - 1, 50, 1)).toBe(0);
  });

  it('heals a slow trickle through the merry band', () => {
    expect(drunkHealthDelta(40, 50, 1)).toBeGreaterThan(0);
  });

  it('turns to a drain past blackout, floored so booze alone cannot kill you', () => {
    expect(drunkHealthDelta(BLACKOUT + 5, 50, 1)).toBeLessThan(0);
    expect(drunkHealthDelta(BLACKOUT + 5, POISON_HEALTH_FLOOR, 1)).toBe(0);
    expect(drunkHealthDelta(BLACKOUT + 5, POISON_HEALTH_FLOOR - 5, 1)).toBe(0);
  });

  it('never drains below the health floor in one frame', () => {
    const delta = drunkHealthDelta(BLACKOUT + 5, POISON_HEALTH_FLOOR + 0.5, 1);
    expect(POISON_HEALTH_FLOOR + 0.5 + delta).toBeGreaterThanOrEqual(POISON_HEALTH_FLOOR);
  });
});

describe('inebriation HUD label', () => {
  it('hides while sober and warns past blackout', () => {
    expect(inebriationLabel(0)).toBeUndefined();
    expect(inebriationLabel(BUZZ_MIN)).toEqual({ text: 'TIPSY', warn: false });
    expect(inebriationLabel(45)).toEqual({ text: 'LEKKER', warn: false });
    expect(inebriationLabel(65)).toEqual({ text: 'DRONK', warn: false });
    expect(inebriationLabel(BLACKOUT)).toEqual({ text: 'BABALAS', warn: true });
  });
});
