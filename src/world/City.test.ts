import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_VARIANTS } from './BuildingArchitecture';
import { PLAYER } from '../config';
import { fallDamage, jumpVelocity, stepVertical, type VerticalMotion } from '../core/GameRules';
import { clearPathIntervals, colliderBase, colliderOverlapsXZ, colliderTop, collidersBlock, districtAt, highestColliderTop, RAILWAY_NETWORK, ROAD_NETWORK, ROAD_SURFACE_OFFSET, SIDEWALK_INNER_EDGE, SIDEWALK_RISE, SIDEWALK_WIDTH, terrainHeightAt, TRACK_NETWORK, type Collider } from './City';
import { CBD_CENTER, distanceToRailwayCorridor, districtCenter, MAP_WORLD_SIZE, RAILWAY_CORRIDOR_HALF_WIDTH, RAILWAY_STATIONS, RAILWAY_STATION_SITES, ridgeMetresAt } from './mapData';
import { CITY_JUNCTIONS, signalCornerOffset } from './UrbanInfrastructure';

describe('generated Joburg road topology', () => {
  it('carries the real OSM network at driveable scale', () => {
    expect(ROAD_NETWORK.length).toBeGreaterThan(1000);
    expect(ROAD_NETWORK.every((road) => road.width >= 5 && road.points.length >= 2)).toBe(true);
    const names = new Set(ROAD_NETWORK.map((road) => road.name));
    expect(names.has('Commissioner Street')).toBe(true); // the keeper icons stay real
    expect(names.has('Jan Smuts Avenue')).toBe(true);
    expect(names.has('Egoli Orbital')).toBe(true); // boundary orbital so no road stops dead at the crop edge
  });

  it('renames the parody streets around the spawn blocks', () => {
    const names = new Set(ROAD_NETWORK.map((road) => road.name));
    for (const parody of ['Risk-It Street', 'Martial Street', 'Fax Street', 'Main Main Street', 'Loadshed Lane', 'Eish-loff Street']) {
      expect(names.has(parody), parody).toBe(true);
    }
  });

  it('keeps every road inside the generated world bounds', () => {
    const half = MAP_WORLD_SIZE / 2 + 240; // the orbital runs slightly outside the road bbox
    expect(ROAD_NETWORK.every((road) => road.points.every((point) => Math.abs(point.x) <= half && Math.abs(point.z) <= half))).toBe(true);
  });

  it('renders off-road tracks separately from the driveable network', () => {
    expect(TRACK_NETWORK.length).toBeGreaterThan(10);
    expect(TRACK_NETWORK.every((track) => track.width <= 6)).toBe(true);
  });

  it('carries a thinned passenger rail network with the airport spur', () => {
    expect(RAILWAY_NETWORK.length).toBeGreaterThanOrEqual(3);
    expect(RAILWAY_NETWORK.length).toBeLessThanOrEqual(8); // a few lines, not the 800-way yard spaghetti
    const names = RAILWAY_NETWORK.map((line) => line.name);
    expect(names).toContain('Lughawe Spur'); // the airport gets rail service
    expect(names.some((name) => name.includes('Main Line'))).toBe(true);
    // Lines are long, coherent polylines — not fragments.
    const length = (points: { x: number; z: number }[]): number =>
      points.reduce((sum, point, index) => index ? sum + Math.hypot(point.x - points[index - 1]!.x, point.z - points[index - 1]!.z) : 0, 0);
    expect(RAILWAY_NETWORK.every((line) => length(line.points) >= 1200)).toBe(true);
  });

  it('projects every named passenger station onto a real railway corridor', () => {
    expect(RAILWAY_STATION_SITES).toHaveLength(RAILWAY_STATIONS.length);
    expect(RAILWAY_STATION_SITES.map((station) => station.name)).toEqual(expect.arrayContaining(['Park Station', 'Sandton', 'Rosebank']));
    for (const station of RAILWAY_STATION_SITES) {
      expect(station.sourceDistance, station.name).toBeLessThan(150);
      expect(Math.hypot(station.dirX, station.dirZ), station.name).toBeCloseTo(1);
      expect(distanceToRailwayCorridor(station.x, station.z), station.name).toBeCloseTo(-RAILWAY_CORRIDOR_HALF_WIDTH, 5);
    }
  });

  it('defines named, phased signalized intersections at major crossings', () => {
    expect(CITY_JUNCTIONS.length).toBeGreaterThanOrEqual(24);
    expect(CITY_JUNCTIONS.length).toBeLessThanOrEqual(80); // visual/update budget
    expect(CITY_JUNCTIONS.every((junction) => junction.roadA.length > 0 && junction.roadB.length > 0 && junction.roadA !== junction.roadB)).toBe(true);
    expect(CITY_JUNCTIONS.every((junction) => signalCornerOffset(junction.widest) > junction.widest / 2 + 2)).toBe(true);
    // Radius scales with the footprint (junctions are ~6x further apart in units at 36000u).
    const cbdSignals = CITY_JUNCTIONS.filter((junction) => Math.hypot(junction.x - CBD_CENTER.x, junction.z - CBD_CENTER.z) < 400 * (MAP_WORLD_SIZE / 6000));
    expect(cbdSignals.length).toBeGreaterThanOrEqual(3); // robots are visible around the spawn district
  });

  it('provides multiple structural building families in every district', () => {
    expect(Object.keys(ARCHITECTURE_VARIANTS)).toHaveLength(7);
    expect(Object.values(ARCHITECTURE_VARIANTS).reduce((sum, count) => sum + count, 0)).toBe(52); // main's 36 + the 16 clutter-variety families
    expect(ARCHITECTURE_VARIANTS.downtown).toBe(11);
    expect(ARCHITECTURE_VARIANTS['mixed-use']).toBe(5);
    expect(ARCHITECTURE_VARIANTS['dense-residential']).toBe(6);
    expect(ARCHITECTURE_VARIANTS.suburban).toBe(9);
    expect(ARCHITECTURE_VARIANTS.industrial).toBe(9);
    expect(ARCHITECTURE_VARIANTS.estate).toBe(8);
    expect(ARCHITECTURE_VARIANTS.rural).toBe(4);
  });
});

