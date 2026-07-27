/**
 * THE REAL VAAL DAM — parsed out of the committed one-off Overpass extract, and NOTHING ELSE.
 *
 * This module used to cut a "north-shore run" out of the ring and rotate it by -90 degrees so a
 * strip of it could become the map's west edge. Both of those were the beginning of the deformation
 * chain that four passes died on: once you have a strip rather than a polygon, the only way to make
 * it fit is to bend it.
 *
 * So it now returns the WHOLE water body — the chained outer ring and every inner ring, including
 * Grooteiland (way 6139539) — in plain projected metres (x east, z south) with no rotation at all.
 * The single rotation, the single uniform scale and the single translation all live in dam.ts, and
 * the clip that decides what the map keeps lives there too.
 */
import { VAAL_MIN_ISLAND_POINTS, VAAL_ORIGIN, VAAL_WATER_RELATION } from './config';
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
  /** The dam's whole outer ring, projected metres, in ring order. Unrotated, unscaled, uncut. */
  outer: Pt[];
  /** Every inner ring (island) of the relation, largest first. Grooteiland is way 6139539. */
  islands: Array<{ id: number; points: Pt[] }>;
  features: VaalFeature[];
  /** Real-world span of the retained strip, for the "how much of the real dam is this" report. */
  span: { x: number; z: number; lengthM: number };
  log: string[];
}

const project = makeProjector(VAAL_ORIGIN);

/**
 * Real lat/lon -> projected metres about VAAL_ORIGIN, x east / z south. No rotation: the map's
 * orientation is one rotation applied once, in dam.ts, to the whole body at once.
 */
export function toVaalFrame(lat: number, lon: number): Pt {
  return project(lat, lon);
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

  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity; let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    if (i > 0) length += Math.hypot(p.x - ring[i - 1]!.x, p.z - ring[i - 1]!.z);
  }
  log.push(
    `vaal: ${(length / 1000).toFixed(1)} km of real shoreline around a ` +
      `${((maxX - minX) / 1000).toFixed(1)} x ${((maxZ - minZ) / 1000).toFixed(1)} km body`,
  );

  // EVERY inner ring, largest first. Which of them survive is dam.ts's decision, taken after the
  // placement, on the only basis that matters: whether the island lands in the world square and is
  // big enough to read. Grooteiland is way 6139539 and has 281 vertices.
  const islands = innerMembers
    .filter((m) => m.geometry!.length >= VAAL_MIN_ISLAND_POINTS)
    .map((m) => ({ id: m.ref, points: m.geometry!.map((g) => toVaalFrame(g.lat, g.lon)) }))
    .sort((a, b) => b.points.length - a.points.length);
  log.push(`vaal: ${islands.length} island ring(s) (largest ${islands[0]?.points.length ?? 0} pts, ` +
    `Grooteiland ${islands.some((i) => i.id === 6139539) ? 'present' : 'MISSING'})`);

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

  return { outer: ring, islands, features, span: { x: maxX - minX, z: maxZ - minZ, lengthM: length }, log };
}
