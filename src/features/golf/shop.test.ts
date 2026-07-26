import { describe, expect, it } from 'vitest';
import { DEFAULT_GOLF_STATE, type GolfState } from '../golf.state';
import {
  BOARD_RATE_AFFILIATED, BOARD_RATE_VISITOR, CADDIE_FEE, GEAR, GREEN_FEE, HUNTER_TIP, LAYBY_CUT,
  SHIRT_LEVY, SLEEVE_PRICE, gearItem, greenFee, laybyBalance, laybyDeposit, settleLayby, toBag,
} from './shop';

const fresh = (over: Partial<GolfState> = {}): GolfState => ({ ...DEFAULT_GOLF_STATE, owned: [], ...over });

describe('prices', () => {
  it('charges the municipal twilight rate, not the board rate', () => {
    expect(GREEN_FEE).toBe(180);
    expect(BOARD_RATE_VISITOR).toBeGreaterThan(BOARD_RATE_AFFILIATED);
    expect(GREEN_FEE).toBeLessThan(BOARD_RATE_AFFILIATED);
  });

  it('levies the hire shirt until you buy a collar, and the shirt pays for itself in two rounds', () => {
    expect(greenFee(fresh())).toBe(GREEN_FEE + SHIRT_LEVY);
    expect(greenFee(fresh({ owned: ['shirt'] }))).toBe(GREEN_FEE);
    const shirt = gearItem('shirt')!;
    expect(shirt.price).toBeLessThan(SHIRT_LEVY * 2);
  });

  it('is a plausible 2026 South African price list', () => {
    expect(gearItem('shirt')!.price).toBe(199);
    expect(gearItem('glove')!.price).toBe(449);
    expect(gearItem('shoes')!.price).toBe(1299);
    expect(gearItem('putter')!.price).toBe(2199);
    expect(gearItem('driver')!.price).toBe(7999);
    expect(gearItem('irons')!.price).toBe(15999);
    expect(SLEEVE_PRICE).toBe(255);
    expect(CADDIE_FEE).toBe(235);
    expect(HUNTER_TIP).toBeLessThan(SLEEVE_PRICE / 3); // tipping beats losing a ball
  });

  it('reads as a ladder — every step up costs more than the one below', () => {
    const prices = GEAR.map((item) => item.price);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it('only the big-ticket clubs go on lay-by', () => {
    expect(GEAR.filter((item) => item.layby).map((item) => item.id)).toEqual(['driver', 'irons']);
    for (const item of GEAR) if (item.layby) expect(item.price).toBeGreaterThan(5000);
  });
});

describe('lay-by', () => {
  it('takes 30% down and leaves the rest owing', () => {
    const irons = gearItem('irons')!;
    expect(laybyDeposit(irons)).toBe(4800);
    expect(laybyBalance(irons)).toBe(11199);
    expect(laybyDeposit(irons) + laybyBalance(irons)).toBe(irons.price);
  });

  it('takes its cut out of a payout and hands the player the rest', () => {
    const state = fresh({ owned: ['irons'], layby: { item: 'irons', owing: 11199 } });
    const result = settleLayby(state, 1000);
    expect(result.paid).toBe(Math.round(1000 * LAYBY_CUT));
    expect(result.pocketed).toBe(1000 - result.paid);
    expect(state.layby!.owing).toBe(11199 - result.paid);
    expect(result.cleared).toBe(false);
  });

  it('never takes more than is owed, and closes the book when it clears', () => {
    const state = fresh({ owned: ['driver'], layby: { item: 'driver', owing: 90 } });
    const result = settleLayby(state, 1000);
    expect(result.paid).toBe(90);
    expect(result.pocketed).toBe(910);
    expect(result.cleared).toBe(true);
    expect(state.layby).toBeNull();
  });

  it('leaves a payout alone when there is no lay-by', () => {
    const state = fresh();
    expect(settleLayby(state, 500)).toEqual({ pocketed: 500, paid: 0, cleared: false });
  });
});

describe('the bag the swing sees', () => {
  it('mirrors what is owned plus this round is extras', () => {
    const state = fresh({ owned: ['glove', 'irons'], balls: 2 });
    expect(toBag(state, true)).toEqual({ driver: false, irons: true, putter: false, glove: true, shoes: false, premiumBall: true, caddie: true });
  });

  it('drops the premium ball the moment the sleeve runs out', () => {
    expect(toBag(fresh({ balls: 0 }), false).premiumBall).toBe(false);
    expect(toBag(fresh({ balls: 1 }), false).premiumBall).toBe(true);
  });
});
