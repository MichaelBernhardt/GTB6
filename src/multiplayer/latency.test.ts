import { describe, expect, it } from 'vitest';
import { extrapolateVehicle, onlineCorrectionFactor } from './latency';

describe('multiplayer latency smoothing', () => {
  it('does not drag active local prediction toward ordinary stale snapshots', () => {
    expect(onlineCorrectionFactor(2, true, false, false)).toBe(0);
    expect(onlineCorrectionFactor(0.1, false, false, false)).toBe(0);
    expect(onlineCorrectionFactor(2, false, false, false)).toBe(0.35);
  });

  it('immediately applies authoritative discontinuities', () => {
    expect(onlineCorrectionFactor(9, true, false, false)).toBe(1);
    expect(onlineCorrectionFactor(1, true, true, false)).toBe(1);
    expect(onlineCorrectionFactor(1, true, false, true)).toBe(1);
  });

  it('extrapolates vehicles along their authoritative heading', () => {
    expect(extrapolateVehicle(10, 20, 0, 12, 0.25)).toEqual([10, 23]);
    const [x, z] = extrapolateVehicle(10, 20, Math.PI / 2, 8, 0.25);
    expect(x).toBeCloseTo(12); expect(z).toBeCloseTo(20);
  });
});
