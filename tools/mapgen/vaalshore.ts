/**
 * THE REAL NORTH-SHORE INFRASTRUCTURE — Deneysville, Refengkgotso, Misty Bay, Vaal Marina and
 * everything else people actually built on the Vaal Dam, parsed out of the second committed
 * Overpass extract (overpass.ts fetchVaalShore) and re-oriented into the same game frame as the
 * water (vaal.ts toVaalFrame).
 *
 * WHY THIS EXISTS. The first pass fetched only the water relation, so the map got a beautiful real
 * shoreline with nothing on it: Deneysville, Misty Bay and Vaal Marina were empty veld with a
 * district label floating over them, and the owner's verdict was "it doesn't have the roads from
 * Misty Bay, etc. It is very bland". Only five roads existed west of x = -3000 and every one was
 * synthesised.
 *
 * THE ONE RULE. Nothing here decides WHERE anything goes. Every point is pushed through
 * DamShore.mapPoint — the identical unfold drift, de-tilt, soft-clip and run-out the shoreline
 * itself went through — so a slipway that is 40 m from the water in Deneysville is 40 m from the
 * water in the game, for free, at whatever strip and scale the dam is currently fitted at.
 *
 * This module PARSES and CLASSIFIES only. coast.ts does the mapping and the network surgery.
 */
import { ROAD_WIDTHS, VAAL_SHORE_CHAIN_TURN_DEG, VAAL_SHORE_MIN_AREA_M2, VAAL_SHORE_STREET_NAMES, VAAL_SHORE_UNNAMED_ROAD } from './config';
import { toVaalFrame } from './vaal';
import type { MapArea, OsmElement, OsmNode, OsmResponse, OsmWay, Pt, RoadKind } from './types';

/** A real street, still as OSM node ids so ways that meet at a node share a graph node. */
export interface ShoreRoad {
  id: number;
  name: string | null;
  kind: RoadKind;
  width: number;
  /** OSM node ids, in order. */
  nodes: number[];
}

export interface ShorePlace {
  name: string;
  /** OSM place=* value (town / village / suburb / island / islet). */
  place: string;
  p: Pt;
}

export interface ShorePoi {
  name: string;
  /** Coarse class used to pick the in-game dressing and the map icon. */
  kind: string;
  p: Pt;
}

export interface VaalShoreExtract {
  /** OSM node id -> point in the game-oriented Vaal frame (real metres). */
  nodes: Map<number, Pt>;
  roads: ShoreRoad[];
  /** Unpaved farm tracks and footpaths — drawn, but deliberately NOT in the drivable graph. */
  tracks: Array<{ name: string; kind: 'track' | 'path'; points: Pt[] }>;
  areas: Array<{ name: string; kind: MapArea['kind']; points: Pt[] }>;
  places: ShorePlace[];
  pois: ShorePoi[];
  /** REAL building footprints — the traced outline, not just a centroid. The map used to reduce
   *  these 498 polygons to five district density scalars, which is why Deneysville's actual houses
   *  never appeared; they are now carried through as geometry (see coast.ts / CityGen). */
  buildings: Array<{ p: Pt; kind: string; areaM2: number; points: Pt[] }>;
  log: string[];
}

/**
 * OSM highway class -> the game's road kinds. Anything not listed is a track, a path or ignored.
 * Width is NOT set here: output.test.ts asserts road.width === ROAD_WIDTHS[road.kind] across the
 * whole map, and that invariant is worth more than a narrower marina lane.
 *
 * Service roads ARE the content at Misty Bay and the marinas — 32 private lanes off Ring Road down
 * to the moorings — so they come in as residential rather than being dropped: driving down to a
 * slipway is the point.
 */
const ROAD_CLASS: Record<string, RoadKind> = {
  primary: 'primary',
  primary_link: 'primary_link',
  secondary: 'secondary',
  secondary_link: 'secondary_link',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary_link',
  unclassified: 'residential',
  residential: 'residential',
  living_street: 'residential',
  service: 'residential',
};

const TRACK_CLASS: Record<string, 'track' | 'path'> = {
  track: 'track', path: 'path', footway: 'path', bridleway: 'path', cycleway: 'path', steps: 'path',
};

