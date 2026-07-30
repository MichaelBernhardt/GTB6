import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { describe, expect, it } from 'vitest';
import {
  BENCH_LEG_CENTER, BENCH_SEAT_TOP, BENCH_SITE_STRIDE, BENCH_SLAT_CENTER, BENCH_SLAT_HALF_HEIGHT,
  BENCH_VERGE_DISTANCE, BIN_SITE_STRIDE, BIN_VERGE_DISTANCE, HYDRANT_FLANGE_RADIUS,
  HYDRANT_KERB_DISTANCE, isBenchSite, isBinSite,
  isUtilityRoadsideCandidate, onRoadsideStride, SIGN_CHUNK_SIZE, SIGN_HYSTERESIS, SIGN_VISIBILITY_STEP,
  SIGN_VISIBLE_RANGE, UTILITY_SITE_STRIDE,
} from './UrbanInfrastructure';
import {
  ROADSIDE_OFFSET, SIDEWALK_BAND, SIDEWALK_CENTER, SIDEWALK_INNER_EDGE, SIDEWALK_WIDTH, type RoadsidePoint,
} from './City';
import { ROAD_BUILD_MARGIN } from './mapData';

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
    // shrubs and roadside trees, not just hydrants — by a full kerb height. Kept as a source assertion
    // because vitest never constructs City and nothing else can catch this wiring silently regressing.
    const city = worldFile('City.ts');
    const construction = city.slice(city.indexOf('new UrbanInfrastructure('), city.indexOf('Merging the city blocks'));
    expect(construction).toContain('this.surfaceHeightAt(x, z, preferred)');
    expect(construction).not.toContain('this.sidewalkHeightAt(x, z)');
    // And nothing is left exactly flush: 1cm proud reads as broken, 1cm buried reads as bolted down.
    const bed = Number(/const SURFACE_BED = ([\d.]+);/.exec(worldFile('UrbanInfrastructure.ts'))?.[1]);
    expect(bed).toBeGreaterThan(0);
    expect(bed).toBeLessThan(0.05);
  });

  it('keeps the walkable band and the drawn paving edge the SAME line', () => {
    // This single identity is what makes the honest query correct at the paving edge: inside the band
    // surfaceHeightAt returns the pavement plane and paving is drawn there; outside it, neither. Widening
    // the ribbon without widening the band (or the reverse) reopens the hover the fix closes, silently.
    expect(SIDEWALK_BAND).toBeCloseTo(SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH, 10);
    expect(SIDEWALK_BAND).toBeCloseTo(ROAD_BUILD_MARGIN, 10);
  });

  it('keeps every family\'s GROUND-LEVEL footprint on one side of the paving edge', () => {
    // A single height query per prop cannot serve a footprint that straddles the edge: half of it would
    // stand on the pavement plane and half on grass 0.37 below. These are the half-extents of the geometry
    // that actually touches the ground (not the collider radii, which overstate them 2-4x).
    const families = [
      { label: 'streetlamp collar', kerb: ROADSIDE_OFFSET, half: 0.28 },
      { label: 'hydrant flange', kerb: HYDRANT_KERB_DISTANCE, half: HYDRANT_FLANGE_RADIUS },
      { label: 'bench leg', kerb: BENCH_VERGE_DISTANCE, half: 0.25 },
      { label: 'cabinet plinth', kerb: ROADSIDE_OFFSET + 1.35, half: 0.575 },
    ];
    for (const family of families) {
      const inner = family.kerb - family.half; const outer = family.kerb + family.half;
      const straddles = inner < SIDEWALK_BAND && outer > SIDEWALK_BAND;
      expect(straddles, `${family.label} straddles the paving edge at ${SIDEWALK_BAND}`).toBe(false);
    }
    // The litter bin is the one exception, and it is 1cm of it: the drum's bottom rim spans 3.49..4.01
    // against a 3.50 edge, so ~0.14u of rim tucks 1cm behind the pavement lip. Named here with the measured
    // number rather than hidden in a tolerance — it is invisible, and the alternative is 37cm of daylight
    // under the whole bin. Anything worse than 3cm means the bin has drifted and wants its own decision.
    const binGraze = SIDEWALK_BAND - (BIN_VERGE_DISTANCE - 0.26);
    expect(binGraze).toBeGreaterThan(0);
    expect(binGraze).toBeLessThan(0.03);
  });

  it('stands a bench on its feet and lets a player stand on its seat', () => {
    // The legs used to be pinned at 0.3 with a 0.55u leg, so a bench's feet stopped 0.025u above whatever
    // it was grounded on. And RoundedBoxGeometry does not keep the height you ask for on a thin slab, so
    // the seat top is measured off the real mesh rather than assumed to be 0.11/2 above the slat centre.
    expect(BENCH_LEG_CENTER).toBeCloseTo(0.55 / 2, 10);
    const slat = new RoundedBoxGeometry(2.25, 0.11, 0.16, 2, 0.035);
    slat.computeBoundingBox();
    expect(slat.boundingBox!.max.y).toBeCloseTo(BENCH_SLAT_HALF_HEIGHT, 4);
    expect(BENCH_SLAT_HALF_HEIGHT).toBeLessThan(0.11 / 2); // the trap: asking for 0.11 gets 0.037
    const bed = Number(/const SURFACE_BED = ([\d.]+);/.exec(worldFile('UrbanInfrastructure.ts'))?.[1]);
    expect(BENCH_SEAT_TOP).toBeCloseTo(BENCH_SLAT_CENTER + slat.boundingBox!.max.y - bed, 6);
    // A player must land ON the seat, not on the backrest band the collider height describes. Standing
    // 0.46u above every bench in the city is what an honest grounding does without this.
    expect(BENCH_SEAT_TOP).toBeLessThan(1.1);
    const source = worldFile('UrbanInfrastructure.ts');
    expect(source).toContain('standHeight: BENCH_SEAT_TOP');
  });
});

