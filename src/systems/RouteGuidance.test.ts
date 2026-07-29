import { describe, expect, it } from 'vitest';
import { GUIDANCE_OFF_ROUTE_WALK, nearestRoutePoint, RouteGuidance } from './RouteGuidance';
import type { NavGraph } from './NavGraph';

const line = (offset = 0): NavGraph => ({
  nodes: [
    { x: 0, z: offset },
    { x: 10, z: offset },
    { x: 20, z: offset },
    { x: 30, z: offset },
    { x: 40, z: offset },
  ],
  edges: [[1], [0, 2], [1, 3], [2, 4], [3]],
});

describe('route guidance', () => {
  it('plans from the exact player position to the exact goal', () => {
    const guidance = new RouteGuidance(line(), line());
    const route = guidance.update(0.016, { x: -2, z: 1 }, { key: 'portia', x: 42, z: 1 }, 'walk');
    expect(route[0]).toEqual({ x: -2, z: 1 });
    expect(route.at(-1)).toEqual({ x: 42, z: 1 });
    expect(route.length).toBeGreaterThan(3);
  });

  it('trims waypoints already passed without replanning every tick', () => {
    const guidance = new RouteGuidance(line(), line());
    const initial = guidance.update(0, { x: 0, z: 0 }, { key: 'job', x: 40, z: 0 }, 'walk');
    const trimmed = guidance.update(1, { x: 31, z: 0 }, { key: 'job', x: 40, z: 0 }, 'walk');
    expect(trimmed.length).toBeLessThan(initial.length);
    expect(trimmed.at(-1)).toEqual({ x: 40, z: 0 });
  });

  it('replans when the player leaves the route or switches to driving lanes', () => {
    const walk = line(0);
    const drive = line(100);
    const guidance = new RouteGuidance(walk, drive);
    guidance.update(0, { x: 0, z: 0 }, { key: 'job', x: 40, z: 0 }, 'walk');
    const detour = guidance.update(1, { x: 0, z: GUIDANCE_OFF_ROUTE_WALK + 10 }, { key: 'job', x: 40, z: 0 }, 'walk');
    expect(detour[0]).toEqual({ x: 0, z: GUIDANCE_OFF_ROUTE_WALK + 10 });
    const driving = guidance.update(0, { x: 0, z: 100 }, { key: 'job', x: 40, z: 100 }, 'drive');
    expect(driving.some((point) => point.z === 100)).toBe(true);
  });

  it('finds the nearest waypoint and clears cleanly without a goal', () => {
    expect(nearestRoutePoint([{ x: 0, z: 0 }, { x: 10, z: 0 }], { x: 8, z: 3 })).toEqual({ index: 1, distance: Math.sqrt(13) });
    const guidance = new RouteGuidance(line(), line());
    guidance.update(0, { x: 0, z: 0 }, { key: 'job', x: 40, z: 0 }, 'walk');
    expect(guidance.update(0, { x: 0, z: 0 }, undefined, 'walk')).toEqual([]);
  });
});
