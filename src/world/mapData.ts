/**
 * Typed access to the generated OSM Johannesburg map (src/world/generated/joburg-map.json,
 * produced by `npm run map:build`). This module is the single narrowing point for the JSON
 * and derives everything the runtime consumes: road polylines, signalised junctions,
 * district centres, water/green polygons and landmark anchors.
 *
 * Pure data + pure functions only — no three.js, no game systems — so tests can lean on it.
 */
import rawMap from './generated/joburg-map.json';
import { deconflictRailway, RAIL_DECONFLICT_DEFAULTS } from './railAlignment';
import type { RailCrossing, RailRoadProbe } from './railAlignment';
import type { District } from '../types';

export interface MapPt { x: number; z: number; }

export interface GeneratedRoad {
  name: string;
  width: number;
  kind: string;
  points: MapPt[];
}

export interface GeneratedTrack extends GeneratedRoad { unpaved: true; }

export interface GeneratedRailway {
  name: string;
  points: MapPt[];
}

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
  /** Green polygons only: tended lawn (park/grass/golf) vs wild veld (scrub/reserve/woodland) — drives lush vs dry turf. */
  manicured?: boolean;
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
  stats: {
    targetSize: number; metresPerUnit: number; totalRoadKm: number; roadCount: number; junctionCount: number;
    /** Emitted land / water split in km². Used by the derivation tests to state their floors as
     *  densities rather than counts pinned to one particular crop. */
    landKm2?: number; oceanKm2?: number;
    bbox?: { south: number; west: number; north: number; east: number };
    /** Exact projected-metres -> game-units fit: game = (metres - c) * scale. See coordTransform.ts. */
    fit?: { scale: number; cx: number; cz: number };
  };
  roads: Array<{ name: string; width: number; kind: string; points: [number, number][] }>;
  junctions: Array<{ x: number; z: number; roads: string[] }>;
  districts: Array<{ name: string; x: number; z: number; radius: number; buildingDensity?: number }>;
  water: Array<{ name: string; points: [number, number][] }>;
  landmarks: Array<{ name: string; x: number; z: number; kind: string }>;
  tracks: Array<{ name: string; width: number; kind: 'track' | 'path'; points: [number, number][] }>;
  railways: Array<{ name: string; points: [number, number][] }>;
  stations?: Array<{ name: string; line: string; x: number; z: number; source: 'osm' | 'synthetic' }>;
  landuse: Array<{ name: string; kind: string; points: [number, number][] }>;
  /** Stage-3 airfield (tools/mapgen): runway/taxiway centrelines + apron and building footprints. */
  airport?: {
    name: string;
    runway: { kind: string; width: number; points: [number, number][] };
    taxiway: { kind: string; width: number; points: [number, number][] };
    apron: [number, number][];
    buildings: [number, number][][];
  };
  /** Vaalpunt Dam graft (tools/mapgen/coast.ts): a strip of the real Vaal Dam west of the crop. */
  coast?: {
    name?: string;
    coastline: [number, number][];
    ocean: [number, number][];
    islands?: [number, number][][];
    beaches: Array<{ name: string; points: [number, number][] }>;
    harbour: { x: number; z: number };
    corridor: { eastX: number; westX: number };
    shoreBuildings?: Array<{ x: number; z: number; w: number; d: number; heading: number; kind: string }>;
  };
  /** SRTM 90 m heightgrid (+ synthetic corridor/coast composite): row-major from the NW corner, values in
   *  metres above sea level, placed in world XZ by an affine origin (x0,z0) + spacing (dx,dz) in game units.
   *  `ridge` is the synthetic northern mountain range's contribution included in `data` per cell. */
  elevation?: { cols: number; rows: number; x0: number; z0: number; dx: number; dz: number; data: number[]; ridge?: number[] };
}

const MAP = rawMap as unknown as RawMap;

export const MAP_STATS = MAP.stats;
/** Landmarks straight from the generated map (name, position, kind). */
export const MAP_LANDMARKS: MapLandmark[] = MAP.landmarks;
/** Square world footprint in game units — the generated map is fitted into this. */
export const MAP_WORLD_SIZE = MAP.stats.targetSize;
export const METRES_PER_UNIT = MAP.stats.metresPerUnit;

// ---- Elevation heightgrid (SRTM composite) ----------------------------------

/**
 * The generated map ships a coarse heightgrid in metres ASL. Two problems make the raw values
 * unusable as world Y: (a) Johannesburg is a ~1760 m plateau while the synthetic ocean sits at 0 m,
 * so raw scale towers the whole city a mile above the sea; (b) the plateau itself is very flat
 * (~40 m of relief across the CBD), so at any sane scale the land looks dead level.
 *
 * We therefore detrend: a heavily-blurred REGIONAL field carries the broad plateau/coast trend, and the
 * LOCAL residual (raw − regional) carries the fine undulation. City.terrainHeightAt scales them
 * independently — regional DOWN to tame the escarpment, local UP to make the flat land read as hills —
 * with the ocean (0 m) staying anchored at Y≈0 because both fields vanish there.
 *
 * The synthetic northern mountain range (tools/mapgen/ridge.ts) would be destroyed by that split — a
 * broad ridge lands almost entirely in the discarded REGIONAL trend and the crumbs left in LOCAL hit
 * the cap. The pipeline therefore ships the range's per-cell contribution as `elevation.ridge`; we
 * subtract it BEFORE detrending (both fields see only the pre-range BASE terrain) and City adds it
 * back at its own scale, so the mountains stay genuinely tall in-game while the CBD is untouched.
 */
const EL = MAP.elevation;

/** The synthetic mountain range's metres per cell (zero-filled when the map ships none). */
const RIDGE_DATA: number[] | undefined = EL?.ridge && EL.ridge.length === EL.data.length ? EL.ridge : undefined;

