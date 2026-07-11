import { describe, expect, it } from 'vitest';
import { ARREST_DEPLOY_RANGE, ARREST_STOP_SPEED, copHitChance, maxInterceptors, nextUnitMode, POLICE_UNITS_BY_WANTED, policeCarStealable, PURSUIT_RANGE, SHOOT_MIN_WANTED, STANDOFF_RANGE, standoffThrottle, toggleSiren, type UnitSituation } from './PoliceSystem';
import { replanInterval } from './NavGraph';

const onFoot = (overrides: Partial<UnitSituation> = {}): UnitSituation => ({ sighted: true, playerInVehicle: false, distance: 20, speed: 12, crewOut: false, ...overrides });

describe('police unit scaling', () => {
  it('scales max active interceptors with wanted stars', () => {
    expect(maxInterceptors(0)).toBe(0);
    expect(maxInterceptors(1)).toBe(2);
    expect(maxInterceptors(2)).toBe(2);
    expect(maxInterceptors(3)).toBe(4);
    expect(maxInterceptors(4)).toBe(6);
    expect(maxInterceptors(5)).toBe(8);
  });

  it('clamps out-of-range and fractional levels', () => {
    expect(maxInterceptors(-3)).toBe(0);
    expect(maxInterceptors(9)).toBe(POLICE_UNITS_BY_WANTED[5]);
    expect(maxInterceptors(3.9)).toBe(4);
  });

  it('never shrinks the response as heat rises', () => {
    for (let level = 1; level <= 5; level++) expect(maxInterceptors(level)).toBeGreaterThanOrEqual(maxInterceptors(level - 1));
  });

  it('adds persistent-pressure reinforcements only to an active response', () => {
    expect(maxInterceptors(0, 2)).toBe(0);
    expect(maxInterceptors(2, 1)).toBe(3);
    expect(maxInterceptors(5, 9)).toBe(10);
  });
});

describe('police replan cadence', () => {
  it('replans every 1.5-2 seconds with per-unit stagger', () => {
    const intervals = Array.from({ length: 8 }, (_, serial) => replanInterval(serial));
    for (const interval of intervals) { expect(interval).toBeGreaterThanOrEqual(1.5); expect(interval).toBeLessThan(2); }
    expect(new Set(intervals.map((interval) => interval.toFixed(3))).size).toBe(intervals.length);
  });

  it('keeps direct pursuit reserved for close-range line of sight', () => {
    expect(PURSUIT_RANGE).toBeGreaterThan(15);
    expect(PURSUIT_RANGE).toBeLessThan(40);
  });
});

describe('standoff driving', () => {
  it('never throttles inside the standoff ring, regardless of speed', () => {
    expect(standoffThrottle(STANDOFF_RANGE - 2, 0)).toBe(0);
    expect(standoffThrottle(5, 30)).toBe(0);
    expect(standoffThrottle(STANDOFF_RANGE, 0)).toBe(0);
  });

  it('brakes earlier when arriving fast: the stopping envelope grows with speed', () => {
    expect(standoffThrottle(16, 0)).toBeGreaterThan(0);
    expect(standoffThrottle(16, 20)).toBe(0);
  });

  it('ramps back to full pursuit throttle by PURSUIT_RANGE', () => {
    expect(standoffThrottle(PURSUIT_RANGE, 0)).toBe(1);
    expect(standoffThrottle(90, 0)).toBe(1);
  });

  it('is monotonic in distance at rest', () => {
    let previous = 0;
    for (let distance = 0; distance <= 40; distance += 2) { const throttle = standoffThrottle(distance, 0); expect(throttle).toBeGreaterThanOrEqual(previous); previous = throttle; }
  });
});

describe('arrest state machine', () => {
  it('turns a close on-foot sighting into a standoff, never a ram', () => {
    expect(nextUnitMode('drive', onFoot({ distance: 20, speed: 18 }))).toBe('standoff');
  });

  it('deploys the crew only once stopped inside the arrest ring', () => {
    expect(nextUnitMode('standoff', onFoot({ distance: ARREST_DEPLOY_RANGE - 2, speed: ARREST_STOP_SPEED - 2 }))).toBe('arrest');
  });

  it('never bails out at speed or straight from drive', () => {
    expect(nextUnitMode('standoff', onFoot({ distance: 12, speed: 15 }))).toBe('standoff');
    expect(nextUnitMode('drive', onFoot({ distance: 12, speed: 1 }))).toBe('standoff'); // one tick of standoff before deploying
  });

  it('returns to driving when the player boards a vehicle or the sighting is lost', () => {
    expect(nextUnitMode('standoff', onFoot({ playerInVehicle: true, distance: 12, speed: 1 }))).toBe('drive');
    expect(nextUnitMode('standoff', onFoot({ sighted: false }))).toBe('drive');
    expect(nextUnitMode('standoff', onFoot({ distance: PURSUIT_RANGE + 5 }))).toBe('drive');
  });

  it('stays pinned on scene while the crew is deployed, whatever the player does', () => {
    expect(nextUnitMode('arrest', onFoot({ sighted: false, playerInVehicle: true, distance: 80, speed: 0, crewOut: true }))).toBe('arrest');
    expect(nextUnitMode('drive', onFoot({ crewOut: true, distance: 90 }))).toBe('arrest');
  });

  it('releases back to drive once the crew has reboarded', () => {
    expect(nextUnitMode('arrest', onFoot({ sighted: false, distance: 80, crewOut: false }))).toBe('drive');
  });
});

describe('officer marksmanship', () => {
  it('loses accuracy with distance but always keeps a miss and a hit chance', () => {
    expect(copHitChance(4)).toBeGreaterThan(copHitChance(30));
    expect(copHitChance(0)).toBeLessThanOrEqual(0.8);
    expect(copHitChance(500)).toBeGreaterThanOrEqual(0.15);
  });

  it('holds fire below two stars by policy', () => { expect(SHOOT_MIN_WANTED).toBe(2); });
});

describe('cruiser theft and siren', () => {
  const empty = { police: true, occupied: false, wrecked: false, disabled: false, playerControlled: false };

  it('lets the player take a cruiser only when no cop is in it', () => {
    expect(policeCarStealable(empty)).toBe(true);
    expect(policeCarStealable({ ...empty, occupied: true })).toBe(false);
    expect(policeCarStealable({ ...empty, wrecked: true })).toBe(false);
    expect(policeCarStealable({ ...empty, disabled: true })).toBe(false);
    expect(policeCarStealable({ ...empty, playerControlled: true })).toBe(false);
    expect(policeCarStealable({ ...empty, police: false })).toBe(false);
  });

  it('toggles the siren on police cars only', () => {
    expect(toggleSiren({ police: true, sirenOn: false })).toBe(true);
    expect(toggleSiren({ police: true, sirenOn: true })).toBe(false);
    expect(toggleSiren({ police: false, sirenOn: false })).toBe(false);
  });
});
