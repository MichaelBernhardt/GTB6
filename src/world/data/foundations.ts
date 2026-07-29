import type { NeighbourhoodId } from './neighbourhoods';
import { neighbourhoodForDistrict } from './neighbourhoods';

export type FoundationTreatment = 'vents' | 'mural' | 'garden' | 'hazard';

export interface FoundationIdentity {
  readonly id: NeighbourhoodId;
  readonly wall: number;
  readonly accent: number;
  readonly treatment: FoundationTreatment;
}

/**
 * Retaining walls are unusually visible in hilly Johannesburg. Treating them as part of each
 * neighbourhood's architecture stops sloped blocks becoming one repeated grey podium.
 */
export const FOUNDATION_IDENTITIES: Readonly<Record<NeighbourhoodId, FoundationIdentity>> = {
  'cbd-core': { id: 'cbd-core', wall: 0x7b8180, accent: 0xd1a82f, treatment: 'vents' },
  'creative-core': { id: 'creative-core', wall: 0x81766d, accent: 0x2f7182, treatment: 'mural' },
  'inner-city': { id: 'inner-city', wall: 0x978b7a, accent: 0xb74a38, treatment: 'mural' },
  'market-west': { id: 'market-west', wall: 0xb09a76, accent: 0xd18b28, treatment: 'mural' },
  'bohemian-west': { id: 'bohemian-west', wall: 0x918774, accent: 0x49735b, treatment: 'mural' },
  'old-money-ridge': { id: 'old-money-ridge', wall: 0x797c72, accent: 0x31563a, treatment: 'garden' },
  'industrial-belt': { id: 'industrial-belt', wall: 0x696c68, accent: 0xd19a29, treatment: 'hazard' },
  'joburg-suburbs': { id: 'joburg-suburbs', wall: 0xa29a86, accent: 0x4c684f, treatment: 'garden' },
  'vaal-township': { id: 'vaal-township', wall: 0xb4a682, accent: 0x38718c, treatment: 'mural' },
  'vaal-marina': { id: 'vaal-marina', wall: 0xc9c4b5, accent: 0x3f7284, treatment: 'garden' },
  'vaal-farms': { id: 'vaal-farms', wall: 0x917c60, accent: 0x66734d, treatment: 'garden' },
};

export function foundationIdentityForDistrict(district: string): FoundationIdentity {
  const id = neighbourhoodForDistrict(district).id;
  return FOUNDATION_IDENTITIES[id];
}
