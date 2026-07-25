import { describe, expect, it } from 'vitest';
import { fbm2, RIDGE_CREST, RIDGE_MAX_M, RIDGE_SUMMIT_ARC_M, RIDGE_TAIL_FRACTION, RIDGE_ZERO_X, RIDGE_ZERO_Z, ridgeMetresAt } from './ridge';

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

  it('summits ON the koppie-track cluster, not out past the top edge', () => {
    // The owner asked for the range "pulled down closer to the CBD" and sited "where there are
    // already tracks". The previous cut peaked at z = -8,407 m, north of every highway=track on
    // the map and 76.9% of the world width from the CBD. The summit arc now sits on the
    // Northcliff/Blackheath cluster at roughly m(-4270,-5450), so pin the peak's LOCATION, not
    // just its height — a height-only assertion is what let the peak drift out there.
    let max = 0; let maxX = 0; let maxZ = 0;
    for (let z = -11000; z < 0; z += 100) {
      for (let x = -6000; x <= 4000; x += 100) {
        const r = ridgeMetresAt(x, z);
        if (r > max) { max = r; maxX = x; maxZ = z; }
      }
    }
    expect(max).toBeGreaterThan(1000);
    expect(max).toBeLessThanOrEqual(RIDGE_MAX_M);
    expect(maxZ).toBeGreaterThan(-6800); // south of the shoulder…
    expect(maxZ).toBeLessThan(-4200);    // …and north of the CBD guard
    expect(Math.hypot(maxX, maxZ)).toBeLessThan(8000); // within 8 km of the CBD (projector origin)
  });

  it('rises out of foothills at the toe and is still a massif where it leaves the map', () => {
    const alongCrest = (arc: number): number => {
      // Walk RIDGE_CREST to the requested arc length and sample the crest line there.
      let left = arc;
      for (let i = 0; i < RIDGE_CREST.length - 1; i++) {
        const a = RIDGE_CREST[i]!; const b = RIDGE_CREST[i + 1]!;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (left <= len) return ridgeMetresAt(a.x + ((b.x - a.x) * left) / len, a.z + ((b.z - a.z) * left) / len);
        left -= len;
      }
      const last = RIDGE_CREST[RIDGE_CREST.length - 1]!;
      return ridgeMetresAt(last.x, last.z);
    };
    const toe = alongCrest(600);
    const summit = alongCrest(RIDGE_SUMMIT_ARC_M);
    const exit = alongCrest(RIDGE_SUMMIT_ARC_M + 4200);
    expect(toe).toBeLessThan(summit * 0.35);  // gentle foothills where it meets the city
    expect(toe).toBeGreaterThan(0);           // …but they do exist
    expect(exit).toBeGreaterThan(summit * RIDGE_TAIL_FRACTION * 0.45); // no "coming down" before the edge
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