/** MapArea kinds the shore extract can contribute. Residential/industrial landuse is deliberately
 *  NOT painted: the towns are drawn by their streets and the procedural massing that follows them,
 *  and a green wash over Deneysville would hide exactly what the owner said was missing. */
function shoreAreaKind(tags: Record<string, string>): MapArea['kind'] | null {
  if (tags.leisure === 'nature_reserve') return 'nature_reserve';
  if (tags.leisure === 'park' || tags.leisure === 'garden') return 'park';
  if (tags.leisure === 'pitch' || tags.leisure === 'sports_centre' || tags.landuse === 'recreation_ground') return 'grass';
  if (tags.landuse === 'cemetery' || tags.landuse === 'grass' || tags.landuse === 'village_green') return 'grass';
  if (tags.landuse === 'farmland' || tags.landuse === 'farmyard' || tags.landuse === 'orchard') return 'farmland';
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'wood';
  if (tags.natural === 'scrub' || tags.natural === 'heath' || tags.natural === 'grassland') return 'scrub';
  if (tags.landuse === 'industrial' || tags.landuse === 'quarry' || tags.man_made === 'wastewater_plant') return 'brownfield';
  if (tags.aeroway === 'aerodrome') return 'aerodrome';
  return null;
}

/** The shore furniture worth a map landmark. Ordered most specific first. */
function poiKind(tags: Record<string, string>): string | null {
  if (tags.leisure === 'marina') return 'marina';
  if (tags.leisure === 'slipway' || tags.service === 'slipway') return 'slipway';
  if (tags.man_made === 'wastewater_plant') return 'sewage';
  if (tags.man_made === 'water_tower') return 'water_tower';
  if (tags.man_made === 'lighthouse') return 'lighthouse';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.amenity === 'police') return 'police';
  if (tags.amenity === 'prison') return 'prison';
  if (tags.amenity === 'pharmacy' || tags.amenity === 'doctors' || tags.amenity === 'clinic') return 'clinic';
  if (tags.amenity === 'school' || tags.amenity === 'college') return 'school';
  if (tags.amenity === 'restaurant' || tags.amenity === 'bar' || tags.amenity === 'pub' || tags.amenity === 'cafe') return 'restaurant';
  if (tags.amenity === 'post_office' || tags.amenity === 'public_building' || tags.amenity === 'townhall') return 'civic';
  if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') return 'camp';
  if (tags.tourism === 'resort' || tags.tourism === 'chalet' || tags.tourism === 'hotel' || tags.tourism === 'guest_house') return 'resort';
  if (tags.tourism === 'attraction' || tags.tourism === 'viewpoint') return 'attraction';
  if (tags.leisure === 'sports_centre' || tags.club === 'yacht' || tags.leisure === 'fishing') return 'club';
  if (tags.emergency === 'water_rescue' || tags.emergency === 'lifeguard') return 'rescue';
  if (tags.shop) return 'shop';
  if (tags.aeroway === 'aerodrome') return 'airfield';
  // Named nodes with NOTHING else on them are how OSM records both Vaal yacht clubs, the aquatic
  // club and NSRI Station 22 — dropping untagged names loses four of the best waterfront places.
  if (tags.name && Object.keys(tags).length === 1) return 'club';
  return null;
}

const ringArea = (pts: Pt[]): number => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j]!.x * pts[i]!.z - pts[i]!.x * pts[j]!.z;
  return Math.abs(a) / 2;
};

/**
 * Give every unnamed real street a name in the local idiom.
 *
 * OSM has a `name` on 108 of the extract's 995 highway ways and nothing on the other 887, so the
 * map used to run 35 of Deneysville's 41 km under one placeholder. Two passes fix that without
 * inventing connectivity:
 *
 * 1. CHAIN. Ways that meet END TO END and carry straight on through the join (turn under
 *    VAAL_SHORE_CHAIN_TURN_DEG) are one street. That is how OSM splits a road at a bridge, a
 *    surface change or an administrative edge, and it is why a single street can arrive as five
 *    unnamed fragments. A chain that touches a NAMED way this way inherits that way's name.
 * 2. NAME. The LONGEST still-unnamed chains take the pool names, longest first — the sign atlas
 *    only has room for a handful (see VAAL_SHORE_STREET_NAMES) so they go where they are read.
 *    Ties break on geometry, never on OSM id order, so two runs of mapgen are byte-identical.
 *    Everything shorter keeps the generic.
 */
