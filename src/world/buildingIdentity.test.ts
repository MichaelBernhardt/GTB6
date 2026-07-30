/**
 * One name per building — the contract behind "exit name doesn't match entry name".
 *
 * The identity module is consumed from BOTH sides (doors.ts prompts, City/model-builder painters),
 * so what these tests really guard is that the two sides can never diverge again: determinism, the
 * routing that keeps a school from being prompted as a mosque, and the sign-atlas budget that the
 * whole scheme sits inside.
 */
import { describe, expect, it } from 'vitest';
import {
  boardText, CAFE_NAMES, COMPLEX_NAMES, HOUSE_NAMES, identityBoardTexts, KERK_NAMES, MALL_NAMES,
  MASJID_NAMES, parcelBuildingName, SAAL_NAMES, scatterBuildingName, SKOOL_NAMES, SPAZA_NAMES,
  VILLA_NAMES, WORKS_NAMES,
} from './buildingIdentity';
import { signAtlasLayout } from './ProceduralMaterials';
import { GENERATED_ROADS } from './mapData';

describe('building identity', () => {
  it('is deterministic: the same building answers the same name every time', () => {
    for (let i = 0; i < 20; i++) {
      expect(parcelBuildingName(120.5 + i, -880.25, 'mixed-use', 'shopfront'))
        .toBe(parcelBuildingName(120.5 + i, -880.25, 'mixed-use', 'shopfront'));
      expect(scatterBuildingName(-4319 + i, -2429, 'mixed-use', 'shopfront', 'spaza-shop'))
        .toBe(scatterBuildingName(-4319 + i, -2429, 'mixed-use', 'shopfront', 'spaza-shop'));
    }
  });

  it('routes each family to its own register', () => {
    expect(SPAZA_NAMES).toContain(parcelBuildingName(10, 10, 'mixed-use', 'shopfront'));
    expect(WORKS_NAMES).toContain(parcelBuildingName(10, 10, 'industrial', 'dock'));
    expect(HOUSE_NAMES).toContain(parcelBuildingName(10, 10, 'suburban', 'porch'));
    expect(VILLA_NAMES).toContain(parcelBuildingName(10, 10, 'estate', 'porch'));
    expect(CAFE_NAMES).toContain(scatterBuildingName(10, 10, 'mixed-use', 'shopfront', 'seafront-bar'));
    expect(MALL_NAMES).toContain(scatterBuildingName(10, 10, 'mixed-use', 'shopfront', 'big-box'));
    expect(COMPLEX_NAMES).toContain(scatterBuildingName(10, 10, 'suburban', 'porch', 'townhouse-row'));
  });

  it('never prompts a church as a mosque or a school as a hall — the civic pool is split by model', () => {
    for (let i = 0; i < 40; i++) {
      expect(KERK_NAMES).toContain(scatterBuildingName(i * 31, -i * 17, 'civic', 'lobby', 'church'));
      expect(MASJID_NAMES).toContain(scatterBuildingName(i * 31, -i * 17, 'civic', 'lobby', 'mosque'));
      expect(SKOOL_NAMES).toContain(scatterBuildingName(i * 31, -i * 17, 'civic', 'lobby', 'school'));
      expect(SAAL_NAMES).toContain(scatterBuildingName(i * 31, -i * 17, 'civic', 'lobby', 'community-hall'));
    }
  });

  it('letters boards in capitals', () => {
    expect(boardText('Sizwe se Spaza')).toBe('SIZWE SE SPAZA');
  });

  it('gives the landmark parcel its landmark name on BOTH sides, not just the prompt', () => {
    // The audit's one surviving disagreement: Ponte Tower's prompt was overridden prompt-side only,
    // so its painted board said RIDGE COURT. The override lives in the identity module now.
    expect(parcelBuildingName(2994, 612, 'downtown', 'lobby')).toBe('Ponte Tower');
    // And an ordinary neighbour still draws from its pool, not the landmark table.
    expect(parcelBuildingName(10, 10, 'downtown', 'lobby')).not.toBe('Ponte Tower');
  });

  it('fits the citywide sign population inside the atlas with real headroom', () => {
    // Census 2026-07-30 (npx tsx tools/qa/sign-atlas-census.ts): 771 distinct sign keys citywide =
    // 398 street names + 73 parcel boards + 275 scattered-model boards + ~25 fixed/interior, against
    // 1023 usable slots. If you GROW a name pool or add a painted sign family, re-run the census and
    // update both constants — an over-budget sign draws as a blank board (never someone else's text),
    // but a blank board on a real building is still a bug.
    const MEASURED_KEYS = 771;
    const MARGIN = 200;
    const { capacity } = signAtlasLayout();
    expect(capacity).toBe(1024);
    expect(MEASURED_KEYS + MARGIN).toBeLessThanOrEqual(capacity - 1);
    // The two inputs the measurement depends on, ratcheted so silent growth trips the test:
    expect(new Set(GENERATED_ROADS.map((road) => road.name)).size).toBeLessThanOrEqual(398);
    expect(identityBoardTexts().length).toBeLessThanOrEqual(84);
  });
});
