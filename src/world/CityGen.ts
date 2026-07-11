/**
 * Citywide procedural building plan (owner's rule A: source → destination).
 *
 * Everything here is derived deterministically from committed data — the OSM road network and
 * district densities (mapData), the zoning layer (data/zoning), the reserved anchor pads
 * (placements) and the manicured-site carve-outs (data/manicured). There is NO hand-placed
 * building coordinate: the whole city is a pure function of those inputs plus positional seeds.
 *
 * The pipeline is:  roads → street frontage → parcels (subdivided TO THE STREET, sized per zone)
 * → per-parcel building spec.  Parcels are computed once and bucketed onto the CELL_SIZE chunk
 * grid; the runtime (City) asks for one cell at a time via generateCell() and builds/disposes the
 * meshes on demand.  Because generateCell() is a pure lookup + positional-seed map, a cell that is
 * generated, disposed and regenerated yields byte-identical buildings — the streaming contract.
 *
 * Pure data + pure functions (no three.js) so tests and the headless perf script consume it freely.
 */
import {
  distanceToRoadEdge,
  GENERATED_ROADS,
  METRES_PER_UNIT,
  MAP_WORLD_SIZE,
  nearestDistrict,
  type GeneratedRoad,
} from './mapData';
import { classifyZone, type Zone } from './data/zoning';
import { RESERVED_PADS } from './placements';
import { MANICURED_FOOTPRINTS } from './data/manicured';
import type { BuildingStyle } from './BuildingArchitecture';

/** Chunk cell size — MUST equal City.MERGE_CHUNK_SIZE (City imports this so they can't drift). */
export const CELL_SIZE = 976;

/**
 * Unit-denominated layout distances were authored at 2.94 m/unit; LAYOUT_SCALE tracks the real
 * footprint so parcel sizes stay constant in metres at any TARGET_SIZE (3.0 at the 18000u map).
 */
const LAYOUT_SCALE = 2.94 / METRES_PER_UNIT;
/** Frontage line offset beyond the road edge — matches City's sidewalk apron so buildings sit behind it. */
const FRONTAGE_CLEARANCE = 3.05;
/** Arc step (units) for walking a road centreline while laying out lots. */
const WALK_STEP = 8;
/** A parcel centre nearer than this to any road edge is rejected (would hang into the carriageway). */
const ROAD_KEEPOUT = 1.6;
/** Per-cell hard cap on buildings — bounds both draw calls and per-cell generation cost. */
export const CELL_BUILDING_CAP = 46;
const HALF_WORLD = MAP_WORLD_SIZE / 2;

export interface GeneratedBuilding {
  x: number;
  z: number;
  /** Yaw (radians, quarter-snapped) so the building faces its street and its AABB stays axis-aligned. */
  heading: number;
  width: number;
  depth: number;
  height: number;
  style: BuildingStyle;
  zone: Zone;
  variant: number;
}

/** Deterministic positional hash in [0,1) — same (x, z, salt) always yields the same value. */
function seeded(x: number, z: number, salt = 0): number {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
}

const QUARTER = Math.PI / 2;
function snapQuarter(yaw: number): number { return Math.round(yaw / QUARTER) * QUARTER; }

interface ZoneShape {
  style: BuildingStyle;
  lot: [number, number];   // frontage width along the street
  depth: [number, number]; // extent into the block
  yard: number;            // gap between the sidewalk apron and the building face
  accept: number;          // base placement probability before density scaling
}

/** Per-zone parcel geometry. Sizes are in game units at the authored 2.94 m/unit scale (× LAYOUT_SCALE). */
const ZONE_SHAPE: Record<Exclude<Zone, 'none'>, ZoneShape> = {
  'commercial-highrise': { style: 'downtown', lot: [26, 44], depth: [22, 38], yard: 1.5, accept: 0.85 },
  'commercial-strip': { style: 'downtown', lot: [12, 22], depth: [14, 22], yard: 2.2, accept: 0.7 },
  residential: { style: 'residential', lot: [15, 25], depth: [9, 14], yard: 4, accept: 0.42 },
  industrial: { style: 'industrial', lot: [26, 46], depth: [22, 40], yard: 3, accept: 0.5 },
  estate: { style: 'estate', lot: [60, 110], depth: [30, 52], yard: 10, accept: 0.72 },
  rural: { style: 'residential', lot: [40, 80], depth: [8, 14], yard: 12, accept: 0.28 },
};

