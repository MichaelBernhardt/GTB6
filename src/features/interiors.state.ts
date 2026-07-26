/**
 * Building interiors — the EAGER half: the save slice and the doorsteps.
 *
 * This file sits one path segment under src/features/, so vite.config.ts sweeps it into the
 * `gameplay-rules` chunk. It must stay small and free of three.js: everything that builds a room
 * lives in src/features/interiors/, which matches no chunk rule and ships as its own async chunk
 * fetched the first time somebody walks up to a door.
 *
 * Every doorstep is DERIVED from the generated map at runtime — a landmark anchor, a district
 * centre, and the road network's own vertices — and memoised on first use. Nothing here is a typed
 * world coordinate: mapgen is re-run against OSM and the world is being reshaped, so a literal
 * would be wrong by the next bake.
 */
import { DISTRICT_CENTERS, distanceToRoadEdge, GENERATED_ROADS, landmark, pointInAnyPolygon, WATER_POLYGONS, type MapPt } from '../world/mapData';
import { ARMS_SITE, BOTTLE_STORES, GARAGE_SITE, HOTDOG_SITE, SAFEHOUSE_SITE, SPAWN_POINT, SPRAY_SITE } from '../world/placements';

export type InteriorKind = 'spaza' | 'flat' | 'ponte';

export interface InteriorDoor {
  readonly id: string;
  readonly kind: InteriorKind;
  /** Shown on the prompt, the HUD chip and the notification. */
  readonly name: string;
  /** Doorstep, on the building line beside the kerb. */
  readonly x: number;
  readonly z: number;
  /** Yaw of the way OUT: stand on the step facing this and the street is in front of you. */
  readonly heading: number;
}

/** How close you must be for the doorway prompt. A shade wider than a shop pad (3.6) because there
 *  is no pulsing marker to aim at until the feature's own chunk has landed. */
export const DOOR_RADIUS = 7;

/** Kerbside anchors already spoken for by shops, the safehouse and the depot — a door must not
 *  land on top of one, or two prompts fight over the same square metre of pavement. */
function claims(): MapPt[] {
  return [ARMS_SITE.pad, SPRAY_SITE.pad, GARAGE_SITE.pad, HOTDOG_SITE.pad, SAFEHOUSE_SITE.pad, ...BOTTLE_STORES.map((store) => store.site.pad)];
}

interface RoadVertex { x: number; z: number; dirX: number; dirZ: number; width: number; d2: number }

/** The `count` road vertices nearest an anchor, nearest first. One pass over the generated network. */
function nearestVertices(x: number, z: number, count: number): RoadVertex[] {
  const best: RoadVertex[] = [];
  for (const road of GENERATED_ROADS) {
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!;
      const d2 = (point.x - x) ** 2 + (point.z - z) ** 2;
      if (best.length === count && d2 >= best[best.length - 1]!.d2) continue;
      const previous = road.points[Math.max(0, index - 1)]!;
      const next = road.points[Math.min(road.points.length - 1, index + 1)]!;
      const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
      const vertex: RoadVertex = { x: point.x, z: point.z, dirX: dx / length, dirZ: dz / length, width: road.width, d2 };
      const at = best.findIndex((entry) => entry.d2 > d2);
      if (at === -1) best.push(vertex); else best.splice(at, 0, vertex);
      if (best.length > count) best.pop();
    }
  }
  return best;
}

/** A doorstep on the building line: the kerb vertex nearest the anchor, stepped back off the road
 *  on the side the anchor sits, skipping anything another system has already claimed. */