/** The heightgrid with the mountain range removed — what the regional/local detrend split sees. */
const BASE_DATA: number[] | undefined = EL ? (RIDGE_DATA ? EL.data.map((v, i) => v - RIDGE_DATA[i]!) : EL.data) : undefined;

/** Blur radius for the regional trend, in grid cells (~1 cell = dx units). */
const REGIONAL_BLUR_CELLS = 6;

/** Separable box-blur of the BASE heightgrid → the smooth regional trend. Computed once; clamped at edges. */
const REGIONAL_DATA: number[] | undefined = (() => {
  if (!EL || !BASE_DATA) return undefined;
  const { cols, rows } = EL;
  const data = BASE_DATA;
  const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
  const pass = (src: number[], horizontal: boolean): number[] => {
    const out = new Array<number>(src.length);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -REGIONAL_BLUR_CELLS; k <= REGIONAL_BLUR_CELLS; k++) {
        const cc = horizontal ? clamp(c + k, cols - 1) : c;
        const rr = horizontal ? r : clamp(r + k, rows - 1);
        sum += src[rr * cols + cc]!;
      }
      out[r * cols + c] = sum / (REGIONAL_BLUR_CELLS * 2 + 1);
    }
    return out;
  };
  return pass(pass(data, true), false);
})();

/** True when the runtime map carries real (non-flat) elevation data. */
export const HAS_ELEVATION = EL !== undefined && EL.data.some((v) => v !== EL.data[0]);

function sampleGrid(grid: number[], x: number, z: number): number {
  const { cols, rows, x0, z0, dx, dz } = EL!;
  let c = (x - x0) / dx; let r = (z - z0) / dz;
  c = c < 0 ? 0 : c > cols - 1 ? cols - 1 : c;
  r = r < 0 ? 0 : r > rows - 1 ? rows - 1 : r;
  const c0 = Math.floor(c); const r0 = Math.floor(r);
  const c1 = c0 + 1 < cols ? c0 + 1 : c0; const r1 = r0 + 1 < rows ? r0 + 1 : r0;
  const fc = c - c0; const fr = r - r0;
  const top = grid[r0 * cols + c0]! + (grid[r0 * cols + c1]! - grid[r0 * cols + c0]!) * fc;
  const bot = grid[r1 * cols + c0]! + (grid[r1 * cols + c1]! - grid[r1 * cols + c0]!) * fc;
  return top + (bot - top) * fr;
}

/** Bilinear-sampled raw elevation at a world point, in metres ASL (0 where the map has no grid). */
export function elevationMetresAt(x: number, z: number): number {
  return EL ? sampleGrid(EL.data, x, z) : 0;
}

/** Bilinear-sampled REGIONAL (blurred) elevation — the broad plateau/coast trend, in metres ASL. */
export function regionalMetresAt(x: number, z: number): number {
  return REGIONAL_DATA ? sampleGrid(REGIONAL_DATA, x, z) : 0;
}

/** Bilinear-sampled BASE elevation (raw minus the synthetic range) — what the detrend split applies to. */
export function baseMetresAt(x: number, z: number): number {
  return BASE_DATA ? sampleGrid(BASE_DATA, x, z) : 0;
}

/** Bilinear-sampled synthetic mountain-range contribution, in metres (0 on maps without the range). */
export function ridgeMetresAt(x: number, z: number): number {
  return RIDGE_DATA ? sampleGrid(RIDGE_DATA, x, z) : 0;
}

const toPts = (points: [number, number][]): MapPt[] => points.map(([x, z]) => ({ x, z }));

/** Every driveable road polyline (all highway classes; the pipeline already thinned residentials to the CBD). */
export const GENERATED_ROADS: GeneratedRoad[] = MAP.roads.map((road) => ({
  name: road.name, width: road.width, kind: road.kind, points: toPts(road.points),
}));

/** Off-road dirt tracks (narrow unpaved strips; footpaths are dropped for the runtime mesh). */
export const GENERATED_TRACKS: GeneratedTrack[] = MAP.tracks
  .filter((track) => track.kind === 'track')
  .map((track) => ({ name: track.name, width: track.width, kind: track.kind, unpaved: true as const, points: toPts(track.points) }));

// ---- Road-edge distance grids --------------------------------------------------
//
// Declared next to the roads, and BEFORE the railways, because the railway alignment is deconflicted
// against the built road footprint at module-init time (see GENERATED_RAILWAYS below).

/** How far beyond a road edge the shared edge grid can measure accurately. */
export const ROAD_EDGE_CAP = 14;

/**
 * How much finished surface the build lays down BEYOND a road's declared `width`, per side.
 *
 * `map.roads[].width` is the CARRIAGEWAY. City.buildRoads then adds, outside it, a kerb bar (out to
 * +0.41) and a raised sidewalk (SIDEWALK_INNER_EDGE 0.38 then SIDEWALK_WIDTH 3.12, out to +3.50), and
 * `isOnSidewalk` treats the whole band as walkable pavement. So a road the map calls 14 u is 21 u of
 * built surface on the ground — 50% wider than declared.
 *
 * This was invisible to every clearance rule, all of which measured against the declared width and so
 * under-read the real road by 3.5 u a side. That is why the Metrorail main line ended up under Albertina
 * Sisulu Road: nothing that placed the rail, the station platforms or anything else beside a road knew
 * how wide the road actually is. City derives SIDEWALK_WIDTH from this constant so the two cannot drift.
 */
export const ROAD_BUILD_MARGIN = 3.5;

interface EdgeSegment { ax: number; az: number; bx: number; bz: number; half: number; }

const EDGE_CELL = 26;

