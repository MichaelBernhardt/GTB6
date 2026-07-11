import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_VARIANTS } from './BuildingArchitecture';
import { PLAYER } from '../config';
import { fallDamage, jumpVelocity, stepVertical, type VerticalMotion } from '../core/GameRules';
import { colliderBase, colliderTop, collidersBlock, districtAt, highestColliderTop, PARK_AREAS, ROAD_NETWORK, ROAD_SURFACE_OFFSET, SIDEWALK_RISE, terrainHeightAt, type Collider } from './City';
import { CITY_JUNCTIONS, SIGNAL_CORNER_OFFSET } from './UrbanInfrastructure';

describe('Joburg road topology', () => {
  it('contains distinct arterials, loops, diagonals, and district roads', () => {
    expect(ROAD_NETWORK.length).toBeGreaterThanOrEqual(10);
    expect(new Set(ROAD_NETWORK.map((road) => road.name)).size).toBe(ROAD_NETWORK.length);
    expect(ROAD_NETWORK.some((road) => road.closed)).toBe(true);
    expect(ROAD_NETWORK.some((road) => road.points.some((point, index) => {
      const next = road.points[index + 1];
      return next && Math.abs(next.x - point.x) > 20 && Math.abs(next.z - point.z) > 20;
    }))).toBe(true);
    expect(ROAD_NETWORK.some((road) => road.name.includes('Commissioner'))).toBe(true);
    expect(ROAD_NETWORK.some((road) => road.name.includes('Main Reef') || road.name.includes('Louis Botha') || road.name.includes('Vilakazi'))).toBe(true);
  });

  it('reserves varied public spaces across multiple districts', () => {
    expect(PARK_AREAS).toHaveLength(3);
    expect(new Set(PARK_AREAS.map((park) => park.kind)).size).toBe(3);
    expect(PARK_AREAS.every((park) => park.width >= 50 && park.depth >= 38)).toBe(true);
  });

  it('defines named, independently phased signalized intersections', () => {
    expect(CITY_JUNCTIONS.length).toBeGreaterThanOrEqual(7);
    expect(CITY_JUNCTIONS.every((junction) => junction.roadA.length > 0 && junction.roadB.length > 0)).toBe(true);
    expect(new Set(CITY_JUNCTIONS.map((junction) => junction.phase)).size).toBe(CITY_JUNCTIONS.length);
    expect(SIGNAL_CORNER_OFFSET).toBeGreaterThan(Math.max(...ROAD_NETWORK.map((road) => road.width / 2)) + 2);
  });

  it('provides multiple structural building families in every district', () => {
    expect(ARCHITECTURE_VARIANTS.downtown).toBeGreaterThanOrEqual(5);
    expect(ARCHITECTURE_VARIANTS.residential).toBeGreaterThanOrEqual(4);
    expect(ARCHITECTURE_VARIANTS.industrial).toBeGreaterThanOrEqual(4);
  });
});

describe('district naming', () => {
  it('names every quarter of the map for dispatch callouts', () => {
    expect(districtAt(0, -200)).toBe('Braamfontein');
    expect(districtAt(-200, 0)).toBe('City Deep');
    expect(districtAt(200, 50)).toBe('Sandton');
    expect(districtAt(0, 0)).toBe('Zoo Lake');
    expect(districtAt(130, 0)).toBe('Joburg CBD');
    expect(districtAt(0, 130)).toBe('Joburg CBD');
  });

  it('gives the deep south to Braamfontein regardless of flank', () => {
    expect(districtAt(300, -300)).toBe('Braamfontein');
    expect(districtAt(-300, -300)).toBe('Braamfontein');
  });
});

describe('city elevation profile', () => {
  it('creates deterministic broad hills and dips while flattening toward the coast', () => {
    const samples = [[-320, 220], [-120, 40], [80, 260], [300, -80]] as const;
    const heights = samples.map(([x, z]) => terrainHeightAt(x, z));
    expect(heights).toEqual(samples.map(([x, z]) => terrainHeightAt(x, z)));
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(2);
    expect(terrainHeightAt(120, -340)).toBeCloseTo(0);
  });

  it('keeps neighboring samples gently sloped and sidewalks above roads', () => {
    for (let x = -350; x <= 350; x += 35) for (let z = -250; z <= 350; z += 35) {
      const height = terrainHeightAt(x, z);
      expect(Math.abs(terrainHeightAt(x + 1, z) - height)).toBeLessThan(0.12);
      expect(Math.abs(terrainHeightAt(x, z + 1) - height)).toBeLessThan(0.12);
    }
    expect(ROAD_SURFACE_OFFSET).toBeGreaterThan(0);
    expect(SIDEWALK_RISE).toBeCloseTo(0.22);
  });
});

