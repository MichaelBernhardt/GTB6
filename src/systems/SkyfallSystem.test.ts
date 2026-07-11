import { describe, expect, it } from 'vitest';
import {
  airborneHint, canDeploy, CHUTE_DESCENT, chuteLandingDamage, deployParachute, FLARE_DESCENT, FREEFALL_DESCENT,
  FREEFALL_DIVE_DESCENT, FREEFALL_FLAT_DESCENT, SAFE_CHUTE_DESCENT, startAirborne, stepAirborne, targetDescent,
  targetForward, type AirborneState, type AirborneStick,
} from './SkyfallSystem';

const DT = 1 / 60;
const NEUTRAL: AirborneStick = { pitch: 0, steer: 0, flare: false };

/** Flies `seconds` of the descent at 60fps against flat ground far below; returns the final altitude. */
function fly(state: AirborneState, stick: AirborneStick, seconds: number, y = 100000, support = 0): number {
  for (let tick = 0; tick < Math.round(seconds / DT); tick++) y = stepAirborne(state, stick, DT, y, support).y;
  return y;
}

describe('freefall', () => {
  it('settles at terminal velocity with a neutral stick', () => {
    const state = startAirborne(0, 600);
    const y = fly(state, NEUTRAL, 10);
    expect(state.descent).toBeGreaterThan(FREEFALL_DESCENT - 2);
    expect(state.descent).toBeLessThan(FREEFALL_DESCENT + 1);
    expect(y).toBeLessThan(100000 - 400); // it really fell
  });

  it('dives faster and gains forward speed with W held', () => {
    const state = startAirborne(0, 600);
    fly(state, { ...NEUTRAL, pitch: 1 }, 5);
    expect(state.pitch).toBeCloseTo(1);
    expect(state.descent).toBeGreaterThan(70);
    expect(targetForward('freefall', 1)).toBeGreaterThan(targetForward('freefall', 0));
    expect(targetDescent('freefall', 1)).toBe(FREEFALL_DIVE_DESCENT);
  });

  it('flattens out slower but tracking further with S held', () => {
    const state = startAirborne(0, 600);
    fly(state, { ...NEUTRAL, pitch: -1 }, 5);
    expect(state.descent).toBeLessThan(FREEFALL_FLAT_DESCENT + 3);
    expect(targetForward('freefall', -1)).toBeGreaterThan(targetForward('freefall', 0));
    expect(targetDescent('freefall', -1)).toBe(FREEFALL_FLAT_DESCENT);
  });

  it('relaxes the trim back to neutral once the stick is released', () => {
    const state = startAirborne(0, 600);
    fly(state, { ...NEUTRAL, pitch: 1 }, 2);
    fly(state, NEUTRAL, 3);
    expect(Math.abs(state.pitch)).toBeLessThan(0.02);
  });

  it('steers with A/D and banks into the turn', () => {
    const state = startAirborne(0, 600);
    fly(state, { ...NEUTRAL, steer: 1 }, 1);
    expect(state.heading).toBeLessThan(-1.4); // D turns clockwise (heading falls)
    expect(state.bank).toBeGreaterThan(0.3);
    const other = startAirborne(0, 600);
    fly(other, { ...NEUTRAL, steer: -1 }, 1);
    expect(other.heading).toBeGreaterThan(1.4);
  });

  it('moves horizontally along the heading', () => {
    const state = startAirborne(0, 600);
    const step = stepAirborne(state, NEUTRAL, DT, 500, 0);
    expect(step.dx).toBeCloseTo(0, 5); // heading 0 points +z
    expect(step.dz).toBeGreaterThan(0);
  });
});

describe('parachute', () => {
  it('only deploys from freefall with a chute aboard', () => {
    expect(canDeploy('freefall', 1)).toBe(true);
    expect(canDeploy('freefall', 0)).toBe(false);
    expect(canDeploy('parachute', 2)).toBe(false);
  });

  it('sheds the freefall sink rate quickly after the canopy opens', () => {
    const state = startAirborne(0, 600);
    fly(state, NEUTRAL, 5); // at terminal velocity
    deployParachute(state);
    fly(state, NEUTRAL, 2);
    expect(state.descent).toBeLessThan(CHUTE_DESCENT + 1.5);
    expect(state.mode).toBe('parachute');
    expect(state.flareArmed).toBe(true);
  });

  it('dives for speed with W and rides the brakes with S', () => {
    expect(targetDescent('parachute', 1)).toBeGreaterThan(CHUTE_DESCENT);
    expect(targetDescent('parachute', -1)).toBeLessThan(CHUTE_DESCENT);
    expect(targetForward('parachute', 1)).toBeGreaterThan(targetForward('parachute', 0));
  });

  it('flares once near the ground, cutting the sink for a soft touchdown', () => {
    const state = startAirborne(0, 600);
    deployParachute(state); state.descent = CHUTE_DESCENT;
    for (let tick = 0; tick < 45; tick++) stepAirborne(state, { pitch: 0, steer: 0, flare: true }, DT, 10, 0); // held 12u up: inside the window
    expect(state.flareArmed).toBe(false);
    expect(state.descent).toBeLessThan(FLARE_DESCENT + 1.5);
    for (let tick = 0; tick < 240; tick++) stepAirborne(state, { pitch: 0, steer: 0, flare: true }, DT, 10, 0); // the burst expires, no re-arm
    expect(state.descent).toBeGreaterThan(4); // back to the braked sink rate despite holding flare
  });

  it('does not flare high above the ground', () => {
    const state = startAirborne(0, 600);
    deployParachute(state);
    stepAirborne(state, { pitch: 0, steer: 0, flare: true }, DT, 300, 0);
    expect(state.flareArmed).toBe(true);
    expect(state.flareTimer).toBe(0);
  });
});

describe('landing', () => {
  it('reports touchdown when the feet reach the support surface', () => {
    const state = startAirborne(0, 600);
    state.descent = 50;
    const step = stepAirborne(state, NEUTRAL, DT, 0.4, 0);
    expect(step.landed).toBe(true);
    expect(step.y).toBe(0);
    expect(step.descent).toBeGreaterThan(40);
  });

  it('lands on elevated supports like rooftops, not just the ground plane', () => {
    const state = startAirborne(0, 600);
    state.descent = 50;
    const step = stepAirborne(state, NEUTRAL, DT, 32.2, 32);
    expect(step.landed).toBe(true);
    expect(step.y).toBe(32);
  });

  it('charges nothing for a sane canopy landing and a bruise per unit over the limit', () => {
    expect(chuteLandingDamage(CHUTE_DESCENT)).toBe(0);
    expect(chuteLandingDamage(SAFE_CHUTE_DESCENT)).toBe(0);
    expect(chuteLandingDamage(SAFE_CHUTE_DESCENT + 5)).toBe(30);
  });
});

describe('airborne hint', () => {
  it('advertises the deploy key only when a parachute is carried', () => {
    expect(airborneHint('freefall', 1)).toContain('SPACE');
    expect(airborneHint('freefall', 0)).not.toContain('SPACE');
    expect(airborneHint('freefall', 0)).toContain('No parachute');
    expect(airborneHint('parachute', 0)).toContain('Flare');
  });
});
