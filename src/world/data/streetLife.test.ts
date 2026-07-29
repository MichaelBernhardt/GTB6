import { describe, expect, it } from 'vitest';
import { isStreetLifeCandidate, STREET_LIFE, streetLifeForDistrict } from './streetLife';

describe('neighbourhood street-life profiles', () => {
  it('gives trading, leisure, workshop, garden and rural areas recognisable layouts', () => {
    expect(streetLifeForDistrict('Fordsburg').kind).toBe('kiosk');
    expect(streetLifeForDistrict('Melville').kind).toBe('cafe');
    expect(streetLifeForDistrict('Booysens').kind).toBe('workshop');
    expect(streetLifeForDistrict('Houghton Estate').kind).toBe('garden');
    expect(streetLifeForDistrict('Refengkgotso').kind).toBe('braai');
    expect(streetLifeForDistrict('Groenpunt').kind).toBe('farmstand');
  });

  it('keeps every profile sparse, deterministic and off undersized roads', () => {
    for (const profile of Object.values(STREET_LIFE)) {
      const first = profile.stride - profile.offset;
      expect(isStreetLifeCandidate(profile, first, profile.minRoadWidth)).toBe(true);
      expect(isStreetLifeCandidate(profile, first + profile.stride, profile.minRoadWidth)).toBe(true);
      expect(isStreetLifeCandidate(profile, first + 1, profile.minRoadWidth)).toBe(false);
      expect(isStreetLifeCandidate(profile, first, profile.minRoadWidth - 0.01)).toBe(false);
      expect(profile.stride).toBeGreaterThanOrEqual(19);
    }
  });

  it('makes dense market streets livelier than estates and farm roads', () => {
    expect(STREET_LIFE['market-west'].stride).toBeLessThan(STREET_LIFE['old-money-ridge'].stride);
    expect(STREET_LIFE['vaal-township'].stride).toBeLessThan(STREET_LIFE['vaal-farms'].stride);
  });
});