function nameUnnamedStreets(roads: ShoreRoad[], nodes: Map<number, Pt>): { named: number; chains: number } {
  const bearing = (a: Pt, b: Pt): number => Math.atan2(b.z - a.z, b.x - a.x);
  const turn = (h1: number, h2: number): number => {
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) * (180 / Math.PI);
  };
  const ends = roads.map((r) => {
    const pts = r.nodes.map((id) => nodes.get(id)).filter((p): p is Pt => Boolean(p));
    if (pts.length < 2) return null;
    return {
      head: r.nodes[0]!, tail: r.nodes[r.nodes.length - 1]!,
      headDir: bearing(pts[0]!, pts[1]!), tailDir: bearing(pts[pts.length - 2]!, pts[pts.length - 1]!),
      mid: pts[Math.floor(pts.length / 2)]!,
    };
  });
  const parent = roads.map((_, i) => i);
  const find = (a: number): number => { let r = a; while (parent[r] !== r) r = parent[r]!; return r; };
  const union = (a: number, b: number): void => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  // Index ways by the node ids at their two ends, so only genuine end-to-end meetings are tested.
  const atNode = new Map<number, number[]>();
  ends.forEach((e, i) => {
    if (!e) return;
    for (const id of [e.head, e.tail]) { const list = atNode.get(id); if (list) list.push(i); else atNode.set(id, [i]); }
  });
  for (const [id, list] of atNode) {
    if (list.length !== 2) continue;              // a T-junction is not a continuation
    const [i, j] = list as [number, number];
    const ei = ends[i]; const ej = ends[j];
    if (!ei || !ej || roads[i]!.kind !== roads[j]!.kind) continue;
    // Travel direction through the join: leaving i, entering j.
    const out = ei.tail === id ? ei.tailDir : ei.headDir + Math.PI;
    const into = ej.head === id ? ej.headDir : ej.tailDir + Math.PI;
    if (turn(out, into) <= VAAL_SHORE_CHAIN_TURN_DEG) union(i, j);
  }
  const groups = new Map<number, number[]>();
  roads.forEach((_, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); });
  // Sorted deterministically by geometry, never by OSM id order.
  const lengthOf = (group: number[]): number => {
    let total = 0;
    for (const i of group) {
      const pts = roads[i]!.nodes.map((id) => nodes.get(id)).filter((p): p is Pt => Boolean(p));
      for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.z - pts[k - 1]!.z);
    }
    return total;
  };
  const ordered = [...groups.values()]
    .map((group) => ({ group, len: lengthOf(group), mid: ends[group[0]!]?.mid ?? { x: 0, z: 0 } }))
    .sort((a, b) => b.len - a.len || a.mid.z - b.mid.z || a.mid.x - b.mid.x);
  let named = 0; let pick = 0;
  for (const { group } of ordered) {
    const real = group.map((i) => roads[i]!.name).find((n): n is string => Boolean(n));
    const name = real
      ?? (pick < VAAL_SHORE_STREET_NAMES.length ? VAAL_SHORE_STREET_NAMES[pick++]! : VAAL_SHORE_UNNAMED_ROAD);
    for (const i of group) if (!roads[i]!.name) { roads[i]!.name = name; named++; }
  }
  return { named, chains: ordered.length };
}

