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
  distanceToRailwayCorridor,
  distanceToRoadEdge,
  GENERATED_ROADS,
  METRES_PER_UNIT,
  MAP_WORLD_SIZE,
  AERODROME_POLYGONS,
  DIRT_POLYGONS,
  FARM_POLYGONS,
  GREEN_POLYGONS,
  WATER_POLYGONS,
  nearestDistrict,
  pointInAnyPolygon,
  RAILWAY_STATION_SITES,
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
/**
 * Minimum clear distance a building FOOTPRINT must keep from every road edge — the reserved
 * corridor is the carriageway plus its sidewalk apron (~2.2u) plus a small margin. Checked over
 * the whole footprint (not just the centre), so a large mass can't reach across a thin block onto
 * a neighbouring / cross / rear street. Kept below the front-face setback (>=4.5u for every zone)
 * so a building fronting its own road is never rejected by its own frontage.
 */
const ROAD_CLEARANCE = 2.5;
/** Extra breathing room beyond the ballast edge: no facade, foundation, or overhang enters railway land. */
export const RAILWAY_BUILDING_CLEARANCE = 2.5;
/** Circular crafted-site claim around each track-aligned station (Park's long platforms span about 32u). */
export const RAILWAY_STATION_CLEARANCE = 34;
/** Footprint sampling pitch (units) for the road-corridor test — quarter-snapped AABBs sample exactly. */
const FOOTPRINT_SAMPLE_STEP = 3;
/** Shrink schedule for a mass that overhangs a road: multiply w&d per attempt, up to this many tries. */
const SHRINK_FACTOR = 0.82;
const SHRINK_ATTEMPTS = 6;
/** Never shrink a footprint below this on either axis — reject instead (keeps the street clear). */
const MIN_FOOTPRINT = 5;
/** Per-cell hard cap on buildings — bounds both draw calls and per-cell generation cost. */
export const CELL_BUILDING_CAP = 64;
const HALF_WORLD = MAP_WORLD_SIZE / 2;
const UNBUILT_POLYGON_GROUPS = [WATER_POLYGONS, GREEN_POLYGONS, DIRT_POLYGONS, FARM_POLYGONS, AERODROME_POLYGONS];

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

/**
 * Minimum distance from a building footprint to the nearest road edge (negative when the footprint
 * sits on a carriageway). The footprint is the W×D rectangle centred at (cx, cz) and rotated by
 * `heading` (any angle — aligned to the street) — sampled on a grid so the interior and every edge are covered, not just the
 * centre. Uses the shared road-edge grid, so it is pure, deterministic and cheap. Exported so tests
 * can assert the citywide guarantee (no footprint intersects a road corridor).
 */
function footprintClearance(
  cx: number, cz: number, width: number, depth: number, heading: number,
  distanceAt: (x: number, z: number) => number,
): number {
  const c = Math.cos(heading); const s = Math.sin(heading);
  const hx = width / 2; const hz = depth / 2;
  const nx = Math.max(1, Math.ceil(width / FOOTPRINT_SAMPLE_STEP));
  const nz = Math.max(1, Math.ceil(depth / FOOTPRINT_SAMPLE_STEP));
  let min = Infinity;
  for (let i = 0; i <= nx; i++) {
    const lx = -hx + (2 * hx) * (i / nx);
    for (let j = 0; j <= nz; j++) {
      const lz = -hz + (2 * hz) * (j / nz);
      // Same rotation City uses to place the collider, so the sampled rectangle IS the collider footprint.
      const wx = cx + lx * c + lz * s;
      const wz = cz - lx * s + lz * c;
      const d = distanceAt(wx, wz);
      if (d < min) min = d;
    }
  }
  return min;
}

export function footprintRoadClearance(cx: number, cz: number, width: number, depth: number, heading: number): number {
  return footprintClearance(cx, cz, width, depth, heading, distanceToRoadEdge);
}

/** Minimum footprint distance to the edge of any railway ballast corridor. Negative means the mass
 *  actually covers track; positive clearance protects foundations and facade detail as well. */
export function footprintRailwayClearance(cx: number, cz: number, width: number, depth: number, heading: number): number {
  return footprintClearance(cx, cz, width, depth, heading, distanceToRailwayCorridor);
}

interface ZoneShape {
  style: BuildingStyle;
  lot: [number, number];   // frontage width along the street
  depth: [number, number]; // extent into the block
  yard: number;            // gap between the sidewalk apron and the building face
  accept: number;          // base placement probability before density scaling
}

