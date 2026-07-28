import { describe, expect, it } from 'vitest';
import {
  AFTER_WORK_SECONDS, BAD_DATE_SECONDS, banHours, hoursUntilShift, isQuiet, onShift, QUIET_DISTANCE,
  quietHint, refuseWindow, STOPPED_SPEED, WRECK_HEALTH_FRACTION, type WindowState,
} from './rules';

const night = { start: 19, end: 5 };
const day = { start: 10, end: 18 };

const ok = (over: Partial<WindowState> = {}): WindowState => ({
  hour: 22, shift: night, banned: 0, balance: 1000, price: 150, busy: 0,
  vehicle: { speed: 0, health: 100, maxHealth: 100, onFire: false, police: false },
  ...over,
});

describe('shifts', () => {
  it('wraps midnight, because every interesting shift in this city does', () => {
    expect(onShift(22, night)).toBe(true);
    expect(onShift(2, night)).toBe(true);
    expect(onShift(19, night)).toBe(true);
    expect(onShift(5, night)).toBe(false);
    expect(onShift(12, night)).toBe(false);
  });

  it('handles an ordinary day shift and out-of-range hours', () => {
    expect(onShift(11, day)).toBe(true);
    expect(onShift(18, day)).toBe(false);
    expect(onShift(-2, day)).toBe(onShift(22, day));
    expect(onShift(26, day)).toBe(onShift(2, day));
  });

  it('quotes a real number of hours until she is back, never zero', () => {
    expect(hoursUntilShift(12, night)).toBe(7);
    expect(hoursUntilShift(19, night)).toBe(1); // asked at the exact moment she starts: never says "0 hours"
    expect(hoursUntilShift(9, day)).toBe(1);
    expect(hoursUntilShift(23, day)).toBe(11);
  });
});

describe('the refusal ladder', () => {
  it('says yes when everything is in order', () => {
    expect(refuseWindow(ok())).toBeUndefined();
  });

  it('puts the bad-date list above everything else — that one is not negotiable', () => {
    expect(refuseWindow(ok({ banned: 10, balance: 0, hour: 3, vehicle: undefined }))).toBe('banned');
  });

  it('refuses a marked JMPD car outright', () => {
    expect(refuseWindow(ok({ vehicle: { speed: 0, health: 100, maxHealth: 100, onFire: false, police: true } }))).toBe('police-car');
  });

  it('refuses off shift, and the caller can turn that into a time', () => {
    expect(refuseWindow(ok({ hour: 12 }))).toBe('off-shift');
    expect(hoursUntilShift(12, night)).toBeGreaterThan(0);
  });

  it('refuses a wreck, a fire and a moving car — each with a fix the player can act on', () => {
    expect(refuseWindow(ok({ vehicle: { speed: 0, health: 100 * WRECK_HEALTH_FRACTION - 1, maxHealth: 100, onFire: false, police: false } }))).toBe('wreck');
    expect(refuseWindow(ok({ vehicle: { speed: 0, health: 100, maxHealth: 100, onFire: true, police: false } }))).toBe('wreck');
    expect(refuseWindow(ok({ vehicle: { speed: STOPPED_SPEED + 1, health: 100, maxHealth: 100, onFire: false, police: false } }))).toBe('moving');
    expect(refuseWindow(ok({ vehicle: { speed: -20, health: 100, maxHealth: 100, onFire: false, police: false } }))).toBe('moving'); // reversing is still moving
  });

  it('refuses when you cannot cover the price she stated', () => {
    expect(refuseWindow(ok({ balance: 149, price: 150 }))).toBe('broke');
    expect(refuseWindow(ok({ balance: 150, price: 150 }))).toBeUndefined();
  });

  it('is not a vending machine: there is a pause after a job', () => {
    expect(refuseWindow(ok({ busy: AFTER_WORK_SECONDS }))).toBe('busy');
  });

  it('works on foot too, where there is no car to judge', () => {
    expect(refuseWindow(ok({ vehicle: undefined }))).toBeUndefined();
    expect(refuseWindow(ok({ vehicle: undefined, hour: 12 }))).toBe('off-shift');
  });
});

describe('somewhere quiet', () => {
  it('is exactly two things the player can see: round the corner, and stopped', () => {
    expect(isQuiet({ speed: 0, distanceFromPickup: QUIET_DISTANCE })).toBe(true);
    expect(isQuiet({ speed: 0, distanceFromPickup: QUIET_DISTANCE - 1 })).toBe(false);
    expect(isQuiet({ speed: 20, distanceFromPickup: 500 })).toBe(false);
  });

  it('nags about one thing at a time, in the order the player should do them', () => {
    expect(quietHint({ speed: 14, distanceFromPickup: 2 })).toBe('Round the corner');
    expect(quietHint({ speed: 14, distanceFromPickup: 400 })).toBe('Stop the car');
    expect(quietHint({ speed: 0, distanceFromPickup: 400 })).toBe('Kill the lights');
  });
});

describe('the bad-date list', () => {
  it('lasts hours of city time, and says so in hours a player understands', () => {
    expect(banHours(BAD_DATE_SECONDS)).toBe(12);
    expect(banHours(0)).toBe(1); // never advertises "0 hours left"
  });
});
