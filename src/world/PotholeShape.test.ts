import { describe, expect, it } from 'vitest';
import {
  POTHOLE_MAX_RADIUS_FACTOR,
  POTHOLE_SEGMENTS,
  potholeRadiusAt,
  potholeRadiusToward,
  potholeRimAt,
  potholeVertexRadius,
  type PotholeHazard,
} from './PotholeShape';

/** A spread of holes across the map, at the real placement radii and every road bearing. */
const HOLES: PotholeHazard[] = Array.from({ length: 600 }, (_, i) => ({
  x: -3000 + i * 9.13,
  z: 1200 - i * 6.07,
  r: 1.1 + (i % 91) / 100,
  axis: ((i % 37) / 37) * Math.PI * 2,
}));

const SEGMENT_ARC = (Math.PI * 2) / POTHOLE_SEGMENTS;

describe('pothole outline', () => {
  it('is a pure function of the hole, identical on every visit and different for every hole', () => {
    for (const hole of HOLES.slice(0, 20)) {
      for (const angle of [-3, -1.1, 0, 0.4, 2.9]) {
        expect(potholeRadiusAt(hole, angle)).toBe(potholeRadiusAt({ ...hole }, angle));
      }
    }
    const shapes = HOLES.slice(0, 50).map((hole) => potholeRadiusAt(hole, 0.4) / hole.r);
    expect(new Set(shapes.map((s) => s.toFixed(6))).size).toBe(shapes.length);
  });

  it('measures the DRAWN polygon, so a scored clearance can never disagree with the silhouette', () => {
    // This is the whole reason the module exists. City fans `potholeVertexRadius` into triangles, so
    // the edge on screen is the chord between consecutive vertices — walk those chords in Cartesian
    // space and every point on them must be exactly where potholeRadiusAt says the edge is.
    for (const hole of HOLES.slice(0, 60)) {
      for (let segment = 0; segment < POTHOLE_SEGMENTS; segment++) {
        const a0 = segment * SEGMENT_ARC; const a1 = a0 + SEGMENT_ARC;
        const r0 = potholeVertexRadius(hole, segment); const r1 = potholeVertexRadius(hole, segment + 1);
        const x0 = Math.cos(a0) * r0; const z0 = Math.sin(a0) * r0;
        const x1 = Math.cos(a1) * r1; const z1 = Math.sin(a1) * r1;
        for (let step = 0; step <= 8; step++) {
          const t = step / 8;
          const x = x0 + (x1 - x0) * t; const z = z0 + (z1 - z0) * t;
          expect(potholeRadiusToward(hole, x, z)).toBeCloseTo(Math.hypot(x, z), 9);
        }
      }
    }
  });

  it('never reaches past the analytic bound the per-frame hit test rejects on', () => {
    // Game skips the exact test when the car is further than r × this. If a tuned amplitude ever
    // pushed the outline past it, potholes would silently stop rattling at their long ends.
    let worst = 0;
    for (const hole of HOLES) {
      for (let s = 0; s < 720; s++) {
        worst = Math.max(worst, potholeRadiusAt(hole, -Math.PI + (s / 720) * Math.PI * 2) / hole.r);
      }
    }
    expect(worst).toBeLessThan(POTHOLE_MAX_RADIUS_FACTOR);
    expect(worst).toBeGreaterThan(1.5); // and the bound is not vacuous: holes really are this ragged
  });

  it('keeps r honest as the equivalent-area radius the placement code hands it', () => {
    // The elongation is area-preserving and the harmonics are mean-1, so `r` still means what every
    // caller that stores or reads it thinks it means.
    for (const hole of HOLES.slice(0, 120)) {
      let area = 0; const samples = 720;
      for (let s = 0; s < samples; s++) {
        const radius = potholeRadiusAt(hole, -Math.PI + (s / samples) * Math.PI * 2);
        area += 0.5 * radius * radius * ((Math.PI * 2) / samples);
      }
      // Measured across the whole spread: mean 0.99, worst 7% out. The lobes are what move it, and
      // they are the point; what matters is that `r` has not quietly become a different quantity.
      expect(area / (Math.PI * hole.r * hole.r)).toBeGreaterThan(0.9);
      expect(area / (Math.PI * hole.r * hole.r)).toBeLessThan(1.1);
    }
  });

  it('breaks along the lane, not across it', () => {
    const along = HOLES.filter((hole) => potholeRadiusAt(hole, hole.axis!) > potholeRadiusAt(hole, hole.axis! + Math.PI / 2));
    expect(along.length / HOLES.length).toBeGreaterThan(0.9);
    // Turning the road turns the hole with it, rather than the raggedness being pinned to world axes.
    const hole = HOLES[3]!;
    const turned = { ...hole, axis: hole.axis! + Math.PI / 2 };
    expect(potholeRadiusAt(turned, hole.axis! + Math.PI / 2)).toBeCloseTo(potholeRadiusAt(hole, hole.axis!), 9);
  });

  it('collars the hole in broken tar that varies in width and closes entirely somewhere', () => {
    let closed = 0;
    for (const hole of HOLES) {
      const spans: number[] = [];
      for (let segment = 0; segment < POTHOLE_SEGMENTS; segment++) {
        const rim = potholeRimAt(hole, segment);
        // Never inside the outline: the dark silhouette the player judges the gap by is unobscured.
        expect(rim.inner).toBe(potholeVertexRadius(hole, segment));
        expect(rim.outer).toBeGreaterThanOrEqual(rim.inner);
        expect(rim.outer).toBeLessThanOrEqual(rim.inner * 1.5); // a rim, never a halo around a crater
        spans.push(rim.outer - rim.inner);
      }
      expect(Math.max(...spans)).toBeGreaterThan(Math.min(...spans) + 0.05); // never a uniform band
      if (Math.min(...spans) < 0.012 * hole.r) closed++;
    }
    expect(closed / HOLES.length).toBeGreaterThan(0.2); // and on a good share of them the tar still holds
  });
});
