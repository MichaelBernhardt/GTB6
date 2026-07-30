import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT_RADIUS,
  DROP_AHEAD,
  GROUND_SEARCH_RADIUS,
  MAX_GROUND_GRADIENT,
  groundFault,
  placementRadius,
  placementRefusal,
  placeVehicleNear,
  probeGround,
  RAIL_CLEARANCE,
  ROAD_SNAP_RADIUS,
  type PlacementWorld,
} from './VehiclePlacement';

/** Flat, dry, empty, roadless veld. Each test overrides only the one thing it is about. */
function world(overrides: Partial<PlacementWorld> = {}): PlacementWorld {
  return {
    surfaceHeightAt: () => 12,
    isWater: () => false,
    blocked: () => false,
    railDistance: () => 18, // the corridor grid's far-field cap: nothing near
    nearestRoadPose: () => undefined,
    occupied: () => false,
    ...overrides,
  };
}

/** A single lane point at (x, z) running due north, as City.nearestRoadPose would report it. */
function roadAt(x: number, z: number, heading = 0): PlacementWorld['nearestRoadPose'] {
  return () => ({ x, y: 12.15, z, heading });
}

describe('road snapping is a range, not an unconditional snap', () => {
  it('takes a road inside the snap radius and aligns to the lane', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ nearestRoadPose: roadAt(40, 0, 1.25) }));
    expect(place).toEqual({ on: 'road', x: 40, y: 12.15, z: 0, heading: 1.25, roadDistance: 40 });
  });

  it('still snaps right up to the radius', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ nearestRoadPose: roadAt(ROAD_SNAP_RADIUS, 0) }));
    expect(place.on).toBe('road');
  });

  it('refuses to chase a road beyond the radius and lands beside the player instead', () => {
    const far = ROAD_SNAP_RADIUS + 400;
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ nearestRoadPose: roadAt(far, 0) }));
    expect(place.on).toBe('ground');
    if (place.on === 'nowhere') throw new Error('unreachable');
    // The whole bug: the vehicle used to appear at `far`. It must now be within a short walk.
    expect(Math.hypot(place.x, place.z)).toBeLessThanOrEqual(DROP_AHEAD + GROUND_SEARCH_RADIUS);
    expect(place.roadDistance).toBeCloseTo(far, 5);
  });

  it('keeps the in-town refusal when a road is in reach but its spot is taken', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ nearestRoadPose: roadAt(9, 0), occupied: () => true }));
    expect(place).toEqual({ on: 'nowhere', refusal: 'kerb' });
    expect(placementRefusal('kerb')).toContain('no clear kerb');
  });

  it('keeps the in-town refusal when the player is standing on the lane point', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ nearestRoadPose: roadAt(1, 0) }));
    expect(place).toEqual({ on: 'nowhere', refusal: 'kerb' });
  });
});

