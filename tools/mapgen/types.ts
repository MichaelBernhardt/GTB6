/** Shared types for the mapgen pipeline. Must not import from src/ game code. */

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

export interface OsmRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmRelationMember[];
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OsmResponse {
  elements: OsmElement[];
}

/** Point in projected metres (x east, z south) or in final game units. */
export interface Pt {
  x: number;
  z: number;
}

export type RoadKind =
  | 'motorway'
  | 'motorway_link'
  | 'trunk'
  | 'trunk_link'
  | 'primary'
  | 'primary_link'
  | 'secondary'
  | 'secondary_link'
  | 'tertiary'
  | 'tertiary_link'
  | 'residential';

export interface MapRoad {
  name: string;
  width: number;
  kind: RoadKind;
  points: [number, number][];
}

export interface MapJunction {
  x: number;
  z: number;
  roads: string[];
}

export interface MapDistrict {
  name: string;
  x: number;
  z: number;
  radius: number;
  /** Buildings per square km around the district centre (teaser stat for later massing). */
  buildingDensity?: number;
}

/** Off-road dirt track / trail; NOT part of the connected road graph. */
export interface MapTrack {
  name: string;
  width: number;
  kind: 'track' | 'path';
  unpaved: true;
  points: [number, number][];
}

/** Green / open / mining / farmland landuse polygon. */
export interface MapArea {
  name: string;
  kind:
    | 'park'
    | 'golf_course'
    | 'nature_reserve'
    | 'grass'
    | 'forest'
    | 'wood'
    | 'scrub'
    | 'mine_dump'
    | 'brownfield'
    | 'farmland'
    | 'aerodrome';
  points: [number, number][];
}

/**
 * Regional airport in the southern farmland. Runway/taxiway are polylines kept OUT of the
 * road graph (kind 'runway'/'taxiway', no traffic routing); the access road that reaches it
 * is a normal graph road. The aerodrome boundary is emitted as a landuse 'aerodrome' polygon.
 */
export interface MapAirport {
  name: string;
  runway: { kind: 'runway'; width: number; points: [number, number][] };
  taxiway: { kind: 'taxiway'; width: number; points: [number, number][] };
  /** Closed apron polygon. */
  apron: [number, number][];
  /** Terminal / hangar parcels (closed polygons). */
  buildings: [number, number][][];
}

/** Small working sea port on the NW coast: a pier reaching into the ocean + a dockside apron. */
export interface MapPort {
  name: string;
  /** Pier polyline (kind 'pier') running from the shore into the ocean. */
  pier: { kind: 'pier'; width: number; points: [number, number][] };
  /** Closed dockside apron polygon (on land). */
  apron: [number, number][];
}

/** The fantastical west coast: real Cape Town seaboard geometry grafted onto the map. */
export interface MapCoast {
  /** South-to-north shoreline polyline; everything west of it is ocean. */
  coastline: [number, number][];
  /** Closed ocean polygon (coastline closed off to the west). */
  ocean: [number, number][];
  beaches: Array<{ name: string; points: [number, number][] }>;
  /** V&A-style working waterfront anchor on the coastal road. */
  harbour: { x: number; z: number };
  /** Rural corridor band between the Joburg block and the coast (game-unit extents; the
   *  z clamp keeps the map tint on the corridor's actual land, not the full square). */
  corridor: { eastX: number; westX: number; northZ: number; southZ: number };
}

export interface MapRuralBuilding { x: number; z: number; kind: 'farmhouse' | 'barn' | 'silo' | 'windmill'; }

/** Farmland corridor content: sparse farm clusters and the obligatory padstal. */
export interface MapRural {
  farms: MapRuralBuilding[];
  padstal: { x: number; z: number; name: string };
}

/**
 * Coarse SRTM height grid over the map. Row-major from the north-west
 * corner: sample (col, row) sits at game position
 * (x0 + col * dx, z0 + row * dz); values are metres above sea level.
 */
export interface HeightGrid {
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  source: string;
  data: number[];
  /** Metres of synthetic northern mountain range included in `data` per cell (coast builds only) —
   *  shipped so the runtime can exempt the range from detrending (see src/world/mapData.ts). */
  ridge?: number[];
}

export interface MapWater {
  name: string;
  points: [number, number][];
}

export interface MapRailway {
  name: string;
  points: [number, number][];
}

export interface MapLandmark {
  name: string;
  x: number;
  z: number;
  kind: string;
}

export interface MapStats {
  totalRoadKm: number;
  roadCount: number;
  junctionCount: number;
  districtCount: number;
  waterCount: number;
  landmarkCount: number;
  trackKm: number;
  trackCount: number;
  landuseCount: number;
  bridgedIslands: number;
  droppedIslands: number;
  droppedIslandKm: number;
  minElevation: number;
  maxElevation: number;
  bbox: { south: number; west: number; north: number; east: number };
  targetSize: number;
  metresPerUnit: number;
  /** Composite (coast) additions. */
  oceanKm2?: number;
  landKm2?: number;
  corridorWidthUnits?: number;
}

export interface JoburgMap {
  meta: {
    source: string;
    attribution: string;
    generatedBy: string;
    coordinateSystem: string;
  };
  stats: MapStats;
  roads: MapRoad[];
  junctions: MapJunction[];
  districts: MapDistrict[];
  water: MapWater[];
  railways: MapRailway[];
  landmarks: MapLandmark[];
  tracks: MapTrack[];
  landuse: MapArea[];
  elevation: HeightGrid;
  coast?: MapCoast;
  rural?: MapRural;
  airport?: MapAirport;
  port?: MapPort;
}
