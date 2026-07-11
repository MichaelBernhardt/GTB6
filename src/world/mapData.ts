/**
 * Typed access to the generated OSM Johannesburg map (src/world/generated/joburg-map.json,
 * produced by `npm run map:build`). This module is the single narrowing point for the JSON
 * and derives everything the runtime consumes: road polylines, signalised junctions,
 * district centres, water/green polygons and landmark anchors.
 *
 * Pure data + pure functions only — no three.js, no game systems — so tests can lean on it.
 */
import rawMap from './generated/joburg-map.json';
import type { District } from '../types';

export interface MapPt { x: number; z: number; }

export interface GeneratedRoad {
  name: string;
  width: number;
  kind: string;
  points: MapPt[];
}

export interface GeneratedTrack extends GeneratedRoad { unpaved: true; }

export interface DistrictCenter {
  name: District;
  x: number;
  z: number;
  radius: number;
  /** Buildings per km² around the centre (OSM building count teaser) — drives procedural massing density. */
  density: number;
}

export interface MapPolygon {
  name: string;
  kind: 'water' | 'green' | 'dirt' | 'farm' | 'aerodrome' | 'ocean' | 'beach';
  points: MapPt[];
  minX: number; maxX: number; minZ: number; maxZ: number;
  cx: number; cz: number;
  area: number;
}

export interface MapLandmark { name: string; x: number; z: number; kind: string; }

export interface SignalJunctionDef {
  x: number;
  z: number;
  angle: number;
  roadA: string;
  roadB: string;
  phase: number;
  /** Width of the widest incident road — junction paint and corner offsets scale from it. */
  widest: number;
}

interface RawMap {
  stats: { targetSize: number; metresPerUnit: number; totalRoadKm: number; roadCount: number; junctionCount: number };
  roads: Array<{ name: string; width: number; kind: string; points: [number, number][] }>;
  junctions: Array<{ x: number; z: number; roads: string[] }>;
  districts: Array<{ name: string; x: number; z: number; radius: number; buildingDensity?: number }>;
  water: Array<{ name: string; points: [number, number][] }>;
  landmarks: Array<{ name: string; x: number; z: number; kind: string }>;
  tracks: Array<{ name: string; width: number; kind: 'track' | 'path'; points: [number, number][] }>;
  landuse: Array<{ name: string; kind: string; points: [number, number][] }>;
  /** Jozi-by-the-Sea graft (tools/mapgen/coast.ts): synthetic Atlantic seaboard west of the crop. */
  coast?: {
    coastline: [number, number][];
    ocean: [number, number][];
    beaches: Array<{ name: string; points: [number, number][] }>;
    harbour: { x: number; z: number };
    corridor: { eastX: number; westX: number };
  };
}

const MAP = rawMap as unknown as RawMap;

export const MAP_STATS = MAP.stats;
/** Square world footprint in game units — the generated map is fitted into this. */
export const MAP_WORLD_SIZE = MAP.stats.targetSize;
export const METRES_PER_UNIT = MAP.stats.metresPerUnit;

const toPts = (points: [number, number][]): MapPt[] => points.map(([x, z]) => ({ x, z }));

/** Every driveable road polyline (all highway classes; the pipeline already thinned residentials to the CBD). */
export const GENERATED_ROADS: GeneratedRoad[] = MAP.roads.map((road) => ({
  name: road.name, width: road.width, kind: road.kind, points: toPts(road.points),
}));

/** Off-road dirt tracks (narrow unpaved strips; footpaths are dropped for the runtime mesh). */
export const GENERATED_TRACKS: GeneratedTrack[] = MAP.tracks
  .filter((track) => track.kind === 'track')
  .map((track) => ({ name: track.name, width: track.width, kind: track.kind, unpaved: true as const, points: toPts(track.points) }));

// ---- Districts -------------------------------------------------------------

export const DISTRICT_CENTERS: DistrictCenter[] = MAP.districts.map((district) => ({
  name: district.name, x: district.x, z: district.z, radius: district.radius, density: district.buildingDensity ?? 100,
}));

export const CBD_NAME: District = 'Joburg CBD';
export const CBD_CENTER: DistrictCenter =
  DISTRICT_CENTERS.find((district) => district.name === CBD_NAME)
  ?? DISTRICT_CENTERS[0]
  ?? { name: CBD_NAME, x: 0, z: 0, radius: 150, density: 200 };