function insertEdgeSegment(grid: Map<string, EdgeSegment[]>, segment: EdgeSegment, cap: number): void {
  const pad = segment.half + cap;
  const minX = Math.floor((Math.min(segment.ax, segment.bx) - pad) / EDGE_CELL);
  const maxX = Math.floor((Math.max(segment.ax, segment.bx) + pad) / EDGE_CELL);
  const minZ = Math.floor((Math.min(segment.az, segment.bz) - pad) / EDGE_CELL);
  const maxZ = Math.floor((Math.max(segment.az, segment.bz) + pad) / EDGE_CELL);
  for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
    const key = `${cx},${cz}`;
    const cell = grid.get(key);
    if (cell) cell.push(segment); else grid.set(key, [segment]);
  }
}

function distanceToEdge(grid: Map<string, EdgeSegment[]>, x: number, z: number, cap: number): number {
  let best = cap;
  for (const segment of grid.get(`${Math.floor(x / EDGE_CELL)},${Math.floor(z / EDGE_CELL)}`) ?? []) {
    const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az; const lengthSq = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq));
    const distance = Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t)) - segment.half;
    if (distance < best) best = distance;
  }
  return best;
}

const edgeGrid = new Map<string, EdgeSegment[]>();
const builtEdgeGrid = new Map<string, EdgeSegment[]>();
for (const road of GENERATED_ROADS) {
  for (let index = 0; index < road.points.length - 1; index++) {
    const a = road.points[index]!; const b = road.points[index + 1]!;
    insertEdgeSegment(edgeGrid, { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: road.width / 2 }, ROAD_EDGE_CAP);
    insertEdgeSegment(builtEdgeGrid, { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: road.width / 2 + ROAD_BUILD_MARGIN }, ROAD_EDGE_CAP);
  }
}

/**
 * Distance from a point to the nearest CARRIAGEWAY edge (negative when on the tar), clamped to
 * ROAD_EDGE_CAP: any value >= the cap just means "at least this clear". Grid-backed, so placement
 * code and tests can call it liberally.
 *
 * This is the TAR only. Anything asking "am I clear of the road?" — as opposed to "am I on the
 * driveable surface?" — wants distanceToBuiltRoadEdge, which counts the kerb and pavement too.
 */
export function distanceToRoadEdge(x: number, z: number): number {
  return distanceToEdge(edgeGrid, x, z, ROAD_EDGE_CAP);
}

/** Distance to the nearest edge of the road AS BUILT — carriageway plus kerb plus sidewalk
 *  (ROAD_BUILD_MARGIN). Negative inside the finished surface. This is the clearance rule; the
 *  declared width is only ever the driveable part of it. */
export function distanceToBuiltRoadEdge(x: number, z: number): number {
  return distanceToEdge(builtEdgeGrid, x, z, ROAD_EDGE_CAP);
}

/**
 * Nearest built road to a point: how much room is left, which way is out, and how the road runs.
 *
 * The general form of "am I clear of the road?", and the query the rail deconfliction is built on.
 * Anything siting something beside a road wants this rather than distanceToRoadEdge, which answers
 * only about the tar and so under-reads the real road by ROAD_BUILD_MARGIN a side.
 */
export function nearestBuiltRoad(x: number, z: number): RailRoadProbe | undefined {
  let best: RailRoadProbe | undefined; let bestClearance = ROAD_EDGE_CAP;
  for (const segment of builtEdgeGrid.get(`${Math.floor(x / EDGE_CELL)},${Math.floor(z / EDGE_CELL)}`) ?? []) {
    const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az; const lengthSq = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq));
    const px = segment.ax + dx * t; const pz = segment.az + dz * t;
    const span = Math.hypot(x - px, z - pz);
    const clearance = span - segment.half;
    if (clearance >= bestClearance) continue;
    const length = Math.sqrt(lengthSq);
    // Degenerate only when the point sits exactly on the centreline; the road's own normal is then
    // as good a "way out" as any, and is stable rather than arbitrary.
    const awayX = span > 1e-6 ? (x - px) / span : -dz / length;
    const awayZ = span > 1e-6 ? (z - pz) / span : dx / length;
    bestClearance = clearance;
    best = { clearance, awayX, awayZ, dirX: dx / length, dirZ: dz / length, half: segment.half };
  }
  return best;
}

/** Half-width of the rendered ballast bed. Placement code protects this exact shared corridor, and the
 *  deconfliction below is what keeps roads out of it. */
export const RAILWAY_CORRIDOR_HALF_WIDTH = 2.6;

/**
 * Passenger rail lines (thinned by the pipeline), pushed clear of the roads they run alongside.
 *
 * The pipeline emits rail and roads independently, so on the shipped map 4.90 km of the 22.5 km network
 * had its ballast inside a built road — the Metrorail main line ran INSIDE Albertina Sisulu Road for
 * ~700 u either side of Grosvenor Station, with the two centrelines just 7.0 u apart against a built
 * road half-width of 10.5 u. deconflictRailway moves the rail off roads it PARALLELS and leaves the
 * places it genuinely CROSSES alone, so a level crossing still reads as a level crossing.
 */
const DECONFLICTED_RAILWAYS = (MAP.railways ?? [])
  .map((line) => ({ name: line.name, points: toPts(line.points) }))
  .filter((line) => line.points.length >= 2)
  .map((line) => ({
    name: line.name,
    ...deconflictRailway(line.points, nearestBuiltRoad, { ...RAIL_DECONFLICT_DEFAULTS, corridorHalf: RAILWAY_CORRIDOR_HALF_WIDTH }),
  }));

export const GENERATED_RAILWAYS: GeneratedRailway[] =
  DECONFLICTED_RAILWAYS.map((line) => ({ name: line.name, points: line.points }));

/** Where a rail line genuinely has to get across a carriageway: the renderer lays a level crossing. */
export const RAILWAY_LEVEL_CROSSINGS: RailCrossing[] = DECONFLICTED_RAILWAYS.flatMap((line) => line.crossings);

export interface RailwaySpot {
  x: number;
  z: number;
  /** Unit tangent of the railway at the projected point. */
  dirX: number;
  dirZ: number;
  railway: GeneratedRailway;
}

