import type { NeighbourhoodId } from './neighbourhoods';
import { neighbourhoodForDistrict } from './neighbourhoods';

export type StreetLifeKind = 'kiosk' | 'cafe' | 'workshop' | 'garden' | 'braai' | 'farmstand';

export interface StreetLifeProfile {
  readonly kind: StreetLifeKind;
  /** Source-point stride: a smaller value creates a busier pavement rhythm. */
  readonly stride: number;
  readonly offset: number;
  readonly minRoadWidth: number;
  readonly colours: readonly [number, number, number, number];
}

/**
 * Small street-level silhouettes do more to distinguish a place than another distant tower.
 * These profiles deliberately reuse four primitive instance batches; neighbourhood identity
 * comes from layout, spacing and colour instead of a new draw call or texture per district.
 */
export const STREET_LIFE: Readonly<Record<NeighbourhoodId, StreetLifeProfile>> = {
  'cbd-core': {
    kind: 'kiosk', stride: 27, offset: 5, minRoadWidth: 9,
    colours: [0xf2c521, 0x252b30, 0xd75a36, 0xe7dfcb],
  },
  'creative-core': {
    kind: 'cafe', stride: 25, offset: 11, minRoadWidth: 8,
    colours: [0x2c647e, 0xe0a82f, 0xc95d3f, 0x315c43],
  },
  'inner-city': {
    kind: 'kiosk', stride: 21, offset: 7, minRoadWidth: 8,
    colours: [0xd84a39, 0xf0c432, 0x3a7184, 0xe9e1c9],
  },
  'market-west': {
    kind: 'kiosk', stride: 19, offset: 3, minRoadWidth: 8,
    colours: [0xd58f25, 0x8c2f32, 0x39705e, 0xf1e1bd],
  },
  'bohemian-west': {
    kind: 'cafe', stride: 25, offset: 17, minRoadWidth: 8,
    colours: [0x477864, 0xb6743e, 0x426b91, 0xe1d2ae],
  },
  'rosebank-mixed': {
    kind: 'cafe', stride: 29, offset: 18, minRoadWidth: 9,
    colours: [0x315f6b, 0xc98b38, 0x8b4939, 0xe5dfd0],
  },
  'parktown-ridge': {
    kind: 'garden', stride: 47, offset: 31, minRoadWidth: 9,
    colours: [0x294832, 0x667b50, 0x9b876b, 0xd5cdbb],
  },
  'old-money-ridge': {
    kind: 'garden', stride: 41, offset: 13, minRoadWidth: 8,
    colours: [0x244d34, 0x376b43, 0xd6d0bc, 0x313b3c],
  },
  'industrial-belt': {
    kind: 'workshop', stride: 29, offset: 19, minRoadWidth: 9,
    colours: [0xd38a2c, 0x48606c, 0x7a312d, 0x393c39],
  },
  'joburg-suburbs': {
    kind: 'garden', stride: 37, offset: 23, minRoadWidth: 8,
    colours: [0x315c3f, 0x5f804d, 0xc7ae7e, 0x526365],
  },
  'vaal-township': {
    kind: 'braai', stride: 21, offset: 9, minRoadWidth: 7,
    colours: [0xf1c32d, 0xc74837, 0x34708d, 0xe8dcc0],
  },
  'vaal-marina': {
    kind: 'braai', stride: 27, offset: 15, minRoadWidth: 7,
    colours: [0x3b7892, 0xe0ad3b, 0xd7633e, 0xe9e4d4],
  },
  'vaal-farms': {
    kind: 'farmstand', stride: 43, offset: 29, minRoadWidth: 7,
    colours: [0xa86a35, 0xd5b955, 0x68744d, 0xe0d2a8],
  },
};

export function streetLifeForDistrict(district: string): StreetLifeProfile {
  return STREET_LIFE[neighbourhoodForDistrict(district).id];
}

/** Stable, sparse selection over the deterministic roadside source. */
export function isStreetLifeCandidate(profile: StreetLifeProfile, index: number, roadWidth: number): boolean {
  if (roadWidth < profile.minRoadWidth) return false;
  return ((index + profile.offset) % profile.stride + profile.stride) % profile.stride === 0;
}
