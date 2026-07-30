/**
 * Building interiors — the EAGER half: the save slice, the shared types, and the one cheap test that
 * decides when the body is worth fetching.
 *
 * This file sits one path segment under src/features/, so vite.config.ts sweeps it into the
 * `gameplay-rules` chunk. Everything that knows where a door IS lives in src/features/interiors/,
 * which matches no chunk rule and ships as its own async chunk.
 *
 * WHY NO DOOR TABLE LIVES HERE ANY MORE. A door has to sit on a real BUILDING, and buildings come
 * from src/world/CityGen.ts, which vite.config.ts puts in the `simulation` chunk — and `simulation`
 * already imports `gameplay-rules` (PopulationSystem -> FearSystem). Importing CityGen from this file
 * would make the two chunks mutually uninitialisable and `npm run build` would (correctly) fail with
 * CIRCULAR_CHUNK. So the door table moved into the lazy body, which may import anything, and what is
 * left here is a road-distance test: "is the player standing in a street at all".
 */
import { distanceToRoadEdge, pointInAnyPolygon, ROAD_EDGE_CAP, WATER_POLYGONS } from '../world/mapData';

/** Structural, not decorative: this is the type only, so it costs the eager chunk nothing. Every
 *  field is read off BuildingArchitecture's own entrance tag — see interiors/doors.ts. */
export interface InteriorDoor {
  /** Stable across builds: the building's own rounded footprint centre. */
  readonly id: string;
  /** Shown on the prompt, the sign over the door and the HUD chip. */
  readonly name: string;
  /** The doorstep you stand on — a stride in front of the tagged wall plane. */
  readonly x: number;
  readonly z: number;
  /** The tagged wall plane itself: where the model's own glazed leaf is mounted. */
  readonly faceX: number;
  readonly faceZ: number;
  /** Yaw of the way OUT. Stand on the step facing this and the street is in front of you; the
   *  building is behind you. Equal to the building's own heading, which CityGen already aims at the
   *  street it fronts. */
  readonly heading: number;
  /** Clear width of the opening the model drew, so the frame matches the wall it is on. */
  readonly openWidth: number;
  /** Head height of that same opening. A cottage's door is 2 m and its wall is 2.5: a fixed 3.4 m
   *  reveal on it is a hole through the roof, which is what the first version drew. */
  readonly openHeight: number;
  /** The building's TOP massing tier, building-local, read off the same tiers City pushes as
   *  colliders — so this rectangle is exactly the flat top a player can already stand on. Powers
   *  roof entry (stand here, drop into the top floor) and roof exit (the hatch teleports onto it).
   *  Undefined when the model's top is too small to stand a player on. */
  readonly roof?: {
    readonly minX: number; readonly maxX: number;
    readonly minZ: number; readonly maxZ: number;
    /** Building-local height of that top — world roof height is the building's base plus this. */
    readonly topY: number;
  };
  /** Everything the interior generator needs about the host building. */
  readonly facts: import('./interiors/core').BuildingFacts;
}

/** How close to the doorstep the prompt lights up. Deliberately close to a shop pad's 3.6: the
 *  feature sits ABOVE `E  Enter vehicle` in Game's on-foot ladder, so a wide ring would stop the
 *  player getting into a car parked at the kerb. */
export const DOOR_RADIUS = 4.2;

/** Ring of probes around the player. distanceToRoadEdge saturates at ROAD_EDGE_CAP (14u), so "is
 *  there a street near here" has to be asked at several points, not scaled up from one. */
const PROBES: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (const radius of [55, 110]) {
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      out.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
  }
  return out;
})();

/**
 * The preload ring — see the note in host.preloadNearby(). A lazily loaded feature cannot put
 * anything in the world until its body arrives, so a feature whose whole point is "you can see it
 * from down the street" is invisible until the first key press. Every other feature rides that ring
 * on its `approach.near`; this one cannot, because `near` answers "are you on a doorstep" and only
 * the loaded body knows where a doorstep is. So the approach declares `preload` and this is it:
 * there is a street within about 110 u, so the doorways are worth fetching. Seventeen grid lookups,
 * no allocation beyond the cell keys, and it stops being asked the moment the body lands (the host
 * polls unloaded features only, every 0.4 s).
 */
export function streetsHere(x: number, z: number): boolean {
  if (pointInAnyPolygon(WATER_POLYGONS, x, z)) return false;
  if (distanceToRoadEdge(x, z) < ROAD_EDGE_CAP - 0.01) return true;
  for (const [dx, dz] of PROBES) if (distanceToRoadEdge(x + dx, z + dz) < ROAD_EDGE_CAP - 0.01) return true;
  return false;
}

// ---- save ---------------------------------------------------------------------------------------

export interface InteriorsSave {
  /** Door ids whose first-visit find has already been paid out (most recent 32). */
  visited: string[];
  /** How many finds have been paid, ever. Caps the payout so a city full of doors is a discovery,
   *  never a farm. */
  finds: number;
}

/** How many first visits pay out. Small, generous, and then it stops mattering. */
export const FIND_CAP = 12;

/** Runs inside SaveManager's synchronous deserialize, on an already generically-sanitised blob. */
export function sanitizeInteriorsState(raw: unknown): InteriorsSave {
  const source = (raw ?? {}) as { visited?: unknown; finds?: unknown };
  const visited = Array.isArray(source.visited)
    ? source.visited.filter((entry): entry is string => typeof entry === 'string' && entry.length < 32).slice(0, 32)
    : [];
  const finds = typeof source.finds === 'number' && Number.isFinite(source.finds)
    ? Math.max(0, Math.min(FIND_CAP, Math.floor(source.finds)))
    : 0;
  return { visited, finds };
}