export function parseVaalShore(data: OsmResponse): VaalShoreExtract {
  const log: string[] = [];
  const osmNodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const element of data.elements as OsmElement[]) {
    if (element.type === 'node') osmNodes.set(element.id, element);
    else if (element.type === 'way') ways.push(element);
  }

  const nodes = new Map<number, Pt>();
  for (const [id, n] of osmNodes) nodes.set(id, toVaalFrame(n.lat, n.lon));
  const ptsOf = (way: OsmWay): Pt[] =>
    (way.nodes ?? []).map((id) => nodes.get(id)).filter((p): p is Pt => Boolean(p));
  const centroid = (pts: Pt[]): Pt => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
  });

  const roads: ShoreRoad[] = [];
  const tracks: VaalShoreExtract['tracks'] = [];
  const areas: VaalShoreExtract['areas'] = [];
  const buildings: VaalShoreExtract['buildings'] = [];
  const pois: ShorePoi[] = [];
  const places: ShorePlace[] = [];
  const roadClassCount: Record<string, number> = {};

  for (const way of ways) {
    const tags = way.tags;
    if (!tags || !way.nodes || way.nodes.length < 2) continue;
    const closed = way.nodes[0] === way.nodes[way.nodes.length - 1];

    if (tags.highway) {
      const kind = ROAD_CLASS[tags.highway];
      if (kind) {
        // Keep the node IDS, not points: two ways that meet at an OSM node must share ONE graph
        // node or the street grid ships as a heap of disconnected sticks that the island pass then
        // deletes wholesale.
        roads.push({ id: way.id, name: tags.name ?? null, kind, width: ROAD_WIDTHS[kind] ?? 7, nodes: way.nodes });
        roadClassCount[tags.highway] = (roadClassCount[tags.highway] ?? 0) + 1;
        continue;
      }
      const track = TRACK_CLASS[tags.highway];
      if (track) {
        const pts = ptsOf(way);
        if (pts.length >= 2) tracks.push({ name: tags.name ?? (track === 'track' ? 'Plaas track' : 'Trail'), kind: track, points: pts });
        continue;
      }
      continue;
    }

    if (tags.building) {
      const pts = ptsOf(way);
      if (pts.length >= 3) {
        // Drop the repeated closing vertex; everything downstream treats a ring as open.
        const ring = pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.z === pts[pts.length - 1]!.z ? pts.slice(0, -1) : pts;
        if (ring.length >= 3) buildings.push({ p: centroid(ring), kind: tags.building, areaM2: ringArea(ring), points: ring });
      }
      continue;
    }

    const areaKind = closed ? shoreAreaKind(tags) : null;
    if (areaKind) {
      const pts = ptsOf(way).slice(0, -1);
      if (pts.length >= 3 && ringArea(pts) >= VAAL_SHORE_MIN_AREA_M2) {
        areas.push({ name: tags.name ?? areaKind, kind: areaKind, points: pts });
      }
      // fall through: a named marina/reserve polygon is also worth a POI pin
    }
    const wayPoi = poiKind(tags);
    if (wayPoi && tags.name) {
      const pts = ptsOf(way);
      if (pts.length >= 2) pois.push({ name: tags.name, kind: wayPoi, p: centroid(pts) });
    }
    if (tags.place && tags.name) {
      const pts = ptsOf(way);
      if (pts.length >= 3) places.push({ name: tags.name, place: tags.place, p: centroid(pts) });
    }
  }

  for (const [, n] of osmNodes) {
    const tags = n.tags;
    if (!tags) continue;
    const p = nodes.get(n.id)!;
    if (tags.place && tags.name) { places.push({ name: tags.name, place: tags.place, p }); continue; }
    const kind = poiKind(tags);
    if (kind && tags.name) pois.push({ name: tags.name, kind, p });
  }

  const naming = nameUnnamedStreets(roads, nodes);
  log.push(
    `vaalshore: named ${naming.named} unnamed way(s) across ${naming.chains} street chains ` +
      `(${new Set(roads.map((r) => r.name)).size} distinct street names in the extract)`,
  );
  log.push(
    `vaalshore: ${roads.length} real streets (${Object.entries(roadClassCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}), ` +
      `${tracks.length} tracks/paths, ${areas.length} landuse polygons >= ${VAAL_SHORE_MIN_AREA_M2} m2, ` +
      `${buildings.length} building footprints, ${places.length} place nodes, ${pois.length} named POIs`,
  );
  return { nodes, roads, tracks, areas, places, pois, buildings, log };
}