/** Per-zone parcel geometry. Sizes are in game units at the authored 2.94 m/unit scale (× LAYOUT_SCALE). */
const ZONE_SHAPE: Record<Exclude<Zone, 'none'>, ZoneShape> = {
  'commercial-highrise': { style: 'downtown', lot: [26, 44], depth: [22, 38], yard: 1.5, accept: 0.95 },
  'commercial-strip': { style: 'mixed-use', lot: [12, 22], depth: [14, 22], yard: 2.2, accept: 0.9 },
  residential: { style: 'suburban', lot: [15, 25], depth: [9, 14], yard: 4, accept: 0.82 },
  industrial: { style: 'industrial', lot: [26, 46], depth: [22, 40], yard: 3, accept: 0.72 },
  estate: { style: 'estate', lot: [60, 110], depth: [30, 52], yard: 10, accept: 0.78 },
  rural: { style: 'rural', lot: [40, 80], depth: [8, 14], yard: 12, accept: 0.28 },
};

/** Placement probability for a zone at a point, scaled by the local OSM building density. */
function acceptance(zone: Exclude<Zone, 'none'>, density: number): number {
  const base = ZONE_SHAPE[zone].accept;
  if (zone === 'residential') return Math.min(base, 0.3 + density / 400);
  if (zone === 'commercial-strip') return Math.min(base, 0.5 + density / 800);
  return base;
}

/** Residential blocks keep one coherent local character instead of shuffling house types lot by lot. */
function buildingStyle(zone: Exclude<Zone, 'none'>, density: number, x: number, z: number): BuildingStyle {
  if (zone !== 'residential') return ZONE_SHAPE[zone].style;
  const denseChance = Math.min(0.85, Math.max(0.1, (density - 40) / 260));
  // Quantise the seed to a neighbourhood-sized tile so adjoining parcels read as one district.
  const blockX = Math.floor(x / 180); const blockZ = Math.floor(z / 180);
  return seeded(blockX, blockZ, 61) < denseChance ? 'dense-residential' : 'suburban';
}

/** Building height for a placed parcel — highrise cores get a full skyline range, suburbs stay low.
 *  (Height does NOT use the OSM count-density: that peaks in low-rise suburbs, not the tower cores.) */