describe('suitable ground', () => {
  it('grounds the drop on the real surface height', () => {
    const surface = (x: number, z: number): number => 30 + Math.sin(x * 0.01) + Math.cos(z * 0.01);
    const place = placeVehicleNear({ x: 200, z: -60 }, 0.4, world({ surfaceHeightAt: surface }));
    if (place.on !== 'ground') throw new Error(`expected ground, got ${place.on}`);
    expect(place.y).toBeCloseTo(surface(place.x, place.z), 10);
  });

  it('faces the player heading on the flat', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 2.1, world());
    if (place.on !== 'ground') throw new Error('expected ground');
    expect(place.heading).toBeCloseTo(2.1, 10);
    expect(place.x).toBeCloseTo(Math.sin(2.1) * DROP_AHEAD, 10);
    expect(place.z).toBeCloseTo(Math.cos(2.1) * DROP_AHEAD, 10);
  });

  it('faces downhill once the ground tilts', () => {
    // Height falls with +x, so the fall line points at +x: heading atan2(1, 0) = +PI/2.
    const place = placeVehicleNear({ x: 0, z: 0 }, Math.PI, world({ surfaceHeightAt: (x) => 40 - x * 0.2 }));
    if (place.on !== 'ground') throw new Error('expected ground');
    expect(place.heading).toBeCloseTo(Math.PI / 2, 6);
  });

  it('refuses water — and tests the polygon at the footprint, not just the centre', () => {
    const allWater = placeVehicleNear({ x: 0, z: 0 }, 0, world({ isWater: () => true }));
    expect(allWater).toEqual({ on: 'nowhere', refusal: 'water' });
    // Dry at the exact point, wet a footprint away: still not suitable.
    const shallows = world({ isWater: (x) => x > 3.5 });
    expect(groundFault(4, 0, DEFAULT_PLACEMENT_RADIUS, shallows)).toBe('water');
    expect(groundFault(3.4, 0, DEFAULT_PLACEMENT_RADIUS, shallows)).toBe('water');
    expect(groundFault(-20, 0, DEFAULT_PLACEMENT_RADIUS, shallows)).toBeUndefined();
  });

  it('refuses buildings, colliders and the world boundary', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ blocked: () => true }));
    expect(place).toEqual({ on: 'nowhere', refusal: 'building' });
  });

  it('refuses the railway ballast and its clearance band', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ railDistance: () => -2.6 }));
    expect(place).toEqual({ on: 'nowhere', refusal: 'rail' });
    const radius = placementRadius([1.8, 1.35, 3.7]);
    const grazing = world({ railDistance: () => radius + RAIL_CLEARANCE - 0.01 });
    expect(groundFault(0, 0, radius, grazing)).toBe('rail');
  });

  it('refuses slopes a car would slide off', () => {
    const cliff = world({ surfaceHeightAt: (x) => -x * (MAX_GROUND_GRADIENT + 0.2) });
    expect(placeVehicleNear({ x: 0, z: 0 }, 0, cliff)).toEqual({ on: 'nowhere', refusal: 'steep' });
    const gentle = world({ surfaceHeightAt: (x) => -x * (MAX_GROUND_GRADIENT - 0.05) });
    expect(placeVehicleNear({ x: 0, z: 0 }, 0, gentle).on).toBe('ground');
  });

  it('refuses ground already full of cars', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ occupied: () => true }));
    expect(place).toEqual({ on: 'nowhere', refusal: 'occupied' });
  });

  it('rings past a blocked aim point to the nearest clear ground', () => {
    // A wall across the aim point only: the search must step around it, not give up or fly off.
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ blocked: (x, z) => Math.hypot(x, z - DROP_AHEAD) < 4 }));
    if (place.on !== 'ground') throw new Error('expected ground');
    expect(Math.hypot(place.x, place.z - DROP_AHEAD)).toBeGreaterThanOrEqual(4);
    expect(Math.hypot(place.x, place.z)).toBeLessThan(DROP_AHEAD + 8);
  });

  it('never returns a coordinate when it refuses — it reports instead of teleporting', () => {
    const place = placeVehicleNear({ x: 0, z: 0 }, 0, world({ isWater: () => true, nearestRoadPose: roadAt(9000, 9000) }));
    expect(place).toEqual({ on: 'nowhere', refusal: 'water' });
    expect(place).not.toHaveProperty('x');
    for (const refusal of ['kerb', 'water', 'rail', 'steep', 'building', 'occupied'] as const) {
      expect(placementRefusal(refusal), refusal).toMatch(/^Eish, .*try again\.$/);
    }
  });

  it('keeps its distance from the origin, and recovery may waive that', () => {
    // The only clear ground is the patch the player is standing on.
    const pinned = world({ blocked: (x, z) => Math.hypot(x, z) > 1.5 });
    expect(placeVehicleNear({ x: 0, z: 0 }, 0, pinned)).toEqual({ on: 'nowhere', refusal: 'building' });
    // Recovery waives the gap: putting the car back exactly where it flipped is the point.
    const recovered = placeVehicleNear({ x: 0, z: 0 }, 0, pinned, { ahead: 0, minGap: 0 });
    expect(recovered).toMatchObject({ on: 'ground', x: 0, z: 0 });
  });
});

describe('ground probing', () => {
  it('reports the steepest rise to a footprint corner, not an averaged plane', () => {
    // A step up on one side only: a plane fit through the four probes halves it, this must not.
    const step = (x: number): number => (x > 1 ? 3 : 0);
    expect(probeGround(0, 0, 2, step).gradient).toBeCloseTo(3 / 2, 10);
  });

  it('points the downhill heading along the fall line', () => {
    expect(probeGround(0, 0, 2, (_x, z) => -z).downhill).toBeCloseTo(0, 10); // falls toward +z: heading 0
    expect(probeGround(0, 0, 2, (x) => -x).downhill).toBeCloseTo(Math.PI / 2, 10); // falls toward +x
  });

  it('matches the radius Vehicle uses for its own driving collisions', () => {
    expect(placementRadius([2.15, 2.15, 4.9])).toBeCloseTo(4.9 * 0.34, 10); // Hilux Bakkie
    expect(placementRadius([0.55, 1.1, 1.85])).toBeCloseTo(1.85 * 0.34, 10); // Kasi Cruiser
  });
});
