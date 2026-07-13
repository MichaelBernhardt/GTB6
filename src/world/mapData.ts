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
  /** SRTM 90 m heightgrid (+ synthetic corridor/coast composite): row-major from the NW corner, values in
   *  metres above sea level, placed in world XZ by an affine origin (x0,z0) + spacing (dx,dz) in game units. */
  elevation?: { cols: number; rows: number; x0: number; z0: number; dx: number; dz: number; data: number[] };
}

const MAP = rawMap as unknown as RawMap;

export const MAP_STATS = MAP.stats;
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
 */
const EL = MAP.elevation;

/** Blur radius for the regional trend, in grid cells (~1 cell = dx units). */
const REGIONAL_BLUR_CELLS = 6;

/** Separable box-blur of the heightgrid → the smooth regional trend. Computed once; clamped at edges. */
const REGIONAL_DATA: number[] | undefined = (() => {
  if (!EL) return undefined;
  const { cols, rows, data } = EL;
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
    map.set(`${junction.x}|${junction.z}`, { x: junction.x, z: junction.z, degree: 0, incident: [] });
  }
  for (const road of GENERATED_ROADS) {
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!;
      const accumulator = map.get(`${point.x}|${point.z}`);
      if (!accumulator) continue;
      accumulator.degree += (index > 0 ? 1 : 0) + (index < road.points.length - 1 ? 1 : 0);
      const spot = spotAt(road, index);
      accumulator.incident.push({ name: road.name, width: road.width, dirX: spot.dirX, dirZ: spot.dirZ });
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
    if (accumulator.degree < minDegree) continue;
    let widest = 0;
    for (const incident of accumulator.incident) if (incident.width > widest) widest = incident.width;
    if (widest <= 0) continue;
    surfaces.push({
      x: accumulator.x, z: accumulator.z, radius: widest / 2 + margin, widest, degree: accumulator.degree,
      arms: distinctArms(accumulator.incident),
      stopLines: computeStopLines(accumulator.incident, signalised.has(`${accumulator.x}|${accumulator.z}`)),
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
