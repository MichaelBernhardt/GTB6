/**
 * The lock line, nailed down before the gate goes live: a place of business that is open is open,
 * a home is locked — and the gate itself stays OFF until the locks pass ships the pick, because a
 * locked city with no pick for sale is a broken city.
 */
import { describe, expect, it } from 'vitest';
import { doorLocked, lockedClass, LOCKS_ENABLED } from './lock';

describe('the lock line (line D)', () => {
  it('opens places of business and locks homes', () => {
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

  it('keeps the live gate off until the pick can actually be bought', () => {
    expect(LOCKS_ENABLED).toBe(false);
    expect(doorLocked({ style: 'suburban', entrance: 'porch' })).toBe(false);
  });
});
