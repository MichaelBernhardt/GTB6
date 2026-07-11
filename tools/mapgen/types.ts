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

/** Green / open / mining landuse polygon. */
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
    | 'brownfield';
  points: [number, number][];
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
}
