import { describe, expect, it } from 'vitest';
import { maxInterceptors, POLICE_UNITS_BY_WANTED, PURSUIT_RANGE } from './PoliceSystem';
import { replanInterval } from './NavGraph';

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