describe('district naming (generated place nodes)', () => {
  it('names the key districts for dispatch callouts', () => {
    for (const name of ['Joburg CBD', 'Sandton', 'Braamfontein', 'Hillbrow', 'Newtown']) {
      const center = districtCenter(name);
      expect(center, name).toBeDefined();
      expect(districtAt(center!.x, center!.z)).toBe(name);
    }
  });

  it('answers with the nearest district everywhere on the map', () => {
    expect(districtAt(CBD_CENTER.x + 5, CBD_CENTER.z - 5)).toBe('Joburg CBD');
    expect(typeof districtAt(-MAP_WORLD_SIZE / 2, -MAP_WORLD_SIZE / 2)).toBe('string');
    expect(districtAt(-MAP_WORLD_SIZE / 2, -MAP_WORLD_SIZE / 2).length).toBeGreaterThan(0);
  });
});

describe('terrain relief from the SRTM heightgrid', () => {
  // The heightgrid is detrended into a tamed regional trend (scaled down so Johannesburg's ~1760 m
  // plateau doesn't tower over the 0 m ocean) plus an exaggerated, capped local residual (so the flat
  // plateau reads as rolling hills). terrainHeightAt is the single sampler everything downstream uses.
  it('samples deterministic, finite relief that varies across the map', () => {
    const samples = [[-320, 220], [-120, 40], [80, 260], [300, -80], [3063, 5434], [-8200, 5434]] as const;
    const heights = samples.map(([x, z]) => terrainHeightAt(x, z));
    for (const h of heights) expect(Number.isFinite(h)).toBe(true);
    for (const [x, z] of samples) expect(terrainHeightAt(x, z)).toBe(terrainHeightAt(x, z)); // pure/deterministic
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(1); // real relief, not a single plane
  });

  it('stays within the detrended envelope everywhere (no runaway escarpment cliffs)', () => {
    // Regional band maxes near maxElevation * scale; local band is capped either side; only the
    // DELIBERATE northern range (elevation.ridge × TERRAIN_RIDGE_SCALE, ≤ ~475 u) rises past that.
    // Sample a coarse grid over the whole world and assert nothing blows past the two bounds.
    let lo = Infinity; let hi = -Infinity; let offRangeHi = -Infinity;
    for (let x = -8900; x <= 8900; x += 445) for (let z = -8900; z <= 8900; z += 445) {
      const h = terrainHeightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h);
      if (ridgeMetresAt(x, z) === 0) offRangeHi = Math.max(offRangeHi, h);
    }
    expect(lo).toBeGreaterThan(-200);
    expect(hi).toBeLessThan(560);
    expect(offRangeHi).toBeLessThan(400); // away from the range the old detrended ceiling still holds
  });

  it('keeps sidewalks stepped above roads above the terrain', () => {
    expect(ROAD_SURFACE_OFFSET).toBeGreaterThan(0);
    expect(SIDEWALK_RISE).toBeCloseTo(0.22);
    expect(SIDEWALK_INNER_EDGE).toBeGreaterThan(0); // kerb has a real face; paving does not overlap tar
    expect(SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH).toBeCloseTo(3.5); // mesh and walkable query end together
  });
});

