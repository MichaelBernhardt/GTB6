import { describe, expect, it } from 'vitest';
import { chopShopAccepts, chopShopOffer } from './ChopShopSystem';

describe('Bra Vusi chop-shop offers', () => {
  it('pays clean, kind-specific cash offers', () => {
    expect(chopShopOffer('compact', 100, 100)).toBe(650);
    expect(chopShopOffer('sport', 80, 80)).toBe(1700);
    expect(chopShopOffer('van', 145, 145)).toBe(1100);
    expect(chopShopOffer('taxi', 120, 120)).toBe(850);
  });

  it('reduces a battered car without making the getaway worthless', () => {
    expect(chopShopOffer('sport', 40, 80)).toBe(1150);
    expect(chopShopOffer('sport', 0, 80)).toBe(600);
    expect(chopShopOffer('sport', -20, 80)).toBe(600);
  });

  it('refuses bikes, delivery equipment, blue lights and invalid condition data', () => {
    for (const kind of ['police', 'bicycle', 'motorbike', 'courier', 'superbike'] as const) {
      expect(chopShopAccepts(kind)).toBe(false);
      expect(chopShopOffer(kind, 100, 100)).toBe(0);
    }
    expect(chopShopOffer('compact', Number.NaN, 100)).toBe(0);
    expect(chopShopOffer('compact', 100, 0)).toBe(0);
  });
});
