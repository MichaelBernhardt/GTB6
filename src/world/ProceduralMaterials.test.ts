import { describe, expect, it } from 'vitest';
import { signAtlasLayout, signSlotIndex } from './ProceduralMaterials';
import { STREET_SIGN_JUNCTIONS } from './mapData';

describe('sign atlas capacity', () => {
  it('holds every unique sign the map needs, with headroom (no wrap-and-overwrite)', () => {
    const names = new Set<string>();
    for (const j of STREET_SIGN_JUNCTIONS) { if (j.roadA) names.add(j.roadA); if (j.roadB) names.add(j.roadB); }
    const { capacity } = signAtlasLayout();
    // ~372 unique street names + the shop/model/vehicle boards (~100). If the atlas can't hold them all it
    // wraps, and early signs (JOZI ARMS, street names) get overwritten with someone else's text.
    expect(capacity).toBeGreaterThan(names.size + 120);
  });
});

describe('signSlotIndex — an allocated slot is never overwritten', () => {
  const { capacity } = signAtlasLayout();

  it('gives each sign a distinct slot until the atlas is full', () => {
    const seen = new Set<number>();
    for (let order = 0; order < capacity - 1; order++) seen.add(signSlotIndex(order, capacity));
    expect(seen.size).toBe(capacity - 1); // all distinct — no two signs share a slot
    expect(signSlotIndex(0, capacity)).toBe(0);
    expect(signSlotIndex(capacity - 2, capacity)).toBe(capacity - 2);
  });

  it('parks every overflow sign on the last slot, never back over slot 0 (which would clobber JOZI ARMS)', () => {
    expect(signSlotIndex(capacity - 1, capacity)).toBe(capacity - 1);
    expect(signSlotIndex(capacity, capacity)).toBe(capacity - 1);
    expect(signSlotIndex(capacity + 9999, capacity)).toBe(capacity - 1);
    expect(signSlotIndex(capacity + 9999, capacity)).not.toBe(0);
  });
});