/** Placement probability for a zone at a point, scaled by the local OSM building density. */
function acceptance(zone: Exclude<Zone, 'none'>, density: number): number {
  const base = ZONE_SHAPE[zone].accept;
  if (zone === 'residential') return Math.min(0.6, 0.12 + density / 500);
  if (zone === 'commercial-strip') return Math.min(0.8, 0.3 + density / 900);
  return base;
}

/** Building height for a placed parcel — highrise cores get a full skyline range, suburbs stay low.
 *  (Height does NOT use the OSM count-density: that peaks in low-rise suburbs, not the tower cores.) */
function buildingHeight(zone: Exclude<Zone, 'none'>, _density: number, s: number): number {
  switch (zone) {
    case 'commercial-highrise': return 40 + s * s * 72; // s² skews toward a few very tall towers
    case 'commercial-strip': return 10 + s * 16;
    case 'industrial': return 8 + s * 9;
    case 'estate': return 7 + s * 5.5;
    case 'rural': return 5 + s * 3;
    default: return 6 + s * 5; // residential
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** True when (x, z) is inside a reserved anchor pad or a manicured site footprint (kept clear). */
function isBlocked(x: number, z: number, radius: number): boolean {
  for (const pad of RESERVED_PADS) if ((pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2) return true;
  for (const site of MANICURED_FOOTPRINTS) if ((site.x - x) ** 2 + (site.z - z) ** 2 < (site.radius + radius) ** 2) return true;
  return false;
}

/** Coarse occupancy grid so parcels from different roads don't stack at intersections. */
class Occupancy {
  private cells = new Map<string, Array<{ x: number; z: number; r: number }>>();
  constructor(private cell = 24) {}
  private key(x: number, z: number): string { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  free(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const other of this.cells.get(`${cx + dx},${cz + dz}`) ?? []) {
        const min = (other.r + r) * 0.62 + 1.5;
        if ((other.x - x) ** 2 + (other.z - z) ** 2 < min * min) return false;
      }
    }
    return true;
  }
  add(x: number, z: number, r: number): void {
    const key = this.key(x, z);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push({ x, z, r }); else this.cells.set(key, [{ x, z, r }]);
  }
}

/** Densely sampled centreline point with its unit direction. */
interface WalkPoint { x: number; z: number; dirX: number; dirZ: number; }

function walkRoad(road: GeneratedRoad): WalkPoint[] {
  const out: WalkPoint[] = [];
  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i]!; const b = road.points[i + 1]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    const dirX = dx / length; const dirZ = dz / length;
    const steps = Math.max(1, Math.ceil(length / WALK_STEP));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + dx * t, z: a.z + dz * t, dirX, dirZ });
    }
  }
  const last = road.points.at(-1);
  const prev = road.points.at(-2);
  if (last && prev) {
    const dx = last.x - prev.x; const dz = last.z - prev.z; const len = Math.hypot(dx, dz) || 1;
    out.push({ x: last.x, z: last.z, dirX: dx / len, dirZ: dz / len });
  }
  return out;
}

let allParcels: GeneratedBuilding[] | undefined;
let parcelCells: Map<string, GeneratedBuilding[]> | undefined;

