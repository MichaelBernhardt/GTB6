/**
 * THE REAL VAAL DAM — parsed out of the committed one-off Overpass extract and re-oriented so a
 * strip of its NORTH-WEST shore can become the map's west edge.
 *
 * Why real data at all: the previous shore was fBm noise plus three hand-placed "drowned valley"
 * notches, and it read as noise. The Vaal is a flooded river system — its crenellation is not
 * decoration, it is the shape of the drowned Wilge and Vaal valleys, and no amount of fBm gets
 * Deneysville's headland, the northern arm, or the channel behind Grooteiland.
 *
 * THE ORIENTATION (the one non-obvious step). The map needs water WEST of a shoreline that is
 * single-valued in z (dam.ts rule 1). The real north shore of the Vaal runs west->east with water
 * to its SOUTH. So the strip is rotated by -90 degrees:
 *
 *      real north  ->  game east        real east  ->  game south
 *      real south  ->  game west        real west  ->  game north
 *
 * which puts the water west of the shore for free, and — because the dam wall sits at the
 * reservoir's western tip — puts the wall and Deneysville near the TOP of the map, exactly the
 * composition asked for. Walking the run west->east in the real world walks it north->south in
 * the game, past the wall, up the northern arm (the waterway), around Grooteiland, along the
 * Misty Bay / Marina Latata shore and out at Vaal Marina.
 *
 * This module only PARSES and ROTATES. All fitting (scale, monotone unfolding, the soft-clip that
 * squeezes a 10 km arm into a 2 km-wide band) lives in dam.ts, so the raw geography stays legible.
 */
import { VAAL_MIN_ISLAND_POINTS, VAAL_ORIGIN, VAAL_SHORE_END, VAAL_SHORE_MID, VAAL_SHORE_START, VAAL_WATER_RELATION } from './config';
import { makeProjector } from './projection';
import type { OsmElement, OsmNode, OsmRelation, OsmResponse, OsmWay, Pt } from './types';

/** A named point on the real shore, already in the game-oriented Vaal frame. */
export interface VaalFeature {
  name: string;
  /** Coarse class used to pick the in-game dressing. */
  kind: 'settlement' | 'wall' | 'marina' | 'slipway' | 'camp' | 'resort' | 'attraction' | 'fuel' | 'sewage' | 'club';
  p: Pt;
}

export interface VaalStrip {
  /** North-shore run, game-oriented Vaal metres, ordered NORTH -> SOUTH (increasing z). */
  shore: Pt[];
  /** Island rings (relation inner rings) that fall inside the strip's bbox, largest first. */
  islands: Array<{ id: number; points: Pt[] }>;
  features: VaalFeature[];
  /** Real-world span of the retained strip, for the "how much of the real dam is this" report. */
  span: { x: number; z: number; lengthM: number };
  log: string[];
}

const project = makeProjector(VAAL_ORIGIN);

/**
 * Real lat/lon -> game-oriented Vaal metres. `project` gives x east / z south; the -90 degree
 * rotation is then simply (x, z) -> (-z, x).
 */
export function toVaalFrame(lat: number, lon: number): Pt {
  const p = project(lat, lon);
  return { x: -p.z, z: p.x };
}

/** Chain relation member ways (matched on endpoint COORDINATES — `out geom` carries no node ids). */
function chainRings(members: Array<Array<{ lat: number; lon: number }>>): Array<Array<{ lat: number; lon: number }>> {
  const key = (p: { lat: number; lon: number }): string => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const remaining = members.filter((m) => m.length >= 2).map((m) => [...m]);
  const rings: Array<Array<{ lat: number; lon: number }>> = [];
  while (remaining.length > 0) {
    let chain = remaining.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i]!;
        if (key(c[0]!) === key(chain[chain.length - 1]!)) chain = chain.concat(c.slice(1));
        else if (key(c[c.length - 1]!) === key(chain[chain.length - 1]!)) chain = chain.concat(c.slice(0, -1).reverse());
        else if (key(c[c.length - 1]!) === key(chain[0]!)) chain = c.slice(0, -1).concat(chain);
        else if (key(c[0]!) === key(chain[0]!)) chain = c.slice(1).reverse().concat(chain);
        else continue;
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    rings.push(chain);
  }
  return rings.sort((a, b) => b.length - a.length);
}

const nearestIndex = (pts: Pt[], q: Pt): number => {
  let best = 0; let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i]!.x - q.x) ** 2 + (pts[i]!.z - q.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
};

const FEATURE_KIND = (tags: Record<string, string>): VaalFeature['kind'] | null => {
  if (tags.man_made === 'wastewater_plant') return 'sewage';
  if (tags.waterway === 'dam') return 'wall';
  if (tags.leisure === 'marina') return 'marina';
  if (tags.leisure === 'slipway' || tags.service === 'slipway') return 'slipway';
  if (tags.leisure === 'sports_centre') return 'club';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') return 'camp';
  if (tags.tourism === 'resort' || tags.tourism === 'chalet' || tags.leisure === 'resort') return 'resort';
  if (tags.tourism === 'attraction') return 'attraction';
  if (tags.place) return 'settlement';
  if (tags.leisure === 'fishing' || tags.natural === 'beach') return 'resort';
  return null;
};

