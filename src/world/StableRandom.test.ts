import { describe, expect, it } from 'vitest';
import { stablePositionRandom, stableWorldFloat } from './StableRandom';

describe('stablePositionRandom', () => {
  it('keeps fixed vectors stable', () => {
    expect(stablePositionRandom(0, 0, 0)).toBe(0.1566575849428773);
    expect(stablePositionRandom(6235.388459760589, 157.25173824159464, 91)).toBe(0.6015236647799611);
    expect(stablePositionRandom(-9600, 9600, 24)).toBe(0.3645835954230279);
  });

  it('canonicalises cross-engine floating-point drift in baked world values', () => {
    expect(stableWorldFloat(3350.349920770089)).toBe(stableWorldFloat(3350.3499207701643));
    expect(stableWorldFloat(-5042.8165272072865)).toBe(stableWorldFloat(-5042.816527207195));
    expect(stableWorldFloat(0.6881794989265484)).toBe(0.6881795);
    expect(Object.is(stableWorldFloat(-1e-10), -0)).toBe(false);
  });

  it('quantises sub-millimetre floating-point drift before hashing', () => {
    const value = stablePositionRandom(3350.349920770089, -5042.8165272072865, 30);
    expect(stablePositionRandom(3350.3499207701643, -5042.816527207195, 30)).toBe(value);
  });

  it('varies by position and salt while remaining in [0, 1)', () => {
    const samples = [
      stablePositionRandom(1, 2, 3),
      stablePositionRandom(1.001, 2, 3),
      stablePositionRandom(1, 2.001, 3),
      stablePositionRandom(1, 2, 4),
    ];
    expect(new Set(samples).size).toBe(samples.length);
    for (const sample of samples) { expect(sample).toBeGreaterThanOrEqual(0); expect(sample).toBeLessThan(1); }
  });
});
