/**
 * WHERE A DELIVERED VEHICLE ACTUALLY LANDS.
 *
 * The console drop and the F recover key both used to snap to `City.nearestRoadPose` unconditionally.
 * In town that is exactly right — a car ON THE TAR, facing the way traffic runs, is the best possible
 * outcome. Out on the farmland west of the dam the nearest sampled lane point can be most of a
 * kilometre away, so "spawn a bakkie" quietly teleported the bakkie out of sight and the player was
 * left standing in the mielies (owner report).
 *
 * So the rule is a RANGE, not an unconditional snap: take the road while a road is genuinely nearby,
 * otherwise set the vehicle down on suitable ground within arm's reach of the player, and when there
 * is no suitable ground either, SAY SO. A clear refusal beats a mystery.
 *
 * Pure placement logic: every world query arrives through `PlacementWorld`, so this is unit-testable
 * without a City, a scene or a renderer.
 */
import { safePlacement } from './Teleport';

/** A road no further than this always wins. Beyond it the "nearest" road is scenery, not a kerb. */
export const ROAD_SNAP_RADIUS = 75;

/** How far ahead of the player the drop is aimed — the spot the ground search rings out from. */
export const DROP_AHEAD = 8;

/** How far past the aim point the ground search will look before giving up. Deliberately short:
 *  the whole complaint was a vehicle appearing somewhere the player has to go and find. */
export const GROUND_SEARCH_RADIUS = 20;

/** Refuse a drop closer than this to the origin — the player wants elbow room, not a car on their
 *  toes. Vehicle recovery passes 0: putting the car back exactly where it flipped is the point. */
export const MIN_DROP_GAP = 2.5;

/** Steepest ground a vehicle may be set down on, as rise over run (0.35 ≈ 19°). Above this it slides
 *  off the moment physics wakes up, and a long body can clip a shoulder into the hillside. */
export const MAX_GROUND_GRADIENT = 0.35;

/** Clearance kept beyond the vehicle's own radius from the nearest ballast edge. Nothing gets parked
 *  on a railway: the trains are real and they do not brake. */
export const RAIL_CLEARANCE = 1;

/** Clearance kept beyond the vehicle's own radius from another vehicle (1.7 + a car's 1.8 radius
 *  reproduces the 3.5 u gap the console drop has always used). */
export const VEHICLE_CLEAR_GAP = 1.7;

/** Ground this tilted gets a downhill-facing vehicle instead of one copying the player's heading:
 *  pointing a car across the fall line is how it ends up on its roof. */
export const DOWNHILL_GRADIENT = 0.1;

/** Fallback probe radius when no vehicle size is to hand (roughly a hatchback). */
export const DEFAULT_PLACEMENT_RADIUS = 1.6;

/** The clearance radius Vehicle's own driving collision uses, so placement and physics agree about
 *  whether a body fits. Same expression as Vehicle.move/Vehicle.nudge. */
export function placementRadius(size: readonly [number, number, number]): number {
  return Math.max(size[0], size[2]) * 0.34;
}

export interface PlacementPoint { x: number; z: number }

/** Everything placement needs to know about the world, all injected. */
export interface PlacementWorld {
  /** Ground height at a world point — City.surfaceHeightAt. */
  surfaceHeightAt(x: number, z: number): number;
  /** Inside real water: the dam's waterline field or an authored pan/lake polygon — City.isWater.
   *  NEVER a bounding envelope: the dam has islands, inlets and peninsulas inside its bbox. */
  isWater(x: number, z: number): boolean;
  /** Buildings, walls, standing props and the world boundary — City.collides. */
  blocked(x: number, z: number, radius: number): boolean;
  /** Distance to the nearest railway ballast edge, negative on the bed — distanceToRailwayCorridor. */
  railDistance(x: number, z: number): number;
  /** Nearest traffic-lane pose, or undefined when the city has no roads at all. */
  nearestRoadPose(x: number, z: number): { x: number; y: number; z: number; heading: number } | undefined;
  /** A live vehicle already stands here. */
  occupied(x: number, z: number, radius: number): boolean;
}

/** Why a candidate spot is not suitable ground. */
export type GroundFault = 'water' | 'building' | 'rail' | 'steep' | 'occupied';

/** Why nothing could be placed. 'kerb' is the in-town case: a road IS in reach but its spot is taken. */
export type PlacementRefusal = 'kerb' | GroundFault;

export type VehiclePlacement =
  | { on: 'road' | 'ground'; x: number; y: number; z: number; heading: number; roadDistance: number }
  | { on: 'nowhere'; refusal: PlacementRefusal };

export interface GroundProbe {
  /** Grounded height at the sampled point. */
  y: number;
  /** Steepest rise from the point to anywhere `reach` away, as rise over run. */
  gradient: number;
  /** Heading that points down the fall line. */
  downhill: number;
}

/**
 * Sample the surface around a point. The gradient is the steepest rise to any of the four probes
 * rather than the slope of a plane fitted through them, because a plane averages away exactly the
 * things that strand a car: a kerb, a retaining ledge, the lip of an embankment.
 */
