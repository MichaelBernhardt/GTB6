import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { advanceBlackout, advanceHour, applyBlackout, BLACKOUT_FADE_SECONDS, createSkySample, DAY_CYCLE_SECONDS, DAWN_END, DAWN_START, DUSK_END, DUSK_START, formatClock, nightFactor, sampleSky, selectNearest, SKY_KEYFRAMES, sunDirection, wrapHour } from './DayNight';

describe('day/night clock', () => {
  it('advances in game hours and wraps at midnight', () => {
    expect(advanceHour(10, DAY_CYCLE_SECONDS / 24)).toBeCloseTo(11);
    expect(advanceHour(23, 2 * DAY_CYCLE_SECONDS / 24)).toBeCloseTo(1);
    expect(advanceHour(7.25, DAY_CYCLE_SECONDS)).toBeCloseTo(7.25); // one full real cycle = one full day
    expect(advanceHour(3, 90, 360)).toBeCloseTo(9); // cycle length is tunable
  });

  it('wraps arbitrary hours into [0, 24)', () => {
    expect(wrapHour(-3)).toBeCloseTo(21);
    expect(wrapHour(25.5)).toBeCloseTo(1.5);
    expect(wrapHour(24)).toBe(0);
  });

  it('formats a HUD clock', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(9.5)).toBe('09:30');
    expect(formatClock(23.999)).toBe('23:59');
  });
});

describe('sky keyframes', () => {
  it('starts at hour 0 and stays sorted so interpolation is well defined', () => {
    expect(SKY_KEYFRAMES[0]!.hour).toBe(0);
    for (let i = 1; i < SKY_KEYFRAMES.length; i++) expect(SKY_KEYFRAMES[i]!.hour).toBeGreaterThan(SKY_KEYFRAMES[i - 1]!.hour);
    expect(SKY_KEYFRAMES.at(-1)!.hour).toBeLessThan(24);
  });

  it('returns exact keyframe values on a keyframe hour', () => {
    const noon = SKY_KEYFRAMES.find((frame) => frame.hour === 12)!;
    const sample = sampleSky(12, createSkySample());
    expect(sample.sky.getHex()).toBe(noon.sky);
    expect(sample.fog.getHex()).toBe(noon.fog);
    expect(sample.sunIntensity).toBeCloseTo(noon.sunIntensity);
    expect(sample.hemiIntensity).toBeCloseTo(noon.hemiIntensity);
  });

  it('interpolates scalars halfway between keyframes', () => {
    const a = SKY_KEYFRAMES.find((frame) => frame.hour === 12)!;
    const b = SKY_KEYFRAMES.find((frame) => frame.hour === 16.5)!;
    const sample = sampleSky((a.hour + b.hour) / 2, createSkySample());
    expect(sample.sunIntensity).toBeCloseTo((a.sunIntensity + b.sunIntensity) / 2);
    expect(sample.ambientIntensity).toBeCloseTo((a.ambientIntensity + b.ambientIntensity) / 2);
  });

  it('wraps across midnight between the last and first keyframes', () => {
    const last = SKY_KEYFRAMES.at(-1)!; const first = SKY_KEYFRAMES[0]!;
    const midpoint = (last.hour + 24) / 2 >= 24 ? 0 : (last.hour + 24) / 2;
    const sample = sampleSky(midpoint, createSkySample());
    expect(sample.sunIntensity).toBeCloseTo((last.sunIntensity + first.sunIntensity) / 2);
    expect(sampleSky(23.99, createSkySample()).sky.getHex()).toBe(first.sky); // night frames match across the wrap
  });
});

describe('night factor', () => {
  it('is 0 in daylight and 1 at night', () => {
    expect(nightFactor(12)).toBe(0);
    expect(nightFactor(10)).toBe(0);
    expect(nightFactor(0)).toBe(1);
    expect(nightFactor(23)).toBe(1);
    expect(nightFactor(3)).toBe(1);
  });

  it('ramps smoothly through dawn and dusk', () => {
    expect(nightFactor((DAWN_START + DAWN_END) / 2)).toBeCloseTo(0.5);
    expect(nightFactor((DUSK_START + DUSK_END) / 2)).toBeCloseTo(0.5);
    const early = nightFactor(DUSK_START + 0.2); const late = nightFactor(DUSK_END - 0.2);
    expect(early).toBeGreaterThan(0); expect(late).toBeLessThan(1); expect(late).toBeGreaterThan(early);
  });
});

