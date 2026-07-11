import { describe, expect, it } from 'vitest';
import { pointToSegmentDistance, simplifyPolyline, simplifyWithPins } from './simplify';
import type { Pt } from './types';

describe('simplifyPolyline', () => {
  it('always preserves both endpoints', () => {
    const line: Pt[] = [{ x: 0, z: 0 }, { x: 10, z: 1 }, { x: 20, z: -1 }, { x: 30, z: 0.5 }, { x: 40, z: 0 }];
    const out = simplifyPolyline(line, 8);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it('collapses nearly-collinear points below tolerance', () => {
    const line: Pt[] = Array.from({ length: 50 }, (_, i) => ({ x: i * 10, z: Math.sin(i) * 2 }));
    const out = simplifyPolyline(line, 8);
    expect(out.length).toBeLessThan(line.length / 3);
  });

  it('keeps deviations larger than tolerance', () => {
    const line: Pt[] = [{ x: 0, z: 0 }, { x: 50, z: 30 }, { x: 100, z: 0 }];
    expect(simplifyPolyline(line, 8)).toHaveLength(3);
    expect(simplifyPolyline(line, 40)).toHaveLength(2);
  });

  it('leaves 2-point lines untouched', () => {
    const line: Pt[] = [{ x: 0, z: 0 }, { x: 5, z: 5 }];
    expect(simplifyPolyline(line, 100)).toEqual(line);
  });
});

describe('simplifyWithPins', () => {
  it('never removes pinned (junction) vertices', () => {
    const line: Pt[] = Array.from({ length: 21 }, (_, i) => ({ x: i * 10, z: 0.5 * (i % 2) }));
    const junction = line[7];
    const out = simplifyWithPins(line, new Set([7]), 8);
    expect(out).toContainEqual(junction);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[20]);
  });

  it('matches plain simplification when no pins are given', () => {
    const line: Pt[] = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }, { x: 30, z: 0 }];
    expect(simplifyWithPins(line, new Set(), 1)).toEqual(simplifyPolyline(line, 1));
  });
});

describe('pointToSegmentDistance', () => {
  it('measures perpendicular distance and clamps to endpoints', () => {
    expect(pointToSegmentDistance({ x: 5, z: 3 }, { x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(3);
    expect(pointToSegmentDistance({ x: -4, z: 0 }, { x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(4);
    expect(pointToSegmentDistance({ x: 1, z: 1 }, { x: 2, z: 2 }, { x: 2, z: 2 })).toBeCloseTo(Math.SQRT2);
  });
});
