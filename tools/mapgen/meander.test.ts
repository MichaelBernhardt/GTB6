/**
 * The organic-curvature helper for the synthetic roads. Above all it must be DETERMINISTIC
 * (same seed in -> identical polyline out) and must never move pinned junction attachment
 * points, so connectivity survives.
 */
import { describe, expect, it } from 'vitest';
import { fbm, meanderPolyline, nameSeed } from './meander';
import type { Pt } from './types';

/** A long straight south-north line to bend. */
function straightLine(n: number, len: number): Pt[] {
  return Array.from({ length: n }, (_, i) => ({ x: 0, z: (i / (n - 1)) * len }));
}

const OPT = { amplitude: 200, wavelength: 2000, octaves: 3, seed: 42, step: 80, taper: 200, chaikin: 2 };

describe('meanderPolyline', () => {
  it('is deterministic: identical inputs give identical output', () => {
    const line = straightLine(6, 5000);
    const pins = [0, 5];
    const a = meanderPolyline(line, pins, OPT);
    const b = meanderPolyline(line, pins, OPT);
    expect(a).toEqual(b);
  });

  it('changes with the seed', () => {
    const line = straightLine(6, 5000);
    const a = meanderPolyline(line, [0, 5], { ...OPT, seed: 1 });
    const b = meanderPolyline(line, [0, 5], { ...OPT, seed: 2 });
    expect(a.map((v) => v.p.x)).not.toEqual(b.map((v) => v.p.x));
  });

  it('keeps pinned vertices exactly in place', () => {
    const line = straightLine(7, 6000);
    const pins = [0, 3, 6];
    const out = meanderPolyline(line, pins, OPT);
    // Every emitted pin vertex must sit exactly on its source point.
    for (const v of out) {
      if (v.pin === null) continue;
      expect(v.p).toEqual(line[v.pin]);
    }
    // First and last are always pinned to the endpoints.
    expect(out[0]!.p).toEqual(line[0]);
    expect(out[out.length - 1]!.p).toEqual(line[6]);
  });

  it('actually curves a straight line (densifies + offsets perpendicular)', () => {
    const line = straightLine(6, 5000);
    const out = meanderPolyline(line, [0, 5], OPT);
    expect(out.length).toBeGreaterThan(line.length * 3); // densified
    const maxDeviation = Math.max(...out.map((v) => Math.abs(v.p.x))); // line is at x=0
    expect(maxDeviation).toBeGreaterThan(30); // meaningfully bent
    expect(maxDeviation).toBeLessThanOrEqual(OPT.amplitude + 1); // but bounded by amplitude
  });

  it('fbm stays within roughly [-1, 1] and is repeatable', () => {
    for (let i = 0; i < 50; i++) {
      const v = fbm(7, i * 0.37, 3);
      expect(v).toBeGreaterThanOrEqual(-1.001);
      expect(v).toBeLessThanOrEqual(1.001);
      expect(fbm(7, i * 0.37, 3)).toBe(v);
    }
  });

  it('nameSeed is stable and name-specific', () => {
    expect(nameSeed('Egoli Orbital')).toBe(nameSeed('Egoli Orbital'));
    expect(nameSeed('Egoli Orbital')).not.toBe(nameSeed('Plaaspad'));
  });
});
