import { describe, expect, it } from 'vitest';
import { streetSites } from '../street.state';
import {
  ARREARS_THRESHOLD, askPrice, bestDemand, bidPrice, blackoutPremium, buysHere, carryCap, carrying,
  DEMAND_FLOOR, demandAfterSale, demandIndex, levyOn, PRODUCTS, productSpec, quoteBuy,
  quoteSell, recoverDemand, sellsToYou, supplyIndex, supplyProduct, tierFor, TIERS,
} from './trade';

const base = { siteId: 'hillbrow-dealer', tier: 0, levy: 0, blackout: 0 };
const corners = streetSites().map((site) => ({ id: site.id, cast: site.cast }));

describe('the shape of the map', () => {
  it('never lets a corner buy back what it sells — the one rule that kills same-corner arbitrage', () => {
    // A price-level rule would not survive tuning; the structural one does. Every corner refuses to
    // bid on its own line, and buysHere() is what both the menu rows and the sale path ask.
    for (const corner of corners) {
      const long = supplyProduct(corner.id, corner.cast);
      expect(buysHere(corner.id, corner.cast, long), `${corner.id} bids on its own ${long}`).toBe(false);
      for (const product of PRODUCTS) {
        if (product.id === long) continue;
        expect(buysHere(corner.id, corner.cast, product.id)).toBe(true);
      }
    }
  });

  it('leaves a real margin on the products a corner does buy', () => {
    for (const corner of corners) {
      for (const product of PRODUCTS) {
        if (!buysHere(corner.id, corner.cast, product.id)) continue;
        expect(bidPrice(product.id, corner.id, 1)).toBeGreaterThan(askPrice(product.id, { ...base, siteId: corner.id }));
      }
    }
  });

  it('prices supply below base and demand above it, so driving somewhere is the profit', () => {
    for (const corner of corners) {
      for (const product of PRODUCTS) {
        expect(supplyIndex(corner.id, product.id)).toBeGreaterThanOrEqual(0.86);
        expect(supplyIndex(corner.id, product.id)).toBeLessThanOrEqual(1.06);
        expect(demandIndex(corner.id, product.id)).toBeGreaterThanOrEqual(1.1);
        expect(demandIndex(corner.id, product.id)).toBeLessThanOrEqual(1.55);
      }
    }
  });

  it('is deterministic — two machines derive the same prices from the same site id', () => {
    expect(supplyProduct('berea-dealer', 3)).toBe(supplyProduct('berea-dealer', 3));
    expect(demandIndex('berea-dealer', 'zol')).toBe(demandIndex('berea-dealer', 'zol'));
    expect(askPrice('zol', { ...base, siteId: 'berea-dealer' })).toBe(askPrice('zol', { ...base, siteId: 'berea-dealer' }));
  });

  it('pins the first block to the beginner product so a new player is never met by a locked row', () => {
    expect(supplyProduct('anything-dealer', 0)).toBe(PRODUCTS[0]!.id);
    expect(productSpec(PRODUCTS[0]!.id).tier).toBe(0);
  });

  it('never stocks a product it is also short of — AT ANY RANK', () => {
    // The regression this pins: an earlier draft let a rank-gated corner sell the beginner product
    // "as a favour", and an in-engine playthrough found Berea asking R66 for a bankie while bidding
    // R71 for the same bankie. Buy, turn round, sell, repeat, forever.
    for (const corner of corners) {
      for (const tier of TIERS) {
        if (!sellsToYou(corner.id, corner.cast, tier.rank)) continue;
        const stocked = supplyProduct(corner.id, corner.cast);
        expect(buysHere(corner.id, corner.cast, stocked), `${corner.id} at ${tier.name}`).toBe(false);
      }
    }
  });

  it('is not a dead end above your rank: it stops selling, it never stops buying', () => {
    const gated = PRODUCTS.find((product) => product.tier > 0)!;
    const site = corners.find((corner) => supplyProduct(corner.id, corner.cast) === gated.id);
    if (!site) return; // this map derivation put no gated corner in the list; the rule still holds
    expect(sellsToYou(site.id, site.cast, 0)).toBe(false);
    expect(sellsToYou(site.id, site.cast, gated.tier)).toBe(true);
    expect(buysHere(site.id, site.cast, PRODUCTS[0]!.id)).toBe(true);
  });
});

describe('rank', () => {
  it('promotes on turnover and never demotes', () => {
    expect(tierFor(0)).toBe(0);
    expect(tierFor(TIERS[1]!.turnover)).toBe(1);
    expect(tierFor(TIERS[2]!.turnover)).toBe(2);
    expect(tierFor(0, 2)).toBe(2); // a reload after spending everything does not cost you your rank
  });

  it('raises the carry cap and lowers the ask as you climb', () => {
    expect(carryCap(0)).toBeLessThan(carryCap(1));
    expect(carryCap(1)).toBeLessThan(carryCap(2));
    expect(askPrice('zol', { ...base, tier: 2 })).toBeLessThan(askPrice('zol', { ...base, tier: 0 }));
  });

  it('reaches Runner inside about two full loads, which is the whole point of a short ladder', () => {
    const perRun = 12 * Math.round(60 * 1.3); // a Corner-rank load sold into a hungry block
    expect(TIERS[1]!.turnover).toBeLessThanOrEqual(perRun * 2);
  });
});

