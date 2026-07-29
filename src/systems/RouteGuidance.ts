import { RoutePlanner, type NavGraph, type NavPoint } from './NavGraph';

export type GuidanceMode = 'walk' | 'drive';
export interface GuidanceGoal extends NavPoint { key: string; }

export const GUIDANCE_RECHECK_SECONDS = 0.75;
export const GUIDANCE_TARGET_MOVE = 18;
export const GUIDANCE_OFF_ROUTE_WALK = 38;
export const GUIDANCE_OFF_ROUTE_DRIVE = 72;

export interface NearestRoutePoint {
  index: number;
  distance: number;
}

/** Finds the closest retained waypoint. Navigation paths are sampled densely enough that a
 * point check is both cheaper and more stable than projecting onto every segment. */
export function nearestRoutePoint(route: readonly NavPoint[], point: NavPoint): NearestRoutePoint {
  let index = -1;
  let distanceSq = Infinity;
  for (let candidate = 0; candidate < route.length; candidate++) {
    const waypoint = route[candidate];
    if (!waypoint) continue;
    const dx = waypoint.x - point.x;
    const dz = waypoint.z - point.z;
    const next = dx * dx + dz * dz;
    if (next < distanceSq) { distanceSq = next; index = candidate; }
  }
  return { index, distance: Math.sqrt(distanceSq) };
}

function samePoint(a: NavPoint | undefined, b: NavPoint): boolean {
  return Boolean(a && (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 0.25);
}

/**
 * Cached, deviation-aware GPS routing for the player. It plans only when the goal/movement mode
 * changes or the player genuinely leaves the route, then trims waypoints already driven past.
 * That keeps citywide A* out of the frame loop while making detours recover automatically.
 */
export class RouteGuidance {
  private readonly walkPlanner: RoutePlanner;
  private readonly drivePlanner: RoutePlanner;
  private points: NavPoint[] = [];
  private goal?: GuidanceGoal;
  private mode?: GuidanceMode;
  private recheck = 0;
  private planned = false;

  constructor(walkGraph: NavGraph, driveGraph: NavGraph) {
    this.walkPlanner = new RoutePlanner(walkGraph, 0);
    this.drivePlanner = new RoutePlanner(driveGraph, 0);
  }

  update(dt: number, origin: NavPoint, goal: GuidanceGoal | undefined, mode: GuidanceMode): readonly NavPoint[] {
    if (!goal) { this.clear(); return this.points; }
    this.recheck -= Math.max(0, dt);
    const movedGoal = !this.goal || (this.goal.x - goal.x) ** 2 + (this.goal.z - goal.z) ** 2 > GUIDANCE_TARGET_MOVE ** 2;
    const changed = this.goal?.key !== goal.key || this.mode !== mode || movedGoal;
    if (changed || !this.planned) return this.plan(origin, goal, mode);
    if (this.recheck > 0) return this.points;

    this.recheck = GUIDANCE_RECHECK_SECONDS;
    if (!this.points.length) return this.plan(origin, goal, mode);
    const nearest = nearestRoutePoint(this.points, origin);
    const tolerance = mode === 'drive' ? GUIDANCE_OFF_ROUTE_DRIVE : GUIDANCE_OFF_ROUTE_WALK;
    if (nearest.index < 0 || nearest.distance > tolerance) return this.plan(origin, goal, mode);
    // Keep one waypoint behind the player so the line joins their arrow instead of starting ahead.
    if (nearest.index > 1) this.points = this.points.slice(nearest.index - 1);
    return this.points;
  }

  clear(): void {
    this.points = [];
    this.goal = undefined;
    this.mode = undefined;
    this.recheck = 0;
    this.planned = false;
  }

  private plan(origin: NavPoint, goal: GuidanceGoal, mode: GuidanceMode): readonly NavPoint[] {
    const planner = mode === 'drive' ? this.drivePlanner : this.walkPlanner;
    const route = planner.planFar(origin.x, origin.z, goal.x, goal.z) ?? [];
    const points = route.map((point) => ({ x: point.x, z: point.z }));
    // No graph route means no line. A straight fallback across buildings/veld would look authoritative
    // while sending the player somewhere a vehicle cannot actually travel.
    if (points.length) {
      if (!samePoint(points[0], origin)) points.unshift({ x: origin.x, z: origin.z });
      if (!samePoint(points[points.length - 1], goal)) points.push({ x: goal.x, z: goal.z });
    }
    this.points = points.length > 1 ? points : [];
    this.goal = { ...goal };
    this.mode = mode;
    this.recheck = GUIDANCE_RECHECK_SECONDS;
    this.planned = true;
    return this.points;
  }
}
