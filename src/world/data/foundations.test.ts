import { describe, expect, it } from 'vitest';
import { FOUNDATION_IDENTITIES, foundationIdentityForDistrict } from './foundations';

describe('neighbourhood retaining-wall identity', () => {
  it('changes treatment with the character of the district', () => {
    expect(foundationIdentityForDistrict('Joburg CBD').treatment).toBe('vents');
    expect(foundationIdentityForDistrict('Fordsburg').treatment).toBe('mural');
    expect(foundationIdentityForDistrict('Booysens').treatment).toBe('hazard');
    expect(foundationIdentityForDistrict('Dunkeld').treatment).toBe('vents');
    expect(foundationIdentityForDistrict('Houghton Estate').treatment).toBe('garden');
  });

  it('covers every neighbourhood with valid contrasting colours', () => {
    expect(Object.keys(FOUNDATION_IDENTITIES)).toHaveLength(13);
    for (const identity of Object.values(FOUNDATION_IDENTITIES)) {
      expect(identity.wall).toBeGreaterThanOrEqual(0);
      expect(identity.wall).toBeLessThanOrEqual(0xffffff);
      expect(identity.accent).not.toBe(identity.wall);
    }
  });
});
