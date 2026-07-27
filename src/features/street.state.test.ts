import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STREET_STATE, MIN_CORNER_GAP, nearestStreetSite, PAVEMENT_CLEARANCE, RELIEF_WORKER_CAST,
  sanitizeStreetState, STREET_BLOCK_COUNT, STREET_LOAD_RADIUS, STREET_MAX_CARRY, STREET_PRODUCTS,
  STREET_STAFF_RADIUS, STREET_UNSTAFF_RADIUS, streetSites,
} from './street.state';
import { distanceToRoadEdge } from '../world/mapData';
import { PLAYER_SPAWN } from '../world/placements';

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

  it('derives one dealer and one worker per block, plus the daylight relief on the first one', () => {
    expect(sites).toHaveLength(STREET_BLOCK_COUNT * 2 + 1);
    expect(sites.filter((site) => site.kind === 'dealer')).toHaveLength(STREET_BLOCK_COUNT);
    expect(sites.filter((site) => site.kind === 'worker')).toHaveLength(STREET_BLOCK_COUNT + 1);
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

  it('keeps every corner on a block apart from every other corner on it', () => {
    for (const dealer of sites.filter((site) => site.kind === 'dealer')) {
      const workers = sites.filter((site) => site.kind === 'worker' && site.district === dealer.district);
      expect(workers.length, dealer.district).toBeGreaterThanOrEqual(1);
      for (const worker of workers) {
        const gap = Math.hypot(worker.x - dealer.x, worker.z - dealer.z);
        expect(gap, `${worker.id} gap ${gap.toFixed(1)}m`).toBeGreaterThanOrEqual(MIN_CORNER_GAP);
        expect(gap, `${worker.id} gap ${gap.toFixed(1)}m`).toBeLessThan(600);
      }
      // Two workers sharing a block must not share a paving slab either.
      for (let a = 0; a < workers.length; a++) {
        for (let b = a + 1; b < workers.length; b++) {
          const gap = Math.hypot(workers[a]!.x - workers[b]!.x, workers[a]!.z - workers[b]!.z);
          expect(gap, `${workers[a]!.id} vs ${workers[b]!.id}`).toBeGreaterThanOrEqual(MIN_CORNER_GAP);
        }
      }
    }
  });

  it('stands every corner on the PAVEMENT, not in a carriageway', () => {
    // The first machine playthrough found Gugu Ndlovu on 0 health and Chidi Nwosu on 60, both being
    // run down by ambient traffic: offsetting past one road's kerb at a junction had put them inside
    // the cross street. A corner in the road kills the person, retires the block for minutes, and —
    // inside the blame radius — bans the player from the whole trade for something a taxi did.
    for (const site of sites) {
      const clear = distanceToRoadEdge(site.x, site.z);
      expect(clear, `${site.id} stands ${clear.toFixed(1)} m from the nearest road edge`).toBeGreaterThanOrEqual(PAVEMENT_CLEARANCE);
    }
  });

  it('uses ids that survive a slugging and address a district', () => {
    for (const site of sites) {
      expect(site.id, site.id).toMatch(/^[a-z0-9-]+-(dealer|worker)$/);
      expect(site.district.length).toBeGreaterThan(0);
    }
  });

  it('answers the proximity ring without loading the feature body', () => {
    const first = sites[0]!;
    const near = nearestStreetSite(first.x + 3, first.z + 3);
    expect(near?.site.id).toBe(first.id);
    expect(Math.sqrt(near!.distanceSq)).toBeLessThan(STREET_LOAD_RADIUS);
    const far = nearestStreetSite(first.x + 5000, first.z + 5000);
    expect(Math.sqrt(far!.distanceSq)).toBeGreaterThan(STREET_LOAD_RADIUS);
  });
});

