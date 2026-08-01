import { describe, expect, it } from 'vitest';
import { accumulateFear, CALM_THRESHOLD, COWER_THRESHOLD, decayFear, DRAWN_ON_ME_FEAR, FEAR_EVENTS, FEAR_MAX, fearContribution, fearResponse, FLEE_THRESHOLD, HOLD_GROUND_CAP, holdGroundFear } from './FearSystem';

describe('FearSystem', () => {
  it('scales fear by proximity with zero effect outside the radius', () => {
    const close = fearContribution(FEAR_EVENTS.gunshot, 2);
    const far = fearContribution(FEAR_EVENTS.gunshot, 40);
    expect(close).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(fearContribution(FEAR_EVENTS.gunshot, FEAR_EVENTS.gunshot.radius)).toBe(0);
    expect(fearContribution(FEAR_EVENTS.gunshot, 200)).toBe(0);
  });

  it('makes a nearby kill scarier than a nearby gunshot', () => {
    expect(fearContribution(FEAR_EVENTS.kill, 10)).toBeGreaterThan(fearContribution(FEAR_EVENTS.gunshot, 10));
  });

  it('carries the sniper crack louder and much further than a pistol shot', () => {
    expect(FEAR_EVENTS.sniperShot.base).toBeGreaterThan(FEAR_EVENTS.gunshot.base);
    expect(FEAR_EVENTS.sniperShot.radius).toBeGreaterThanOrEqual(FEAR_EVENTS.gunshot.radius * 1.5);
    expect(fearContribution(FEAR_EVENTS.sniperShot, 60)).toBeGreaterThan(0); // still heard beyond the pistol's whole radius
    expect(fearContribution(FEAR_EVENTS.gunshot, 60)).toBe(0);
  });

  it('accumulates repeated events up to the cap and ignores negatives', () => {
    let fear = 0;
    for (let i = 0; i < 6; i++) fear = accumulateFear(fear, fearContribution(FEAR_EVENTS.gunshot, 5));
    expect(fear).toBe(FEAR_MAX);
    expect(accumulateFear(50, -20)).toBe(50);
  });

  it('decays slowly over time and never goes negative', () => {
    let fear = 60;
    fear = decayFear(fear, 4);
    expect(fear).toBe(40);
    expect(decayFear(fear, 999)).toBe(0);
  });

  it('stays calm below the flee threshold', () => {
    expect(fearResponse(FLEE_THRESHOLD - 1, false, 0.5)).toBe('calm');
    expect(fearResponse(FLEE_THRESHOLD - 1, true, 0.99)).toBe('calm');
  });

  it('branches fight or flight by personality once the threshold is crossed', () => {
    expect(fearResponse(FLEE_THRESHOLD, true, 0.1)).toBe('fight');
    expect(fearResponse(FLEE_THRESHOLD, false, 0.9)).toBe('fight');
    expect(fearResponse(FLEE_THRESHOLD, false, 0.5)).toBe('flee');
    expect(fearResponse(CALM_THRESHOLD, false, 0.5)).toBe('calm');
  });

  it('sends only timid peds into a cower at extreme fear', () => {
    expect(fearResponse(COWER_THRESHOLD, false, 0.1)).toBe('cower');
    expect(fearResponse(COWER_THRESHOLD - 1, false, 0.1)).toBe('flee');
    expect(fearResponse(COWER_THRESHOLD, false, 0.5)).toBe('flee');
    expect(fearResponse(FEAR_MAX, true, 0.1)).toBe('fight');
  });

  it('never cowers a ped that is already fleeing', () => {
    expect(fearResponse(FEAR_MAX, false, 0.1, true)).toBe('flee');
    expect(fearResponse(COWER_THRESHOLD, false, 0.1, true)).toBe('flee');
    expect(fearResponse(FEAR_MAX, true, 0.1, true)).toBe('fight');
  });

  it('breaks a mid-fight attacker off decisively without treating a drawn gun as a killing', () => {
    expect(DRAWN_ON_ME_FEAR).toBeGreaterThan(FLEE_THRESHOLD); // the attacker actually lets go
    expect(DRAWN_ON_ME_FEAR).toBeLessThan(FEAR_EVENTS.kill.base);
  });
});

