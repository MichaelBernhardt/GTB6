import { describe, expect, it } from 'vitest';
import { bumperAhead, carYields, CORRIDOR_MARGIN, corridorBlocked, FIRST_HONK, firstHonkDelay, holdRelease, overlapPush, PULL_AROUND_MAX, PULL_AROUND_MIN, pullAroundPatience, pullAroundSide, REHONK_MAX, REHONK_MIN, rehonkDelay, RELEASE_CLEAR, SHOVE_SPEED, STOP_BASE, STOP_SCALE, stoppingEnvelope, vehicleHitDamage } from './TrafficAvoidance';

describe('stopping envelope', () => {
  it('keeps a personal-space floor at a standstill', () => {
    expect(stoppingEnvelope(0)).toBe(STOP_BASE);
  });

  it('scales with speed and ignores its sign', () => {
    expect(stoppingEnvelope(20)).toBeCloseTo(20 * STOP_SCALE + STOP_BASE);
    expect(stoppingEnvelope(-20)).toBe(stoppingEnvelope(20));
  });
});

describe('forward corridor', () => {
  const halfWidth = 0.9; // compact: 1.8 wide

  it('blocks on a player dead ahead inside the envelope', () => {
    expect(corridorBlocked(5, 0, 20, halfWidth)).toBe(true);
  });

  it('ignores a player behind the car', () => {
    expect(corridorBlocked(-2, 0, 20, halfWidth)).toBe(false);
    expect(corridorBlocked(0, 0, 20, halfWidth)).toBe(false);
  });

  it('ignores a player beyond the stopping envelope', () => {
    expect(corridorBlocked(stoppingEnvelope(20), 0, 20, halfWidth)).toBe(false);
    expect(corridorBlocked(stoppingEnvelope(20) - 0.1, 0, 20, halfWidth)).toBe(true);
  });

  it('faster cars scan further ahead', () => {
    const ahead = 12;
    expect(corridorBlocked(ahead, 0, 5, halfWidth)).toBe(false);
    expect(corridorBlocked(ahead, 0, 30, halfWidth)).toBe(true);
  });

  it('bounds the lateral half-width at half body plus the margin', () => {
    const edge = halfWidth + CORRIDOR_MARGIN;
    expect(corridorBlocked(4, (edge - 0.05) ** 2, 10, halfWidth)).toBe(true);
    expect(corridorBlocked(4, edge ** 2, 10, halfWidth)).toBe(false);
  });

  it('measures the envelope from the front bumper, so long noses stop as short as compacts', () => {
    const quantumHalf = 5.05 / 2; const compactHalf = 3.7 / 2; // Quantum vs Citi Golf halves from the specs
    const playerFromCenter = 5.4; // inside a stopped Quantum's bumper envelope, outside a compact's
    expect(corridorBlocked(bumperAhead(playerFromCenter, quantumHalf), 0, 0, halfWidth)).toBe(true);
    expect(corridorBlocked(bumperAhead(playerFromCenter, compactHalf), 0, 0, halfWidth)).toBe(false);
    expect(bumperAhead(playerFromCenter, quantumHalf)).toBeCloseTo(playerFromCenter - quantumHalf); // the gap the BUMPER sees
  });

  it('never blocks on a player already alongside the nose', () => {
    expect(corridorBlocked(bumperAhead(1.5, 5.05 / 2), 0, 10, halfWidth)).toBe(false); // beside a Quantum's bumper: contact code owns this
  });
});

describe('held-state hysteresis', () => {
  it('resets the clear timer whenever the corridor blocks again', () => {
    expect(holdRelease(RELEASE_CLEAR - 0.05, true, 0.016)).toBe(0); // a 20cm shuffle out and back never restarts the creep
  });

  it('accrues clear time and releases only after the full window', () => {
    let clear: number | undefined = 0;
    for (let step = 0; step < 4; step++) { clear = holdRelease(clear ?? 0, false, 0.1); expect(clear).not.toBeUndefined(); }
    expect(holdRelease(clear ?? 0, false, 0.11)).toBeUndefined(); // corridor stayed clear: roll again
  });
});

