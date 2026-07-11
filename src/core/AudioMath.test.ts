import { describe, expect, it } from 'vitest';
import { ENGINE_PROFILES, IDLE_RPM, distanceGain, engineCutoff, engineFrequency, engineLevel, engineProfile, engineState, engineThrob, shiftGlide, stereoPan, trafficEngineGain } from './AudioMath';

describe('engineState', () => {
  it('idles at low rpm when stopped', () => {
    const idle = engineState(0, 40);
    expect(idle.gear).toBe(0);
    expect(idle.rpm).toBeCloseTo(IDLE_RPM, 5);
  });
  it('climbs within a gear then drops rpm after shifting', () => {
    const low = engineState(4, 40); const nearShift = engineState(7.8, 40); const shifted = engineState(8.4, 40);
    expect(nearShift.rpm).toBeGreaterThan(low.rpm);
    expect(shifted.gear).toBe(low.gear + 1);
    expect(shifted.rpm).toBeLessThan(nearShift.rpm);
  });
  it('caps at redline in top gear and ignores reverse sign', () => {
    const top = engineState(80, 40);
    expect(top.gear).toBe(3);
    expect(top.rpm).toBeLessThanOrEqual(1);
    expect(engineState(-10, 40).rpm).toBeCloseTo(engineState(10, 40).rpm, 5);
  });
});

describe('distanceGain', () => {
  it('is full inside the reference radius and silent past max', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(12)).toBe(1);
    expect(distanceGain(150)).toBe(0);
    expect(distanceGain(400)).toBe(0);
  });
  it('falls off monotonically between ref and max', () => {
    const near = distanceGain(30); const mid = distanceGain(80); const far = distanceGain(140);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });
});

describe('engineCutoff', () => {
  it('rises with rpm and opens modestly with throttle', () => {
    expect(engineCutoff(0.6, 0)).toBeGreaterThan(engineCutoff(0.2, 0));
    expect(engineCutoff(0.5, 1)).toBeGreaterThan(engineCutoff(0.5, 0));
  });
  it('stays capped low even at redline full throttle', () => {
    expect(engineCutoff(1, 1)).toBeLessThanOrEqual(950);
    expect(engineCutoff(1, 1, ENGINE_PROFILES.sport.brightness)).toBeLessThanOrEqual(950 * ENGINE_PROFILES.sport.brightness);
  });
  it('scales with the brightness param', () => {
    expect(engineCutoff(0.5, 0.5, 1.3)).toBeGreaterThan(engineCutoff(0.5, 0.5, 0.8));
  });
});

describe('engineThrob', () => {
  it('throbs faster as rpm climbs, tracking the firing order', () => {
    expect(engineThrob(0.8).rate).toBeGreaterThan(engineThrob(IDLE_RPM).rate);
    expect(engineThrob(IDLE_RPM).rate).toBeCloseTo(engineFrequency(IDLE_RPM) * 0.25, 5);
  });
  it('is lumpy at idle and smooths out toward redline, never vanishing', () => {
    expect(engineThrob(IDLE_RPM).depth).toBeGreaterThan(engineThrob(0.9).depth);
    expect(engineThrob(1).depth).toBeGreaterThanOrEqual(0.07);
  });
  it('scales rate with the per-kind throbRate param', () => {
    expect(engineThrob(0.5, 1.3).rate).toBeCloseTo(engineThrob(0.5, 1).rate * 1.3, 5);
  });
});

describe('engineLevel', () => {
  it('keeps the engine a quiet bed even flat-out', () => {
    expect(engineLevel(1, 1, ENGINE_PROFILES.sport.level)).toBeLessThan(0.05);
  });
  it('makes coasting quieter than throttle-on at the same rpm', () => {
    expect(engineLevel(0.6, 0)).toBeLessThan(engineLevel(0.6, 1));
  });
  it('rises monotonically with rpm', () => {
    expect(engineLevel(0.9, 0.5)).toBeGreaterThan(engineLevel(0.3, 0.5));
  });
});

describe('shiftGlide', () => {
  it('glides longer through a gear change than steady tracking', () => {
    expect(shiftGlide(false)).toBeGreaterThan(shiftGlide(true));
  });
});

describe('trafficEngineGain', () => {
  it('falls off much more aggressively than the generic distance gain', () => {
    expect(trafficEngineGain(30)).toBeLessThan(distanceGain(30));
    expect(trafficEngineGain(60)).toBe(0);
    expect(trafficEngineGain(100)).toBe(0);
  });
  it('is full only right next to the vehicle and monotone in between', () => {
    expect(trafficEngineGain(5)).toBe(1);
    expect(trafficEngineGain(15)).toBeGreaterThan(trafficEngineGain(30));
    expect(trafficEngineGain(30)).toBeGreaterThan(trafficEngineGain(50));
  });
});

describe('engineProfile', () => {
  it('falls back to the compact profile for unknown kinds', () => {
    expect(engineProfile('bicycle')).toBe(ENGINE_PROFILES.compact);
    expect(engineProfile()).toBe(ENGINE_PROFILES.compact);
  });
  it('gives the sport kind an angrier voice: higher pitch, brighter, more growl', () => {
    const sport = engineProfile('sport'); const compact = engineProfile('compact');
    expect(sport.basePitch).toBeGreaterThan(compact.basePitch);
    expect(sport.brightness).toBeGreaterThan(compact.brightness);
    expect(sport.growl).toBeGreaterThan(compact.growl);
    expect(sport.throbRate).toBeGreaterThan(compact.throbRate);
  });
  it('keeps every kind quieter than screams and sirens at full send', () => {
    for (const profile of Object.values(ENGINE_PROFILES)) expect(engineLevel(1, 1, profile.level)).toBeLessThan(0.05);
  });
});

describe('stereoPan', () => {
  it('pans hard right for a source to the right of the view', () => {
    expect(stereoPan(0, 0, 0, 10, 0)).toBeCloseTo(1, 5);
    expect(stereoPan(0, 0, 0, -10, 0)).toBeCloseTo(-1, 5);
  });
  it('is centered for sources ahead, behind, or coincident', () => {
    expect(stereoPan(0, 0, 0, 0, -10)).toBeCloseTo(0, 5);
    expect(stereoPan(0, 0, 0, 0, 10)).toBeCloseTo(0, 5);
    expect(stereoPan(5, 5, 1.2, 5, 5)).toBe(0);
  });
  it('rotates with the listener yaw', () => {
    expect(stereoPan(0, 0, Math.PI / 2, 0, -10)).toBeCloseTo(1, 5);
    expect(stereoPan(0, 0, Math.PI / 2, 0, 10)).toBeCloseTo(-1, 5);
  });
});
