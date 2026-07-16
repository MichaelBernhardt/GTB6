import { describe, expect, it } from 'vitest';
import { fbm2, RIDGE_CREST, RIDGE_MAX_M, RIDGE_ZERO_X, RIDGE_ZERO_Z, ridgeMetresAt } from './ridge';

describe('northern fractal mountain range (ridge field)', () => {
  it('is deterministic — same point, same metres', () => {
    for (const [x, z] of [[1200, -8600], [-2000, -5000], [6800, -9100]] as const) {
      expect(ridgeMetresAt(x, z)).toBe(ridgeMetresAt(x, z));
    }
  });

  it('is EXACTLY zero south of the gate — the CBD and the whole lower map feel nothing', () => {
    for (let z = RIDGE_ZERO_Z; z <= 9600; z += 400) {
      for (let x = -9600; x <= 9600; x += 400) expect(ridgeMetresAt(x, z)).toBe(0);
    }
    expect(ridgeMetresAt(2913, 5332)).toBe(0); // Joburg CBD
  });

  it('is exactly zero west of the corridor gate (rural corridor and coast untouched)', () => {
    for (let z = -9600; z <= 9600; z += 300) {
      for (let x = -9600; x <= RIDGE_ZERO_X; x += 300) expect(ridgeMetresAt(x, z)).toBe(0);
    }
  });

  it('peaks genuinely tall in the far north, under the hard cap', () => {
    let max = 0; let maxZ = 0;
    for (let z = -9600; z < 0; z += 100) {
      for (let x = -4500; x <= 9600; x += 100) {
        const r = ridgeMetresAt(x, z);
        if (r > max) { max = r; maxZ = z; }
      }
    }
    expect(max).toBeGreaterThan(1000);
    expect(max).toBeLessThanOrEqual(RIDGE_MAX_M);
    expect(maxZ).toBeLessThan(-7000); // the tall core stays by the top edge, off the street grid
  });

  it('intensity grows toward the top edge (foothills south, mountains north)', () => {
    const bandMean = (z0: number, z1: number): number => {
      let sum = 0; let n = 0;
      for (let z = z0; z <= z1; z += 150) for (let x = -4000; x <= 9600; x += 150) { sum += ridgeMetresAt(x, z); n++; }
      return sum / n;
    };
    const north = bandMean(-9500, -8000);
    const south = bandMean(-5500, -4000);
    expect(north).toBeGreaterThan(south * 3);
    expect(south).toBeGreaterThan(0); // ...but the foothills do exist
  });

  it('reads organic along the crest — fBm peaks and saddles, not a constant wall', () => {
    const samples: number[] = [];
    for (let i = 0; i < RIDGE_CREST.length - 1; i++) {
      const a = RIDGE_CREST[i]!; const b = RIDGE_CREST[i + 1]!;
      for (let t = 0; t < 1; t += 0.05) samples.push(ridgeMetresAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
    }
    const tall = samples.filter((r) => r > 300);
    expect(tall.length).toBeGreaterThan(20);
    const mean = tall.reduce((s, v) => s + v, 0) / tall.length;
    const sd = Math.sqrt(tall.reduce((s, v) => s + (v - mean) ** 2, 0) / tall.length);
    expect(sd).toBeGreaterThan(120); // real variation along the top ridge
  });

  it('fbm2 detail noise stays bounded and deterministic', () => {
    for (let i = 0; i < 200; i++) {
      const v = fbm2(99, i * 0.37, i * -0.53);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(fbm2(99, i * 0.37, i * -0.53)).toBe(v);
    }
  });
});
