import type { VehicleKind } from '../../config';
import {
  AMBIENT_NPC_CHARACTER_IDS,
  type NpcCharacterId,
} from '../../entities/NpcCatalog';
import type { BuildingStyle } from '../BuildingArchitecture';

/**
 * A district name says where the player is; a neighbourhood profile says what that place feels like.
 *
 * The profile deliberately points at assets the game already owns. Facade pools select from the same
 * twelve generated atlases, vehicle fleets select from the existing garage, and pedestrian casts
 * select from the eight ambient rigs. That gives adjoining districts a coherent visual language
 * without adding a texture, material family, draw call, or download.
 */
export type NeighbourhoodId =
  | 'cbd-core'
  | 'creative-core'
  | 'inner-city'
  | 'market-west'
  | 'bohemian-west'
  | 'rosebank-mixed'
  | 'parktown-ridge'
  | 'old-money-ridge'
  | 'industrial-belt'
  | 'joburg-suburbs'
  | 'vaal-township'
  | 'vaal-marina'
  | 'vaal-farms';

interface FacadePools {
  /** Downtown and mixed-use towers (facade atlas indices 0..5). */
  tower: readonly number[];
  /** Dense residential can bridge masonry towers and house-scale atlases (indices 4..9). */
  dense: readonly number[];
  /** Suburban, estate and rural buildings (indices 6..9). */
  house: readonly number[];
  /** Corrugated factory grammars (indices 10..11). */
  factory: readonly number[];
}

export interface NeighbourhoodProfile {
  readonly id: NeighbourhoodId;
  readonly label: string;
  readonly tagline: string;
  readonly facades: FacadePools;
  /** Shifts massing families coherently while retaining each building style's own modulo. */
  readonly architectureOffset: number;
  /** Arrays are intentionally weighted: a repeated entry is a common face or vehicle. */
  readonly pedestrians: readonly NpcCharacterId[];
  readonly traffic: readonly VehicleKind[];
  readonly trafficColours: readonly number[];
}

const ALL_AMBIENT = [...AMBIENT_NPC_CHARACTER_IDS] as const;
const CBD_COLOURS = [0x586b78, 0xb86548, 0xc8c7be, 0x65706f] as const;
const CREATIVE_COLOURS = [0xb54f37, 0x325f8e, 0xe0a82f, 0x5f6954] as const;
const INNER_COLOURS = [0xc7c2ad, 0x7f5141, 0x65777a, 0xa97942] as const;
const MARKET_COLOURS = [0x8b3937, 0xc99b3c, 0xe5dfcc, 0x456b63] as const;
const WEST_COLOURS = [0x537360, 0xb98045, 0x52799a, 0xd1c4a4] as const;
const ROSEBANK_COLOURS = [0x2f3940, 0xd8d5ca, 0x8e4e39, 0x356c78] as const;
const PARKTOWN_COLOURS = [0x354046, 0x8b765d, 0xd5d0c1, 0x4d6144] as const;
const RIDGE_COLOURS = [0x262c31, 0xd9d8d2, 0x82888d, 0x365363] as const;
const INDUSTRIAL_COLOURS = [0xe0dfd4, 0xb98738, 0x466378, 0x696b64] as const;
const SUBURB_COLOURS = [0xc9bf9e, 0x8d5a43, 0x6e8588, 0x4f6a54] as const;
const TOWNSHIP_COLOURS = [0xe0d8bd, 0x3c6884, 0xb44f37, 0xd29b31] as const;
const MARINA_COLOURS = [0xe5e2d5, 0x477890, 0x78918b, 0xb86d3e] as const;
const FARM_COLOURS = [0xc5b78d, 0x65735b, 0x9a6542, 0xddd6bb] as const;