describe('true 3D colliders', () => {
  const wall: Collider = { minX: -0.4, maxX: 0.4, minZ: -6, maxZ: 6, y0: 0, height: 3 };
  const podium: Collider = { minX: -10, maxX: 10, minZ: -10, maxZ: 10, y0: 0, height: 9 };
  const tower: Collider = { minX: -6, maxX: 6, minZ: -6, maxZ: 6, y0: 9, height: 26 }; // stacked setback tier
  const curb: Collider = { minX: 2, maxX: 8, minZ: -2, maxZ: 2, y0: 0, height: 0.3 };

  it('defaults an unregistered base to the terrain under the collider centre', () => {
    const legacy: Collider = { minX: 99, maxX: 101, minZ: 99, maxZ: 101, height: 5 };
    expect(colliderBase(legacy)).toBeCloseTo(terrainHeightAt(100, 100));
    expect(colliderTop(legacy)).toBeCloseTo(terrainHeightAt(100, 100) + 5);
  });

  it('blocks a ground-level capsule but frees the band above the wall top', () => {
    expect(collidersBlock([wall], 0, 0, 0.65, PLAYER.stepUp, PLAYER.height)).toBe(true);
    expect(collidersBlock([wall], 0, 0, 0.65, 3 + PLAYER.stepUp, 3 + PLAYER.height)).toBe(false); // standing on top: nothing in the band
    expect(collidersBlock([tower], 0, 0, 0.65, PLAYER.stepUp, PLAYER.height)).toBe(false); // the setback tier floats above the street
    expect(collidersBlock([tower], 0, 0, 0.65, 9 + PLAYER.stepUp, 9 + PLAYER.height)).toBe(true); // but walls in a podium-roof walker
  });

  it('treats tops within the step allowance as steps, not walls', () => {
    expect(collidersBlock([curb], 5, 0, 0.65, PLAYER.stepUp, PLAYER.height)).toBe(false); // 0.3 curb: walk on
    expect(highestColliderTop([curb], 5, 0, 0)).toBeCloseTo(0.3);
  });

  it('finds the highest standable top under the feet, tier by tier', () => {
    expect(highestColliderTop([podium, tower], 8, 8, 9)).toBeCloseTo(9); // on the podium roof, beside the tower
    expect(highestColliderTop([podium, tower], 0, 0, 35)).toBeCloseTo(35); // on the tower roof
    expect(highestColliderTop([podium, tower], 0, 0, 9)).toBeCloseTo(9); // the tower top is out of reach from the podium
    expect(highestColliderTop([podium, tower], 20, 20, 35)).toBeUndefined(); // past the edge: nothing underfoot
    expect(highestColliderTop([wall], 0, 6.2, 3, 0.35)).toBeCloseTo(3); // edge forgiveness within the support radius
    expect(highestColliderTop([wall], 0, 6.5, 3, 0.35)).toBeUndefined();
  });
});

describe('headless player on a 3u wall', () => {
  const wall: Collider = { minX: -0.4, maxX: 0.4, minZ: -6, maxZ: 6, y0: 0, height: 3 };
  const dt = 1 / 60;
  const support = (x: number, z: number, feetY: number): number => Math.max(0, highestColliderTop([wall], x, z, feetY) ?? 0);
  const blocked = (x: number, z: number, y: number): boolean => collidersBlock([wall], x, z, PLAYER.radius, y + PLAYER.stepUp, y + PLAYER.height);
  const walk = (motion: VerticalMotion, position: { x: number; z: number }, tx: number, tz: number): void => {
    const step = PLAYER.walkSpeed * dt;
    const nx = position.x + Math.sign(tx - position.x) * Math.min(step, Math.abs(tx - position.x));
    if (!blocked(nx, position.z, motion.y)) position.x = nx;
    const nz = position.z + Math.sign(tz - position.z) * Math.min(step, Math.abs(tz - position.z));
    if (!blocked(position.x, nz, motion.y)) position.z = nz;
  };
  const simulate = (motion: VerticalMotion, position: { x: number; z: number }, tx: number, tz: number, ticks: number, jump?: number): { landed: boolean; drop: number } => {
    let landing = { landed: false, drop: 0 };
    for (let i = 0; i < ticks; i++) {
      walk(motion, position, tx, tz);
      const result = stepVertical(motion, dt, support(position.x, position.z, motion.y), i === 0 ? jump : undefined);
      if (result.landed) landing = result;
    }
    return landing;
  };

  it('mounts the wall with the big jump, walks its length, and drops off damage-free', () => {
    const motion: VerticalMotion = { y: 0, velocityY: 0, onGround: true, fallOriginY: 0 };
    const position = { x: -2, z: 0 };
    expect(blocked(-0.9, 0, 0)).toBe(true); // at street level the wall is a wall
    simulate(motion, position, 0, 0, 240, jumpVelocity(true));
    expect(position.x).toBeCloseTo(0);
    expect(motion.onGround).toBe(true);
    expect(motion.y).toBeCloseTo(3); // standing on the wall top
    const along = simulate(motion, position, 0, 5, 300);
    expect(along.landed).toBe(false); // the whole walk stays on the wall
    expect(motion.y).toBeCloseTo(3);
    const off = simulate(motion, position, 0, 8, 300); // straight off the end
    expect(off.landed).toBe(true);
    expect(motion.y).toBe(0);
    expect(fallDamage(off.drop)).toBe(0); // 3u is far inside the safe drop
  });

  it('cannot mount the wall on a normal jump', () => {
    const motion: VerticalMotion = { y: 0, velocityY: 0, onGround: true, fallOriginY: 0 };
    const position = { x: -2, z: 0 };
    simulate(motion, position, 0, 0, 240, jumpVelocity(false));
    expect(motion.y).toBe(0);
    expect(position.x).toBeLessThan(-0.9); // clamped outside the wall for the whole hop
  });

  it('bills a rooftop drop beyond the safe height', () => {
    const roof: Collider = { minX: -5, maxX: 5, minZ: -5, maxZ: 5, y0: 0, height: 18 };
    const motion: VerticalMotion = { y: 18, velocityY: 0, onGround: true, fallOriginY: 18 };
    let landing = { landed: false, drop: 0 };
    for (let i = 0; i < 300 && !landing.landed; i++) landing = stepVertical(motion, dt, Math.max(0, highestColliderTop([roof], 8, 0, motion.y) ?? 0));
    expect(landing.landed).toBe(true);
    expect(landing.drop).toBeCloseTo(18);
    expect(fallDamage(landing.drop)).toBe(30);
  });
});
