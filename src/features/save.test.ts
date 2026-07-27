import { describe, expect, it } from 'vitest';
import { sanitizeFeatureBlob, sanitizeFeatureSaves } from './save';

describe('sanitizeFeatureBlob', () => {
  it('keeps JSON-safe data intact', () => {
    const value = { litres: 38.5, station: 'Brixton', visited: ['a', 'b'], open: true, note: null };
    expect(sanitizeFeatureBlob(value)).toEqual(value);
  });

  it('drops functions, symbols and non-finite numbers — localStorage is attacker-writable', () => {
    expect(sanitizeFeatureBlob({ fn: () => 1, bad: NaN, worse: Infinity, good: 2 })).toEqual({ good: 2 });
  });

  it('refuses prototype-polluting keys', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as unknown;
    const clean = sanitizeFeatureBlob(parsed) as Record<string, unknown>;
    expect(clean).toEqual({ safe: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('bounds depth, array length, key count and string length so a hostile save cannot hang the load', () => {
    let deep: unknown = 'floor';
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(sanitizeFeatureBlob(deep)).length).toBeLessThan(100);
    expect((sanitizeFeatureBlob(new Array(5000).fill(1)) as unknown[]).length).toBe(512);
    expect(Object.keys(sanitizeFeatureBlob(Object.fromEntries(new Array(200).fill(0).map((_, i) => [`k${i}`, i]))) as object).length).toBe(64);
    expect((sanitizeFeatureBlob('x'.repeat(2000)) as string).length).toBe(512);
  });
});

describe('sanitizeFeatureSaves', () => {
  it('returns an empty record for a save written before the slot existed', () => {
    expect(sanitizeFeatureSaves(undefined)).toEqual({});
    expect(sanitizeFeatureSaves(null)).toEqual({});
    expect(sanitizeFeatureSaves('nonsense')).toEqual({});
    expect(sanitizeFeatureSaves([1, 2, 3])).toEqual({});
  });

  it('drops slices belonging to features this build does not register', () => {
    // The live registry is empty in Wave 0, so every stored key is unknown by definition.
    expect(sanitizeFeatureSaves({ ghostFeature: { keep: 'me' } })).toEqual({});
  });
});