describe('crawl contact yields the car', () => {
  it('a crawling nose contact moves the car, never the standing player', () => {
    expect(carYields(0, SHOVE_SPEED - 0.5)).toBe(true);
    expect(carYields(0, -(SHOVE_SPEED - 0.5))).toBe(true); // crawling in reverse too
  });

  it('above the shove threshold the bumper wins', () => {
    expect(carYields(0, SHOVE_SPEED)).toBe(false);
  });

  it('lateral overlap still pushes the player — he sidled into the car', () => {
    expect(carYields(0.4, 1)).toBe(false);
  });
});

describe('honk cadence', () => {
  it('waits at least the patience window before the first hoot', () => {
    expect(firstHonkDelay(() => 0)).toBe(FIRST_HONK);
    expect(firstHonkDelay(() => 0.999)).toBeLessThan(FIRST_HONK + 0.61);
  });

  it('re-honks inside the 2-3s band with per-driver jitter', () => {
    expect(rehonkDelay(() => 0)).toBe(REHONK_MIN);
    expect(rehonkDelay(() => 1)).toBe(REHONK_MAX);
    expect(rehonkDelay(() => 0.2)).not.toBe(rehonkDelay(() => 0.8)); // two drivers never sync up
  });

  it('runs out of patience inside the 8-10s pull-around band', () => {
    expect(pullAroundPatience(() => 0)).toBe(PULL_AROUND_MIN);
    expect(pullAroundPatience(() => 1)).toBe(PULL_AROUND_MAX);
  });
});

describe('damage vs shove threshold', () => {
  it('below the threshold contact is a zero-damage shove', () => {
    expect(vehicleHitDamage(0)).toBe(0);
    expect(vehicleHitDamage(SHOVE_SPEED - 0.1)).toBe(0);
  });

  it('at and above the threshold damage lands and scales with speed', () => {
    expect(vehicleHitDamage(SHOVE_SPEED)).toBeGreaterThan(0);
    expect(vehicleHitDamage(20)).toBeGreaterThan(vehicleHitDamage(10));
    expect(vehicleHitDamage(-20)).toBe(vehicleHitDamage(20)); // reversing over someone still hurts
  });
});

describe('pull-around eligibility', () => {
  it('prefers the side away from the player', () => {
    expect(pullAroundSide(0.4, true, true)).toBe(-1); // player on the right: swing left
    expect(pullAroundSide(-0.4, true, true)).toBe(1);
  });

  it('falls back to the other side when the preferred lane is obstructed', () => {
    expect(pullAroundSide(0.4, true, false)).toBe(1);
    expect(pullAroundSide(-0.4, false, true)).toBe(-1);
  });

  it('reports boxed in when neither side is clear', () => {
    expect(pullAroundSide(0.4, false, false)).toBe(0);
  });
});

describe('overlap push-out', () => {
  const halfLength = 2; const halfWidth = 0.9; const radius = 0.65;

  it('returns nothing when the player is clear of the car', () => {
    expect(overlapPush(halfLength + radius, 0, halfLength, halfWidth, radius)).toBeUndefined();
    expect(overlapPush(0, halfWidth + radius, halfLength, halfWidth, radius)).toBeUndefined();
  });

  it('pushes sideways when the side is the shallower axis', () => {
    const push = overlapPush(0.5, 1.2, halfLength, halfWidth, radius);
    expect(push).toEqual({ ahead: 0, lateral: expect.closeTo(halfWidth + radius - 1.2, 5) as number });
  });

  it('pushes along the length when the bumper is the shallower axis', () => {
    const push = overlapPush(2.5, 0.2, halfLength, halfWidth, radius);
    expect(push?.lateral).toBe(0);
    expect(push?.ahead).toBeCloseTo(halfLength + radius - 2.5);
  });

  it('keeps the push on the player side of the car', () => {
    expect(overlapPush(0.5, -1.2, halfLength, halfWidth, radius)?.lateral).toBeLessThan(0);
    expect(overlapPush(-2.5, 0.2, halfLength, halfWidth, radius)?.ahead).toBeLessThan(0);
  });

  it('resolves a dead-centre overlap deterministically', () => {
    const push = overlapPush(0, 0, halfLength, halfWidth, radius);
    expect(push).toEqual({ ahead: 0, lateral: halfWidth + radius }); // lateral is always the lesser reach
  });
});