export const NEIGHBOURHOODS: Readonly<Record<NeighbourhoodId, NeighbourhoodProfile>> = {
  'cbd-core': {
    id: 'cbd-core',
    label: 'Jozi Core',
    tagline: 'Gold towers, impatient robots and somebody double-parked.',
    facades: { tower: [0, 1, 3, 5], dense: [4, 5, 6], house: [6, 7, 8], factory: [10] },
    architectureOffset: 0,
    // Keep the complete round-robin at the opening spawn: every downloaded ambient rig is exercised
    // immediately, while the more opinionated casts below take over as the player travels.
    pedestrians: ALL_AMBIENT,
    traffic: ['taxi', 'compact', 'taxi', 'sport', 'motorbike', 'courier', 'van'],
    trafficColours: CBD_COLOURS,
  },
  'creative-core': {
    id: 'creative-core',
    label: 'Creative Mile',
    tagline: 'Students, studios and one generator too many.',
    facades: { tower: [2, 4, 2, 3], dense: [4, 6, 9], house: [6, 9, 7], factory: [11, 10] },
    architectureOffset: 2,
    pedestrians: ['braamfontein-creative', 'newtown-producer', 'maboneng-courier', 'melville-creative', 'braamfontein-creative'],
    traffic: ['compact', 'courier', 'taxi', 'motorbike', 'compact', 'bicycle'],
    trafficColours: CREATIVE_COLOURS,
  },
  'inner-city': {
    id: 'inner-city',
    label: 'High-Density Jozi',
    tagline: 'Towers, taxis and absolutely no personal space.',
    facades: { tower: [4, 5, 0, 4], dense: [4, 5, 6, 4], house: [6, 9, 7], factory: [10, 11] },
    architectureOffset: 4,
    pedestrians: ['newtown-producer', 'maboneng-courier', 'braamfontein-creative', 'fordsburg-restaurateur', 'newtown-producer'],
    traffic: ['taxi', 'taxi', 'compact', 'van', 'taxi', 'motorbike'],
    trafficColours: INNER_COLOURS,
  },
  'market-west': {
    id: 'market-west',
    label: 'Market Quarter',
    tagline: 'Curry, commerce and Olympic-level double-parking.',
    facades: { tower: [2, 4, 2], dense: [6, 9, 4], house: [6, 7, 9], factory: [11] },
    architectureOffset: 1,
    pedestrians: ['fordsburg-restaurateur', 'fordsburg-restaurateur', 'newtown-producer', 'maboneng-courier', 'sandton-professional'],
    traffic: ['taxi', 'van', 'compact', 'taxi', 'motorbike', 'courier'],
    trafficColours: MARKET_COLOURS,
  },
  'bohemian-west': {
    id: 'bohemian-west',
    label: 'West Rand Bohemia',
    tagline: 'Coffee, cottages and philosophical potholes.',
    facades: { tower: [2, 3], dense: [6, 9, 7], house: [6, 9, 7, 6], factory: [11, 10] },
    architectureOffset: 5,
    pedestrians: ['melville-creative', 'braamfontein-creative', 'parkhurst-architect', 'newtown-producer', 'melville-creative'],
    traffic: ['compact', 'motorbike', 'courier', 'compact', 'bicycle', 'van'],
    trafficColours: WEST_COLOURS,
  },
  'rosebank-mixed': {
    id: 'rosebank-mixed',
    label: 'Rosebank Rise',
    tagline: 'Glass, brunch and parking validated for seven minutes.',
    facades: { tower: [1, 3, 5, 1], dense: [5, 7, 8, 5], house: [7, 8, 9], factory: [10, 11] },
    architectureOffset: 11,
    pedestrians: ['sandton-professional', 'rosebank-athlete', 'parkhurst-architect', 'maboneng-courier', 'sandton-professional'],
    traffic: ['sport', 'compact', 'courier', 'compact', 'superbike', 'taxi'],
    trafficColours: ROSEBANK_COLOURS,
  },
  'parktown-ridge': {
    id: 'parktown-ridge',
    label: 'Parktown Ridge',
    tagline: 'Stone walls, jacarandas and security armed with a clipboard.',
    facades: { tower: [0, 1, 3], dense: [5, 7, 8], house: [8, 7, 8, 9], factory: [10] },
    architectureOffset: 13,
    pedestrians: ['parkhurst-architect', 'sandton-professional', 'rosebank-athlete', 'melville-creative', 'parkhurst-architect'],
    traffic: ['compact', 'van', 'sport', 'compact', 'motorbike', 'van'],
    trafficColours: PARKTOWN_COLOURS,
  },
  'old-money-ridge': {
    id: 'old-money-ridge',
    label: 'Jacaranda Ridge',
    tagline: 'Boom gates, old money and suspiciously quiet pavements.',
    facades: { tower: [1, 3, 0], dense: [7, 8, 5], house: [7, 8, 7], factory: [10] },
    architectureOffset: 6,
    pedestrians: ['sandton-professional', 'rosebank-athlete', 'parkhurst-architect', 'sandton-professional', 'melville-creative'],
    traffic: ['sport', 'compact', 'compact', 'van', 'superbike', 'sport'],
    trafficColours: RIDGE_COLOURS,
  },
  'industrial-belt': {
    id: 'industrial-belt',
    label: 'Reef Works',
    tagline: 'Mine dust, panelbeaters and bakkies working overtime.',
    facades: { tower: [3, 5], dense: [5, 6], house: [8, 9], factory: [10, 10, 11] },
    architectureOffset: 3,
    pedestrians: ['newtown-producer', 'maboneng-courier', 'fordsburg-restaurateur', 'parkhurst-architect'],
    traffic: ['van', 'van', 'compact', 'taxi', 'courier', 'motorbike'],
    trafficColours: INDUSTRIAL_COLOURS,
  },
  'joburg-suburbs': {
    id: 'joburg-suburbs',
    label: 'Jozi Suburbs',
    tagline: 'Stoep life, security gates and municipal surprises.',
    facades: { tower: [0, 2, 4], dense: [6, 7, 8, 9], house: [6, 7, 8, 9], factory: [10, 11] },
    architectureOffset: 7,
    pedestrians: ALL_AMBIENT,
    traffic: ['compact', 'taxi', 'van', 'compact', 'motorbike', 'sport'],
    trafficColours: SUBURB_COLOURS,
  },
  'vaal-township': {
    id: 'vaal-township',
    label: 'Vaal Kasi',
    tagline: 'Taxi ranks, tuck shops and football in the road.',
    facades: { tower: [2, 4], dense: [6, 9, 6, 8], house: [6, 9, 8, 6], factory: [11, 10] },
    architectureOffset: 8,
    pedestrians: ['newtown-producer', 'maboneng-courier', 'braamfontein-creative', 'fordsburg-restaurateur', 'newtown-producer'],
    traffic: ['taxi', 'taxi', 'compact', 'van', 'motorbike', 'compact'],
    trafficColours: TOWNSHIP_COLOURS,
  },
  'vaal-marina': {
    id: 'vaal-marina',
    label: 'Vaal Waterfront',
    tagline: 'Boats, braais and a queue home every Sunday.',
    facades: { tower: [0, 3], dense: [7, 8, 5], house: [7, 8, 7, 9], factory: [11, 10] },
    architectureOffset: 9,
    pedestrians: ['rosebank-athlete', 'parkhurst-architect', 'melville-creative', 'sandton-professional', 'maboneng-courier'],
    traffic: ['compact', 'van', 'sport', 'bicycle', 'compact', 'taxi'],
    trafficColours: MARINA_COLOURS,
  },
  'vaal-farms': {
    id: 'vaal-farms',
    label: 'Vaal Plots',
    tagline: 'Dust roads, bait shops and a braai that started yesterday.',
    facades: { tower: [4, 2], dense: [8, 9, 6], house: [8, 7, 9], factory: [11, 11, 10] },
    architectureOffset: 10,
    pedestrians: ['parkhurst-architect', 'fordsburg-restaurateur', 'newtown-producer', 'melville-creative'],
    traffic: ['van', 'compact', 'motorbike', 'van', 'taxi'],
    trafficColours: FARM_COLOURS,
  },
};

