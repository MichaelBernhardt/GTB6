import { describe, expect, it } from 'vitest';
import { CBD, civilianDisposition, defaultLivingCityState, LivingCitySystem, policeReinforcementModifier, reputationTier, sanitizeLivingCityState, shopPriceMultiplier, witnessDelayMultiplier } from './LivingCitySystem';

describe('LivingCitySystem', () => {
  it('applies CBD events, clamps values, and reports tier crossings', () => {
    const city = new LivingCitySystem();
    expect(city.apply({ kind: 'mugging', district: CBD })).toBeUndefined();
    const crossing = city.apply({ kind: 'civilian-murder', district: CBD });
    expect(crossing).toMatchObject({ previous: 'neutral', current: 'feared' });
    for (let i = 0; i < 20; i++) city.apply({ kind: 'civilian-murder', district: CBD });
    expect(city.district(CBD)).toEqual({ communityStanding: -100, policePressure: 100 });
  });

  it('keeps non-CBD districts neutral in the vertical slice', () => {
    const city = new LivingCitySystem();
    expect(city.apply({ kind: 'civilian-murder', district: 'Sandton' })).toBeUndefined();
    expect(city.district('Sandton')).toEqual({ communityStanding: 0, policePressure: 0 });
  });

  it('applies exclusive mission resolutions and their consequence bundles', () => {
    const protectedCity = new LivingCitySystem(); protectedCity.apply({ kind: 'mission-protected', district: CBD });
    expect(protectedCity.state.joziArmsResolution).toBe('protected');
    expect(protectedCity.district(CBD)).toEqual({ communityStanding: 55, policePressure: 30 });
    const robbedCity = new LivingCitySystem(); robbedCity.apply({ kind: 'mission-robbed', district: CBD });
    expect(robbedCity.state.joziArmsResolution).toBe('robbed');
    expect(robbedCity.district(CBD)).toEqual({ communityStanding: -55, policePressure: 45 });
    const redeemed = new LivingCitySystem();
    for (let index = 0; index < 4; index++) redeemed.apply({ kind: 'civilian-murder', district: CBD });
    redeemed.apply({ kind: 'mission-protected', district: CBD }); expect(redeemed.district(CBD).communityStanding).toBe(55);
  });

  it('maps thresholds to gameplay modifiers exactly', () => {
    expect(reputationTier(-50)).toBe('notorious'); expect(reputationTier(-20)).toBe('feared');
    expect(reputationTier(19)).toBe('neutral'); expect(reputationTier(20)).toBe('known'); expect(reputationTier(50)).toBe('trusted');
    expect(shopPriceMultiplier({ communityStanding: -50, policePressure: 0 })).toBe(1.35);
    expect(shopPriceMultiplier({ communityStanding: 50, policePressure: 0 })).toBe(0.8);
    expect(witnessDelayMultiplier({ communityStanding: -20, policePressure: 0 })).toBe(0.75);
    expect(witnessDelayMultiplier({ communityStanding: 50, policePressure: 0 })).toBe(1.5);
    expect(policeReinforcementModifier({ communityStanding: 0, policePressure: 40 })).toBe(1);
    expect(policeReinforcementModifier({ communityStanding: 0, policePressure: 75 })).toBe(2);
    expect(civilianDisposition({ communityStanding: -50, policePressure: 0 })).toBe('hostile');
    expect(civilianDisposition({ communityStanding: 50, policePressure: 0 })).toBe('supportive');
  });

  it('sanitizes partial and malformed state', () => {
    const state = sanitizeLivingCityState({ districts: { [CBD]: { communityStanding: -999, policePressure: 150 } }, joziArmsResolution: 'maybe' });
    expect(state.districts[CBD]).toEqual({ communityStanding: -100, policePressure: 100 });
    expect(state.districts.Sandton).toEqual(defaultLivingCityState().districts.Sandton);
    expect(state.joziArmsResolution).toBeNull();
  });

  it('lets police pressure cool without erasing reputation', () => {
    const city = new LivingCitySystem(); city.apply({ kind: 'mission-robbed', district: CBD }); city.update(120);
    expect(city.district(CBD).communityStanding).toBe(-55);
    expect(city.district(CBD).policePressure).toBe(44);
  });
});

describe('grid resolution events', () => {
  it('applies exclusive grid resolutions with standing floors, mirroring joziArms', () => {
    const defended = new LivingCitySystem();
    defended.apply({ kind: 'grid-defended', district: CBD });
    expect(defended.state.gridResolution).toBe('defended');
    expect(defended.district(CBD).communityStanding).toBeGreaterThanOrEqual(60);
    expect(defended.district(CBD).policePressure).toBe(25);
    const sold = new LivingCitySystem();
    sold.apply({ kind: 'grid-sold', district: CBD });
    expect(sold.state.gridResolution).toBe('sold');
    expect(sold.district(CBD).communityStanding).toBeLessThanOrEqual(-60);
    expect(sold.district(CBD).policePressure).toBe(40);
  });

  it('sanitizes and round-trips the grid resolution', () => {
    expect(sanitizeLivingCityState({ gridResolution: 'defended' }).gridResolution).toBe('defended');
    expect(sanitizeLivingCityState({ gridResolution: 'nonsense' }).gridResolution).toBeNull();
    expect(sanitizeLivingCityState(undefined).gridResolution).toBeNull();
    const system = new LivingCitySystem();
    system.apply({ kind: 'grid-sold', district: CBD });
    expect(new LivingCitySystem(JSON.parse(JSON.stringify(system.state))).state.gridResolution).toBe('sold');
  });
});
