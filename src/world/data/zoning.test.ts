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
    expect(districtBaseZone(center('Sandhurst'))).toBe('estate');
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
    expect(live(ESTATE_DISTRICTS)).toBeGreaterThanOrEqual(ESTATE_DISTRICTS.size - 2);
    expect(live(HIGHRISE_DISTRICTS)).toBe(HIGHRISE_DISTRICTS.size); // every skyline core must exist
    expect(live(INDUSTRIAL_DISTRICTS)).toBeGreaterThanOrEqual(INDUSTRIAL_DISTRICTS.size - 3);
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
