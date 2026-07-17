import type { District } from '../types';

export type ReputationTier = 'notorious' | 'feared' | 'neutral' | 'known' | 'trusted';
export type MissionResolution = 'protected' | 'robbed';
export type GridResolution = 'defended' | 'sold';

export interface DistrictState {
  communityStanding: number;
  policePressure: number;
}

export interface LivingCityState {
  districts: Record<District, DistrictState>;
  joziArmsResolution: MissionResolution | null;
  gridResolution: GridResolution | null;
}

export type CityEvent =
  | { kind: 'civilian-assault'; district: District }
  | { kind: 'civilian-murder'; district: District }
  | { kind: 'mugging'; district: District }
  | { kind: 'shop-purchase'; district: District }
  | { kind: 'police-evaded'; district: District }
  | { kind: 'mission-protected'; district: District }
  | { kind: 'mission-robbed'; district: District }
  | { kind: 'grid-defended'; district: District }
  | { kind: 'grid-sold'; district: District };

export interface CityTransition {
  previous: ReputationTier;
  current: ReputationTier;
  state: DistrictState;
}

/** Districts with pre-seeded reputation slots; any other generated district gets a neutral slot on demand. */
export const DISTRICTS: District[] = ['Joburg CBD', 'Sandton', 'Braamfontein', 'Hillbrow', 'Newtown'];
export const CBD: District = 'Joburg CBD';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const neutralDistrict = (): DistrictState => ({ communityStanding: 0, policePressure: 0 });

export function defaultLivingCityState(): LivingCityState {
  return {
    districts: Object.fromEntries(DISTRICTS.map((district) => [district, neutralDistrict()])) as Record<District, DistrictState>,
    joziArmsResolution: null,
    gridResolution: null,
  };
}

export function sanitizeLivingCityState(raw: unknown): LivingCityState {
  const result = defaultLivingCityState();
  if (!raw || typeof raw !== 'object') return result;
  const value = raw as Partial<LivingCityState>;
  for (const district of DISTRICTS) {
    const candidate = value.districts?.[district];
    if (!candidate || typeof candidate !== 'object') continue;
    result.districts[district] = {
      communityStanding: Number.isFinite(candidate.communityStanding) ? clamp(Number(candidate.communityStanding), -100, 100) : 0,
      policePressure: Number.isFinite(candidate.policePressure) ? clamp(Number(candidate.policePressure), 0, 100) : 0,
    };
  }
  if (value.joziArmsResolution === 'protected' || value.joziArmsResolution === 'robbed') result.joziArmsResolution = value.joziArmsResolution;
  if (value.gridResolution === 'defended' || value.gridResolution === 'sold') result.gridResolution = value.gridResolution;
  return result;
}

export function reputationTier(standing: number): ReputationTier {
  if (standing <= -50) return 'notorious';
  if (standing <= -20) return 'feared';
  if (standing >= 50) return 'trusted';
  if (standing >= 20) return 'known';
  return 'neutral';
}

export function shopPriceMultiplier(state: DistrictState): number {
  if (state.communityStanding >= 50) return 0.8;
  if (state.communityStanding >= 20) return 0.9;
  if (state.communityStanding <= -50) return 1.35;
  if (state.communityStanding <= -20) return 1.15;
  return 1;
}

export function witnessDelayMultiplier(state: DistrictState): number {
  if (state.communityStanding >= 50) return 1.5;
  if (state.communityStanding >= 20) return 1.2;
  if (state.communityStanding <= -50) return 0.5;
  if (state.communityStanding <= -20) return 0.75;
  return 1;
}

export function policeReinforcementModifier(state: DistrictState): number {
  if (state.policePressure >= 75) return 2;
  if (state.policePressure >= 40) return 1;
  return 0;
}

export function civilianDisposition(state: DistrictState): 'hostile' | 'afraid' | 'neutral' | 'supportive' {
  if (state.communityStanding <= -50) return 'hostile';
  if (state.communityStanding <= -20) return 'afraid';
  if (state.communityStanding >= 50) return 'supportive';
  return 'neutral';
}

export class LivingCitySystem {
  state: LivingCityState;

  constructor(state: LivingCityState = defaultLivingCityState()) { this.state = sanitizeLivingCityState(state); }

  /** State for any generated district name: unseen districts lazily get a neutral slot. */
  district(district: District): DistrictState { return this.state.districts[district] ??= neutralDistrict(); }

  apply(event: CityEvent): CityTransition | undefined {
    // The vertical slice only changes the CBD. Other districts already have state slots for later expansion.
    if (event.district !== CBD) return undefined;
    const state = this.district(event.district); const previous = reputationTier(state.communityStanding);
    const changes: Record<CityEvent['kind'], [number, number]> = {
      'civilian-assault': [-8, 5], 'civilian-murder': [-18, 12], mugging: [-10, 7],
      'shop-purchase': [1, 0], 'police-evaded': [0, -3], 'mission-protected': [0, 30], 'mission-robbed': [0, 45],
      'grid-defended': [0, 25], 'grid-sold': [0, 40],
    };
    const [standing, pressure] = changes[event.kind];
    state.communityStanding = clamp(state.communityStanding + standing, -100, 100);
    if (event.kind === 'mission-protected') state.communityStanding = Math.max(55, state.communityStanding);
    if (event.kind === 'mission-robbed') state.communityStanding = Math.min(-55, state.communityStanding);
    state.policePressure = clamp(state.policePressure + pressure, 0, 100);
    if (event.kind === 'mission-protected') this.state.joziArmsResolution = 'protected';
    if (event.kind === 'mission-robbed') this.state.joziArmsResolution = 'robbed';
    if (event.kind === 'grid-defended') { this.state.gridResolution = 'defended'; state.communityStanding = Math.max(60, state.communityStanding); }
    if (event.kind === 'grid-sold') { this.state.gridResolution = 'sold'; state.communityStanding = Math.min(-60, state.communityStanding); }
    const current = reputationTier(state.communityStanding);
    return current === previous ? undefined : { previous, current, state: { ...state } };
  }

  /** Long-term pressure cools slowly; standing is deliberately persistent and changes through play. */
  update(dt: number): void {
    const cbd = this.district(CBD);
    cbd.policePressure = clamp(cbd.policePressure - Math.max(0, dt) / 120, 0, 100);
  }
}
