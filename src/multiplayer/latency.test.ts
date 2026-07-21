import { describe, expect, it } from 'vitest';
import { extrapolateVehicle } from './latency';

describe('multiplayer latency smoothing', () => {
  it('extrapolates vehicles along their authoritative heading', () => {
    expect(extrapolateVehicle(10, 20, 0, 12, 0.25)).toEqual([10, 23]);
    const [x, z] = extrapolateVehicle(10, 20, Math.PI / 2, 8, 0.25);
    expect(x).toBeCloseTo(12); expect(z).toBeCloseTo(20);
  });
});
