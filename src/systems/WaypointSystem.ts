import type { MapPoint } from '../ui/MinimapView';

export const WAYPOINT_REACHED_RADIUS = 14;

/** Horizontal arrival check for a player-placed GPS pin. Terrain height is irrelevant. */
export function waypointReached(
  waypoint: MapPoint | undefined, position: MapPoint, radius = WAYPOINT_REACHED_RADIUS,
): boolean {
  if (!waypoint) return false;
  return (waypoint.x - position.x) ** 2 + (waypoint.z - position.z) ** 2 <= radius * radius;
}