function layoutRoadSide(road: GeneratedRoad, roadIndex: number, side: 1 | -1, walk: WalkPoint[], occ: Occupancy, out: GeneratedBuilding[]): void {
  const half = road.width / 2;
  let acc = seeded(roadIndex, side, 7) * 20; // phase offset so lots don't align across parallel roads
  let target = 12 * LAYOUT_SCALE;
  let anchor = 0;
  for (let i = 1; i < walk.length; i++) {
    acc += Math.hypot(walk[i]!.x - walk[i - 1]!.x, walk[i]!.z - walk[i - 1]!.z);
    if (acc < target) continue;
    const mid = walk[Math.floor((anchor + i) / 2)]!;
    anchor = i; acc = 0;

    // Frontage line: perpendicular to the road on `side`, one apron beyond the kerb.
    const nX = side * -mid.dirZ; const nZ = side * mid.dirX; // unit inward normal (into the block)
    const frontX = mid.x + nX * (half + FRONTAGE_CLEARANCE);
    const frontZ = mid.z + nZ * (half + FRONTAGE_CLEARANCE);

    const zone = classifyZone(frontX, frontZ, road.width);
    if (zone === 'none') { target = 14 * LAYOUT_SCALE; continue; }
    const shape = ZONE_SHAPE[zone];
    const district = nearestDistrict(frontX, frontZ);

    const lot = lerp(shape.lot[0], shape.lot[1], seeded(frontX, frontZ, 11)) * LAYOUT_SCALE;
    const depth = lerp(shape.depth[0], shape.depth[1], seeded(frontX, frontZ, 12)) * LAYOUT_SCALE;
    const width = lot * (0.72 + seeded(frontX, frontZ, 13) * 0.2); // building narrower than the lot (side gaps)
    const gap = lot * (0.12 + seeded(frontX, frontZ, 14) * 0.16);
    target = lot + gap; // spacing to the next lot on this frontage

    if (seeded(frontX, frontZ, 20) > acceptance(zone, district.density)) continue;

    const cx = frontX + nX * (shape.yard * LAYOUT_SCALE + depth / 2);
    const cz = frontZ + nZ * (shape.yard * LAYOUT_SCALE + depth / 2);
    if (Math.abs(cx) > HALF_WORLD - 20 || Math.abs(cz) > HALF_WORLD - 20) continue;
    if (distanceToRoadEdge(cx, cz) < ROAD_KEEPOUT) continue; // centre sits on/against a street
    const radius = Math.hypot(width, depth) / 2;
    if (isBlocked(cx, cz, radius * 0.6)) continue;
    if (!occ.free(cx, cz, radius)) continue;
    occ.add(cx, cz, radius);

    // Face the street: local +z (the entrance face) points back toward the road, quarter-snapped.
    const heading = snapQuarter(Math.atan2(-nX, -nZ));
    const s = seeded(frontX, frontZ, 30);
    out.push({
      x: cx, z: cz, heading, width, depth,
      height: buildingHeight(zone, district.density, s),
      style: shape.style, zone,
      variant: Math.floor(seeded(frontX, frontZ, 40) * 997),
    });
  }
}

function buildAllParcels(): void {
  const out: GeneratedBuilding[] = [];
  const occ = new Occupancy();
  for (let ri = 0; ri < GENERATED_ROADS.length; ri++) {
    const road = GENERATED_ROADS[ri]!;
    if (road.width < 6) continue;
    const walk = walkRoad(road);
    if (walk.length < 2) continue;
    layoutRoadSide(road, ri, 1, walk, occ, out);
    layoutRoadSide(road, ri, -1, walk, occ, out);
  }
  const cells = new Map<string, GeneratedBuilding[]>();
  for (const building of out) {
    const key = `${Math.floor(building.x / CELL_SIZE)},${Math.floor(building.z / CELL_SIZE)}`;
    const bucket = cells.get(key);
    if (bucket) { if (bucket.length < CELL_BUILDING_CAP) bucket.push(building); }
    else cells.set(key, [building]);
  }
  allParcels = out;
  parcelCells = cells;
}

/** Force the (memoized) citywide parcel layout to build now — call during load, not first frame. */
export function ensureParcels(): void {
  if (!parcelCells) buildAllParcels();
}

/** Every parcel across the whole map (capped per cell). Memoized; deterministic. */
export function allBuildings(): readonly GeneratedBuilding[] {
  ensureParcels();
  return allParcels!;
}

/**
 * The buildings for one chunk cell — a pure function of (cellX, cellZ). Returns fresh spec objects
 * each call (identical by value) so generate → dispose → regenerate reproduces the cell exactly.
 */
export function generateCell(cellX: number, cellZ: number): GeneratedBuilding[] {
  ensureParcels();
  const bucket = parcelCells!.get(`${cellX},${cellZ}`);
  return bucket ? bucket.map((b) => ({ ...b })) : [];
}

/** Zoning/parcel summary for the headless build report. */
export function buildingStats(): {
  total: number;
  perZone: Record<string, number>;
  cells: number;
  maxPerCell: number;
  cappedCells: number;
} {
  ensureParcels();
  const perZone: Record<string, number> = {};
  for (const b of allParcels!) perZone[b.zone] = (perZone[b.zone] ?? 0) + 1;
  let maxPerCell = 0; let cappedCells = 0;
  for (const bucket of parcelCells!.values()) {
    maxPerCell = Math.max(maxPerCell, bucket.length);
    if (bucket.length >= CELL_BUILDING_CAP) cappedCells++;
  }
  return { total: allParcels!.length, perZone, cells: parcelCells!.size, maxPerCell, cappedCells };
}