/**
 * THE OWNER PLAYTEST THIS SUITE EXISTS TO STOP REPEATING.
 *
 * First report: "I hung around some for a while and never saw anything. It was 2300 at night."
 * Second report: "It took a lot of work to find a clue to see someone... the instructions toasted too
 * quickly to follow... then the person stopped telling me, so I can't find it. Just unusable really."
 *
 * Both are the same failure at different depths: the content existed but was not REACHABLE. These
 * pin the reachability numbers so no refactor can quietly make the street a treasure hunt again.
 */
describe('the trade is findable from where a session actually begins', () => {
  it('puts a corner inside the ring that auto-loads the feature, at the game’s own start point', () => {
    // FeatureHost.preloadNearby() watches this ring every 0.4 s and loads the body without a press,
    // so a corner inside it at spawn means the street is staffed and blipped before the player moves.
    const near = nearestStreetSite(PLAYER_SPAWN[0], PLAYER_SPAWN[2]);
    expect(near, 'no corner derived at all').toBeDefined();
    const metres = Math.sqrt(near!.distanceSq);
    expect(metres, `nearest corner (${near!.site.id}) is ${metres.toFixed(0)} m from the spawn kerb — outside the ${STREET_LOAD_RADIUS} m ring, so a fresh session never loads the trade at all`)
      .toBeLessThan(STREET_LOAD_RADIUS);
  });

  it('keeps time-to-first-contact to a short walk, not an expedition', () => {
    // "Someone should be visible and dealable-with within a short walk of the inner-city blocks."
    // A brisk walk is about 4 m/s in this build, so 200 m is under a minute from a standing start.
    const near = nearestStreetSite(PLAYER_SPAWN[0], PLAYER_SPAWN[2])!;
    expect(Math.sqrt(near.distanceSq), `${near.site.id} is the first person you can reach`).toBeLessThan(200);
  });

  it('makes the FIRST block the nearest one, because block 0 is the block the design privileges', () => {
    // trade.supplyProduct pins block 0 to the beginner product and RELIEF_WORKER_CAST staffs block 0
    // through daylight. Both of those are wasted if block 0 is 1.7 km away, which is where the
    // density ranking used to put it.
    const sites = streetSites();
    const first = sites.filter((site) => site.cast === 0 || site.id.endsWith('day-worker'))[0]!;
    const nearest = [...sites].sort((a, b) =>
      Math.hypot(a.x - PLAYER_SPAWN[0], a.z - PLAYER_SPAWN[2]) - Math.hypot(b.x - PLAYER_SPAWN[0], b.z - PLAYER_SPAWN[2]))[0]!;
    expect(first.district, 'block 0 must be the district you start in').toBe(nearest.district);
  });

  it('staffs the introduction block around the clock by pairing two shifts on it', () => {
    const sites = streetSites();
    const home = sites[0]!.district;
    const workers = sites.filter((site) => site.kind === 'worker' && site.district === home);
    expect(workers.length, `${home} needs a day shift and a night shift`).toBe(2);
    expect(workers.map((site) => site.cast)).toContain(RELIEF_WORKER_CAST);
  });

  it('staffs a corner at least as far out as the ring that loaded it', () => {
    // Otherwise the map blip and the pillar of light point at an empty pavement, which reads as
    // exactly the same bug all over again.
    expect(STREET_STAFF_RADIUS).toBeGreaterThanOrEqual(STREET_LOAD_RADIUS);
    expect(STREET_UNSTAFF_RADIUS).toBeGreaterThan(STREET_STAFF_RADIUS);
  });

  it('never asks the city for more than a handful of fixtures at once', () => {
    // The block-sized staffing ring is only affordable because the corners are spread out. If a map
    // rework ever bunches them, this fails before the frame rate does.
    const corners = streetSites();
    for (const site of corners) {
      const crowd = corners.filter((other) => Math.hypot(other.x - site.x, other.z - site.z) <= STREET_STAFF_RADIUS).length;
      expect(crowd, `${site.id} would staff ${crowd} corners at once`).toBeLessThanOrEqual(6);
    }
  });
});