/** Exact nearest point on any generated railway segment (not merely its nearest source vertex). */
export function nearestRailwaySpot(x: number, z: number): RailwaySpot | undefined {
  let best: RailwaySpot | undefined; let bestDistanceSq = Infinity;
  for (const railway of GENERATED_RAILWAYS) {
    for (let index = 0; index < railway.points.length - 1; index++) {
      const a = railway.points[index]!; const b = railway.points[index + 1]!;
      const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz;
      if (lengthSq < 1e-8) continue;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
      const px = a.x + dx * t; const pz = a.z + dz * t;
      const distanceSq = (px - x) ** 2 + (pz - z) ** 2;
      if (distanceSq < bestDistanceSq) {
        const length = Math.sqrt(lengthSq);
        bestDistanceSq = distanceSq;
        best = { x: px, z: pz, dirX: dx / length, dirZ: dz / length, railway };
      }
    }
  }
  return best;
}

/** A passenger stop on a rail line: trains dwell here, the world builds a platform here. */
export interface MapStation { name: string; line: string; x: number; z: number; source: 'osm' | 'synthetic'; }

/** Every generated rail station (both line ends + OSM/synthesized intermediate stops). */
export const STATIONS: MapStation[] = MAP.stations ?? [];

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
const MANICURED_KINDS = new Set(['park', 'grass', 'golf_course']); // tended lawns get lush turf; the rest read as dry veld
const DIRT_KINDS = new Set(['mine_dump', 'brownfield']);
const FARM_KINDS = new Set(['farmland']);
const AERODROME_KINDS = new Set(['aerodrome']);

export const WATER_POLYGONS: MapPolygon[] = MAP.water
  .map((water) => buildPolygon(water.name, 'water', water.points))
  .filter((polygon): polygon is MapPolygon => polygon !== undefined);

/** Every green/open landuse polygon — uncapped, so the 3D grass matches exactly what the map paints green
 *  (the old top-64 cap left smaller parks green on the map but bare dry ground in the world). */
export const GREEN_POLYGONS: MapPolygon[] = MAP.landuse
  .filter((area) => GREEN_KINDS.has(area.kind))
  .map((area) => {
    const polygon = buildPolygon(area.name, 'green', area.points);
    if (polygon) polygon.manicured = MANICURED_KINDS.has(area.kind);
    return polygon;
  })
  .filter((polygon): polygon is MapPolygon => polygon !== undefined);

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

// ---- Airport (the corridor airfield) -----------------------------------------

/** The generated airfield. The runway/taxiway carry road-like widths but are deliberately NOT part of
 *  GENERATED_ROADS: they must never enter the road index, nav graphs or spawn surfaces — only the 3D
 *  airport renderer (world/Airport.ts) and the map view consume them. */
export interface AirportData {
  name: string;
  runway: GeneratedRoad;
  taxiway: GeneratedRoad;
  apron: MapPolygon;
  buildings: MapPolygon[];
}

const RAW_AIRPORT = MAP.airport;
const AIRPORT_APRON = RAW_AIRPORT ? buildPolygon(`${RAW_AIRPORT.name} apron`, 'aerodrome', RAW_AIRPORT.apron) : undefined;

export const AIRPORT: AirportData | undefined = RAW_AIRPORT && AIRPORT_APRON ? {
  name: RAW_AIRPORT.name,
  runway: { name: `${RAW_AIRPORT.name} runway`, width: RAW_AIRPORT.runway.width, kind: RAW_AIRPORT.runway.kind, points: toPts(RAW_AIRPORT.runway.points) },
  taxiway: { name: `${RAW_AIRPORT.name} taxiway`, width: RAW_AIRPORT.taxiway.width, kind: RAW_AIRPORT.taxiway.kind, points: toPts(RAW_AIRPORT.taxiway.points) },
  apron: AIRPORT_APRON,
  buildings: RAW_AIRPORT.buildings
    .map((footprint, index) => buildPolygon(`${RAW_AIRPORT.name} building ${index + 1}`, 'aerodrome', footprint))
    .filter((polygon): polygon is MapPolygon => polygon !== undefined),
} : undefined;

// ---- Coast (Jozi-by-the-Sea graft) ------------------------------------------

const RAW_COAST = MAP.coast;

/** North→south shoreline polyline: the land/water boundary the beach strip and ocean share. */
export const COASTLINE: MapPt[] = RAW_COAST ? toPts(RAW_COAST.coastline) : [];

/** Closed reservoir polygon (west of the coastline, extending past the world edge). One premium
 *  water site, and NAMED: it is a dam, and the map should say so. */
export const OCEAN_POLYGON: MapPolygon | undefined =
  RAW_COAST ? buildPolygon(RAW_COAST.name ?? 'Dam', 'ocean', RAW_COAST.ocean) : undefined;

/** Resort beach polygons — Misty Bay and Leboya Bay, both placed ON LAND at the measured waterline
 *  by the mapgen graft. They drive both the golden-sand z-bands on the strand and the 'beach' scatter
 *  zone, so resort clutter (loungers, kiosks, ablutions, ski-boat sheds) lands at the resorts and
 *  nowhere else along the shore. */
/** The dam's real islands — inner rings of the placed Vaal outline, Grooteiland first. These are
 *  HOLES in OCEAN_POLYGON: the terrain lifts them out of the water so they are landable ground. */
export const DAM_ISLAND_RINGS: MapPt[][] = (RAW_COAST?.islands ?? []).map((ring) => toPts(ring));

export const BEACH_POLYGONS: MapPolygon[] = RAW_COAST
  ? RAW_COAST.beaches
      .map((beach) => buildPolygon(beach.name, 'beach', beach.points))
      .filter((polygon): polygon is MapPolygon => polygon !== undefined)
  : [];

/** Quay end where the coastal highway meets the sea (dock apron anchor). */
export const HARBOUR_POINT: MapPt | undefined = RAW_COAST ? { x: RAW_COAST.harbour.x, z: RAW_COAST.harbour.z } : undefined;

