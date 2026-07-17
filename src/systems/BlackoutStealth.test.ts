import { describe, expect, it } from 'vitest';
import { SIGHT_RADIUS } from './PoliceKnowledge';
import { BLACKOUT_SIGHT_RADIUS, BLACKOUT_STEALTH_THRESHOLD, concealedInBlackout, HEADLIGHT_CONE_HALF_ANGLE, HEADLIGHT_CONE_RANGE, inHeadlightCone, MUZZLE_FLASH_SECONDS, policeSightRadius, visibleInBlackout } from './BlackoutStealth';

describe('headlight cone', () => {
  // Vehicle forward is (sin heading, cos heading): heading 0 faces +z.
  it('lights a player straight ahead within range', () => {
    expect(inHeadlightCone(0, 0, 0, 0, 10)).toBe(true);
    expect(inHeadlightCone(0, 0, 0, 0, HEADLIGHT_CONE_RANGE - 0.5)).toBe(true);
  });

  it('does not reach past the cone range', () => {
    expect(inHeadlightCone(0, 0, 0, 0, HEADLIGHT_CONE_RANGE + 0.5)).toBe(false);
    expect(inHeadlightCone(0, 0, 0, 0, 200)).toBe(false);
  });

  it('misses a player beside or behind the vehicle', () => {
    expect(inHeadlightCone(0, 0, 0, 10, 0)).toBe(false); // 90° off the nose
    expect(inHeadlightCone(0, 0, 0, 0, -10)).toBe(false); // dead astern
  });

  it('requires the vehicle to actually face the player', () => {
    expect(inHeadlightCone(0, 0, Math.PI, 0, 10)).toBe(false); // facing -z, player at +z
    expect(inHeadlightCone(0, 0, Math.PI, 0, -10)).toBe(true);
  });

  it('respects the half-angle edge on both sides', () => {
    const inside = HEADLIGHT_CONE_HALF_ANGLE - 0.02; const outside = HEADLIGHT_CONE_HALF_ANGLE + 0.02;
    expect(inHeadlightCone(0, 0, 0, Math.sin(inside) * 15, Math.cos(inside) * 15)).toBe(true);
    expect(inHeadlightCone(0, 0, 0, Math.sin(outside) * 15, Math.cos(outside) * 15)).toBe(false);
    expect(inHeadlightCone(0, 0, 0, -Math.sin(inside) * 15, Math.cos(inside) * 15)).toBe(true);
  });

  it('never lights a player standing dead on the vehicle — beams point ahead', () => {
    expect(inHeadlightCone(5, 5, 0, 5, 5)).toBe(false);
  });
});

describe('visible in blackout', () => {
  const cone = { x: 0, z: 0, heading: 0 };

  it('an unlit player with no cones is not visible', () => {
    expect(visibleInBlackout(0, 10, false, 0, [])).toBe(false);
  });

  it('the torch always gives you away', () => {
    expect(visibleInBlackout(500, 500, true, 0, [])).toBe(true);
  });

  it('a fresh muzzle flash gives you away until it fades', () => {
    expect(visibleInBlackout(0, 10, false, MUZZLE_FLASH_SECONDS, [])).toBe(true);
    expect(visibleInBlackout(0, 10, false, 0.01, [])).toBe(true);
    expect(visibleInBlackout(0, 10, false, 0, [])).toBe(false);
  });

  it('standing in a live headlight cone gives you away; outside it does not', () => {
    expect(visibleInBlackout(0, 10, false, 0, [cone])).toBe(true);
    expect(visibleInBlackout(0, -10, false, 0, [cone])).toBe(false);
    expect(visibleInBlackout(0, 10, false, 0, [{ x: 0, z: 0, heading: Math.PI }])).toBe(false); // facing away
  });
});

describe('concealment gate', () => {
  it('conceals only past the darkness threshold', () => {
    expect(concealedInBlackout(1, false)).toBe(true);
    expect(concealedInBlackout(BLACKOUT_STEALTH_THRESHOLD + 0.01, false)).toBe(true);
    expect(concealedInBlackout(BLACKOUT_STEALTH_THRESHOLD, false)).toBe(false); // ramp still fading / dusk shedding
    expect(concealedInBlackout(0, false)).toBe(false); // grid up or broad daylight
  });

  it('never conceals a visible player, however dark it is', () => {
    expect(concealedInBlackout(1, true)).toBe(false);
  });

  it('shrinks the police sight radius to whites-of-eyes while concealed', () => {
    expect(policeSightRadius(true)).toBe(BLACKOUT_SIGHT_RADIUS);
    expect(policeSightRadius(false)).toBe(SIGHT_RADIUS);
    expect(BLACKOUT_SIGHT_RADIUS).toBeLessThan(SIGHT_RADIUS);
    expect(BLACKOUT_SIGHT_RADIUS).toBeGreaterThan(0); // you still can't stand on a cop's toes
  });
});
