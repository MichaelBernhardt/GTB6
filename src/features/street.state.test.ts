import { describe, expect, it } from 'vitest';
import {
  ASK_AROUND_RADIUS, DEFAULT_STREET_STATE, MIN_CORNER_GAP, nearestStreetSite, sanitizeStreetState,
  STREET_BLOCK_COUNT, STREET_MAX_CARRY, STREET_PRODUCTS, streetSites,
} from './street.state';

describe('street save slice', () => {
  it('accepts nothing and returns a playable default', () => {
    expect(sanitizeStreetState(undefined)).toEqual(DEFAULT_STREET_STATE);
    expect(sanitizeStreetState('not a save')).toEqual(DEFAULT_STREET_STATE);
    expect(sanitizeStreetState(null).stock.zol).toBe(0);
  });

  it('does not hand a mutable default back to two different sessions', () => {
    const first = sanitizeStreetState(undefined);
    first.stock.zol = 9;
    expect(sanitizeStreetState(undefined).stock.zol).toBe(0);
    expect(DEFAULT_STREET_STATE.stock.zol).toBe(0);
  });

  it('clamps hostile numbers instead of trusting localStorage', () => {
    const state = sanitizeStreetState({
      tier: 99, turnover: -5, levy: Number.POSITIVE_INFINITY, banned: 1e9, rides: NaN,
      stock: { zol: -4, buttons: 3.7, nyaope: 1e12, mystery: 5 },
    });
    expect(state.tier).toBe(2);
    expect(state.turnover).toBe(0);
    expect(state.levy).toBe(0);
    expect(state.banned).toBe(6000);
    expect(state.rides).toBe(0);
    expect(state.stock).toEqual({ zol: 0, buttons: 3, nyaope: STREET_MAX_CARRY - 3 });
    expect(Object.keys(state.stock)).toEqual([...STREET_PRODUCTS]);
  });

  it('clamps a hand-edited hoard to what the top rank could actually have bought', () => {
    // Without this, a save claiming 999 straws is a five-figure windfall on the first corner.
    const state = sanitizeStreetState({ stock: { zol: 500, buttons: 500, nyaope: 500 } });
    const total = STREET_PRODUCTS.reduce((sum, product) => sum + state.stock[product], 0);
    expect(total).toBe(STREET_MAX_CARRY);
    expect(state.stock.zol).toBe(STREET_MAX_CARRY);
    expect(state.stock.buttons).toBe(0);
  });

  it('bounds the met list and drops junk entries', () => {
    const state = sanitizeStreetState({ met: ['a', 'a', 'b', 7, '', 'x'.repeat(80), ...Array.from({ length: 60 }, (_, i) => `s${i}`)] });
    expect(state.met.length).toBeLessThanOrEqual(32);
    expect(state.met).toContain('a');
    expect(state.met.filter((id) => id === 'a')).toHaveLength(1);
    expect(state.met.some((id) => id.length > 48)).toBe(false);
  });

  it('only keeps a tip product it recognises', () => {
    expect(sanitizeStreetState({ tipProduct: 'zol', tipSite: 'hillbrow-dealer' }).tipProduct).toBe('zol');
    expect(sanitizeStreetState({ tipProduct: 'cocaine' }).tipProduct).toBeUndefined();
  });
});

describe('derived kerb sites', () => {
  const sites = streetSites();

  it('derives one dealer and one worker per block from live map data', () => {
    expect(sites).toHaveLength(STREET_BLOCK_COUNT * 2);
    expect(sites.filter((site) => site.kind === 'dealer')).toHaveLength(STREET_BLOCK_COUNT);
    expect(sites.filter((site) => site.kind === 'worker')).toHaveLength(STREET_BLOCK_COUNT);
    expect(new Set(sites.map((site) => site.id)).size).toBe(sites.length);
  });

  it('is memoized and identical between calls — the derivation is not a per-frame cost', () => {
    expect(streetSites()).toBe(sites);
  });

  it('lands on finite coordinates inside the generated world', () => {
    for (const site of sites) {
      expect(Number.isFinite(site.x), site.id).toBe(true);
      expect(Number.isFinite(site.z), site.id).toBe(true);
      expect(Number.isFinite(site.heading), site.id).toBe(true);
      expect(Math.hypot(site.x, site.z)).toBeLessThan(20_000);
    }
  });

  it('keeps the dealer and the worker on the same block but not on the same paving slab', () => {
    for (const dealer of sites.filter((site) => site.kind === 'dealer')) {
      const worker = sites.find((site) => site.kind === 'worker' && site.district === dealer.district);
      expect(worker, dealer.district).toBeDefined();
      const gap = Math.hypot(worker!.x - dealer.x, worker!.z - dealer.z);
      expect(gap, `${dealer.district} gap ${gap.toFixed(1)}m`).toBeGreaterThanOrEqual(MIN_CORNER_GAP);
      expect(gap, `${dealer.district} gap ${gap.toFixed(1)}m`).toBeLessThan(600);
    }
  });

  it('uses ids that survive a slugging and address a district', () => {
    for (const site of sites) {
      expect(site.id, site.id).toMatch(/^[a-z0-9-]+-(dealer|worker)$/);
      expect(site.district.length).toBeGreaterThan(0);
    }
  });

  it('answers the eager approach ring without loading the feature body', () => {
    const first = sites[0]!;
    const near = nearestStreetSite(first.x + 3, first.z + 3);
    expect(near?.site.id).toBe(first.id);
    expect(Math.sqrt(near!.distanceSq)).toBeLessThan(ASK_AROUND_RADIUS);
    const far = nearestStreetSite(first.x + 5000, first.z + 5000);
    expect(Math.sqrt(far!.distanceSq)).toBeGreaterThan(ASK_AROUND_RADIUS);
  });
});
