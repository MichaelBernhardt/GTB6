import { describe, expect, it } from 'vitest';
import { IDLE_RPM, distanceGain, engineState, stereoPan } from './AudioMath';

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
