import { describe, expect, it } from 'vitest';
import {
  isUtilityRoadsideCandidate, SIGN_CHUNK_SIZE, SIGN_HYSTERESIS, SIGN_VISIBILITY_STEP, SIGN_VISIBLE_RANGE,
  UTILITY_SITE_STRIDE,
} from './UrbanInfrastructure';
import type { RoadsidePoint } from './City';

const arterial: RoadsidePoint = { x: 10, z: -4, inwardX: 0, inwardZ: 1, width: 12 };

describe('citywide utility infrastructure placement', () => {
  it('uses a deterministic sparse stride across serviceable streets', () => {
    const chosen = Array.from({ length: UTILITY_SITE_STRIDE * 5 }, (_, index) => index)
      .filter((index) => isUtilityRoadsideCandidate(arterial, index));
    expect(chosen).toEqual([11, 54, 97, 140, 183]);
  });

  it('keeps cabinets off narrow residential lanes and handles negative indices safely', () => {
    expect(isUtilityRoadsideCandidate({ ...arterial, width: 7.99 }, 11)).toBe(false);
    expect(isUtilityRoadsideCandidate(arterial, 11 - UTILITY_SITE_STRIDE)).toBe(true);
    expect(isUtilityRoadsideCandidate(arterial, 12)).toBe(false);
  });
});

describe('readable-sign streaming policy', () => {
  it('uses a fine stable grid with a hysteresis band and sub-cell refresh step', () => {
    expect(SIGN_CHUNK_SIZE).toBeLessThan(SIGN_VISIBLE_RANGE);
    expect(SIGN_HYSTERESIS).toBeLessThan(SIGN_CHUNK_SIZE);
    expect(SIGN_VISIBILITY_STEP).toBeLessThanOrEqual(SIGN_HYSTERESIS);
  });
});
