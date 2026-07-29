import { describe, expect, it } from 'vitest';
import { facadeWindowGrammar, facadeWorldTile, SIGN_NIGHT_EMISSIVE, SIGN_RETRO_BOOST, gennySignEmissiveIntensity, signAtlasLayout, signDiffuseScale, signEmissiveIntensity, signSlotIndex } from './ProceduralMaterials';
import { STREET_SIGN_JUNCTIONS } from './mapData';

describe('facade physical grammars', () => {
  it('uses compact floor tiles for houses and broad tall bays for factories', () => {
    expect(facadeWorldTile(6).height).toBeLessThan(10);
    expect(facadeWorldTile(10).width).toBeGreaterThan(facadeWorldTile(6).width);
    expect(facadeWorldTile(10).height).toBeGreaterThan(facadeWorldTile(6).height);
  });

  it('gives each building family a recognisable window language', () => {
    expect(facadeWindowGrammar(0)).toBe('punched');
    expect(facadeWindowGrammar(1)).toBe('strip');
    expect(facadeWindowGrammar(6)).toBe('barred');
    expect(facadeWindowGrammar(7)).toBe('curtained');
    expect(facadeWindowGrammar(10)).toBe('clerestory');
    expect(facadeWindowGrammar(-1)).toBe('clerestory');
  });
});

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

describe('sign glow ramp (BUG: boards stayed full-bright through load shedding, at any distance)', () => {
  it('glows at full atlas brightness on a healthy-grid night — the unchanged readable look', () => {
    expect(signEmissiveIntensity(1, 0)).toBe(SIGN_NIGHT_EMISSIVE);
  });

  it('sinks with the eased blackout factor and lands fully dark when shedding bites', () => {
    expect(signEmissiveIntensity(1, 0.5)).toBeCloseTo(SIGN_NIGHT_EMISSIVE * 0.5); // mid-fade tracks the same 3s ramp as the sky
    expect(signEmissiveIntensity(1, 1)).toBe(0); // no glow at ANY distance — only the torch/headlights reveal a board
  });

  it('stays off by day, shedding or not (the sun lights the boards through the diffuse face)', () => {
    expect(signEmissiveIntensity(0, 0)).toBe(0);
    expect(signEmissiveIntensity(0, 1)).toBe(0); // daytime load shedding changes nothing, like applyBlackout
  });

  it('keeps the genny boards lit right through a blackout — the forecourt is the lit thing on a dark street', () => {
    // A filling station runs a generator, and a red fuel gauge in a load-shedding night is exactly
    // when the player needs to SEE one. Its pylon board therefore ignores the blackout factor.
    expect(gennySignEmissiveIntensity(1)).toBe(SIGN_NIGHT_EMISSIVE);
    expect(gennySignEmissiveIntensity(1)).toBeGreaterThan(signEmissiveIntensity(1, 1));
    expect(gennySignEmissiveIntensity(1)).toBeGreaterThan(signEmissiveIntensity(1, 0.5));
    expect(gennySignEmissiveIntensity(0)).toBe(0); // still nothing by day — the sun does that job
  });

  it('boosts the diffuse response only in a night blackout — the retro-reflective pop under a beam', () => {
    expect(signDiffuseScale(1, 0)).toBe(1); // normal night: face untouched
    expect(signDiffuseScale(0, 1)).toBe(1); // day: face untouched
    expect(signDiffuseScale(1, 1)).toBeCloseTo(1 + SIGN_RETRO_BOOST);
    expect(signDiffuseScale(1, 0.5)).toBeGreaterThan(1); // ramps in with the same blackout factor, no second clock
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
