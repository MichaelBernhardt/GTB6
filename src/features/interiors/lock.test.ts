/**
 * The lock line, LIVE: a place of business that is open is open, a home is locked, works lock at
 * night — and the one rule that outranks all of it: NO door is ever locked from the inside. The
 * owner's wording: "you don't need to lockpick to get out... Getting back in is when you need to
 * lock pick."
 */
import { describe, expect, it } from 'vitest';
import {
  doorLocked, isNightHour, lockedClass, LOCKS_ENABLED, locksAtNight,
  PICK_MASTERY, pickBites, pickBiteWidth, WORKS_LOCK_AT_NIGHT,
} from './lock';

const NOON = 12;
const MIDNIGHT = 0;

describe('the lock line (line D + the night fork)', () => {
  it('opens places of business and locks homes, in daylight', () => {
    expect(lockedClass({ style: 'mixed-use', entrance: 'shopfront' })).toBe(false);
    expect(lockedClass({ style: 'industrial', entrance: 'dock' })).toBe(false);
    expect(lockedClass({ style: 'downtown', entrance: 'lobby' })).toBe(false);
    expect(lockedClass({ style: 'civic', entrance: 'lobby' })).toBe(false);
    expect(lockedClass({ style: 'suburban', entrance: 'porch' })).toBe(true);
    expect(lockedClass({ style: 'estate', entrance: 'porch' })).toBe(true);
    expect(lockedClass({ style: 'rural', entrance: 'porch' })).toBe(true);
    // A block of flats shares a lobby's door furniture and none of its welcome.
    expect(lockedClass({ style: 'dense-residential', entrance: 'lobby' })).toBe(true);
  });

  it('is live', () => {
    expect(LOCKS_ENABLED).toBe(true);
    expect(doorLocked({ style: 'suburban', entrance: 'porch' }, 'outside', NOON)).toBe(true);
  });

  it('locks places of WORK at night but never the retail city centre', () => {
    expect(WORKS_LOCK_AT_NIGHT).toBe(true);
    expect(locksAtNight({ style: 'industrial', entrance: 'dock' })).toBe(true);
    expect(locksAtNight({ style: 'civic', entrance: 'lobby' })).toBe(true);
    expect(locksAtNight({ style: 'mixed-use', entrance: 'shopfront' })).toBe(false);
    expect(locksAtNight({ style: 'downtown', entrance: 'lobby' })).toBe(false);
    // and the live answer follows the clock
    expect(doorLocked({ style: 'industrial', entrance: 'dock' }, 'outside', NOON)).toBe(false);
    expect(doorLocked({ style: 'industrial', entrance: 'dock' }, 'outside', MIDNIGHT)).toBe(true);
    expect(doorLocked({ style: 'civic', entrance: 'lobby' }, 'outside', 23)).toBe(true);
    expect(doorLocked({ style: 'downtown', entrance: 'lobby' }, 'outside', MIDNIGHT)).toBe(false);
    expect(doorLocked({ style: 'mixed-use', entrance: 'shopfront' }, 'outside', 3)).toBe(false);
  });

  it('night is 22:00 to 06:00', () => {
    expect(isNightHour(21.99)).toBe(false);
    expect(isNightHour(22)).toBe(true);
    expect(isNightHour(0)).toBe(true);
    expect(isNightHour(5.99)).toBe(true);
    expect(isNightHour(6)).toBe(false);
  });

  it('NEVER locks any door from the inside — the one rule that outranks the whole table', () => {
    const everyKind = [
      { style: 'suburban', entrance: 'porch' }, { style: 'estate', entrance: 'porch' },
      { style: 'rural', entrance: 'porch' }, { style: 'dense-residential', entrance: 'lobby' },
      { style: 'downtown', entrance: 'lobby' }, { style: 'mixed-use', entrance: 'shopfront' },
      { style: 'civic', entrance: 'lobby' }, { style: 'industrial', entrance: 'dock' },
    ] as const;
    for (const facts of everyKind) {
      for (const hour of [0, 3, 12, 23]) {
        expect(doorLocked(facts, 'inside', hour), `${facts.style} ${facts.entrance} @${hour}h`).toBe(false);
      }
    }
  });
});

describe('the picking dial arithmetic', () => {
  it('opens rough doors wider than smart ones', () => {
    expect(pickBiteWidth('bare', 0, 0)).toBeGreaterThan(pickBiteWidth('homely', 0, 0));
    expect(pickBiteWidth('homely', 0, 0)).toBeGreaterThan(pickBiteWidth('smart', 0, 0));
  });

  it('doubles the bite for good after mastery', () => {
    expect(pickBiteWidth('smart', PICK_MASTERY, 0)).toBeCloseTo(pickBiteWidth('smart', 0, 0) * 2, 5);
    expect(pickBiteWidth('smart', PICK_MASTERY - 1, 0)).toBeCloseTo(pickBiteWidth('smart', 0, 0), 5);
  });

  it('widens with every miss (the lock only ever gets easier) and caps', () => {
    const fresh = pickBiteWidth('smart', 0, 0);
    expect(pickBiteWidth('smart', 0, 1)).toBeGreaterThan(fresh);
    expect(pickBiteWidth('smart', 0, 3)).toBeGreaterThan(pickBiteWidth('smart', 0, 1));
    expect(pickBiteWidth('bare', PICK_MASTERY, 6)).toBeLessThanOrEqual(0.55);
  });

  it('bites only at the top of the sweep', () => {
    expect(pickBites(1, 0.2)).toBe(true);
    expect(pickBites(0.85, 0.2)).toBe(true);
    expect(pickBites(0.79, 0.2)).toBe(false);
    expect(pickBites(0, 0.2)).toBe(false);
  });
});