export function probeGround(x: number, z: number, reach: number, surfaceHeightAt: (x: number, z: number) => number): GroundProbe {
  const y = surfaceHeightAt(x, z);
  const west = surfaceHeightAt(x - reach, z); const east = surfaceHeightAt(x + reach, z);
  const north = surfaceHeightAt(x, z - reach); const south = surfaceHeightAt(x, z + reach);
  const rise = Math.max(Math.abs(west - y), Math.abs(east - y), Math.abs(north - y), Math.abs(south - y));
  // Heading convention is forward = (sin h, cos h), so the fall line is (west - east, north - south).
  return { y, gradient: rise / reach, downhill: Math.atan2(west - east, north - south) };
}

/**
 * SUITABLE GROUND, defined. A vehicle may be set down on a spot only when it is:
 *   - not in water — tested at the centre AND at the four footprint probes, so it is never
 *     ankle-deep in the shallows of the dam or an inland pan;
 *   - not inside a building footprint, wall, standing prop or the world boundary;
 *   - clear of the railway ballast;
 *   - flat enough that it will not slide away or clip the hillside;
 *   - not already occupied by another vehicle.
 * Returns the fault, or undefined when the ground is good.
 */
export function groundFault(x: number, z: number, radius: number, world: PlacementWorld): GroundFault | undefined {
  if (world.isWater(x, z)
    || world.isWater(x - radius, z) || world.isWater(x + radius, z)
    || world.isWater(x, z - radius) || world.isWater(x, z + radius)) return 'water';
  if (world.blocked(x, z, radius)) return 'building';
  if (world.railDistance(x, z) < radius + RAIL_CLEARANCE) return 'rail';
  if (probeGround(x, z, radius, world.surfaceHeightAt).gradient > MAX_GROUND_GRADIENT) return 'steep';
  if (world.occupied(x, z, radius)) return 'occupied';
  return undefined;
}

export interface PlacementOptions {
  /** Half-extent probed for clearance and slope — `placementRadius(spec.size)`. */
  radius?: number;
  /** How far in front of the origin the drop is aimed. Recovery passes 0 (place it where it is). */
  ahead?: number;
  /** Refuse a spot closer than this to the origin. */
  minGap?: number;
  /** How far the ground search rings out from the aim point. */
  searchRadius?: number;
}

/**
 * Pick a spot for a vehicle near `origin`, facing sensibly.
 *
 * A road within ROAD_SNAP_RADIUS wins outright, aligned to the lane. Otherwise the aim point rings
 * outward (reusing the teleporter's `safePlacement`) until suitable ground turns up, grounded on the
 * real surface height and facing the player's heading — or downhill once the ground actually tilts.
 * When nothing within the short search radius qualifies it refuses, and names the fault so the
 * console can explain itself instead of silently flinging the car over the horizon.
 */
export function placeVehicleNear(origin: PlacementPoint, heading: number, world: PlacementWorld, options: PlacementOptions = {}): VehiclePlacement {
  const radius = options.radius ?? DEFAULT_PLACEMENT_RADIUS;
  const ahead = options.ahead ?? DROP_AHEAD;
  const minGap = options.minGap ?? MIN_DROP_GAP;
  const searchRadius = options.searchRadius ?? GROUND_SEARCH_RADIUS;
  const aimX = origin.x + Math.sin(heading) * ahead;
  const aimZ = origin.z + Math.cos(heading) * ahead;

  const road = world.nearestRoadPose(aimX, aimZ);
  const roadDistance = road ? Math.hypot(road.x - origin.x, road.z - origin.z) : Infinity;
  if (road && roadDistance <= ROAD_SNAP_RADIUS) {
    if (roadDistance < minGap || world.occupied(road.x, road.z, radius)) return { on: 'nowhere', refusal: 'kerb' };
    return { on: 'road', x: road.x, y: road.y, z: road.z, heading: road.heading, roadDistance };
  }

  const tooClose = (x: number, z: number): boolean => Math.hypot(x - origin.x, z - origin.z) < minGap;
  const spot = safePlacement(aimX, aimZ, (x, z) => tooClose(x, z) || groundFault(x, z, radius, world) !== undefined, searchRadius);
  if (!spot.clear) return { on: 'nowhere', refusal: groundFault(aimX, aimZ, radius, world) ?? 'occupied' };
  const ground = probeGround(spot.x, spot.z, radius, world.surfaceHeightAt);
  return {
    on: 'ground', x: spot.x, y: ground.y, z: spot.z, roadDistance,
    heading: ground.gradient >= DOWNHILL_GRADIENT ? ground.downhill : heading,
  };
}

/** The console line for a refusal. One sentence, names the obstacle, tells the player what to do. */
export function placementRefusal(refusal: PlacementRefusal): string {
  switch (refusal) {
    case 'kerb': return 'Eish, no clear kerb for the drop-off. Move along and try again.';
    case 'water': return 'Eish, it is all water around here. Get onto dry land and try again.';
    case 'rail': return 'Eish, nothing but railway line here. Step off the tracks and try again.';
    case 'steep': return 'Eish, this ground is far too steep to park on. Find flatter footing and try again.';
    case 'building': return 'Eish, no room to set it down here. Move into the open and try again.';
    case 'occupied': return 'Eish, the space around you is already full of cars. Move along and try again.';
  }
}
