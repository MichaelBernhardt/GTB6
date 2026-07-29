import { describe, expect, it } from 'vitest';
import { AMBIENT_NPC_CHARACTER_IDS, type NpcCharacterId } from '../../entities/NpcCatalog';
import type { BuildingStyle } from '../BuildingArchitecture';
import { DISTRICT_CENTERS } from '../mapData';
import {
  CURATED_NEIGHBOURHOOD_DISTRICTS,
  NEIGHBOURHOODS,
  NeighbourhoodArrivalTracker,
  neighbourhoodBuildingVariant,
  neighbourhoodFacadeIndex,
  neighbourhoodForDistrict,
} from './neighbourhoods';

describe('neighbourhood identity', () => {
  it('deliberately profiles every district in the cropped playable world', () => {
    const missing = DISTRICT_CENTERS.map((district) => district.name).filter((name) => !CURATED_NEIGHBOURHOOD_DISTRICTS.has(name));
    expect(missing).toEqual([]);
  });

  it('gives representative places recognisably different identities', () => {
    expect(neighbourhoodForDistrict('Joburg CBD').id).toBe('cbd-core');
    expect(neighbourhoodForDistrict('Braamfontein').id).toBe('creative-core');
    expect(neighbourhoodForDistrict('Hillbrow').id).toBe('inner-city');
    expect(neighbourhoodForDistrict('Fordsburg').id).toBe('market-west');
    expect(neighbourhoodForDistrict('Melville').id).toBe('bohemian-west');
    expect(neighbourhoodForDistrict('Dunkeld').id).toBe('old-money-ridge');
    expect(neighbourhoodForDistrict('Booysens').id).toBe('industrial-belt');
    expect(neighbourhoodForDistrict('Refengkgotso').id).toBe('vaal-township');
    expect(neighbourhoodForDistrict('Misty Bay').id).toBe('vaal-marina');
    expect(neighbourhoodForDistrict('Oranjedorp').id).toBe('vaal-farms');
  });

  it('keeps facade choices inside each texture grammar family', () => {
    const styles: BuildingStyle[] = ['downtown', 'mixed-use', 'dense-residential', 'suburban', 'industrial', 'estate', 'rural'];
    for (const district of DISTRICT_CENTERS) {
      for (const style of styles) {
        for (let variant = 0; variant < 24; variant++) {
          const index = neighbourhoodFacadeIndex(district.name, style, variant);
          if (style === 'industrial') expect(index).toBeGreaterThanOrEqual(10);
          else if (style === 'suburban' || style === 'estate' || style === 'rural') {
            expect(index).toBeGreaterThanOrEqual(6);
            expect(index).toBeLessThanOrEqual(9);
          } else if (style === 'dense-residential') {
            expect(index).toBeGreaterThanOrEqual(4);
            expect(index).toBeLessThanOrEqual(9);
          } else {
            expect(index).toBeGreaterThanOrEqual(0);
            expect(index).toBeLessThanOrEqual(5);
          }
        }
      }
    }
  });

  it('uses only real ambient rigs and real vehicle kinds', () => {
    const ambient = new Set<NpcCharacterId>(AMBIENT_NPC_CHARACTER_IDS);
    for (const profile of Object.values(NEIGHBOURHOODS)) {
      expect(profile.pedestrians.length).toBeGreaterThan(0);
      expect(profile.traffic.length).toBeGreaterThan(0);
      expect(profile.trafficColours.length).toBeGreaterThan(0);
      for (const pedestrian of profile.pedestrians) expect(ambient.has(pedestrian)).toBe(true);
      for (const vehicle of profile.traffic) {
        expect(['compact', 'sport', 'van', 'taxi', 'bicycle', 'motorbike', 'courier', 'superbike']).toContain(vehicle);
      }
    }
  });

  it('shifts architecture deterministically without changing a district between streams', () => {
    expect(neighbourhoodBuildingVariant('Hillbrow', 17)).toBe(neighbourhoodBuildingVariant('Hillbrow', 17));
    expect(neighbourhoodBuildingVariant('Hillbrow', 17)).not.toBe(neighbourhoodBuildingVariant('Melville', 17));
  });

  it('announces settled region changes once and ignores same-profile district edges', () => {
    const tracker = new NeighbourhoodArrivalTracker(1);
    expect(tracker.update('Hillbrow', 0.6)).toBeUndefined();
    expect(tracker.update('Berea', 0.5)).toMatchObject({ district: 'Berea', profile: { id: 'inner-city' } });
    expect(tracker.update('Hillbrow', 5)).toBeUndefined();
    expect(tracker.update('Melville', 0.9)).toBeUndefined();
    expect(tracker.update('Melville', 0.11)).toMatchObject({ district: 'Melville', profile: { id: 'bohemian-west' } });
  });
});