describe('pavement furniture strides', () => {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

  it('gives each prop its own stride, pairwise co-prime with the others', () => {
    const strides = { bench: BENCH_SITE_STRIDE, bin: BIN_SITE_STRIDE, cabinet: UTILITY_SITE_STRIDE };
    const named = Object.entries(strides);
    expect(new Set(Object.values(strides)).size, 'two props sharing a stride share their sites').toBe(named.length);
    for (let a = 0; a < named.length; a++) {
      for (let b = a + 1; b < named.length; b++) {
        const [nameA, strideA] = named[a]!; const [nameB, strideB] = named[b]!;
        expect(gcd(strideA, strideB), `${nameA} (${strideA}) and ${nameB} (${strideB}) must be co-prime so their rhythms interleave`).toBe(1);
      }
    }
  });

  it('keeps the two amenity rhythms interleaved down a street', () => {
    // The real city has ~22k roadside points; walk that many and count the sites each prop claims.
    const span = 25000;
    const indices = Array.from({ length: span }, (_, index) => index);
    const benches = indices.filter(isBenchSite);
    const bins = indices.filter(isBinSite);
    expect(benches.length).toBeGreaterThan(1500);
    expect(bins.length).toBeGreaterThan(1200);
    const shared = (a: number[], b: number[]): number => { const set = new Set(b); return a.filter((index) => set.has(index)).length; };
    expect(shared(benches, bins) / benches.length).toBeLessThan(0.07);
    // Co-prime strides cannot avoid every coincidence — the residual is what the pass order handles.
    expect(shared(benches, bins)).toBeGreaterThan(0);
  });

  it('reads strides identically on either side of the origin', () => {
    for (const site of [isBenchSite, isBinSite]) {
      const stride = site === isBenchSite ? BENCH_SITE_STRIDE : BIN_SITE_STRIDE;
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
    // And the hydrant pass must guard its OWN spot, not the station point it was offset from.
    const pass = source.slice(source.indexOf('private buildFireHydrants'), source.indexOf('private buildLitterBins'));
    expect(pass, 'the hydrant guard must test the hydrant position').toContain('this.isBlocked(x, z,');
    expect(pass).toContain('this.isRoad(x, z,');
  });

  it('separates two hydrants by a distance a player would call separate', () => {
    // The 1.2u spacedFrom() this replaced was a coincident-point dedupe wearing a separation guard's
    // clothes: 1.2u is barely wider than one hydrant, so the closest legal pair (measured at 1.2047u in
    // the CBD) was a visible twin. Nothing had escaped the guard; the guard promised nothing.
    const source = worldFile('UrbanInfrastructure.ts');
    const separation = Number(/const HYDRANT_MIN_SEPARATION = ([\d.]+);/.exec(source)?.[1]);
    expect(separation).toBeGreaterThan(4 * (HYDRANT_KERB_DISTANCE + HYDRANT_FLANGE_RADIUS));
    const pass = source.slice(source.indexOf('private buildFireHydrants'), source.indexOf('private buildLitterBins'));
    expect(pass, 'a linear scan over ~4,900 placements is 12M comparisons').not.toContain('spacedFrom(');
    expect(pass).toContain('farEnoughFromOtherHydrants(x, z)');
  });
});

describe('readable-sign streaming policy', () => {
  it('uses a fine stable grid with a hysteresis band and sub-cell refresh step', () => {
    expect(SIGN_CHUNK_SIZE).toBeLessThan(SIGN_VISIBLE_RANGE);
    expect(SIGN_HYSTERESIS).toBeLessThan(SIGN_CHUNK_SIZE);
    expect(SIGN_VISIBILITY_STEP).toBeLessThanOrEqual(SIGN_HYSTERESIS);
  });
});
