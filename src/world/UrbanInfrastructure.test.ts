import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BENCH_SITE_STRIDE, BENCH_VERGE_DISTANCE, BIN_SITE_STRIDE, BIN_VERGE_DISTANCE, HYDRANT_FLANGE_RADIUS,
  HYDRANT_KERB_DISTANCE, HYDRANT_SITE_STRIDE, isBenchSite, isBinSite, isHydrantSite,
  isUtilityRoadsideCandidate, onRoadsideStride, SIGN_CHUNK_SIZE, SIGN_HYSTERESIS, SIGN_VISIBILITY_STEP,
  SIGN_VISIBLE_RANGE, UTILITY_SITE_STRIDE,
} from './UrbanInfrastructure';
import { ROADSIDE_OFFSET, SIDEWALK_CENTER, SIDEWALK_INNER_EDGE, SIDEWALK_WIDTH, type RoadsidePoint } from './City';

const worldFile = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');

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

/**
 * WHERE PAVEMENT FURNITURE STANDS ACROSS THE PAVEMENT, as a distance beyond the kerb. Two things have
 * gone wrong here, both of them because every pass measured itself from the verge line instead of from
 * the paving:
 *
 *   - benches and hydrants came off the SAME site list 0.05u apart, so every hydrant in the city stood
 *     inside a bench. Separate strides fixed that; this suite proves the separation is now geometric —
 *     the hydrant is a pavement's width away from the bench, whatever the strides do;
 *   - stepping OUTWARD off the verge line walks a prop past the outer edge of the paving the renderer
 *     draws (3.50), so it was grounded on a pavement plane that isn't there and hung a kerb height above
 *     the grass. The hydrant now stands kerbside, wholly inside the drawn paving.
 *
 * UrbanInfrastructure cannot import City's constants (City constructs it — a value import would be a
 * load-time cycle), so it declares the distances as literals. These are the assertions that stop the two
 * from drifting apart.
 */
describe('pavement furniture placement across the pavement', () => {
  it('measures its kerb distances off the same verge line City puts the roadside points on', () => {
    const declared = /const ROADSIDE_LINE = ([\d.]+);/.exec(worldFile('UrbanInfrastructure.ts'))?.[1];
    expect(Number(declared), 'UrbanInfrastructure.ROADSIDE_LINE must be City.ROADSIDE_OFFSET').toBe(ROADSIDE_OFFSET);
    // Benches and bins are where they have always been: the old outward steps off that same line.
    expect(BENCH_VERGE_DISTANCE - ROADSIDE_OFFSET).toBeCloseTo(0.8, 10);
    expect(BIN_VERGE_DISTANCE - ROADSIDE_OFFSET).toBeCloseTo(0.7, 10);
  });

  it('stands the hydrant wholly on paving the renderer actually draws', () => {
    // This is the whole of the hover fix: the height it is grounded at is the pavement's, so there must
    // be pavement under all of it. The paving runs SIDEWALK_INNER_EDGE..+SIDEWALK_WIDTH beyond the kerb.
    expect(HYDRANT_KERB_DISTANCE - HYDRANT_FLANGE_RADIUS).toBeGreaterThan(SIDEWALK_INNER_EDGE);
    expect(HYDRANT_KERB_DISTANCE + HYDRANT_FLANGE_RADIUS).toBeLessThan(SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH);
    // ...and kerbside, on the road half of it, which is where a hydrant belongs and where a player looks.
    expect(HYDRANT_KERB_DISTANCE).toBeLessThan(SIDEWALK_CENTER);
  });

  it('leaves the routed walk line clear', () => {
    // Peds route along SIDEWALK_CENTER. A hydrant embedded in a walking pedestrian was the reason the
    // original placement stepped away from it at all — it just stepped the wrong way.
    expect(SIDEWALK_CENTER - (HYDRANT_KERB_DISTANCE + HYDRANT_FLANGE_RADIUS)).toBeGreaterThan(0.5);
  });

  it('puts a whole pavement between a hydrant and every other roadside prop', () => {
    // The bench/bin/hydrant non-overlap this suite exists for, as geometry rather than as a guard: no
    // coincidence of strides, and no failure of the pass order, can put a hydrant inside any of these.
    const verge = [
      { label: 'streetlamp', distance: ROADSIDE_OFFSET, radius: 0.2 },
      { label: 'litter bin', distance: BIN_VERGE_DISTANCE, radius: 0.34 },
      { label: 'park bench', distance: BENCH_VERGE_DISTANCE, radius: 0.85 },
    ];
    for (const prop of verge) {
      const clearance = (prop.distance - prop.radius) - (HYDRANT_KERB_DISTANCE + HYDRANT_FLANGE_RADIUS);
      expect(clearance, `a hydrant must not reach the ${prop.label} line`).toBeGreaterThan(1);
    }
  });

  it('grounds the streetscape on the surface City actually draws, and beds it in', () => {
    // sidewalkHeightAt is terrain + 0.37 whether or not paving exists at (x, z). Handing that to
    // UrbanInfrastructure floated every prop that stands off the paving — bins, benches, cabinets,
    // shrubs and roadside trees, not just hydrants — by a full kerb height.
    const city = worldFile('City.ts');
    const construction = city.slice(city.indexOf('new UrbanInfrastructure('), city.indexOf('Merging the city blocks'));
    expect(construction).toContain('this.surfaceHeightAt(x, z)');
    expect(construction).not.toContain('this.sidewalkHeightAt(x, z)');
    // And nothing is left exactly flush: 1cm proud reads as broken, 1cm buried reads as bolted down.
    const bed = Number(/const SURFACE_BED = ([\d.]+);/.exec(worldFile('UrbanInfrastructure.ts'))?.[1]);
    expect(bed).toBeGreaterThan(0);
    expect(bed).toBeLessThan(0.05);
  });
});