/**
 * Pull the north-shore run, the islands and the shore furniture out of the Vaal extract.
 *
 * The run is defined by three GEOGRAPHIC anchors rather than by indices into the chained ring:
 * the chaining order depends on which member way happens to come first in the relation, so an
 * index would silently point somewhere else after any OSM edit. START and END cut the run; MID
 * disambiguates which way round the closed ring to travel.
 */
export function parseVaal(data: OsmResponse): VaalStrip {
  const log: string[] = [];
  const relation = data.elements.find(
    (e): e is OsmRelation => e.type === 'relation' && e.id === VAAL_WATER_RELATION,
  );
  if (!relation) throw new Error(`Vaal extract has no relation ${VAAL_WATER_RELATION}`);

  const outer = relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry!);
  const innerMembers = relation.members.filter((m) => m.role === 'inner' && m.geometry?.length);
  if (outer.length === 0) throw new Error('Vaal relation carries no `out geom` outer geometry — refetch with out geom');

  const rings = chainRings(outer);
  const ring = rings[0]!.map((g) => toVaalFrame(g.lat, g.lon));
  log.push(`vaal: outer ring ${ring.length} pts chained from ${outer.length} member ways (${rings.length} ring(s))`);

  const startI = nearestIndex(ring, toVaalFrame(VAAL_SHORE_START.lat, VAAL_SHORE_START.lon));
  const midI = nearestIndex(ring, toVaalFrame(VAAL_SHORE_MID.lat, VAAL_SHORE_MID.lon));
  const endI = nearestIndex(ring, toVaalFrame(VAAL_SHORE_END.lat, VAAL_SHORE_END.lon));
  const n = ring.length;
  const forward = (from: number, to: number): Pt[] => {
    const out: Pt[] = [];
    for (let i = from; ; i = (i + 1) % n) { out.push(ring[i]!); if (i === to) break; }
    return out;
  };
  const between = (from: number, to: number, probe: number): boolean => {
    const span = (to - from + n) % n;
    return ((probe - from + n) % n) <= span;
  };
  // Travel whichever way round the closed ring passes the MID anchor (up the northern arm).
  const shore = between(startI, endI, midI) ? forward(startI, endI) : forward(endI, startI).reverse();

  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity; let length = 0;
  for (let i = 0; i < shore.length; i++) {
    const p = shore[i]!;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    if (i > 0) length += Math.hypot(p.x - shore[i - 1]!.x, p.z - shore[i - 1]!.z);
  }
  log.push(
    `vaal: north-shore run ${shore.length} pts, ${(length / 1000).toFixed(1)} km of real shoreline across ` +
      `${((maxZ - minZ) / 1000).toFixed(1)} x ${((maxX - minX) / 1000).toFixed(1)} km of the real dam`,
  );

  // Islands: inner rings whose centroid falls inside the strip's bbox. Only rings with real
  // outlines are kept — the 20-odd-vertex islets are sub-pixel at the fitted 1:4 scale, and they
  // land west of the world edge where process.ts would only drop them again.
  const islands = innerMembers
    .filter((m) => m.geometry!.length >= VAAL_MIN_ISLAND_POINTS)
    .map((m) => ({ id: m.ref, points: m.geometry!.map((g) => toVaalFrame(g.lat, g.lon)) }))
    .filter((island) => {
      const cx = island.points.reduce((s, p) => s + p.x, 0) / island.points.length;
      const cz = island.points.reduce((s, p) => s + p.z, 0) / island.points.length;
      return cx >= minX && cx <= maxX && cz >= minZ && cz <= maxZ;
    })
    .sort((a, b) => b.points.length - a.points.length);
  log.push(`vaal: ${islands.length} island(s) inside the strip (largest ${islands[0]?.points.length ?? 0} pts)`);

  const features: VaalFeature[] = [];
  for (const element of data.elements as OsmElement[]) {
    if (element.type === 'relation' && element.id === VAAL_WATER_RELATION) continue;
    const tags = element.tags;
    if (!tags) continue;
    const kind = FEATURE_KIND(tags);
    if (!kind) continue;
    const centre = element.type === 'node'
      ? { lat: (element as OsmNode).lat, lon: (element as OsmNode).lon }
      : (element as OsmWay | OsmRelation).center;
    if (!centre) continue;
    features.push({ name: tags.name ?? `${kind}`, kind, p: toVaalFrame(centre.lat, centre.lon) });
  }
  log.push(`vaal: ${features.length} shore features (${[...new Set(features.map((f) => f.kind))].join(', ')})`);

  return { shore, islands, features, span: { x: maxX - minX, z: maxZ - minZ, lengthM: length }, log };
}