function buildingHeight(zone: Exclude<Zone, 'none'>, _density: number, s: number, style: BuildingStyle): number {
  switch (zone) {
    case 'commercial-highrise': return 40 + s * s * 72; // s² skews toward a few very tall towers
    case 'commercial-strip': return 10 + s * 16;
    case 'industrial': return 8 + s * 9;
    case 'estate': return 7 + s * 5.5;
    case 'rural': return 5 + s * 3;
    default: return style === 'dense-residential' ? 11 + s * 17 : 6 + s * 5;
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** True when (x, z) is inside a reserved anchor pad or a manicured site footprint (kept clear). */
function isBlocked(x: number, z: number, radius: number): boolean {
  for (const pad of RESERVED_PADS) if ((pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2) return true;
  for (const site of MANICURED_FOOTPRINTS) if ((site.x - x) ** 2 + (site.z - z) ** 2 < (site.radius + radius) ** 2) return true;
  return false;
}

/** Stations need the complete circumscribed footprint radius, unlike the looser visual spacing used by
 *  generic anchor pads, because a platform corner hidden under a building would recreate the reported bug. */
function stationBlocks(x: number, z: number, radius: number): boolean {
  return RAILWAY_STATION_SITES.some((station) => (station.x - x) ** 2 + (station.z - z) ** 2 < (RAILWAY_STATION_CLEARANCE + radius) ** 2);
}

/** Coarse occupancy grid so parcels from different roads don't stack at intersections. */
class Occupancy {
  private cells = new Map<string, Array<{ x: number; z: number; r: number }>>();
  private maxRadius = 0;
  constructor(private cell = 64) {}
  private key(x: number, z: number): string { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  free(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    const reach = Math.max(1, Math.ceil(((r + this.maxRadius) * 0.62 + 1.5) / this.cell) + 1);
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
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
    this.maxRadius = Math.max(this.maxRadius, r);
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

interface FittedFootprint { x: number; z: number; width: number; depth: number; }

/** Fit a mass behind an anchored front face without ever pulling that face back toward the street. */
function fitFootprint(
  faceX: number, faceZ: number, nX: number, nZ: number,
  width0: number, depth0: number, heading: number,
): FittedFootprint | undefined {
  let width = width0; let depth = depth0;
  for (let attempt = 0; attempt <= SHRINK_ATTEMPTS; attempt++) {
    const x = faceX + nX * (depth / 2); const z = faceZ + nZ * (depth / 2);
    const clearsRoads = footprintRoadClearance(x, z, width, depth, heading) >= ROAD_CLEARANCE;
    const clearsRailways = footprintRailwayClearance(x, z, width, depth, heading) >= RAILWAY_BUILDING_CLEARANCE;
    if (clearsRoads && clearsRailways) return { x, z, width, depth };
    if (Math.min(width, depth) * SHRINK_FACTOR < MIN_FOOTPRINT) break;
    width *= SHRINK_FACTOR; depth *= SHRINK_FACTOR;
  }
  return undefined;
}

function commitBuilding(
  fit: FittedFootprint, heading: number, zone: Exclude<Zone, 'none'>, density: number,
  style: BuildingStyle, seedX: number, seedZ: number, salt: number,
  occ: Occupancy, out: GeneratedBuilding[],
): boolean {
  const { x, z, width, depth } = fit;
  if (Math.abs(x) > HALF_WORLD - 20 || Math.abs(z) > HALF_WORLD - 20) return false;
  const c = Math.cos(heading); const s = Math.sin(heading);
  for (const fx of [-0.5, 0, 0.5]) for (const fz of [-0.5, 0, 0.5]) {
    const sampleX = x + fx * width * c + fz * depth * s;
    const sampleZ = z - fx * width * s + fz * depth * c;
    if (UNBUILT_POLYGON_GROUPS.some((polygons) => pointInAnyPolygon(polygons, sampleX, sampleZ))) return false;
  }
  const radius = Math.hypot(width, depth) / 2;
  if (isBlocked(x, z, radius * 0.6) || stationBlocks(x, z, radius) || !occ.free(x, z, radius)) return false;
  occ.add(x, z, radius);
  out.push({
    x, z, heading, width, depth,
    height: buildingHeight(zone, density, seeded(seedX, seedZ, 30 + salt), style),
    style, zone,
    variant: Math.floor(seeded(seedX, seedZ, 40 + salt) * 997),
  });
  return true;
}

const INFILL_ACCEPT: Partial<Record<Exclude<Zone, 'none'>, number>> = {
  'commercial-highrise': 0.55,
  'commercial-strip': 0.45,
  residential: 0.35,
  industrial: 0.3,
};

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
    const depth0 = lerp(shape.depth[0], shape.depth[1], seeded(frontX, frontZ, 12)) * LAYOUT_SCALE;
    const width0 = lot * (0.72 + seeded(frontX, frontZ, 13) * 0.2); // building narrower than the lot (side gaps)
    const gap = lot * (0.12 + seeded(frontX, frontZ, 14) * 0.16);
    const pitchScale = zone === 'rural' ? 1 : zone === 'estate' ? 0.95 : 0.85;
    target = (lot + gap) * pitchScale; // denser frontage in built districts; rural spacing stays open

    if (seeded(frontX, frontZ, 20) > acceptance(zone, district.density)) continue;

    // Face the street: local +z (the entrance face) points back toward the road, aligned to the actual road
    // segment (no quarter snap — colliders are oriented boxes now, so diagonal streets get diagonal buildings).
    const heading = Math.atan2(-nX, -nZ);
    // Front face line: `yard` beyond the sidewalk apron. Anchored — the building grows from here into
    // the block, so shrinking never pulls the face onto the road it fronts.
    const faceX = frontX + nX * (shape.yard * LAYOUT_SCALE);
    const faceZ = frontZ + nZ * (shape.yard * LAYOUT_SCALE);

    // A large mass (highrise/estate especially) can reach across a thin block and overhang a
    // neighbouring, cross or rear street. Shrink w&d until the whole footprint clears every road
    // corridor; if even a minimal footprint still overhangs, reject the lot. Correctness (no road
    // overlap) over density — but shrink first so we keep the building wherever it can be made to fit.
    const fit = fitFootprint(faceX, faceZ, nX, nZ, width0, depth0, heading);
    if (!fit) continue;
    const style = buildingStyle(zone, district.density, frontX, frontZ);
    if (!commitBuilding(fit, heading, zone, district.density, style, frontX, frontZ, 0, occ, out)) continue;

    // Eligible urban lots can carry a second, smaller mass behind the street building. It stays
    // deterministic and must still be in the same zone and pass every normal clearance/blocker rule.
    const infillAccept = INFILL_ACCEPT[zone] ?? 0;
    if (infillAccept > 0 && seeded(frontX, frontZ, 70) < infillAccept) {
      const infillDepth = depth0 * (0.65 + seeded(frontX, frontZ, 71) * 0.18);
      const infillWidth = width0 * (0.7 + seeded(frontX, frontZ, 72) * 0.18);
      const infillGap = (2.5 + seeded(frontX, frontZ, 73) * 3) * LAYOUT_SCALE;
      const infillFaceX = faceX + nX * (fit.depth + infillGap);
      const infillFaceZ = faceZ + nZ * (fit.depth + infillGap);
      const infill = fitFootprint(infillFaceX, infillFaceZ, nX, nZ, infillWidth, infillDepth, heading);
      if (infill && classifyZone(infill.x, infill.z, road.width) === zone) {
        commitBuilding(infill, heading, zone, district.density, style, frontX, frontZ, 100, occ, out);
      }
    }
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
  const canonical: GeneratedBuilding[] = [];
  for (const building of out) {
    const key = `${Math.floor(building.x / CELL_SIZE)},${Math.floor(building.z / CELL_SIZE)}`;
    const bucket = cells.get(key);
    if (bucket) {
      if (bucket.length < CELL_BUILDING_CAP) { bucket.push(building); canonical.push(building); }
    } else { cells.set(key, [building]); canonical.push(building); }
  }
  allParcels = canonical;
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
