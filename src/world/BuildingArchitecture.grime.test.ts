import { describe, expect, it } from 'vitest';
import {
  glazingBayLayout, GRIME_DECAL_CHANCE, planEntrance, planGrimeDecals, planShopBays,
  type BuildingStyle, type MassingTier,
} from './BuildingArchitecture';
import { GRIME_ATLAS_CELLS, GRIME_TAG_CLASSES, type GrimeTagClass } from './ProceduralMaterials';

const slab = (width: number, depth: number, height: number): MassingTier[] => [
  { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2, y0: 0, y1: height },
];

/** A spread of world positions — the entropy source planGrimeDecals hashes. */
const SEED_POSITIONS: Array<[number, number]> = [];
for (let i = 0; i < 240; i++) SEED_POSITIONS.push([2500 + (i % 16) * 37.5, 2000 + Math.floor(i / 16) * 41.25]);

describe('grime atlas cell table (the layout contract shared with the drop-in generated sheet)', () => {
  it('holds 8 tag cells and 4 grime cells inside the unit square', () => {
    expect(GRIME_ATLAS_CELLS.filter((cell) => cell.kind === 'tag')).toHaveLength(8);
    expect(GRIME_ATLAS_CELLS.filter((cell) => cell.kind === 'grime')).toHaveLength(4);
    for (const cell of GRIME_ATLAS_CELLS) {
      expect(cell.u0).toBeGreaterThanOrEqual(0); expect(cell.u1).toBeLessThanOrEqual(1);
      expect(cell.v0).toBeGreaterThanOrEqual(0); expect(cell.v1).toBeLessThanOrEqual(1);
      expect(cell.u1).toBeGreaterThan(cell.u0); expect(cell.v1).toBeGreaterThan(cell.v0);
      expect(cell.aspect).toBeGreaterThan(0);
    }
  });

  it('keeps every cell clear of the others (no tag bleeding into a neighbour)', () => {
    for (let a = 0; a < GRIME_ATLAS_CELLS.length; a++) for (let b = a + 1; b < GRIME_ATLAS_CELLS.length; b++) {
      const ca = GRIME_ATLAS_CELLS[a]!; const cb = GRIME_ATLAS_CELLS[b]!;
      const overlaps = ca.u0 < cb.u1 - 1e-6 && cb.u0 < ca.u1 - 1e-6 && ca.v0 < cb.v1 - 1e-6 && cb.v0 < ca.v1 - 1e-6;
      expect(overlaps).toBe(false);
    }
  });
});

