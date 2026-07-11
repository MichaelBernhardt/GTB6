import { describe, expect, it } from 'vitest';
import { MANICURED_SITES, MANICURED_FOOTPRINTS, RESOLVED_MANICURED_SITES, resolveAnchor } from './manicured';
import { MAP_WORLD_SIZE } from '../mapData';

const HALF = MAP_WORLD_SIZE / 2;

describe('manicured override hooks', () => {
  it('ships at least the one proven example (the stadium bowl)', () => {
    expect(MANICURED_SITES.length).toBeGreaterThanOrEqual(1);
    const bowl = MANICURED_SITES.find((s) => s.generator === 'stadiumBowl');
    expect(bowl, 'a stadiumBowl example exists').toBeDefined();
  });

  it('resolves every shipped site anchor against committed map data', () => {
    for (const site of MANICURED_SITES) expect(resolveAnchor(site.anchor), site.id).toBeDefined();
    expect(RESOLVED_MANICURED_SITES.length).toBe(MANICURED_SITES.length);
  });

  it('places footprints inside the world with a positive keep-out radius', () => {
    for (const site of RESOLVED_MANICURED_SITES) {
      expect(Math.abs(site.x)).toBeLessThan(HALF);
      expect(Math.abs(site.z)).toBeLessThan(HALF);
      expect(site.radius).toBeGreaterThan(0);
    }
    expect(MANICURED_FOOTPRINTS.length).toBe(RESOLVED_MANICURED_SITES.length);
  });

  it('returns undefined for an anchor whose data is missing (no crash, just skipped)', () => {
    expect(resolveAnchor({ kind: 'landmark', name: 'Nonexistent Arena' })).toBeUndefined();
    expect(resolveAnchor({ kind: 'district', name: 'Nowhere-ville' })).toBeUndefined();
  });
});