/** Nearest generated place node to a point (Voronoi-style district ownership). */
export function nearestDistrict(x: number, z: number): DistrictCenter {
  let best = CBD_CENTER; let bestDistance = Infinity;
  for (const district of DISTRICT_CENTERS) {
    const distance = (district.x - x) ** 2 + (district.z - z) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = district; }
  }
  return best;
}

/** Nearest-centre district lookup over the generated place nodes. */
export function districtAt(x: number, z: number): District {
  return nearestDistrict(x, z).name;
}

export function districtCenter(name: District): DistrictCenter | undefined {
  return DISTRICT_CENTERS.find((district) => district.name === name);
}

// ---- Polygons (water / parks / mine dumps) ----------------------------------

function buildPolygon(name: string, kind: MapPolygon['kind'], rawPoints: [number, number][]): MapPolygon | undefined {
  const points = toPts(rawPoints);
  if (points.length < 3) return undefined;
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  let area = 0; let cx = 0; let cz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!; const b = points[(i + 1) % points.length]!;
    minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
    area += a.x * b.z - b.x * a.z;
    cx += a.x; cz += a.z;
  }
  return { name, kind, points, minX, maxX, minZ, maxZ, cx: cx / points.length, cz: cz / points.length, area: Math.abs(area / 2) };
}

const GREEN_KINDS = new Set(['park', 'grass', 'golf_course', 'nature_reserve', 'forest', 'wood', 'scrub']);
const DIRT_KINDS = new Set(['mine_dump', 'brownfield']);
const FARM_KINDS = new Set(['farmland']);
const AERODROME_KINDS = new Set(['aerodrome']);

export const WATER_POLYGONS: MapPolygon[] = MAP.water
  .map((water) => buildPolygon(water.name, 'water', water.points))
  .filter((polygon): polygon is MapPolygon => polygon !== undefined);

/** Green/open landuse, largest first, capped so the runtime mesh and prop budgets stay sane. */
export const GREEN_POLYGONS: MapPolygon[] = MAP.landuse
  .filter((area) => GREEN_KINDS.has(area.kind))
  .map((area) => buildPolygon(area.name, 'green', area.points))
  .filter((polygon): polygon is MapPolygon => polygon !== undefined)
  .sort((a, b) => b.area - a.area)
  .slice(0, 64);

export const DIRT_POLYGONS: MapPolygon[] = MAP.landuse
  .filter((area) => DIRT_KINDS.has(area.kind))
  .map((area) => buildPolygon(area.name, 'dirt', area.points))
  .filter((polygon): polygon is MapPolygon => polygon !== undefined);

/** Farmland landuse: the rural corridor's cultivated fields (Stage-3 farm content anchors here). */
export const FARM_POLYGONS: MapPolygon[] = MAP.landuse
  .filter((area) => FARM_KINDS.has(area.kind))
  .map((area) => buildPolygon(area.name, 'farm', area.points))
  .filter((polygon): polygon is MapPolygon => polygon !== undefined);

/** Aerodrome landuse: the airport apron/field — kept clear of procedural streets and buildings. */
export const AERODROME_POLYGONS: MapPolygon[] = MAP.landuse
  .filter((area) => AERODROME_KINDS.has(area.kind))
  .map((area) => buildPolygon(area.name, 'aerodrome', area.points))
  .filter((polygon): polygon is MapPolygon => polygon !== undefined);

// ---- Coast (Jozi-by-the-Sea graft) ------------------------------------------

const RAW_COAST = MAP.coast;

/** North→south shoreline polyline: the land/water boundary the beach strip and ocean share. */
export const COASTLINE: MapPt[] = RAW_COAST ? toPts(RAW_COAST.coastline) : [];

/** Closed ocean polygon (west of the coastline, extending past the world edge). One premium water site. */
export const OCEAN_POLYGON: MapPolygon | undefined =
  RAW_COAST ? buildPolygon('Ocean', 'ocean', RAW_COAST.ocean) : undefined;

/** Named OSM beach polygons. NB: the real Cape coords sit inland of the *synthetic* coastline, so the
 *  runtime uses only their z-spans (where along the shore the golden sand goes), not their x-position. */
