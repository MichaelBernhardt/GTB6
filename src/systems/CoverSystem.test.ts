import { describe, expect, it } from 'vitest';
import type { Collider } from '../world/City';
import {
  clampT, cornerSide, CORNER_HOLD, COVER_ENTER_RANGE, COVER_GAP, coverHeading, coverPosition, coverT,
  MIN_COVER_HEIGHT, movingAway, nearestCoverSpot, nearestGroundedCoverSpot, peekEligible, tangentOf,
} from './CoverSystem';

const box = (minX: number, maxX: number, minZ: number, maxZ: number, height = 20): Collider => ({ minX, maxX, minZ, maxZ, height });
const building = box(-10, 10, -5, 5); // 20x10 AABB centred at origin
const RADIUS = 0.65;

describe('nearest-face detection', () => {
  it('finds the +X face when standing east of the building', () => {
    const spot = nearestCoverSpot(11.5, 0, [building]);
    expect(spot?.normal).toEqual({ x: 1, z: 0 });
    expect(spot?.plane).toBe(10);
    expect(spot?.span).toEqual([-5, 5]);
  });

  it('finds each of the four faces from its own side', () => {
    expect(nearestCoverSpot(-12, 0, [building])?.normal).toEqual({ x: -1, z: 0 });
    expect(nearestCoverSpot(0, 6.5, [building])?.normal).toEqual({ x: 0, z: 1 });
    expect(nearestCoverSpot(0, -6.5, [building])?.normal).toEqual({ x: 0, z: -1 });
  });

  it('offers nothing beyond the enter range or past the corner', () => {
    expect(nearestCoverSpot(10 + COVER_ENTER_RANGE + 0.1, 0, [building])).toBeUndefined();
    expect(nearestCoverSpot(11.5, 6.5, [building])).toBeUndefined(); // diagonal: no wall at your back
  });

  it('ignores colliders too low to hide behind', () => {
    expect(nearestCoverSpot(11.5, 0, [box(-10, 10, -5, 5, MIN_COVER_HEIGHT - 0.1)])).toBeUndefined();
  });

  it('picks the closest face across multiple colliders', () => {
    const other = box(14, 20, -5, 5);
    const spot = nearestCoverSpot(12.2, 0, [building, other]); // 2.2 from building's +X, 1.8 from other's -X
    expect(spot?.collider).toBe(other);
    expect(spot?.normal).toEqual({ x: -1, z: 0 });
  });

  it('allows cover while grounded above world zero and rejects airborne entry', () => {
    // Elevation is deliberately absent from cover math: grounding state is the source of truth.
    expect(nearestGroundedCoverSpot(11.5, 0, true, [building])?.normal).toEqual({ x: 1, z: 0 });
    expect(nearestGroundedCoverSpot(11.5, 0, false, [building])).toBeUndefined();
  });
});

describe('snap and slide clamping', () => {
  it('snaps flat against the wall with the capsule gap', () => {
    const spot = nearestCoverSpot(11.5, 2, [building])!;
    const t = clampT(spot, coverT(spot, 11.5, 2), RADIUS);
    expect(coverPosition(spot, t, RADIUS)).toEqual({ x: 10 + RADIUS + COVER_GAP, z: 2 });
  });

  it('clamps the slide so the capsule never passes a corner', () => {
    const spot = nearestCoverSpot(11.5, 0, [building])!;
    expect(clampT(spot, 99, RADIUS)).toBe(5 - RADIUS);
    expect(clampT(spot, -99, RADIUS)).toBe(-(5 - RADIUS));
    expect(clampT(spot, 1.2, RADIUS)).toBe(1.2);
  });

  it('pins to the middle of a face narrower than the player', () => {
    const sliver = box(0, 1, -0.4, 0.4, 20);
    const spot = nearestCoverSpot(2, 0, [sliver])!;
    expect(clampT(spot, 99, RADIUS)).toBe(0);
  });

  it('round-trips tangential coordinates on every face orientation', () => {
    for (const point of [[11.5, 2], [-11.5, -3], [4, 6.5], [-4, -6.5]] as const) {
      const spot = nearestCoverSpot(point[0], point[1], [building])!;
      const t = coverT(spot, point[0], point[1]);
      const position = coverPosition(spot, t, RADIUS);
      expect(coverT(spot, position.x, position.z)).toBeCloseTo(t, 10);
    }
  });
});

describe('corners and peek eligibility', () => {
  const spot = nearestCoverSpot(11.5, 0, [building])!;

  it('reports no corner mid-wall and the correct side near each end', () => {
    expect(cornerSide(spot, 0, RADIUS)).toBe(0);
    expect(cornerSide(spot, -(5 - RADIUS), RADIUS)).toBe(-1);
    expect(cornerSide(spot, 5 - RADIUS, RADIUS)).toBe(1);
    expect(cornerSide(spot, 5 - RADIUS - CORNER_HOLD - 0.05, RADIUS)).toBe(0);
  });

  it('resolves a short face to its nearer corner', () => {
    const hut = box(0, 2, -1, 1, 20);
    const hutSpot = nearestCoverSpot(3, 0.2, [hut])!;
    expect(cornerSide(hutSpot, 0.2, RADIUS)).toBe(1);
    expect(cornerSide(hutSpot, -0.2, RADIUS)).toBe(-1);
  });

  it('allows peeking only at corners', () => {
    expect(peekEligible(spot, 0, RADIUS)).toBe(false);
    expect(peekEligible(spot, 5 - RADIUS, RADIUS)).toBe(true);
  });
});

describe('facing and release', () => {
  it('faces outward along the wall normal', () => {
    expect(coverHeading(nearestCoverSpot(11.5, 0, [building])!)).toBeCloseTo(Math.PI / 2);
    expect(coverHeading(nearestCoverSpot(0, 6.5, [building])!)).toBeCloseTo(0);
    expect(coverHeading(nearestCoverSpot(0, -6.5, [building])!)).toBeCloseTo(Math.PI);
  });

  it('keeps the (normal, tangent) frame orthonormal', () => {
    const tangent = tangentOf({ x: 0, z: -1 });
    expect(tangent.x * 0 + tangent.z * -1).toBe(0);
    expect(Math.hypot(tangent.x, tangent.z)).toBe(1);
  });

  it('releases only when the move points away from the wall', () => {
    const normal = { x: 1, z: 0 };
    expect(movingAway({ x: 1, z: 0 }, normal)).toBe(true);
    expect(movingAway({ x: 0.9, z: 0.3 }, normal)).toBe(true);
    expect(movingAway({ x: 0, z: 1 }, normal)).toBe(false);   // sliding along the wall
    expect(movingAway({ x: -1, z: 0 }, normal)).toBe(false);  // pushing into the wall
    expect(movingAway({ x: 0, z: 0 }, normal)).toBe(false);   // idle
  });
});
