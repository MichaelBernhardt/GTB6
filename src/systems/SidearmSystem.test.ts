import { describe, expect, it } from 'vitest';
import {
  ARMED_CITIZEN_MODULO,
  CIVILIAN_FIRE_MIN,
  CIVILIAN_FIRE_JITTER,
  CIVILIAN_FIRE_RANGE,
  CIVILIAN_GUN_DAMAGE,
  civilianFireDelay,
  GUN_ENGAGE_RANGE,
  GUN_ENGAGE_RELEASE,
  gunDeterrence,
  isArmedCitizen,
} from './SidearmSystem';

describe('the armed-citizen trait', () => {
  it('is deterministic index arithmetic: same index, same answer, no dice anywhere', () => {
    for (const index of [0, 3, 27, 207, 1_000_003]) {
      expect(isArmedCitizen(index, false, false)).toBe(isArmedCitizen(index, false, false));
    }
  });

  it('arms exactly 1 in 12 citizens — rare enough to be a discovery, common enough to exist in any crowd', () => {
    let armed = 0;
    for (let index = 0; index < 1200; index++) if (isArmedCitizen(index, false, false)) armed += 1;
    expect(armed).toBe(1200 / ARMED_CITIZEN_MODULO);
  });

  it('deliberately overlaps the aggressive personality at exactly 1 in 36: armed aggressives must exist', () => {
    // The person who squares up to a player holding a gun and answers it by drawing their own
    // is only reachable if the two modular wheels intersect — 12 shares a factor with 9 on purpose.
    const overlaps: number[] = [];
    for (let index = 0; index < 360; index++) if (isArmedCitizen(index, false, false) && index % 9 === 0) overlaps.push(index);
    expect(overlaps).toEqual([27, 63, 99, 135, 171, 207, 243, 279, 315, 351]); // every 36th, phase 27
  });

  it('never arms police (their service pistol is PoliceSystem) or Rank Enforcers (a fist crew by design)', () => {
    expect(isArmedCitizen(3, false, false)).toBe(true); // the same index, as a citizen, carries
    expect(isArmedCitizen(3, true, false)).toBe(false);
    expect(isArmedCitizen(3, false, true)).toBe(false);
  });
});

describe('gunDeterrence — fists only pick fights with fists', () => {
  it('collapses an unarmed fight response to flight when the player is visibly armed', () => {
    expect(gunDeterrence('fight', true, false)).toBe('flee');
  });

  it('lets an armed citizen fight an armed player, and anyone fight an unarmed one', () => {
    expect(gunDeterrence('fight', true, true)).toBe('fight'); // they have an answer: they draw
    expect(gunDeterrence('fight', false, false)).toBe('fight'); // unarmed player: fists are fair
    expect(gunDeterrence('fight', false, true)).toBe('fight');
  });

  it('never touches non-fight responses — the rest of the fear model is not its business', () => {
    for (const response of ['calm', 'flee', 'cower'] as const) {
      expect(gunDeterrence(response, true, false)).toBe(response);
      expect(gunDeterrence(response, true, true)).toBe(response);
    }
  });
});

describe('civilian fire shape', () => {
  it('holds ground further out than fists, fires only from inside the settled stance ring', () => {
    expect(GUN_ENGAGE_RANGE).toBeGreaterThan(4.5); // outside the square-up trigger: the draw reads before contact
    expect(GUN_ENGAGE_RELEASE).toBeGreaterThan(GUN_ENGAGE_RANGE); // hysteresis, like the melee guard
    expect(CIVILIAN_FIRE_RANGE).toBe(GUN_ENGAGE_RELEASE); // shots come from the aim stance, never a mid-sprint hip fire
  });

  it('keeps a civilian defender below JMPD pressure and paces shots on a bounded jittered beat', () => {
    expect(CIVILIAN_GUN_DAMAGE).toBeLessThan(4 + 2); // under a two-star officer's 4 + wanted
    expect(civilianFireDelay(0)).toBe(CIVILIAN_FIRE_MIN);
    expect(civilianFireDelay(1)).toBe(CIVILIAN_FIRE_MIN + CIVILIAN_FIRE_JITTER);
    expect(civilianFireDelay(0.5)).toBeGreaterThan(civilianFireDelay(0.25));
  });
});