describe('pavement furniture strides', () => {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

  it('gives each prop its own stride, pairwise co-prime with the others', () => {
    const strides = { bench: BENCH_SITE_STRIDE, bin: BIN_SITE_STRIDE, hydrant: HYDRANT_SITE_STRIDE, cabinet: UTILITY_SITE_STRIDE };
    const named = Object.entries(strides);
    expect(new Set(Object.values(strides)).size, 'two props sharing a stride share their sites').toBe(named.length);
    for (let a = 0; a < named.length; a++) {
      for (let b = a + 1; b < named.length; b++) {
        const [nameA, strideA] = named[a]!; const [nameB, strideB] = named[b]!;
        expect(gcd(strideA, strideB), `${nameA} (${strideA}) and ${nameB} (${strideB}) must be co-prime so their rhythms interleave`).toBe(1);
      }
    }
  });

  it('keeps the three rhythms interleaved down a street, and gives the hydrant the tightest', () => {
    // The real city has ~22k roadside points; walk that many and count the sites each prop claims.
    const span = 25000;
    const indices = Array.from({ length: span }, (_, index) => index);
    const benches = indices.filter(isBenchSite);
    const bins = indices.filter(isBinSite);
    const hydrants = indices.filter(isHydrantSite);
    expect(benches.length).toBeGreaterThan(1500);
    expect(bins.length).toBeGreaterThan(1200);
    // A hydrant is municipal equipment, not an amenity: it must be the commonest thing on the pavement,
    // or a player who wants one has to search the city for it (which is exactly what happened at 19).
    expect(hydrants.length).toBeGreaterThan(benches.length);
    expect(hydrants.length).toBeGreaterThan(bins.length);

    const shared = (a: number[], b: number[]): number => { const set = new Set(b); return a.filter((index) => set.has(index)).length; };
    // Before the fix this was 100% of hydrants: same stride, same offset, same points. Coincidences no
    // longer put one prop inside another (the hydrant is kerbside now) but a low rate keeps a street's
    // furniture spread out rather than bunched.
    expect(shared(hydrants, benches) / hydrants.length).toBeLessThan(0.1);
    expect(shared(hydrants, bins) / hydrants.length).toBeLessThan(0.07);
    expect(shared(benches, bins) / benches.length).toBeLessThan(0.07);
    // Co-prime strides cannot avoid every coincidence — the residual is what the pass order handles.
    expect(shared(hydrants, benches)).toBeGreaterThan(0);
  });

  it('reads strides identically on either side of the origin', () => {
    for (const site of [isBenchSite, isBinSite, isHydrantSite]) {
      const stride = site === isBenchSite ? BENCH_SITE_STRIDE : site === isBinSite ? BIN_SITE_STRIDE : HYDRANT_SITE_STRIDE;
      const offset = Array.from({ length: stride }, (_, index) => index).find(site)!;
      expect(site(offset - stride * 3)).toBe(true);
      expect(site(offset + 1)).toBe(false);
    }
    expect(onRoadsideStride(-43 + 11, UTILITY_SITE_STRIDE, 11)).toBe(true);
  });

  it('places hydrants last, so their guard sees the benches and bins already standing', () => {
    // Belt and braces behind the kerb-distance geometry above: where two roads' points coincide the
    // hydrant's own spot can still land on another prop (a lamp, a cabinet, a bench on a crossing
    // street), and isBlocked() only sees those if the hydrant pass runs after the passes that place them.
    const source = worldFile('UrbanInfrastructure.ts');
    const constructorBody = source.slice(source.indexOf('constructor('), source.indexOf('/** Raise every streetscape root'));
    const at = (call: string): number => {
      const index = constructorBody.indexOf(call);
      expect(index, `expected the constructor to call ${call}`).toBeGreaterThan(-1);
      return index;
    };
    expect(at('this.buildFireHydrants()')).toBeGreaterThan(at('this.buildStreetFurniture()'));
    expect(at('this.buildFireHydrants()')).toBeGreaterThan(at('this.buildLitterBins()'));
    expect(at('this.buildStreetFurniture()')).toBeGreaterThan(at('this.buildUtilityInfrastructure()'));
    // And the hydrant pass must guard its OWN spot, not the roadside point it was offset from.
    const pass = source.slice(source.indexOf('private buildFireHydrants'), source.indexOf('private buildLitterBins'));
    expect(pass, 'the hydrant guard must test the hydrant position').toContain('this.isBlocked(x, z,');
    expect(pass).toContain('this.isRoad(x, z,');
  });
});

describe('readable-sign streaming policy', () => {
  it('uses a fine stable grid with a hysteresis band and sub-cell refresh step', () => {
    expect(SIGN_CHUNK_SIZE).toBeLessThan(SIGN_VISIBLE_RANGE);
    expect(SIGN_HYSTERESIS).toBeLessThan(SIGN_CHUNK_SIZE);
    expect(SIGN_VISIBILITY_STEP).toBeLessThanOrEqual(SIGN_HYSTERESIS);
  });
});