/** Rural corridor x-band separating the Joburg crop (east) from the seaboard (west). */
export const COAST_CORRIDOR: { eastX: number; westX: number } | undefined = RAW_COAST ? { ...RAW_COAST.corridor } : undefined;

/**
 * REAL traced building footprints on the dam shore (oriented boxes, world units). These are actual
 * OSM outlines from Deneysville, Refengkgotso and the marina frontage — the map used to reduce them
 * to a district density scalar and draw nothing. CityGen lays them down before the procedural
 * frontage pass, so the real village is the village and the procedural massing infills around it.
 */
export interface RealFootprint { x: number; z: number; w: number; d: number; heading: number; kind: string }
export const REAL_FOOTPRINTS: readonly RealFootprint[] = RAW_COAST?.shoreBuildings ?? [];

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

/** Named passenger stations supplied by the map pipeline. */
export const RAILWAY_STATIONS: MapLandmark[] = LANDMARKS.filter((entry) => entry.kind === 'station');

export interface RailwayStationSite extends MapLandmark {
  dirX: number;
  dirZ: number;
  railway: GeneratedRailway;
  /** Offset from the source landmark to its rendered, track-aligned site. */
  sourceDistance: number;
}

// ---- Station platform geometry (shared with the renderer) ---------------------
//
// City.buildRailwayStation lays the slabs from these, and the siting below tests against them, so the
// stop is only ever placed where the architecture it is about to build actually fits.

/** Width of one platform slab. */
export const STATION_PLATFORM_WIDTH = 3.6;
/** Slab centre offset from the rail centreline: clear of the ballast, plus a small gap. */
export const STATION_PLATFORM_OFFSET = RAILWAY_CORRIDOR_HALF_WIDTH + STATION_PLATFORM_WIDTH / 2 + 0.25;
/** Platform length. Park Station, the terminus, gets the long one. */
export const STATION_PLATFORM_LENGTH = 46;
export const STATION_PLATFORM_LENGTH_TERMINUS = 58;
export function stationPlatformLength(name: string): number {
  return name === 'Park Station' ? STATION_PLATFORM_LENGTH_TERMINUS : STATION_PLATFORM_LENGTH;
}
/** How far along its line a stop may slide to find room for both platforms. */
const STATION_SLIDE_LIMIT = 200;
const STATION_SLIDE_STEP = 4;

/** Worst clearance a platform slab on `side` has from the carriageway and from the road AS BUILT. */
export function platformSideClearance(
  x: number, z: number, dirX: number, dirZ: number, side: 1 | -1, length: number,
): { tar: number; built: number } {
  const heading = Math.atan2(dirX, dirZ);
  const c = Math.cos(heading); const s = Math.sin(heading);
  const lx = side * STATION_PLATFORM_OFFSET;
  let tar = Infinity; let built = Infinity;
  for (let lz = -length / 2; lz <= length / 2 + 1e-9; lz += 6) {
    const px = x + lx * c + lz * s; const pz = z - lx * s + lz * c;
    tar = Math.min(tar, distanceToRoadEdge(px, pz));
    built = Math.min(built, distanceToBuiltRoadEdge(px, pz));
  }
  return { tar, built };
}

/**
 * Whether a platform slab on `side` may be built beside the line at (x, z).
 *
 * Two standards, because they are different failures. A slab overlapping the PAVEMENT is a station
 * entrance meeting the footway, which is what stations do — that is only worth sliding a stop to
 * avoid. A slab overlapping the CARRIAGEWAY is a concrete block in a live traffic lane, and is never
 * built. Siting below asks for 'built' first and settles for 'tar'; the renderer only ever enforces
 * 'tar', so a station that got sited is a station that gets both its platforms.
 */
export function platformSideFits(
  x: number, z: number, dirX: number, dirZ: number, side: 1 | -1, length: number, standard: 'built' | 'tar' = 'tar',
): boolean {
  const clearance = platformSideClearance(x, z, dirX, dirZ, side, length);
  return (standard === 'built' ? clearance.built : clearance.tar) >= STATION_PLATFORM_WIDTH / 2;
}

/** Arc-length walk along a rail line: the spot `distance` further on from `spot`, or undefined at the end. */
function railSpotAlong(railway: GeneratedRailway, x: number, z: number, distance: number): RailwaySpot | undefined {
  const points = railway.points;
  // Locate the parametric position of (x, z) on the line, then walk.
  let bestIndex = -1; let bestT = 0; let bestDistanceSq = Infinity;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!; const b = points[index + 1]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-8) continue;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
    const distanceSq = (a.x + dx * t - x) ** 2 + (a.z + dz * t - z) ** 2;
    if (distanceSq < bestDistanceSq) { bestDistanceSq = distanceSq; bestIndex = index; bestT = t; }
  }
  if (bestIndex < 0) return undefined;
  let index = bestIndex; let t = bestT; let remaining = distance;
  while (index >= 0 && index < points.length - 1) {
    const a = points[index]!; const b = points[index + 1]!;
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (segment < 1e-8) { index += remaining >= 0 ? 1 : -1; t = remaining >= 0 ? 0 : 1; continue; }
    const ahead = remaining >= 0 ? (1 - t) * segment : -t * segment;
    if (remaining >= 0 ? remaining <= ahead : remaining >= ahead) {
      const at = t + remaining / segment;
      return {
        x: a.x + (b.x - a.x) * at, z: a.z + (b.z - a.z) * at,
        dirX: (b.x - a.x) / segment, dirZ: (b.z - a.z) / segment, railway,
      };
    }
    remaining -= ahead;
    if (remaining >= 0) { index++; t = 0; } else { index--; t = 1; }
  }
  return undefined;
}

