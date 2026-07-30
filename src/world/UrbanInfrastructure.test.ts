import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BENCH_SITE_STRIDE, BIN_SITE_STRIDE, HYDRANT_SITE_STRIDE, isBenchSite, isBinSite, isHydrantSite,
  isUtilityRoadsideCandidate, onRoadsideStride, SIGN_CHUNK_SIZE, SIGN_HYSTERESIS, SIGN_VISIBILITY_STEP,
  SIGN_VISIBLE_RANGE, UTILITY_SITE_STRIDE,
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

/**
 * Pavement furniture placement. Benches, bins and hydrants all stand within a tenth of a unit of the
 * same line behind the walk line, so two of them on one roadside point is one prop inside another —
 * which is what shipped: hydrants were emitted from the BENCH site list, 0.05u away, so every single
 * hydrant was buried in a bench. Separate strides are the fix; the pass order is what makes it hold
 * where the strides still coincide.
 */
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

  it('never plants a hydrant on the bench stride — the shipped bug, measured not asserted', () => {
    // The real city has ~25k roadside points; walk that many and count the sites each prop claims.
    const span = 25000;
    const indices = Array.from({ length: span }, (_, index) => index);
    const benches = indices.filter(isBenchSite);
    const bins = indices.filter(isBinSite);
    const hydrants = indices.filter(isHydrantSite);
    expect(benches.length).toBeGreaterThan(1500);
    expect(bins.length).toBeGreaterThan(1200);
    expect(hydrants.length).toBeGreaterThan(1000);

    const shared = (a: number[], b: number[]): number => { const set = new Set(b); return a.filter((index) => set.has(index)).length; };
    // Before the fix this was 100% of hydrants: same stride, same offset, same points.
    expect(shared(hydrants, benches) / hydrants.length).toBeLessThan(0.09);
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
    // The strides interleave but still coincide once every 221st/247th point. What keeps those sites
    // from carrying two props is that isBlocked() consults the prop registry — which only works if
    // the hydrant pass runs after the passes whose props it must respect.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'UrbanInfrastructure.ts'), 'utf8');
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