/**
 * THE TRIGGER TABLE. The owner: "They shouldn't scare away at all unless actually shot at or
 * punched. Seeing a gun or whatever spooks them now is not enough."
 *
 * The rule lives in the SHAPE of the fear table, not in a flag somewhere: only things that
 * happened get to be broadcastable events, and the one firearm fright left in the codebase is
 * deliberately not one of them. Both halves are pinned here — a passive-sight source cannot be
 * re-added without failing this block, and none of the violence has been softened to get there.
 */
describe('only violence frightens anybody', () => {
  it('has no broadcastable event for the sight of a weapon', () => {
    // A FearEvent is precisely "a thing PopulationSystem.broadcastFear can scatter a street with".
    // Anything gun-shaped in this list is a street-emptying bug: the old `brandish` entry, fired
    // every 1.5s while the player merely held right-mouse, is what made the peds unapproachable.
    expect(Object.keys(FEAR_EVENTS).sort()).toEqual(['assault', 'body', 'gunshot', 'kill', 'panic', 'sniperShot']);
  });

  it('keeps every violent event exactly as loud as it was', () => {
    // Regression floor, not decoration: the fix must not have bought calm streets by quietly
    // detuning the events that are SUPPOSED to scatter one.
    expect(FEAR_EVENTS.gunshot).toEqual({ base: 34, radius: 48 });
    expect(FEAR_EVENTS.sniperShot).toEqual({ base: 42, radius: 84 });
    expect(FEAR_EVENTS.kill).toEqual({ base: 62, radius: 58 });
    expect(FEAR_EVENTS.assault).toEqual({ base: 42, radius: 24 });
    expect(FEAR_EVENTS.body).toEqual({ base: 22, radius: 10 });
    expect(FEAR_EVENTS.panic).toEqual({ base: 16, radius: 12 });
  });

  it('still scatters the street at a killing, a punch and a rifle crack', () => {
    for (const event of [FEAR_EVENTS.kill, FEAR_EVENTS.assault, FEAR_EVENTS.sniperShot]) {
      expect(fearContribution(event, 2)).toBeGreaterThan(FLEE_THRESHOLD); // point blank: they run
    }
  });

  it('sends them on the second pistol pop, which is the pre-existing tuning and stays', () => {
    // One 34-point pop lands a whisker under the 35 threshold on purpose — a single round makes
    // people flinch, a firefight clears the block. Untouched by this fix; asserted so it stays that way.
    const pop = fearContribution(FEAR_EVENTS.gunshot, 2);
    expect(pop).toBeLessThan(FLEE_THRESHOLD);
    expect(accumulateFear(pop, pop)).toBeGreaterThan(FLEE_THRESHOLD);
  });
});

/**
 * SOLIDARITY. The owner: "when I join a protest, everyone gets scared of me and runs away, which
 * means it's not much of a protest."
 */
describe('a picket line holds', () => {
  it('never lets fear reach the flee threshold, however much of it lands', () => {
    expect(holdGroundFear(0, FEAR_EVENTS.kill.base)).toBeLessThan(FLEE_THRESHOLD);
    expect(holdGroundFear(HOLD_GROUND_CAP, FEAR_MAX)).toBe(HOLD_GROUND_CAP);
    expect(fearResponse(holdGroundFear(0, FEAR_EVENTS.assault.base), false, 0.5)).toBe('calm');
    expect(fearResponse(holdGroundFear(0, FEAR_EVENTS.kill.base), false, 0.05)).toBe('calm'); // not even a cower
  });

  it('still ACCUMULATES, so the moment solidarity breaks there is already something to act on', () => {
    // This is why it is a cap and not a zero: a protester who has been shouted at all morning and
    // then sees a shooting does not start from calm.
    const rattled = holdGroundFear(0, FEAR_EVENTS.assault.base);
    expect(rattled).toBeGreaterThan(0);
    expect(accumulateFear(rattled, FEAR_EVENTS.kill.base)).toBeGreaterThan(COWER_THRESHOLD);
  });

  it('is a repeated bump that scatters an ordinary crowd — the thing the cap exists to stop', () => {
    // Two bumps inside BUMP_WINDOW read as `assault`, and one assault is over the threshold on its
    // own. Standing in a crowd of ten makes that unavoidable.
    expect(FEAR_EVENTS.assault.base).toBeGreaterThan(FLEE_THRESHOLD);
    expect(holdGroundFear(0, FEAR_EVENTS.assault.base)).toBeLessThan(FLEE_THRESHOLD);
  });
});