export const BEACH_POLYGONS: MapPolygon[] = RAW_COAST
  ? RAW_COAST.beaches
      .map((beach) => buildPolygon(beach.name, 'beach', beach.points))
      .filter((polygon): polygon is MapPolygon => polygon !== undefined)
  : [];

/** Quay end where the coastal highway meets the sea (dock apron anchor). */
export const HARBOUR_POINT: MapPt | undefined = RAW_COAST ? { x: RAW_COAST.harbour.x, z: RAW_COAST.harbour.z } : undefined;

/** Rural corridor x-band separating the Joburg crop (east) from the seaboard (west). */
export const COAST_CORRIDOR: { eastX: number; westX: number } | undefined = RAW_COAST ? { ...RAW_COAST.corridor } : undefined;

export function pointInPolygon(polygon: MapPolygon, x: number, z: number): boolean {
  if (x < polygon.minX || x > polygon.maxX || z < polygon.minZ || z > polygon.maxZ) return false;
  let inside = false;
  const points = polygon.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!; const b = points[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** True when (x, z) lands inside any polygon in the set (bbox-guarded per polygon). */
export function pointInAnyPolygon(polygons: readonly MapPolygon[], x: number, z: number): boolean {
  return polygons.some((polygon) => pointInPolygon(polygon, x, z));
}

// ---- Landmarks ---------------------------------------------------------------

export const LANDMARKS: MapLandmark[] = MAP.landmarks;
export function landmark(name: string): MapLandmark | undefined {
  return LANDMARKS.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

// ---- Road spot helpers (data-driven anchor placement) -------------------------

export interface RoadSpot {
  x: number;
  z: number;
  /** Unit direction of the road at this point. */
  dirX: number;
  dirZ: number;
  road: GeneratedRoad;
}

function spotAt(road: GeneratedRoad, index: number): RoadSpot {
  const point = road.points[index]!;
  const previous = road.points[Math.max(0, index - 1)] ?? point;
  const next = road.points[Math.min(road.points.length - 1, index + 1)] ?? point;
  const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
  return { x: point.x, z: point.z, dirX: dx / length, dirZ: dz / length, road };
}

/** Nearest vertex of any road matching `filter` to the given point. */
export function nearestRoadSpot(x: number, z: number, filter?: (road: GeneratedRoad) => boolean): RoadSpot {
  let best: RoadSpot | undefined; let bestDistance = Infinity;
  for (const road of GENERATED_ROADS) {
    if (filter && !filter(road)) continue;
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!;
      const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = spotAt(road, index); }
    }
  }
  return best ?? { x, z, dirX: 1, dirZ: 0, road: GENERATED_ROADS[0]! };
}

/** Nearest vertex of the named road to the given point (name is the post-override in-game name). */
export function roadSpot(name: string, nearX: number, nearZ: number): RoadSpot {
  return nearestRoadSpot(nearX, nearZ, (road) => road.name === name);
}

/** Perpendicular offset from a road spot: side +1/-1, clearance measured beyond the road edge. */
export function besideRoad(spot: RoadSpot, side: 1 | -1, clearance: number): MapPt {
  const offset = side * (spot.road.width / 2 + clearance);
  return { x: spot.x - spot.dirZ * offset, z: spot.z + spot.dirX * offset };
}

// ---- Road-edge distance grid ---------------------------------------------------

/** How far beyond a road edge the shared edge grid can measure accurately. */
export const ROAD_EDGE_CAP = 14;

interface EdgeSegment { ax: number; az: number; bx: number; bz: number; half: number; }

const EDGE_CELL = 26;
const edgeGrid = new Map<string, EdgeSegment[]>();

function insertEdgeSegment(segment: EdgeSegment): void {
  const pad = segment.half + ROAD_EDGE_CAP;
  const minX = Math.floor((Math.min(segment.ax, segment.bx) - pad) / EDGE_CELL);
  const maxX = Math.floor((Math.max(segment.ax, segment.bx) + pad) / EDGE_CELL);
  const minZ = Math.floor((Math.min(segment.az, segment.bz) - pad) / EDGE_CELL);
  const maxZ = Math.floor((Math.max(segment.az, segment.bz) + pad) / EDGE_CELL);
  for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
    const key = `${cx},${cz}`;
    const cell = edgeGrid.get(key);
    if (cell) cell.push(segment); else edgeGrid.set(key, [segment]);
  }
}

