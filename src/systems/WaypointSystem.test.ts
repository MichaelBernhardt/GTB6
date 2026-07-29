import { describe, expect, it } from 'vitest';
import { WAYPOINT_REACHED_RADIUS, waypointReached } from './WaypointSystem';

describe('personal waypoint arrival', () => {
  it('fires at the pin or inside its forgiving road-scale radius', () => {
    expect(waypointReached({ x: 10, z: 20 }, { x: 10, z: 20 })).toBe(true);
    expect(waypointReached({ x: 10, z: 20 }, { x: 10 + WAYPOINT_REACHED_RADIUS, z: 20 })).toBe(true);
  });

  it('does not fire without a pin or beyond the radius', () => {
    expect(waypointReached(undefined, { x: 0, z: 0 })).toBe(false);
    expect(waypointReached({ x: 10, z: 20 }, { x: 10 + WAYPOINT_REACHED_RADIUS + 0.01, z: 20 })).toBe(false);
  });
});