const DISTRICTS_BY_PROFILE: Readonly<Record<NeighbourhoodId, readonly string[]>> = {
  'cbd-core': ['Joburg CBD', 'Ferreirasdorp'],
  'creative-core': ['Braamfontein', 'Newtown', 'Maboneng Precinct', 'Cottesloe'],
  'inner-city': ['Hillbrow', 'Berea', 'Yeoville', 'Doornfontein', 'Bertrams', 'Troyeville'],
  'market-west': ['Fordsburg', 'Mayfair', 'Mayfair West', 'Vrededorp'],
  'bohemian-west': ['Melville', 'Brixton', 'Westdene', 'Greenside', 'Richmond', 'Rossmore'],
  'rosebank-mixed': ['Birdhaven', 'Dunkeld', 'Melrose', 'Melrose North', 'Parktown North', 'Parkwood'],
  'parktown-ridge': ['Forest Town', 'Houghton Estate', 'Killarney', 'Parktown', 'Riviera', 'Westcliff'],
  'old-money-ridge': ['Abbotsford', 'Emmarentia', 'Oaklands', 'Parkhurst', 'Parkview', 'Saxonwold'],
  'industrial-belt': ['Booysens', 'Crown', 'Langlaagte North', 'Ophirton', 'Paarlshoop', 'Crosby', 'Homestead Park'],
  'joburg-suburbs': ['Franklin Roosevelt Park', 'Hursthill', 'Montgomery Park', 'Montroux'],
  'vaal-township': ['Refengkgotso', 'Mamello', 'Metsimaholo', 'Sonsakker'],
  'vaal-marina': ['Anker Baai', 'Deneys Quay', 'Leboya Baai', 'Misty Bay', 'Vaal Marina Community Center', 'Vaalpunt'],
  'vaal-farms': ['Groenpunt', 'Grooteiland', 'Oranjedorp'],
};