for (const road of GENERATED_ROADS) {
  for (let index = 0; index < road.points.length - 1; index++) {
    const a = road.points[index]!; const b = road.points[index + 1]!;
    insertEdgeSegment({ ax: a.x, az: a.z, bx: b.x, bz: b.z, half: road.width / 2 });
  }
}

/**
 * Distance from a point to the nearest road EDGE (negative when inside a road surface),
 * clamped to ROAD_EDGE_CAP: any value >= the cap just means "at least this clear".
 * Grid-backed, so placement code and tests can call it liberally.
 */
export function distanceToRoadEdge(x: number, z: number): number {
  let best = ROAD_EDGE_CAP;
  for (const segment of edgeGrid.get(`${Math.floor(x / EDGE_CELL)},${Math.floor(z / EDGE_CELL)}`) ?? []) {
    const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az; const lengthSq = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq));
    const distance = Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t)) - segment.half;
    if (distance < best) best = distance;
  }
  return best;
}

// ---- Signalised junctions -----------------------------------------------------

interface JunctionAccumulator {
  x: number; z: number; degree: number;
  incident: Array<{ name: string; width: number; dirX: number; dirZ: number }>;
}

export interface SignalSelectionOptions {
  budget?: number;
  minSpacing?: number;
  minWidestWidth?: number;
  minSecondWidth?: number;
}

/**
 * Picks the junctions that get robots (traffic signals) + street-name signs: proper crossings
 * (degree >= 3, two distinct road names) of reasonably wide roads, best-scored first with a
 * spacing constraint so the budget spreads across the city instead of clumping in the CBD grid.
 */
export function computeSignalJunctions(options: SignalSelectionOptions = {}): SignalJunctionDef[] {
  const { budget = 64, minSpacing = 130, minWidestWidth = 11, minSecondWidth = 9 } = options;
  const accumulators = new Map<string, JunctionAccumulator>();
  for (const junction of MAP.junctions) {
    accumulators.set(`${junction.x}|${junction.z}`, { x: junction.x, z: junction.z, degree: 0, incident: [] });
  }
  for (const road of GENERATED_ROADS) {
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!;
      const accumulator = accumulators.get(`${point.x}|${point.z}`);
      if (!accumulator) continue;
      accumulator.degree += (index > 0 ? 1 : 0) + (index < road.points.length - 1 ? 1 : 0);
      const spot = spotAt(road, index);
      accumulator.incident.push({ name: road.name, width: road.width, dirX: spot.dirX, dirZ: spot.dirZ });
    }
  }
  interface Candidate { x: number; z: number; angle: number; roadA: string; roadB: string; widest: number; score: number; }
  const candidates: Candidate[] = [];
  for (const accumulator of accumulators.values()) {
    if (accumulator.degree < 3) continue;
    const byWidth = [...accumulator.incident].sort((a, b) => b.width - a.width);
    const widest = byWidth[0];
    const other = byWidth.find((entry) => entry.name !== widest?.name);
    if (!widest || !other) continue; // self-junction of one road: no signals
    if (widest.width < minWidestWidth || other.width < minSecondWidth) continue;
    if (/^unnamed /i.test(widest.name) || /^unnamed /i.test(other.name)) continue; // ramps/links: no street signs to show
    candidates.push({
      x: accumulator.x, z: accumulator.z,
      angle: Math.atan2(widest.dirX, widest.dirZ),
      roadA: widest.name.toUpperCase(), roadB: other.name.toUpperCase(),
      widest: widest.width,
      score: widest.width * 2 + other.width + accumulator.degree,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen: Candidate[] = [];
  const spacingSq = minSpacing * minSpacing;
  for (const candidate of candidates) {
    if (chosen.length >= budget) break;
    if (chosen.some((existing) => (existing.x - candidate.x) ** 2 + (existing.z - candidate.z) ** 2 < spacingSq)) continue;
    chosen.push(candidate);
  }
  return chosen.map((candidate, index) => ({
    x: candidate.x, z: candidate.z, angle: candidate.angle,
    roadA: candidate.roadA, roadB: candidate.roadB,
    phase: (index * 4) % 28, widest: candidate.widest,
  }));
}

/** The signal set the game builds — computed once at module load. */
export const SIGNAL_JUNCTIONS: SignalJunctionDef[] = computeSignalJunctions();