/** Station architecture is snapped to real track so platforms can never float beside or cross the line.
 *  Sites come from the pipeline's full `stations` coverage (a stop at every line end + 2.5–5 km spacing),
 *  deduped at shared-interchange points; the station-kind landmarks are the fallback on older maps.
 *  The Lughawe Halt is excluded — Airport.ts builds its own bespoke platform beside the apron.
 *
 *  A stop whose projection leaves a platform on a road SLIDES ALONG ITS LINE to the nearest spot where
 *  both sides fit. It used to be built anyway, minus the offending side: five of the seventeen sites on
 *  the shipped map rendered as a station with one platform, one row of shelters and nothing opposite —
 *  which is what "one of the rail station sides is missing" was. Sliding a stop a few tens of units
 *  along its own line is invisible and authentic; a half-built station is neither. */
export const RAILWAY_STATION_SITES: RailwayStationSite[] = (() => {
  const sources: Array<{ name: string; x: number; z: number }> = STATIONS.length > 0
    ? STATIONS.filter((station) => !/^lughawe halt$/i.test(station.name))
    : RAILWAY_STATIONS;
  const sites: RailwayStationSite[] = [];
  for (const station of sources) {
    if (sites.some((prior) => (prior.x - station.x) ** 2 + (prior.z - station.z) ** 2 < 40 ** 2)) continue; // one physical interchange, one site
    const projected = nearestRailwaySpot(station.x, station.z);
    if (!projected) continue;
    const length = stationPlatformLength(station.name);
    const fits = (spot: RailwaySpot, standard: 'built' | 'tar'): boolean =>
      platformSideFits(spot.x, spot.z, spot.dirX, spot.dirZ, -1, length, standard)
      && platformSideFits(spot.x, spot.z, spot.dirX, spot.dirZ, 1, length, standard)
      && !sites.some((prior) => (prior.x - spot.x) ** 2 + (prior.z - spot.z) ** 2 < 40 ** 2);
    /** Nearest first, alternating downline/upline so the choice is symmetric and deterministic. */
    const search = (standard: 'built' | 'tar'): RailwaySpot | undefined => {
      if (fits(projected, standard)) return projected;
      for (let slide = STATION_SLIDE_STEP; slide <= STATION_SLIDE_LIMIT; slide += STATION_SLIDE_STEP) {
        for (const direction of [1, -1]) {
          const candidate = railSpotAlong(projected.railway, projected.x, projected.z, slide * direction);
          if (candidate && fits(candidate, standard)) return candidate;
        }
      }
      return undefined;
    };
    const spot = search('built') ?? search('tar') ?? projected;
    sites.push({
      name: station.name,
      kind: 'station',
      x: spot.x,
      z: spot.z,
      dirX: spot.dirX,
      dirZ: spot.dirZ,
      railway: spot.railway,
      sourceDistance: Math.hypot(spot.x - station.x, spot.z - station.z),
    });
  }
  return sites;
})();

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

// ---- Railway-corridor distance grid -----------------------------------------

/** How far beyond the ballast edge the railway grid measures accurately. */
export const RAILWAY_EDGE_CAP = 18;

const railwayEdgeGrid = new Map<string, EdgeSegment[]>();
for (const railway of GENERATED_RAILWAYS) {
  for (let index = 0; index < railway.points.length - 1; index++) {
    const a = railway.points[index]!; const b = railway.points[index + 1]!;
    insertEdgeSegment(railwayEdgeGrid, { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: RAILWAY_CORRIDOR_HALF_WIDTH }, RAILWAY_EDGE_CAP);
  }
}

/** Distance to the nearest ballast edge (negative on the railway bed), capped for cheap bulk placement. */
export function distanceToRailwayCorridor(x: number, z: number): number {
  return distanceToEdge(railwayEdgeGrid, x, z, RAILWAY_EDGE_CAP);
}

// ---- Signalised junctions -----------------------------------------------------

interface JunctionAccumulator {
  x: number; z: number; degree: number;
  incident: Array<{ name: string; width: number; dirX: number; dirZ: number }>;
  /** Every carriageway half that LEAVES the node, direction pointing away from it — one per road segment
   *  touching the junction (a through-road contributes two). Unlike `incident`/`arms` these carry the real
   *  outward sign, so the sidewalk-corner builder can tell the inside of a bend from the outside. */
  outward: Array<{ dirX: number; dirZ: number; width: number }>;
}

/**
 * Every generated junction with its degree and incident-road tally. Degree counts road SEGMENTS at
 * the node: a road passing through adds 2, a road ending there adds 1 — so degree is the classic
 * "number of arms" (T = 3, crossroads = 4). Built once from the road vertices that land exactly on a
 * junction anchor (the pipeline emits junctions on shared vertices), then cached: both the signal
 * selection and the intersection-surface geometry read it.
 */
