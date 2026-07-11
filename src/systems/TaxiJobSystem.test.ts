import { describe, expect, it } from 'vitest';
import { FLEE_THRESHOLD } from './FearSystem';
import {
  BAIL_FEAR, BAIL_IMPACT, canHail, computeFare, crashTipPenalty, FARE_BASE, HAIL_RADIUS, isTaxiKind,
  routeDistance, SPEEDING_SPEED, startingTip, TaxiRide, taxiHudText, TIP_CAP, TIP_MIN, TIP_SPEED_DRAIN, type HailCandidate,
} from './TaxiJobSystem';

const walker = (overrides: Partial<HailCandidate> = {}): HailCandidate =>
  ({ state: 'walk', contact: false, hostile: false, police: false, carGuard: false, fear: 0, ...overrides });

const boardedRide = (distance = 350): TaxiRide => {
  const ride = new TaxiRide();
  ride.hail(); ride.beginBoarding(); ride.board(distance);
  return ride;
};

describe('taxi fare math', () => {
  it('charges the flag-drop plus R8 per 100 units of route', () => {
    expect(computeFare(0)).toBe(FARE_BASE);
    expect(computeFare(100)).toBe(FARE_BASE + 8);
    expect(computeFare(350)).toBe(48);
    expect(computeFare(500)).toBeGreaterThan(computeFare(200));
    expect(computeFare(-50)).toBe(FARE_BASE); // bad distance never discounts below the flag-drop
  });

  it('sums route distance along the polyline, not as the crow flies', () => {
    expect(routeDistance([{ x: 0, z: 0 }, { x: 3, z: 4 }, { x: 3, z: 14 }])).toBe(15);
    expect(routeDistance([{ x: 5, z: 5 }])).toBe(0);
    expect(routeDistance([])).toBe(0);
  });

  it('seeds the tip from the fare between the polite floor and the cap', () => {
    expect(startingTip(FARE_BASE)).toBe(TIP_MIN);
    expect(startingTip(100)).toBe(25);
    expect(startingTip(1000)).toBe(TIP_CAP);
  });

  it('scales the crash penalty with impact but always charges at least R1', () => {
    expect(crashTipPenalty(1)).toBe(1);
    expect(crashTipPenalty(16)).toBe(4);
    expect(crashTipPenalty(40)).toBeGreaterThan(crashTipPenalty(12));
  });
});

describe('hail eligibility', () => {
  it('lets a calm wandering civilian hail from inside the radius', () => {
    expect(canHail(walker(), 10)).toBe(true);
    expect(canHail(walker(), HAIL_RADIUS)).toBe(true);
  });

  it('ignores peds beyond the hail radius', () => {
    expect(canHail(walker(), HAIL_RADIUS + 0.1)).toBe(false);
  });

  it('excludes everyone without wanderlust: idle, fleeing, cowering, downed', () => {
    for (const state of ['idle', 'flee', 'cower', 'down', 'hostile']) expect(canHail(walker({ state }), 5)).toBe(false);
  });

  it('excludes contacts, car guards, cops, hostiles and the frightened', () => {
    expect(canHail(walker({ contact: true }), 5)).toBe(false);
    expect(canHail(walker({ carGuard: true }), 5)).toBe(false);
    expect(canHail(walker({ police: true }), 5)).toBe(false);
    expect(canHail(walker({ hostile: true }), 5)).toBe(false);
    expect(canHail(walker({ fear: FLEE_THRESHOLD }), 5)).toBe(false);
    expect(canHail(walker({ fear: FLEE_THRESHOLD - 1 }), 5)).toBe(true);
  });

  it('marks both the sedan cab and the Quantum as taxi kinds', () => {
    expect(isTaxiKind('cab')).toBe(true);
    expect(isTaxiKind('taxi')).toBe(true);
    expect(isTaxiKind('compact')).toBe(false);
  });
});

describe('ride state transitions', () => {
  it('walks idle -> hailed -> boarding -> riding and refuses out-of-order jumps', () => {
    const ride = new TaxiRide();
    expect(ride.beginBoarding()).toBe(false);
    expect(ride.board(200)).toBe(0);
    expect(ride.hail()).toBe(true);
    expect(ride.hail()).toBe(false);
    expect(ride.beginBoarding()).toBe(true);
    expect(ride.beginBoarding()).toBe(false);
    expect(ride.board(350)).toBe(48);
    expect(ride.phase).toBe('riding');
    expect(ride.tip).toBe(startingTip(48));
  });

  it('resets to a clean idle state after any ride', () => {
    const ride = boardedRide();
    ride.recordCrash(BAIL_IMPACT);
    ride.reset();
    expect(ride.phase).toBe('idle');
    expect(ride.fare).toBe(0);
    expect(ride.tip).toBe(0);
    expect(ride.bailed).toBe(false);
    expect(ride.hail()).toBe(true);
  });

  it('drains the tip while speeding but never below zero, and only mid-ride', () => {
    const ride = boardedRide();
    const before = ride.tip;
    ride.recordSpeeding(1, SPEEDING_SPEED - 1);
    expect(ride.tip).toBe(before);
    ride.recordSpeeding(1, SPEEDING_SPEED + 5);
    expect(ride.tip).toBeCloseTo(before - TIP_SPEED_DRAIN);
    ride.recordSpeeding(999, SPEEDING_SPEED + 5);
    expect(ride.tip).toBe(0);
    const idle = new TaxiRide();
    idle.recordSpeeding(1, 99);
    expect(idle.tip).toBe(0);
  });

  it('docks the tip on a fender-bender and bails the passenger on a heavy crash', () => {
    const ride = boardedRide();
    const before = ride.tip;
    ride.recordCrash(BAIL_IMPACT - 8);
    expect(ride.tip).toBe(before - crashTipPenalty(BAIL_IMPACT - 8));
    expect(ride.bailed).toBe(false);
    ride.recordCrash(BAIL_IMPACT);
    expect(ride.bailed).toBe(true);
  });

  it('accumulates gunfire fear until the passenger bails, and ignores fear outside a ride', () => {
    const ride = boardedRide();
    ride.frighten(BAIL_FEAR / 2);
    expect(ride.bailed).toBe(false);
    ride.frighten(BAIL_FEAR / 2);
    expect(ride.bailed).toBe(true);
    const idle = new TaxiRide();
    idle.frighten(999);
    expect(idle.bailed).toBe(false);
    expect(boardedRide().frighten(-5)).toBeUndefined(); // negatives are ignored, not banked
  });

  it('pays fare plus the rounded remaining tip on arrival', () => {
    const ride = boardedRide(350);
    ride.recordSpeeding(0.5, SPEEDING_SPEED + 1); // fractional drain rounds at payout
    const pay = ride.payout();
    expect(pay.fare).toBe(48);
    expect(pay.tip).toBe(Math.round(startingTip(48) - TIP_SPEED_DRAIN * 0.5));
    expect(pay.total).toBe(pay.fare + pay.tip);
  });

  it('renders the HUD meter for every duty state', () => {
    expect(taxiHudText('idle', false, 0, 0)).toBe('TAXI · OCCUPIED');
    expect(taxiHudText('idle', true, 0, 0)).toBe('TAXI · AVAILABLE');
    expect(taxiHudText('hailed', true, 0, 0)).toBe('TAXI · PICKING UP');
    expect(taxiHudText('boarding', true, 0, 0)).toBe('TAXI · PICKING UP');
    expect(taxiHudText('riding', true, 48, 11.4)).toBe('FARE R48 · TIP R11');
  });
});