function doorstep(anchor: MapPt, taken: MapPt[]): { x: number; z: number; heading: number } | undefined {
  for (const vertex of nearestVertices(anchor.x, anchor.z, 48)) {
    // besideRoad's own perpendicular step, inlined so this module needs no RoadSpot value import.
    const beside = (side: 1 | -1): MapPt => {
      const offset = side * (vertex.width / 2 + 3.4);
      return { x: vertex.x - vertex.dirZ * offset, z: vertex.z + vertex.dirX * offset };
    };
    const a = beside(1); const b = beside(-1);
    const step = Math.hypot(a.x - anchor.x, a.z - anchor.z) <= Math.hypot(b.x - anchor.x, b.z - anchor.z) ? a : b;
    // The kerb offset only clears the road this vertex belongs to. In the CBD grid a second road
    // crosses within metres, so the step has to be re-tested against the whole network or a door
    // lands in the middle of the carriageway (caught by interiors.state.test.ts).
    if (distanceToRoadEdge(step.x, step.z) < 1.2) continue;
    if (pointInAnyPolygon(WATER_POLYGONS, step.x, step.z)) continue;
    if (taken.some((pad) => Math.hypot(pad.x - step.x, pad.z - step.z) < 26)) continue;
    return { x: step.x, z: step.z, heading: Math.atan2(vertex.x - step.x, vertex.z - step.z) };
  }
  return undefined;
}

function district(name: string): MapPt | undefined {
  const found = DISTRICT_CENTERS.find((entry) => entry.name === name);
  return found ? { x: found.x, z: found.z } : undefined;
}

/** Densest district that is not the one the player spawns in — the fallback anchor when a named
 *  suburb has been renamed or dropped by a map rebuild. */
function densestAway(from: MapPt): MapPt | undefined {
  let best: MapPt | undefined; let bestDensity = -1;
  for (const entry of DISTRICT_CENTERS) {
    if (Math.hypot(entry.x - from.x, entry.z - from.z) < 900) continue;
    if (entry.density > bestDensity) { bestDensity = entry.density; best = { x: entry.x, z: entry.z }; }
  }
  return best;
}

let memo: readonly InteriorDoor[] | undefined;

/** The doorsteps, derived once per session from map data. Memoised because `near()` runs every
 *  rendered frame from the registry's eager approach. */
export function interiorDoors(): readonly InteriorDoor[] {
  if (memo) return memo;
  const taken = claims();
  const doors: InteriorDoor[] = [];
  const add = (id: string, kind: InteriorKind, name: string, anchor: MapPt | undefined): void => {
    if (!anchor) return;
    const step = doorstep(anchor, taken);
    if (!step) return;
    taken.push({ x: step.x, z: step.z });
    doors.push({ id, kind, name, x: step.x, z: step.z, heading: step.heading });
  };
  // A spaza a short walk from the spawn kerb, so the first door is one you actually trip over.
  add('spaza', 'spaza', 'Sizwe se Spaza', { x: SPAWN_POINT.x + 120, z: SPAWN_POINT.z - 60 });
  add('flat', 'flat', 'Flat 704', district('Hillbrow') ?? district('Yeoville') ?? densestAway(SPAWN_POINT));
  add('ponte', 'ponte', 'Ponte Tower', landmark('Ponte Tower') ?? landmark('Hillbrow tower'));
  memo = doors;
  return memo;
}

/** The doorstep under a point, or undefined. Shared by the eager approach and the loaded rung so
 *  the ring the prompt appears in and the ring E acts in are the same ring. */
export function doorNear(x: number, z: number): InteriorDoor | undefined {
  let best: InteriorDoor | undefined; let bestDistance = DOOR_RADIUS;
  for (const door of interiorDoors()) {
    const distance = Math.hypot(door.x - x, door.z - z);
    if (distance < bestDistance) { best = door; bestDistance = distance; }
  }
  return best;
}

// ---- save ---------------------------------------------------------------------------------------

export interface InteriorsSave {
  /** Door ids whose first-visit find has already been paid out. */
  visited: string[];
}

/** Runs inside SaveManager's synchronous deserialize, on an already generically-sanitised blob. */
export function sanitizeInteriorsState(raw: unknown): InteriorsSave {
  const source = (raw ?? {}) as { visited?: unknown };
  const visited = Array.isArray(source.visited)
    ? source.visited.filter((entry): entry is string => typeof entry === 'string' && entry.length < 32).slice(0, 32)
    : [];
  return { visited };
}