describe('load-shedding blackout', () => {
  it('eases toward the target over the fade window and clamps at the ends', () => {
    expect(advanceBlackout(0, 1, BLACKOUT_FADE_SECONDS / 2)).toBeCloseTo(0.5);
    expect(advanceBlackout(0.5, 1, BLACKOUT_FADE_SECONDS)).toBe(1); // never overshoots
    expect(advanceBlackout(1, 0, BLACKOUT_FADE_SECONDS / 4)).toBeCloseTo(0.75); // power back: same ramp in reverse
    expect(advanceBlackout(0, 1, Infinity)).toBe(1); // the constructor's first apply snaps straight to the grid state
    expect(advanceBlackout(0.4, 0.4, 10)).toBeCloseTo(0.4);
  });

  it('sinks the night sky to near-black at full darkness', () => {
    const lit = sampleSky(23, createSkySample()); const dark = applyBlackout(sampleSky(23, createSkySample()), 1);
    expect(dark.ambientIntensity).toBeLessThan(lit.ambientIntensity * 0.1);
    expect(dark.hemiIntensity).toBeLessThan(lit.hemiIntensity * 0.1);
    expect(dark.sunIntensity).toBeLessThan(lit.sunIntensity * 0.2); // moonless-ish: silhouettes only
    expect(dark.sky.getHex()).toBeLessThan(0x050505); // no urban glow left on the sky dome
    expect(dark.fog.getHex()).toBeLessThan(0x050505);
    expect(dark.ambientIntensity).toBeGreaterThan(0); // not a literal void — shapes stay barely readable
  });

  it('leaves an unaffected sample untouched at zero darkness', () => {
    const lit = sampleSky(12, createSkySample()); const same = applyBlackout(sampleSky(12, createSkySample()), 0);
    expect(same.hemiIntensity).toBe(lit.hemiIntensity);
    expect(same.sky.getHex()).toBe(lit.sky.getHex());
  });
});

describe('sun path', () => {
  it('rises through the day and drops below the horizon at night', () => {
    const direction = new THREE.Vector3();
    expect(sunDirection(12, direction).y).toBeGreaterThan(0.5);
    expect(sunDirection(0, direction).y).toBeLessThan(0);
    expect(sunDirection(12, direction).length()).toBeCloseTo(1);
    // moon (hour + 12) mirrors the sun: exactly one body is up at noon and midnight
    expect(sunDirection(24, direction).y).toBeLessThan(sunDirection(12, direction).y);
  });
});

describe('light pool assignment', () => {
  it('selects the N nearest points ordered by ascending distance', () => {
    const xz = Float32Array.from([0, 0, 10, 0, 3, 4, 100, 100, -1, -1]);
    const indices: number[] = []; const distances: number[] = [];
    expect(selectNearest(xz, 0, 0, 3, indices, distances)).toBe(3);
    expect(indices.slice(0, 3)).toEqual([0, 4, 2]);
    expect(distances.slice(0, 3)).toEqual([0, 2, 25]);
  });

  it('returns fewer when the pool outnumbers the candidates', () => {
    const xz = Float32Array.from([5, 0, 1, 1, 9, 9, 0, 0]);
    const indices: number[] = []; const distances: number[] = [];
    expect(selectNearest(xz, 0, 0, 8, indices, distances)).toBe(4);
    expect(indices[0]).toBe(3);
  });

  it('honours the total limit for partially filled buffers', () => {
    const xz = Float32Array.from([5, 0, 1, 1, 0, 0, 0, 0]); // trailing entries are stale
    const indices: number[] = []; const distances: number[] = [];
    expect(selectNearest(xz, 0, 0, 2, indices, distances, 2)).toBe(2);
    expect(indices.slice(0, 2)).toEqual([1, 0]);
  });

  it('tracks a moving focus so lights swap to the new nearest lamps', () => {
    const xz = Float32Array.from([0, 0, 20, 0, 40, 0, 60, 0]);
    const indices: number[] = []; const distances: number[] = [];
    selectNearest(xz, 0, 0, 2, indices, distances);
    expect(indices.slice(0, 2)).toEqual([0, 1]);
    selectNearest(xz, 55, 0, 2, indices, distances);
    expect(indices.slice(0, 2)).toEqual([3, 2]);
  });
});
