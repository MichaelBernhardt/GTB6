import { describe, expect, it } from 'vitest';
import { districtAt } from '../world/City';
import { MISSIONS } from './MissionSystem';
import { SAFEHOUSES } from './SafehouseSystem';
import { SHOPS } from './ShopSystem';
import { buildTeleportTargets, clampToWorld, districtAnchors, resolveTeleport, safePlacement, slugify, WORLD_LIMIT, type TeleportTarget } from './Teleport';

const gazetteer = (): TeleportTarget[] => buildTeleportTargets({
  spawn: [-20, 1, 260],
  districts: districtAnchors(districtAt),
  shops: SHOPS,
  safehouses: SAFEHOUSES,
  missions: MISSIONS,
});

describe('slugify', () => {
  it('lowercases, drops apostrophes and collapses separators to dashes', () => {
    expect(slugify('Joburg CBD')).toBe('joburg-cbd');
    expect(slugify('Pik-’n’-Spray')).toBe('pik-n-spray');
    expect(slugify('  Brixton   Flat ')).toBe('brixton-flat');
    expect(slugify('delivery-run')).toBe('delivery-run');
  });
});

describe('districtAnchors', () => {
  it('derives one anchor per district from the lookup, each landing inside its own district', () => {
    const anchors = districtAnchors(districtAt);
    expect(anchors.map((anchor) => anchor.name).sort()).toEqual(['braamfontein', 'city-deep', 'joburg-cbd', 'sandton', 'zoo-lake']);
    for (const anchor of anchors) expect(slugify(districtAt(anchor.x, anchor.z)), anchor.name).toBe(anchor.name);
  });
});

describe('buildTeleportTargets', () => {
  it('assembles spawn, districts, shops, safehouses and missions from live data', () => {
    const names = gazetteer().map((target) => target.name);
    expect(names).toContain('spawn');
    expect(names).toContain('sandton');
    expect(names).toContain('jozi-arms');
    expect(names).toContain('brixton-flat');
    expect(names).toContain('delivery-run');
    expect(names).toContain('hot-property');
    expect(new Set(names).size).toBe(names.length); // no colliding slugs
  });

  it('keeps the spawn coordinates from the save tuple', () => {
    const spawn = gazetteer().find((target) => target.name === 'spawn');
    expect(spawn).toMatchObject({ x: -20, z: 260, kind: 'spawn' });
  });
});

describe('resolveTeleport', () => {
  const targets = gazetteer();

  it('matches exact names regardless of dashes and spacing', () => {
    expect(resolveTeleport('jozi-arms', targets)?.name).toBe('jozi-arms');
    expect(resolveTeleport('jozi arms', targets)?.name).toBe('jozi-arms');
    expect(resolveTeleport('JOZIARMS', targets)?.name).toBe('jozi-arms');
    expect(resolveTeleport('pik n spray', targets)?.name).toBe('pik-n-spray');
  });

  it('accepts an unambiguous prefix and rejects an ambiguous one', () => {
    expect(resolveTeleport('sand', targets)?.name).toBe('sandton');
    expect(resolveTeleport('brix', targets)?.name).toBe('brixton-flat');
    const ambiguous = resolveTeleport('j', targets); // jozi-arms, joburg-cbd, jan-smuts-garage
    expect(ambiguous).toBeUndefined();
  });

  it('returns undefined for unknown or empty queries', () => {
    expect(resolveTeleport('atlantis', targets)).toBeUndefined();
    expect(resolveTeleport('  ', targets)).toBeUndefined();
  });
});

describe('clampToWorld', () => {
  it('pins coordinates inside the playable boundary', () => {
    expect(clampToWorld(0)).toBe(0);
    expect(clampToWorld(99999)).toBe(WORLD_LIMIT);
    expect(clampToWorld(-99999)).toBe(-WORLD_LIMIT);
  });
});

describe('safePlacement', () => {
  it('keeps a clear spot untouched', () => {
    expect(safePlacement(4, -7, () => false)).toEqual({ x: 4, z: -7, clear: true });
  });

  it('nudges off a blocked disc to the nearest clear ring', () => {
    const blocked = (x: number, z: number): boolean => Math.hypot(x - 10, z - 10) < 4; // building footprint
    const spot = safePlacement(10, 10, blocked);
    expect(spot.clear).toBe(true);
    expect(blocked(spot.x, spot.z)).toBe(false);
    expect(Math.hypot(spot.x - 10, spot.z - 10)).toBeLessThanOrEqual(6.5); // first clear ring, not a random faraway point
  });

  it('reports failure but returns the original mark when everything is blocked', () => {
    expect(safePlacement(0, 0, () => true)).toEqual({ x: 0, z: 0, clear: false });
  });
});
