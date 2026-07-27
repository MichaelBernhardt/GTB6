import { describe, expect, it } from 'vitest';
import { classifyZone, districtBaseZone, districtZoneSummary, ESTATE_DISTRICTS, HIGHRISE_DISTRICTS, INDUSTRIAL_DISTRICTS } from './zoning';
import { DISTRICT_CENTERS, districtCenter, FARM_POLYGONS, GREEN_POLYGONS, WATER_POLYGONS } from '../mapData';

const center = (name: string) => {
  const found = districtCenter(name);
  if (!found) throw new Error(`missing district ${name}`);
  return found;
};

describe('districtBaseZone (name/density classification)', () => {
  it('reads the CBD as a highrise commercial core', () => {
    expect(districtBaseZone(center('Joburg CBD'))).toBe('commercial-highrise');
  });
  it('flags the curated wealthy districts as estates and the belt as industrial', () => {
    // Was Sandhurst, which the 2/3 crop put outside the bbox. Houghton Estate is the estate the
    // curated list's own doc-comment names, and this map has it.
    expect(districtBaseZone(center('Houghton Estate'))).toBe('estate');
    expect(districtBaseZone(center('Ophirton'))).toBe('industrial');
  });
  it('treats an ordinary low-density suburb as residential', () => {
    expect(districtBaseZone(center('Crosby'))).toBe('residential');
  });
  it('only ever returns non-geometry base zones', () => {
    for (const district of DISTRICT_CENTERS) {
      expect(['estate', 'industrial', 'commercial-highrise', 'residential']).toContain(districtBaseZone(district));
    }
  });
  it('keeps the curated zone lists anchored to real districts (guards against dead data)', () => {
    const live = (names: Iterable<string>) => [...names].filter((name) => districtCenter(name)).length;
    // These lists are a gazetteer of Johannesburg's character, not of whatever a given crop kept. The
    // 2/3 crop dropped 55 of the pre-crop map's 117 districts, taking 10 of the 21 estates with it
    // (Sandhurst, Hyde Park, Illovo, Craighall Park, Strathavon...). "At most 2 absent" would now be
    // asserting the bbox rather than the data.
    //
    // The guard exists to catch DEAD DATA — a typo or a rename that quietly stops classifying
    // anything — so it is restated as the share of the map each list still claims, with the original
    // tolerances translated at the pre-crop district count (117). The crop barely moved those shares:
    // estates were 21/117 = 17.9% of districts and are 11/62 = 17.7%; industrial 6/117 = 5.1%, now
    // 5/62 = 8.1%. A list that went dead would collapse to ~0 and still fail.
    expect(live(ESTATE_DISTRICTS) / DISTRICT_CENTERS.length).toBeGreaterThanOrEqual((ESTATE_DISTRICTS.size - 2) / 117);
    expect(live(INDUSTRIAL_DISTRICTS) / DISTRICT_CENTERS.length).toBeGreaterThanOrEqual((INDUSTRIAL_DISTRICTS.size - 3) / 117);
    // Every skyline core must still exist, and Sandton is the ONLY one the crop is allowed to have
    // taken — named explicitly so the assertion tightens itself again the day it comes back.
    expect([...HIGHRISE_DISTRICTS].filter((name) => !districtCenter(name))).toEqual(['Sandton']);
  });
});

describe('classifyZone (per-point geometry + character)', () => {
  it('leaves water, parks and airports unbuilt (none)', () => {
    const water = WATER_POLYGONS[0]!;
    expect(classifyZone(water.cx, water.cz)).toBe('none');
    const park = GREEN_POLYGONS[0]!;
    expect(classifyZone(park.cx, park.cz)).toBe('none');
  });
  it('classifies farmland as rural corridor', () => {
    const farm = FARM_POLYGONS[0]!;
    expect(classifyZone(farm.cx, farm.cz)).toBe('rural');
  });
  it('promotes a wide arterial in a dense suburb to a commercial strip', () => {
    // find a residential-base district (clear of exclusion polygons) with enough density for a strip
    const dense = DISTRICT_CENTERS.find((d) => d.density >= 60 && districtBaseZone(d) === 'residential' && classifyZone(d.x, d.z, 6) === 'residential');
    expect(dense, 'a dense residential district exists').toBeDefined();
    expect(classifyZone(dense!.x, dense!.z, 6)).toBe('residential');       // narrow street: still houses
    expect(classifyZone(dense!.x, dense!.z, 16)).toBe('commercial-strip'); // arterial frontage: retail strip
  });
  it('keeps the CBD highrise regardless of road width', () => {
    const cbd = center('Joburg CBD');
    // (unless the exact centre sits in a park polygon, which it does not here)
    expect(classifyZone(cbd.x, cbd.z, 6)).toBe('commercial-highrise');
    expect(classifyZone(cbd.x, cbd.z, 16)).toBe('commercial-highrise');
  });
});

describe('districtZoneSummary', () => {
  it('classifies every district exactly once', () => {
    const summary = districtZoneSummary();
    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    expect(total).toBe(DISTRICT_CENTERS.length);
    expect(summary.residential ?? 0).toBeGreaterThan(0);
    expect(summary.estate ?? 0).toBeGreaterThan(0);
    expect(summary['commercial-highrise'] ?? 0).toBeGreaterThan(0);
  });
});
