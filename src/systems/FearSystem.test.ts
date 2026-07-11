import { describe, expect, it } from 'vitest';
import { accumulateFear, BRANDISH_SENSE_RADIUS, CALM_THRESHOLD, COWER_THRESHOLD, decayFear, FEAR_EVENTS, FEAR_MAX, fearContribution, fearResponse, FLEE_THRESHOLD, seesBrandish } from './FearSystem';

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

  it('lets only witnesses facing the raised gun (or very close) see the brandish', () => {
    expect(seesBrandish(0, 1, 0, 10, 10)).toBe(true); // facing +z, gun ahead
    expect(seesBrandish(0, 1, 0, -10, 10)).toBe(false); // gun behind their back
    expect(seesBrandish(0, 1, 0, -5, 5)).toBe(true); // behind but inside the sense radius
    expect(seesBrandish(1, 0, -10, 0, 10)).toBe(false);
    expect(seesBrandish(1, 0, 10, 0.5, 10)).toBe(true);
    expect(BRANDISH_SENSE_RADIUS).toBeLessThan(FEAR_EVENTS.brandish.radius);
  });

  it('scares brandish witnesses less than a kill, and panic contagion less than the brandish itself', () => {
    expect(FEAR_EVENTS.brandish.base).toBeLessThan(FEAR_EVENTS.kill.base);
    expect(fearContribution(FEAR_EVENTS.panic, 5)).toBeLessThan(fearContribution(FEAR_EVENTS.brandish, 5));
    expect(fearContribution(FEAR_EVENTS.brandish, FEAR_EVENTS.brandish.radius)).toBe(0);
    expect(fearContribution(FEAR_EVENTS.brandish, 3)).toBeGreaterThan(FLEE_THRESHOLD); // point-blank raised gun starts a panic
  });
});