describe('sidewalk cross-street clipping', () => {
  it('keeps long clear runs as single intervals and removes only the crossing', () => {
    const clear = clearPathIntervals(36, (distance) => distance >= 14 && distance <= 22);
    expect(clear).toHaveLength(2);
    expect(clear[0]![0]).toBe(0);
    expect(clear[0]![1]).toBeCloseTo(14, 1);
    expect(clear[1]![0]).toBeCloseTo(22, 1);
    expect(clear[1]![1]).toBe(36);
  });

  it('handles a clipped endpoint without dropping the rest of the paving slab', () => {
    const clear = clearPathIntervals(20, (distance) => distance < 4);
    expect(clear).toHaveLength(1);
    expect(clear[0]![0]).toBeCloseTo(4, 1);
    expect(clear[0]![1]).toBe(20);
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

describe('oriented-box colliders (buildings aligned to diagonal streets)', () => {
  // A 10×10 box rotated 45°: its vertices point along the world axes (±5√2, 0)/(0, ±5√2) and its walls
  // face the diagonals. The enclosing AABB is the full [-5√2, 5√2] square — 1.4× oversized.
  const R2 = Math.SQRT2 * 5;
  const box: Collider = { minX: -R2, maxX: R2, minZ: -R2, maxZ: R2, y0: 0, height: 20, heading: Math.PI / 4, hw: 5, hd: 5 };

  it('blocks the true rotated footprint, never the empty AABB corners', () => {
    expect(colliderOverlapsXZ(box, 0, 0, 0.35)).toBe(true);      // dead centre
    expect(colliderOverlapsXZ(box, 3.4, 3.4, 0.35)).toBe(true);  // just inside a flat wall
    expect(colliderOverlapsXZ(box, 7, 0, 0.35)).toBe(true);      // near a vertex (points along world x)
    // The AABB corner (6, 6) is open ground beyond the diagonal wall — the whole reason for oriented boxes.
    expect(colliderOverlapsXZ(box, 6, 6, 0.35)).toBe(false);
    expect(colliderOverlapsXZ(box, 6.9, 6.9, 0.35)).toBe(false); // hard against the AABB corner: still empty
  });

  it('matches the plain AABB test when no heading is set', () => {
    const aabb: Collider = { minX: -5, maxX: 5, minZ: -5, maxZ: 5, y0: 0, height: 20 };
    expect(colliderOverlapsXZ(aabb, 4.9, 4.9, 0.05)).toBe(true);
    expect(colliderOverlapsXZ(aabb, 6, 0, 0.05)).toBe(false);
  });
});
