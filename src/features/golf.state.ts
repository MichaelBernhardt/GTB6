/**
 * Golf's ENTIRE eager cost: the save slice, its sanitizer, and a cheap "is there golf under my
 * feet?" test for the registry's approach stand-in. Nothing here builds geometry, routes a hole or
 * knows what a three-click swing is — that all lives in the lazy body (src/features/golf/).
 *
 * This file sits at ONE path segment under src/features/, so vite.config.ts sweeps it into the
 * `gameplay-rules` chunk (see src/features/README.md, "Bundle rules"). The lazy body imports it with
 * `import type` ONLY; the runtime helpers below are for registry.ts.
 */
import { GREEN_POLYGONS, type MapPolygon } from '../world/mapData';

/** Gear the pro shop sells. Stored as plain ids so the save slice stays JSON-trivial. */
export const GOLF_GEAR_IDS = ['shirt', 'glove', 'shoes', 'putter', 'driver', 'irons'] as const;
export type GolfGearId = (typeof GOLF_GEAR_IDS)[number];

export interface GolfLayby {
  /** Gear id under lay-by. South African retail: 30% down, the club goes in your bag today. */
  item: GolfGearId;
  /** Rand still owed. Forty percent of every round's winnings goes here until it clears. */
  owing: number;
}

export interface GolfState {
  /** Best completed round, in strokes. Null until the first card is signed. */
  best: number | null;
  rounds: number;
  owned: GolfGearId[];
  /** Pro V1x in the bag. One is scuffed beyond use per round. */
  balls: number;
  layby: GolfLayby | null;
}

export const DEFAULT_GOLF_STATE: GolfState = { best: null, rounds: 0, owned: [], balls: 0, layby: null };

const GEAR = new Set<string>(GOLF_GEAR_IDS);
const clampInt = (value: unknown, lo: number, hi: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : lo;

/**
 * Refines the generically sanitized blob into GolfState. Runs inside SaveManager's synchronous
 * deserialize, so it imports nothing from the feature body and never throws on a hostile save.
 */
export function sanitizeGolfState(raw: unknown): GolfState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_GOLF_STATE, owned: [] };
  const source = raw as Record<string, unknown>;
  const owned: GolfGearId[] = [];
  if (Array.isArray(source.owned)) {
    for (const entry of source.owned) {
      if (typeof entry === 'string' && GEAR.has(entry) && !owned.includes(entry as GolfGearId)) owned.push(entry as GolfGearId);
    }
  }
  const rawLayby = source.layby;
  let layby: GolfLayby | null = null;
  if (rawLayby && typeof rawLayby === 'object' && !Array.isArray(rawLayby)) {
    const item = (rawLayby as Record<string, unknown>).item;
    const owing = clampInt((rawLayby as Record<string, unknown>).owing, 0, 200_000);
    // A settled or unknown lay-by is simply dropped: the gear stays in `owned`, the ledger closes.
    if (typeof item === 'string' && GEAR.has(item) && owing > 0) layby = { item: item as GolfGearId, owing };
  }
  const rawBest = source.best;
  const best = typeof rawBest === 'number' && Number.isFinite(rawBest) && rawBest > 0 ? Math.min(99, Math.round(rawBest)) : null;
  return { best, rounds: clampInt(source.rounds, 0, 99_999), owned, balls: clampInt(source.balls, 0, 99), layby };
}

// ---- the approach stand-in ------------------------------------------------------------------

/** A three-hole loop needs room. Anything smaller in the landuse layer is a driving range or a scrap. */
export const GOLF_MIN_AREA = 60_000;

/**
 * GREEN_POLYGONS drops the OSM `kind`, so golf is matched on the name the map kept — every
 * golf_course polygon in the crop is named "… Golf Course", "… Golf Club", "… Country Club" or the
 * bare kind string "golf_course". Never a typed coordinate: the map has moved once and will again.
 */
const GOLF_NAME = /golf|country club/i;

let cachedCourses: MapPolygon[] | undefined;

/** Every golf polygon large enough to route three holes on, biggest first. Derived once, on demand. */
export function golfPolygons(): MapPolygon[] {
  if (!cachedCourses) {
    cachedCourses = GREEN_POLYGONS
      .filter((polygon) => polygon.manicured === true && polygon.area >= GOLF_MIN_AREA && GOLF_NAME.test(polygon.name))
      .sort((a, b) => b.area - a.area);
  }
  return cachedCourses;
}

/** Even-odd point-in-polygon over a MapPolygon's ring. */
export function inGolfPolygon(polygon: MapPolygon, x: number, z: number): boolean {
  const points = polygon.points;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!; const b = points[j]!;
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The registry's proximity test: are you standing on ANY golf course? Deliberately not "the playable
 * one" — pressing E on a private club is how you find out it is a private club, and keeping the
 * choice of course entirely inside the lazy body means no derivation is duplicated across the
 * eager/lazy boundary. Bbox-rejects first, so the common case is a handful of comparisons.
 */
export function nearGolfCourse(x: number, z: number, margin = 24): boolean {
  for (const polygon of golfPolygons()) {
    if (x < polygon.minX - margin || x > polygon.maxX + margin || z < polygon.minZ - margin || z > polygon.maxZ + margin) continue;
    if (inGolfPolygon(polygon, x, z)) return true;
  }
  return false;
}