let cachedAccumulators: JunctionAccumulator[] | undefined;
function junctionAccumulators(): JunctionAccumulator[] {
  if (cachedAccumulators) return cachedAccumulators;
  const map = new Map<string, JunctionAccumulator>();
  for (const junction of MAP.junctions) {
    map.set(`${junction.x}|${junction.z}`, { x: junction.x, z: junction.z, degree: 0, incident: [], outward: [] });
  }
  for (const road of GENERATED_ROADS) {
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!;
      const accumulator = map.get(`${point.x}|${point.z}`);
      if (!accumulator) continue;
      accumulator.degree += (index > 0 ? 1 : 0) + (index < road.points.length - 1 ? 1 : 0);
      const spot = spotAt(road, index);
      accumulator.incident.push({ name: road.name, width: road.width, dirX: spot.dirX, dirZ: spot.dirZ });
      for (const neighbour of [road.points[index - 1], road.points[index + 1]]) { // each road segment that leaves the node
        if (!neighbour) continue;
        const dx = neighbour.x - point.x; const dz = neighbour.z - point.z; const length = Math.hypot(dx, dz);
        if (length > 1e-6) accumulator.outward.push({ dirX: dx / length, dirZ: dz / length, width: road.width });
      }
    }
  }
  cachedAccumulators = [...map.values()];
  return cachedAccumulators;
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
  interface Candidate { x: number; z: number; angle: number; roadA: string; roadB: string; widest: number; score: number; }
  const candidates: Candidate[] = [];
  for (const accumulator of junctionAccumulators()) {
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

// ---- Street-name sign junctions ------------------------------------------------

/** A named crossing that carries street-name boards (no signal phase — signs only). */
export interface StreetSignJunctionDef {
  x: number;
  z: number;
  angle: number;
  roadA: string;
  roadB: string;
  /** Width of the widest incident road — the board post's corner offset scales from it. */
  widest: number;
}

/** Placeholder / generic labels that shouldn't headline a street-name board. Real crossings need two
 *  distinct *named* roads: OSM's "Unnamed …" ramp links and the odd "Water" placeholder are excluded. */
function isNamedRoad(name: string): boolean {
  return name.trim().length > 0 && !/^unnamed\b/i.test(name) && !/^water$/i.test(name);
}

export interface StreetSignSelectionOptions {
  budget?: number;
  minSpacing?: number;
  minWidestWidth?: number;
  minSecondWidth?: number;
}

/**
 * The junctions that get street-name signs: every real NAMED intersection — degree >= 3 with at least
 * two DISTINCT named incident roads — labelled with the two most prominent (widest) of those names, and
 * angled to the widest road's bearing so roadA's board runs along it. Far broader than the ~64 signalised
 * junctions, so named corners read across the whole map like the old hand-authored city ("plenty" of them).
 * Scored widest-first with a spacing constraint so the budget spreads rather than clumping in the CBD grid.
 * Pure, deterministic and cached-friendly (reads the shared junction accumulators).
 */
export function computeStreetSignJunctions(options: StreetSignSelectionOptions = {}): StreetSignJunctionDef[] {
  const { budget = 1200, minSpacing = 34, minWidestWidth = 7, minSecondWidth = 7 } = options;
  interface Candidate { x: number; z: number; angle: number; roadA: string; roadB: string; widest: number; score: number; }
  const candidates: Candidate[] = [];
  for (const accumulator of junctionAccumulators()) {
    if (accumulator.degree < 3) continue;
    // Named arms with a real bearing: a road that doubles back on itself here leaves a zero-length
    // direction (no street to align a board to), so it can't headline roadA — drop it.
    const named = accumulator.incident
      .filter((entry) => isNamedRoad(entry.name) && Math.hypot(entry.dirX, entry.dirZ) > 1e-6)
      .sort((a, b) => b.width - a.width);
    const widest = named[0];
    const other = named.find((entry) => entry.name !== widest?.name);
    if (!widest || !other) continue; // needs two DISTINCT named roads: a lone-named corner gets no board
    if (widest.width < minWidestWidth || other.width < minSecondWidth) continue;
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
  return chosen.map((candidate) => ({
    x: candidate.x, z: candidate.z, angle: candidate.angle,
    roadA: candidate.roadA, roadB: candidate.roadB, widest: candidate.widest,
  }));
}

/** The street-sign set the game builds — computed once at module load. Signalised junctions already carry
 *  boards via the signal path, so the placement loop skips any that coincide (see UrbanInfrastructure). */
export const STREET_SIGN_JUNCTIONS: StreetSignJunctionDef[] = computeStreetSignJunctions();

// ---- Intersection surfaces (paved crossing polygons) --------------------------

/** One carriageway meeting a junction: a unit outward direction and the road's width. Distinct directions
 *  only (a road passing through contributes a single arm, not two opposed ones). */
export interface JunctionArm {
  dirX: number;
  dirZ: number;
  width: number;
}

export interface JunctionSurface {
  x: number;
  z: number;
  /** Radius of the paved disc laid over the crossing centre — scales from the widest meeting carriageway. */
  radius: number;
  /** Width of the widest road that meets here (drives the radius). */
  widest: number;
  /** Number of road arms at the node (T = 3, crossroads = 4, +). */
  degree: number;
  /** The distinct incident carriageways, so the renderer can pave each arm's strip through the node — a disc
   *  alone leaves the square crossing's corners (and the ribbon edge-lines) poking out as an "X". */
  arms: JunctionArm[];
  /** The approaches that carry a painted stop/yield bar (outward bearing + carriageway width). SA rule: a
   *  signalised junction and every 4-way stops all its approaches; at an uncontrolled T the continuous
   *  through-road is exempt and only the terminating minor(s) get a line. See computeStopLines. */
  stopLines: JunctionArm[];
  /** Every carriageway half LEAVING the node with its true outward direction (a through-road gives two).
   *  The sidewalk-corner builder pairs adjacent ones and fills the off-road wedge between them. */
  outwardArms: JunctionArm[];
}

/** Collapse arms sharing the SAME outward bearing (not opposed — a through-road's two ends stay separate,
 *  each is its own approach), keeping the widest width. Deterministic. */
function distinctBearings(arms: JunctionArm[]): JunctionArm[] {
  const out: JunctionArm[] = [];
  for (const arm of arms) {
    const match = out.find((existing) => existing.dirX * arm.dirX + existing.dirZ * arm.dirZ > 0.985);
    if (match) { if (arm.width > match.width) match.width = arm.width; }
    else out.push({ ...arm });
  }
  return out;
}

/**
 * Which approaches at a junction get a painted stop bar, from the incident-road tally and whether the node
 * is signalised. A road that contributes >= 2 incident segments passes/bends through the node (continuous);
 * one segment terminates there. SA marking convention:
 *  - signalised (robot): every approach stops -> line on all.
 *  - >= 2 through-roads (a proper crossing / 4-way): line on all approaches.
 *  - otherwise (a T or minor spur): the continuous through-road is priority and gets NO line; only the
 *    terminating minor approaches are painted.
 */
export function computeStopLines(
  incident: Array<{ name: string; width: number; dirX: number; dirZ: number }>,
  signalised: boolean,
): JunctionArm[] {
  const byName = new Map<string, { width: number; dirs: JunctionArm[] }>();
  for (const entry of incident) {
    const length = Math.hypot(entry.dirX, entry.dirZ);
    if (length < 1e-6) continue; // degenerate spot: no bearing
    const road = byName.get(entry.name) ?? { width: entry.width, dirs: [] };
    road.width = Math.max(road.width, entry.width);
    road.dirs.push({ dirX: entry.dirX / length, dirZ: entry.dirZ / length, width: entry.width });
    byName.set(entry.name, road);
  }
  const throughRoads = [...byName.values()].filter((road) => distinctBearings(road.dirs).length >= 2);
  const paintAll = signalised || throughRoads.length >= 2;
  const lines: JunctionArm[] = [];
  for (const road of byName.values()) {
    const isThrough = distinctBearings(road.dirs).length >= 2;
    if (!paintAll && isThrough) continue; // the continuous main road at an uncontrolled T keeps priority — no bar
    for (const dir of distinctBearings(road.dirs)) lines.push({ dirX: dir.dirX, dirZ: dir.dirZ, width: road.width });
  }
  return distinctBearings(lines);
}

/** Collapse a node's incident roads to distinct outward directions (a through-road's two opposed vertices
 *  become one arm, keeping the widest width), so paving covers each carriageway once. Deterministic. */
function distinctArms(incident: Array<{ width: number; dirX: number; dirZ: number }>): JunctionArm[] {
  const arms: JunctionArm[] = [];
  for (const entry of incident) {
    const length = Math.hypot(entry.dirX, entry.dirZ);
    if (length < 1e-6) continue; // degenerate spot (coincident vertices): no meaningful arm direction
    const dirX = entry.dirX / length; const dirZ = entry.dirZ / length;
    const match = arms.find((arm) => Math.abs(arm.dirX * dirX + arm.dirZ * dirZ) > 0.985); // same line (either heading)
    if (match) { if (entry.width > match.width) match.width = entry.width; }
    else arms.push({ dirX, dirZ, width: entry.width });
  }
  return arms;
}

export interface JunctionSurfaceOptions {
  /** Minimum arm count to pave. 3 = every real crossing (T/cross/multi-way); degree ≤ 2 is a single
   *  ribbon passing through or two roads meeting end-to-end — no overlapping ribbons to unify. */
  minDegree?: number;
  /** Extra reach beyond the widest carriageway's edge, so the disc buries the ribbon-overlap seams. */
  margin?: number;
}

/**
 * The crossings that need a filled intersection surface. Where two road ribbons cross they are drawn
 * as independent overlapping planes (z-fighting seams, an "X of two planes"); a paved disc sized to
 * the widest meeting road, laid just over the tar, unifies each crossing into one clean surface.
 * Pure and deterministic — derived straight from junction degree + incident road widths.
 */
export function computeJunctionSurfaces(options: JunctionSurfaceOptions = {}): JunctionSurface[] {
  const { minDegree = 3, margin = 1 } = options;
  const signalised = new Set(SIGNAL_JUNCTIONS.map((junction) => `${junction.x}|${junction.z}`)); // robots stop every approach
  const surfaces: JunctionSurface[] = [];
  for (const accumulator of junctionAccumulators()) {
    // Degree-2 nodes where two DIFFERENT named roads meet end-to-end are corners (a bend/name change), not
    // through-traffic — pave them too so the outer corner of the two ribbons (and its footpath) is filled
    // in, but with no stop bar (a bend isn't a stop). Everything degree >= minDegree paves as before.
    const corner = accumulator.degree === 2 && new Set(accumulator.incident.map((entry) => entry.name)).size >= 2;
    if (accumulator.degree < minDegree && !corner) continue;
    let widest = 0;
    for (const incident of accumulator.incident) if (incident.width > widest) widest = incident.width;
    if (widest <= 0) continue;
    surfaces.push({
      x: accumulator.x, z: accumulator.z, radius: widest / 2 + margin, widest, degree: accumulator.degree,
      arms: distinctArms(accumulator.incident),
      stopLines: corner ? [] : computeStopLines(accumulator.incident, signalised.has(`${accumulator.x}|${accumulator.z}`)),
      outwardArms: accumulator.outward.map((arm) => ({ dirX: arm.dirX, dirZ: arm.dirZ, width: arm.width })),
    });
  }
  return surfaces;
}

/** How far a junction's paving reaches from the node along each arm: enough to cover the square crossing
 *  footprint of the widest carriageway (half-diagonal ~= 0.71 * width), never less than the centre disc. */
export function junctionReach(surface: JunctionSurface): number {
  return Math.max(surface.radius, surface.widest * 0.72);
}

/** True when (x, z) lies on a junction's paved surface: inside the centre disc, or on any arm's strip
 *  (a carriageway-wide band running clear across the node). The renderer bakes exactly this shape, and the
 *  lane-marking pass blanks markings wherever this holds — so a crossing reads as one clean surface. */
export function junctionPaves(surface: JunctionSurface, x: number, z: number): boolean {
  const dx = x - surface.x; const dz = z - surface.z;
  if (dx * dx + dz * dz <= surface.radius * surface.radius) return true;
  const reach = junctionReach(surface);
  for (const arm of surface.arms) {
    const along = dx * arm.dirX + dz * arm.dirZ;
    const perp = -dx * arm.dirZ + dz * arm.dirX;
    if (Math.abs(along) <= reach && Math.abs(perp) <= arm.width / 2) return true;
  }
  return false;
}

/** The intersection surfaces the game bakes into the chunked road geometry — computed once at load. */
export const JUNCTION_SURFACES: JunctionSurface[] = computeJunctionSurfaces();
