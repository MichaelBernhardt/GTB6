import { describe, expect, it } from 'vitest';
import {
  advanceSwing, beginSwing, MELEE_HIT_ARC_DOT, MELEE_HIT_AT, MELEE_HIT_RANGE,
  MELEE_SWING_SECONDS, meleeHitLands, swingExtension,
} from './MeleeSystem';

const DT = 1 / 60;

describe('melee swing timing', () => {
  it('delivers the hit exactly once, at the fist-extension frame, and finishes after the full clip', () => {
    const swing = beginSwing();
    let hits = 0; let hitTime = 0; let doneTime = 0; let time = 0;
    while (time < MELEE_SWING_SECONDS + 0.2) {
      const { hit, done } = advanceSwing(swing, DT);
      time += DT;
      if (hit) { hits += 1; hitTime = time; }
      if (done && !doneTime) doneTime = time;
    }
    expect(hits).toBe(1);
    expect(hitTime).toBeGreaterThanOrEqual(MELEE_HIT_AT);
    expect(hitTime).toBeLessThan(MELEE_HIT_AT + 2 * DT); // lands the frame the windup completes, not later
    expect(doneTime).toBeGreaterThanOrEqual(MELEE_SWING_SECONDS);
    expect(doneTime).toBeLessThan(MELEE_SWING_SECONDS + 2 * DT);
  });

  it('gives the player a real escape window before the hit frame', () => {
    // Base movement is 8 u/s: backing off for the whole windup covers far more than the
    // reach margin between the engage ring and the hit range.
    expect(8 * MELEE_HIT_AT).toBeGreaterThan(MELEE_HIT_RANGE);
  });
});

describe('hit gate', () => {
  it("lands only in reach and in the attacker's forward arc at the hit frame", () => {
    expect(meleeHitLands(MELEE_HIT_RANGE - 0.1, 1)).toBe(true);
    expect(meleeHitLands(MELEE_HIT_RANGE + 0.1, 1)).toBe(false); // backed off mid-windup: whiff
    expect(meleeHitLands(1, MELEE_HIT_ARC_DOT - 0.1)).toBe(false); // circled behind the attacker
    expect(meleeHitLands(1, MELEE_HIT_ARC_DOT + 0.1)).toBe(true);
  });
});

describe('procedural jab curve', () => {
  it('peaks exactly at the hit frame and rests at both ends', () => {
    expect(swingExtension(0)).toBe(0);
    expect(swingExtension(MELEE_HIT_AT)).toBeCloseTo(1);
    expect(swingExtension(MELEE_SWING_SECONDS)).toBe(0);
    expect(swingExtension(MELEE_HIT_AT / 2)).toBeGreaterThan(0.5);
    expect(swingExtension(MELEE_HIT_AT / 2)).toBeLessThan(1);
  });
});