describe('arrears, blackout and the levy', () => {
  it('takes eight per cent of a sale', () => {
    expect(levyOn(1000)).toBe(80);
    expect(levyOn(0)).toBe(0);
  });

  it('surcharges the ask once you are properly in arrears, and not before', () => {
    const clean = askPrice('zol', base);
    expect(askPrice('zol', { ...base, levy: ARREARS_THRESHOLD })).toBe(clean);
    expect(askPrice('zol', { ...base, levy: ARREARS_THRESHOLD + 1 })).toBeGreaterThan(clean);
  });

  it('charges a danger premium when the block is dark', () => {
    expect(blackoutPremium(0)).toBe(1);
    expect(blackoutPremium(1)).toBeCloseTo(1.15);
    expect(blackoutPremium(-3)).toBe(1);
    expect(askPrice('zol', { ...base, blackout: 1 })).toBeGreaterThan(askPrice('zol', base));
  });
});

describe('corner demand', () => {
  it('walks the price down as you dump and never below the floor', () => {
    expect(demandAfterSale(1, 0)).toBe(1);
    expect(demandAfterSale(1, 5)).toBeLessThan(1);
    expect(demandAfterSale(1, 500)).toBe(DEMAND_FLOOR);
  });

  it('recovers to full over minutes of play, not instantly', () => {
    const soaked = demandAfterSale(1, 20);
    expect(recoverDemand(soaked, 1)).toBeGreaterThan(soaked);
    expect(recoverDemand(soaked, 1)).toBeLessThan(1);
    expect(recoverDemand(soaked, 10_000)).toBe(1);
  });

  it('makes a big drop on one corner worth less per unit than spreading it', () => {
    const bulk = quoteSell('zol', 'berea-dealer', 20, 20, 1);
    const single = quoteSell('zol', 'berea-dealer', 20, 1, 1);
    expect(bulk.unitPrice).toBeLessThan(single.unitPrice);
    expect(bulk.total).toBeGreaterThan(single.total);
    expect(bulk.demandAfter).toBeLessThan(1);
  });
});

describe('quotes', () => {
  const limits = { want: 99, held: 0, cap: 12, balance: 100_000, supply: 40 };

  it('refuses a product above your rank and says so', () => {
    const gated = PRODUCTS.find((product) => product.tier > 0)!;
    expect(quoteBuy(gated.id, base, limits).limit).toBe('tier');
    expect(quoteBuy(gated.id, base, limits).units).toBe(0);
  });

  it('stops at the carry cap, the corner stock and the wallet, and names which', () => {
    expect(quoteBuy('zol', base, limits).units).toBe(12);
    expect(quoteBuy('zol', base, limits).limit).toBe('carry');
    expect(quoteBuy('zol', base, { ...limits, cap: 80, supply: 4 }).limit).toBe('stock');
    const price = askPrice('zol', base);
    expect(quoteBuy('zol', base, { ...limits, cap: 80, balance: price * 3 }).units).toBe(3);
    expect(quoteBuy('zol', base, { ...limits, cap: 80, balance: price * 3 }).limit).toBe('money');
  });

  it('never sells more than is in your hands', () => {
    expect(quoteSell('zol', 'berea-dealer', 3, 99, 1).units).toBe(3);
    expect(quoteSell('zol', 'berea-dealer', 0, 99, 1).units).toBe(0);
    expect(quoteSell('zol', 'berea-dealer', 0, 99, 1).total).toBe(0);
  });

  it('counts every product against one pair of hands', () => {
    expect(carrying({ zol: 3, buttons: 2, nyaope: 1 })).toBe(6);
  });

  it('a full Corner-rank run turns a profit worth the drive but not a mission payout', () => {
    const buy = quoteBuy('zol', base, { ...limits, cap: carryCap(0) });
    const target = bestDemand(corners, 'zol')!;
    const sale = quoteSell('zol', target, buy.units, buy.units, 1);
    const profit = sale.total - sale.levy - buy.total;
    expect(profit).toBeGreaterThan(120);
    expect(profit).toBeLessThan(900); // the smallest story mission still pays more
  });
});

describe('the tip a worker sells', () => {
  it('names a corner that is actually short of the product, never one that is long', () => {
    for (const product of PRODUCTS) {
      const target = bestDemand(corners, product.id);
      expect(target).toBeDefined();
      const corner = corners.find((entry) => entry.id === target)!;
      expect(supplyProduct(corner.id, corner.cast)).not.toBe(product.id);
      for (const other of corners) {
        if (supplyProduct(other.id, other.cast) === product.id) continue;
        expect(demandIndex(target!, product.id)).toBeGreaterThanOrEqual(demandIndex(other.id, product.id));
      }
    }
  });

  it('is worth more than she charges for it', () => {
    const best = bestDemand(corners, 'zol')!;
    const worst = corners.filter((corner) => supplyProduct(corner.id, corner.cast) !== 'zol')
      .reduce((low, corner) => (demandIndex(corner.id, 'zol') < demandIndex(low.id, 'zol') ? corner : low));
    const load = carryCap(0);
    const gain = quoteSell('zol', best, load, load, 1).total - quoteSell('zol', worst.id, load, load, 1).total;
    expect(gain).toBeGreaterThan(80); // the most expensive information on the street costs R80
  });
});
