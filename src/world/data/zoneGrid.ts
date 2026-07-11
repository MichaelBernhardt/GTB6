/**
 * Population zone grid (owner's zone-local density model). The 18000u map is far bigger than the
 * player can ever see at once, so a single global population target spreads people to homeopathic
 * dilution. Instead the world is diced into square zones; only the player's zone and its eight
 * neighbours (a 3×3 block) are ever populated, and each of those zones earns its own ped/car target
 * from its land-use character. Everything beyond the 3×3 is dead — fog and the ~2500u chunk-visibility
 * limit hide the seam.
 *
 * Pure data + pure functions (classification + grid maths only, no three.js) so the lifecycle census
 * and the tests can consume it freely. Character sampling is deterministic: a fixed probe grid over
 * the zone, classified through zoning.ts.
 */
import { WORLD_SIZE } from '../../config';
import { nearestDistrict } from '../mapData';
import { classifyZone, ZONES, type Zone } from './zoning';

/**
 * Edge length (units) of one population zone. Sized so the 3×3 active block spans 3×1800 = 5400u
 * (±2700u around the player) — comfortably past the ~2500u chunk-visibility range, so the dead ring
 * beyond the active set always falls in fog, never in a visible empty seam. It also sits well outside
 * the 500u AI freeze radius, so a zone can leave the active set only long after its agents froze.
 */
export const ZONE_SIZE = 1800;

/** Zones per axis across the square world (ceil so the far edge is always covered). */
export const ZONE_COLS = Math.max(1, Math.ceil(WORLD_SIZE / ZONE_SIZE));

/**
 * Units the player must travel PAST a zone boundary before the current zone flips. A dead-band this
 * wide (the switch costs ZONE_SIZE + 2×hysteresis of travel) stops a player driving along a seam from
 * thrashing the active set — and therefore the spawn/despawn churn — every few metres.
 */
export const ZONE_HYSTERESIS = 220;

/** How many probes per axis when sampling a zone's dominant land-use character (25 total). */
export const ZONE_CHARACTER_SAMPLES = 5;

/**
 * Mean building density at/above which a residential-dominant zone reads as a bustling retail strip
 * instead of an ordinary suburb. Far higher than zoning.ts's per-frontage STRIP_DENSITY (60): that
 * gate also requires an arterial road, whereas here we judge a whole zone on density alone, so only
 * the genuinely dense inner-ring suburbs (top ~quartile — Greenside, Brixton, Mayfair) qualify.
 */
export const ZONE_STRIP_DENSITY = 300;

export interface ZoneCell { col: number; row: number; }

/** Stable scalar id for a grid cell; usable as a Map/Set key. */
export function zoneKey(col: number, row: number): number { return row * ZONE_COLS + col; }

/** Raw grid index of a world coordinate along one axis, clamped to the grid. */
export function axisIndex(coord: number): number {
  return Math.min(ZONE_COLS - 1, Math.max(0, Math.floor((coord + WORLD_SIZE / 2) / ZONE_SIZE)));
}

/** The grid cell a world point sits in. */
export function zoneOf(x: number, z: number): ZoneCell { return { col: axisIndex(x), row: axisIndex(z) }; }

/**
 * Advance one axis' current index toward `coord` with hysteresis: hold the current cell until the
 * player is ZONE_HYSTERESIS past its edge, then snap to wherever the coordinate now is (which also
 * absorbs multi-cell jumps like a teleport in a single step).
 */
export function advanceAxis(current: number, coord: number): number {
  const clamped = Math.min(ZONE_COLS - 1, Math.max(0, current));
  const lower = clamped * ZONE_SIZE - WORLD_SIZE / 2;
  const upper = lower + ZONE_SIZE;
  if (coord > upper + ZONE_HYSTERESIS || coord < lower - ZONE_HYSTERESIS) return axisIndex(coord);
  return clamped;
}

/** Slide the current zone toward the viewpoint, one hysteresis-gated step per axis. */
export function advanceZone(current: ZoneCell, x: number, z: number): ZoneCell {
  return { col: advanceAxis(current.col, x), row: advanceAxis(current.row, z) };
}

/** The player's zone plus its up-to-eight neighbours (fewer at the map edge), clamped to the grid. */
export function activeZones(current: ZoneCell): ZoneCell[] {
  const cells: ZoneCell[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const col = current.col + dc; const row = current.row + dr;
    if (col < 0 || row < 0 || col >= ZONE_COLS || row >= ZONE_COLS) continue;
    cells.push({ col, row });
  }
  return cells;
}

const characterCache = new Map<number, Zone>();

/** Dominant land-use zone across a probe grid; a dense-enough residential zone reads as a retail strip. */
function dominantCharacter(counts: Map<Zone, number>, meanDensity: number): Zone {
  let best: Zone = 'none'; let bestCount = -1;
  for (const zone of ZONES) { const count = counts.get(zone) ?? 0; if (count > bestCount) { bestCount = count; best = zone; } } // ZONES order breaks ties toward the denser character
  if (best === 'residential' && meanDensity >= ZONE_STRIP_DENSITY) return 'commercial-strip';
  return best;
}

/**
 * The land-use character of a whole zone, from a deterministic probe grid classified through
 * zoning.ts. Cached: a cell's character is fixed committed-map data, so it is computed at most once.
 */
export function zoneCharacter(col: number, row: number): Zone {
  const key = zoneKey(col, row);
  const cached = characterCache.get(key);
  if (cached !== undefined) return cached;
  const left = col * ZONE_SIZE - WORLD_SIZE / 2;
  const top = row * ZONE_SIZE - WORLD_SIZE / 2;
  const counts = new Map<Zone, number>();
  let densitySum = 0;
  for (let i = 0; i < ZONE_CHARACTER_SAMPLES; i++) for (let j = 0; j < ZONE_CHARACTER_SAMPLES; j++) {
    const x = left + (i + 0.5) / ZONE_CHARACTER_SAMPLES * ZONE_SIZE;
    const z = top + (j + 0.5) / ZONE_CHARACTER_SAMPLES * ZONE_SIZE;
    const zone = classifyZone(x, z);
    counts.set(zone, (counts.get(zone) ?? 0) + 1);
    densitySum += nearestDistrict(x, z).density;
  }
  const character = dominantCharacter(counts, densitySum / (ZONE_CHARACTER_SAMPLES * ZONE_CHARACTER_SAMPLES));
  characterCache.set(key, character);
  return character;
}