const DISTRICT_PROFILES = new Map<string, NeighbourhoodProfile>();
for (const [id, districts] of Object.entries(DISTRICTS_BY_PROFILE) as Array<[NeighbourhoodId, readonly string[]]>) {
  for (const district of districts) DISTRICT_PROFILES.set(district, NEIGHBOURHOODS[id]);
}

/** Names explicitly curated into a profile. Exported for coverage tests against the generated map. */
export const CURATED_NEIGHBOURHOOD_DISTRICTS: ReadonlySet<string> = new Set(DISTRICT_PROFILES.keys());

/** Unknown future districts get a safe, varied Jozi-suburb identity until deliberately curated. */
export function neighbourhoodForDistrict(district: string): NeighbourhoodProfile {
  return DISTRICT_PROFILES.get(district) ?? NEIGHBOURHOODS['joburg-suburbs'];
}

function positiveModulo(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function facadePool(profile: NeighbourhoodProfile, style: BuildingStyle): readonly number[] {
  if (style === 'industrial') return profile.facades.factory;
  if (style === 'suburban' || style === 'estate' || style === 'rural') return profile.facades.house;
  if (style === 'dense-residential') return profile.facades.dense;
  return profile.facades.tower;
}

/** District-coherent facade atlas selection. Every returned index stays in its style's valid family. */
export function neighbourhoodFacadeIndex(district: string, style: BuildingStyle, variant: number): number {
  const profile = neighbourhoodForDistrict(district);
  const pool = facadePool(profile, style);
  return pool[positiveModulo(variant + profile.architectureOffset, pool.length)]!;
}

/** Coherent silhouette shift; consumers that plan entrances must use the same transformed variant. */
export function neighbourhoodBuildingVariant(district: string, variant: number): number {
  return variant + neighbourhoodForDistrict(district).architectureOffset;
}

export function neighbourhoodPedestrian(district: string, serial: number): NpcCharacterId {
  const cast = neighbourhoodForDistrict(district).pedestrians;
  return cast[positiveModulo(serial, cast.length)]!;
}

export function neighbourhoodTrafficKind(district: string, serial: number): VehicleKind {
  const fleet = neighbourhoodForDistrict(district).traffic;
  return fleet[positiveModulo(serial, fleet.length)]!;
}

export function neighbourhoodTrafficColour(district: string, serial: number): number {
  const colours = neighbourhoodForDistrict(district).trafficColours;
  return colours[positiveModulo(serial, colours.length)]!;
}

export interface NeighbourhoodArrival {
  readonly district: string;
  readonly profile: NeighbourhoodProfile;
}

/**
 * Debounced region crossing. Generated district boundaries are Voronoi edges, so a player circling
 * one junction can technically cross them several times; the broader profile id plus a short settle
 * window turns that geometry into one readable GTA-style arrival instead of notification spam.
 */
export class NeighbourhoodArrivalTracker {
  private candidate?: NeighbourhoodId;
  private candidateDistrict = '';
  private seconds = 0;
  private announced?: NeighbourhoodId;

  constructor(private readonly settleSeconds = 1.25) {}

  update(district: string, dt: number): NeighbourhoodArrival | undefined {
    const profile = neighbourhoodForDistrict(district);
    if (profile.id !== this.candidate) {
      this.candidate = profile.id;
      this.candidateDistrict = district;
      this.seconds = Math.max(0, dt);
    } else {
      this.candidateDistrict = district;
      this.seconds += Math.max(0, dt);
    }
    if (this.seconds < this.settleSeconds || this.announced === profile.id) return undefined;
    this.announced = profile.id;
    return { district: this.candidateDistrict, profile };
  }

  reset(): void {
    this.candidate = undefined;
    this.candidateDistrict = '';
    this.seconds = 0;
    this.announced = undefined;
  }
}