describe('planGrimeDecals — where the dirt goes', () => {
  it('is a pure function of its inputs (identical plans on identical calls)', () => {
    const tiers = slab(24, 16, 40);
    const entrance = planEntrance(24, 'downtown', tiers);
    const first = planGrimeDecals(tiers, 'downtown', 24, 40, 2513.25, 2087.5, entrance);
    const second = planGrimeDecals(tiers, 'downtown', 24, 40, 2513.25, 2087.5, entrance);
    expect(second).toEqual(first);
  });

  it('decorates only the dirty families — suburbs, estates and the rural belt stay clean', () => {
    const tiers = slab(18, 12, 8);
    for (const style of ['suburban', 'estate', 'rural'] as BuildingStyle[]) {
      for (const [x, z] of SEED_POSITIONS) {
        expect(planGrimeDecals(tiers, style, 18, 8, x, z)).toHaveLength(0);
      }
    }
  });

  it('hits roughly the authored fraction of buildings, with tags and grime both present', () => {
    const tiers = slab(24, 16, 40);
    let decorated = 0; let tags = 0; let grime = 0;
    for (const [x, z] of SEED_POSITIONS) {
      const decals = planGrimeDecals(tiers, 'downtown', 24, 40, x, z);
      if (decals.length > 0) decorated++;
      for (const decal of decals) {
        if (GRIME_ATLAS_CELLS[decal.cell]!.kind === 'tag') tags++; else grime++;
      }
    }
    const fraction = decorated / SEED_POSITIONS.length;
    expect(fraction).toBeGreaterThan(GRIME_DECAL_CHANCE.downtown! - 0.15);
    expect(fraction).toBeLessThan(GRIME_DECAL_CHANCE.downtown! + 0.15);
    expect(tags).toBeGreaterThan(0); expect(grime).toBeGreaterThan(0);
  });

  it('never covers the planned entrance, a shop bay, or a display window', () => {
    const width = 30; const height = 40;
    const tiers = slab(width, 20, height);
    const entrance = planEntrance(width, 'downtown', tiers);
    expect(entrance).toBeDefined();
    const bays = planShopBays(tiers, width, height, 0, 0, entrance);
    expect(bays.length).toBeGreaterThan(0);
    const glazing = glazingBayLayout(width);
    for (const [x, z] of SEED_POSITIONS) {
      // With bays (the shopfronted CBD case): decals clear the entrance and every bay wherever
      // their height band overlaps the blocked feature (the keep-outs are x-bands WITH a height).
      for (const decal of planGrimeDecals(tiers, 'downtown', width, height, x, z, entrance, bays)) {
        if (decal.y - decal.height / 2 < entrance!.height + 0.6) {
          expect(Math.abs(decal.x - entrance!.x)).toBeGreaterThanOrEqual((decal.width + entrance!.width) / 2 + 0.35);
        }
        if (decal.y - decal.height / 2 < 4.2) {
          for (const bay of bays) expect(Math.abs(decal.x - bay.x)).toBeGreaterThanOrEqual((decal.width + bay.width) / 2);
        }
      }
      // Without bays (the hold-out case): spray TAGS clear the glazing strip the City draws
      // instead (soft grime may run behind a window box — the box stands proud and clips it).
      for (const decal of planGrimeDecals(tiers, 'downtown', width, height, x, z, entrance)) {
        if (GRIME_ATLAS_CELLS[decal.cell]!.kind !== 'tag') continue;
        if (decal.y - decal.height / 2 >= 2.9) continue; // above the window band
        for (const window of glazing.positions) {
          expect(Math.abs(decal.x - window)).toBeGreaterThanOrEqual((decal.width + glazing.windowWidth) / 2);
        }
      }
    }
  });

  it('hangs every quad on a real wall, inside the parcel, proud by the decal offset', () => {
    const width = 26; const tiers: MassingTier[] = [ // stepped massing: two front planes
      { minX: -13, maxX: 2, minZ: -9, maxZ: 9, y0: 0, y1: 36 },
      { minX: 2, maxX: 13, minZ: -9, maxZ: 5, y0: 0, y1: 12 },
    ];
    for (const [x, z] of SEED_POSITIONS) {
      for (const decal of planGrimeDecals(tiers, 'dense-residential', width, 36, x, z)) {
        const wall = tiers.find((tier) =>
          decal.x - decal.width / 2 >= tier.minX - 1e-6 && decal.x + decal.width / 2 <= tier.maxX + 1e-6
          && Math.abs(decal.z - 0.035 - tier.maxZ) < 1e-6
          && decal.y + decal.height / 2 <= tier.y1 + 1e-6);
        expect(wall).toBeDefined();
      }
    }
  });

  it('never overlaps two decals on the same building', () => {
    const tiers = slab(34, 22, 60);
    for (const [x, z] of SEED_POSITIONS) {
      const decals = planGrimeDecals(tiers, 'downtown', 34, 60, x, z);
      for (let a = 0; a < decals.length; a++) for (let b = a + 1; b < decals.length; b++) {
        const da = decals[a]!; const db = decals[b]!;
        const clearX = Math.abs(da.x - db.x) >= (da.width + db.width) / 2;
        const clearY = Math.abs(da.y - db.y) >= (da.height + db.height) / 2;
        expect(clearX || clearY).toBe(true);
      }
    }
  });

  /**
   * Two tag bands, not one. The spray-reach band is unchanged; the FASCIA band above it is the
   * graffiti-density pass, and it exists because a shopfronted CBD front is blocked solid from the
   * pavement to 4.2 u by its own bays — the band a writer can actually reach on those buildings is
   * the one over the shop, off the hood. So a tag may top out either in reach (<= 3.36) or on the
   * fascia (<= 8.6); above that only the wash streak, and only on a tall shaft.
   */
  /**
   * THE MIX, which is the other half of the playtest note: "I only saw one, so maybe they already
   * area, but the one I saw was all white." Half the atlas tag cells are monochrome, and the draw
   * used to be uniform over all eight, so half of every wall in the city was white or black at one
   * size in a random gap. The planner now picks a CLASS first (weighted per band) and a cell second.
   *
   * These bounds are wide on purpose. The realised mix is an emergent number — it depends on how
   * many attempts each band lands, which depends on massing, bays and the size ladder — so the test
   * pins the SHAPE (mono is the bulk, pieces are the rare big ones, the ladder and the band skew are
   * the right way round) rather than the exact weights, which are tuned against the citywide census
   * (`npx tsx tools/qa/grime-census.ts`, landing 59.5 / 31.1 / 9.3 across the CBD's 79 k u of
   * downtown frontage — that is the number to re-check after any change here, not this fixture).
   */
  describe('the colour mix on the wall', () => {
    const width = 30; const height = 40;
    const tiers = slab(width, 20, height);
    const entrance = planEntrance(width, 'downtown', tiers);
    const sample = (bays?: ReturnType<typeof planShopBays>) => {
      const count: Record<GrimeTagClass, number> = { mono: 0, colour: 0, piece: 0 };
      const area: Record<GrimeTagClass, number> = { mono: 0, colour: 0, piece: 0 };
      const street: Record<GrimeTagClass, number> = { mono: 0, colour: 0, piece: 0 };
      let tags = 0;
      for (const [x, z] of SEED_POSITIONS) {
        for (const decal of planGrimeDecals(tiers, 'downtown', width, height, x, z, entrance, bays)) {
          if (GRIME_ATLAS_CELLS[decal.cell]!.kind !== 'tag') continue;
          const cls = GRIME_TAG_CLASSES[decal.cell]!;
          tags++; count[cls]++; area[cls] += decal.width * decal.height;
          if (decal.y <= 4.5) street[cls]++;
        }
      }
      return { tags, count, area, street };
    };

    it('makes quick mono handstyles the bulk and pieces the rare exception', () => {
      const { tags, count } = sample();
      expect(tags).toBeGreaterThan(300); // enough of a sample for the shares to mean anything
      expect(count.mono / tags).toBeGreaterThan(0.45);
      expect(count.mono).toBeGreaterThan(count.colour);
      expect(count.colour).toBeGreaterThan(count.piece);
      expect(count.piece / tags).toBeGreaterThan(0.04); // a piece per couple of block faces, not per district
      expect(count.piece / tags).toBeLessThan(0.20);
    });

    it('draws colour bigger than mono and a piece bigger again — 10% of the quads, a fifth of the paint', () => {
      const { count, area } = sample();
      const mean = (cls: GrimeTagClass): number => area[cls] / Math.max(1, count[cls]);
      expect(mean('colour')).toBeGreaterThan(mean('mono') * 1.2);
      expect(mean('piece')).toBeGreaterThan(mean('colour') * 1.2);
    });

    it('clusters quick tags at street level and lifts the big colour onto the fascia', () => {
      // The shopfronted CBD case: bays block the pavement band, so this is the front the owner walks.
      const bays = planShopBays(tiers, width, height, 0, 0, entrance);
      const { count, street } = sample(bays);
      const streetShare = (cls: GrimeTagClass): number => street[cls] / Math.max(1, count[cls]);
      expect(streetShare('mono')).toBeGreaterThan(streetShare('colour'));
      expect(streetShare('colour')).toBeGreaterThan(streetShare('piece'));
      expect(streetShare('piece')).toBeLessThan(0.15);
    });

    it('lands a piece on the WIDEST blank span, never on the offcut beside it', () => {
      // Stepped massing: a 15 u front plane and an 11 u one, both present through the fascia band.
      const stepped: MassingTier[] = [
        { minX: -13, maxX: 2, minZ: -9, maxZ: 9, y0: 0, y1: 36 },
        { minX: 2, maxX: 13, minZ: -9, maxZ: 5, y0: 0, y1: 14 },
      ];
      let pieces = 0;
      for (const [x, z] of SEED_POSITIONS) {
        for (const decal of planGrimeDecals(stepped, 'downtown', 26, 36, x, z)) {
          if (GRIME_TAG_CLASSES[decal.cell] !== 'piece') continue;
          pieces++;
          expect(decal.x + decal.width / 2, 'a piece on the narrow offcut').toBeLessThanOrEqual(2 + 1e-6);
        }
      }
      expect(pieces).toBeGreaterThan(0);
    });
  });

  it('keeps tags in the two reachable bands and upper wash on tall shafts only', () => {
    const short = slab(24, 16, 12); const tall = slab(24, 16, 60);
    for (const [x, z] of SEED_POSITIONS) {
      for (const decal of planGrimeDecals(short, 'mixed-use', 24, 12, x, z)) {
        expect(decal.y + decal.height / 2).toBeLessThanOrEqual(8.61);
      }
      for (const decal of planGrimeDecals(tall, 'downtown', 24, 60, x, z)) {
        const top = decal.y + decal.height / 2;
        const tag = GRIME_ATLAS_CELLS[decal.cell]!.kind === 'tag';
        if (tag) expect(top, 'a tag above the fascia band').toBeLessThanOrEqual(8.61);
        else if (top > 3.4) expect(top, 'a wash streak above the shaft band').toBeLessThanOrEqual(11.01);
      }
    }
  });
});
