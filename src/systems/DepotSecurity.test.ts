import { describe, expect, it } from 'vitest';
import { DEPOT_DARK_THRESHOLD, DepotSecurity, depotDark, GUARD_TORCH_RANGE, guardSees, POWER_SURGE_GRACE_S, type DepotSnapshot } from './DepotSecurity';

const base: DepotSnapshot = { insideFence: true, blackout: 1, isNight: true, torchOn: false, firedRecently: false, guardSees: false };

describe('depotDark / gate', () => {
  it('is only dark at night during a deep blackout', () => {
    expect(depotDark(1, true)).toBe(true);
    expect(depotDark(DEPOT_DARK_THRESHOLD, true)).toBe(true);
    expect(depotDark(0.5, true)).toBe(false);
    expect(depotDark(1, false)).toBe(false); // daytime shedding leaves the yard watched
    expect(depotDark(0, true)).toBe(false);
  });

  it('gate maglock follows the dark state', () => {
    const security = new DepotSecurity();
    expect(security.gateOpen(1, true)).toBe(true);
    expect(security.gateOpen(0, true)).toBe(false);
    expect(security.gateOpen(1, false)).toBe(false);
  });
});

describe('DepotSecurity.update', () => {
  it('grid up: inside the fence is spotted unconditionally, day or night', () => {
    expect(new DepotSecurity().update(0.016, { ...base, blackout: 0 })).toBe('spotted');
    expect(new DepotSecurity().update(0.016, { ...base, blackout: 0, isNight: false })).toBe('spotted');
    expect(new DepotSecurity().update(0.016, { ...base, blackout: 1, isNight: false })).toBe('spotted');
  });

  it('outside the fence is always clear', () => {
    expect(new DepotSecurity().update(0.016, { ...base, insideFence: false, blackout: 0 })).toBe('clear');
  });

  it('blackout night breach is clear unless torch, gunfire, or a guard cone gives it away', () => {
    expect(new DepotSecurity().update(0.016, base)).toBe('clear');
    expect(new DepotSecurity().update(0.016, { ...base, torchOn: true })).toBe('spotted');
    expect(new DepotSecurity().update(0.016, { ...base, firedRecently: true })).toBe('spotted');
    expect(new DepotSecurity().update(0.016, { ...base, guardSees: true })).toBe('spotted');
  });

  it('power returning mid-breach grants the surge grace, then spots', () => {
    const security = new DepotSecurity();
    expect(security.update(0.016, base)).toBe('clear'); // dark, inside
    expect(security.update(0.016, { ...base, blackout: 0 })).toBe('clear'); // surge flicker
    expect(security.surge).toBeGreaterThan(0);
    expect(security.update(POWER_SURGE_GRACE_S / 2, { ...base, blackout: 0 })).toBe('clear');
    expect(security.update(POWER_SURGE_GRACE_S, { ...base, blackout: 0 })).toBe('spotted');
  });

  it('no grace without a preceding dark phase (walking in with the grid up)', () => {
    const security = new DepotSecurity();
    expect(security.update(0.016, { ...base, blackout: 0 })).toBe('spotted');
    expect(security.surge).toBe(0);
  });

  it('reset clears surge state between attempts', () => {
    const security = new DepotSecurity();
    security.update(0.016, base);
    security.update(0.016, { ...base, blackout: 0 });
    security.reset();
    expect(security.surge).toBe(0);
    expect(security.update(0.016, { ...base, blackout: 0 })).toBe('spotted');
  });
});

describe('guardSees', () => {
  it('spots inside the cone within range, not behind or beyond', () => {
    const guard = { x: 0, z: 0, heading: 0 }; // facing +z
    expect(guardSees(guard, 0, 10)).toBe(true); // dead ahead
    expect(guardSees(guard, 3, 10)).toBe(true); // inside the half-angle
    expect(guardSees(guard, 0, -10)).toBe(false); // behind
    expect(guardSees(guard, 10, 0)).toBe(false); // 90° off
    expect(guardSees(guard, 0, GUARD_TORCH_RANGE + 1)).toBe(false); // out of throw
  });

  it('point-blank contact is a spot regardless of facing', () => {
    expect(guardSees({ x: 0, z: 0, heading: 0 }, 0, -1)).toBe(true);
  });

  it('handles heading wrap-around', () => {
    const guard = { x: 0, z: 0, heading: Math.PI }; // facing -z
    expect(guardSees(guard, 0, -10)).toBe(true);
    expect(guardSees(guard, 0, 10)).toBe(false);
  });
});
