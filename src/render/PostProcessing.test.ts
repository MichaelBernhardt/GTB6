import { describe, expect, it } from 'vitest';
import { usesGtao } from './PostProcessing';

describe('post-processing quality budget', () => {
  it('reserves the full-scene GTAO passes for the opt-in Ultra tier', () => {
    expect(usesGtao('medium')).toBe(false);
    expect(usesGtao('high')).toBe(false);
    expect(usesGtao('ultra')).toBe(true);
  });
});
