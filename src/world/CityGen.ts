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
  REAL_FOOTPRINTS,
  RAILWAY_STATION_SITES,
  LANDMARKS,
  BEACH_POLYGONS,
  type GeneratedRoad,
} from './mapData';
import { classifyZone, type Zone } from './data/zoning';
import { RESERVED_PADS } from './placements';
import { MANICURED_FOOTPRINTS } from './data/manicured';
import type { BuildingStyle } from './BuildingArchitecture';
import { stablePositionRandom, stableWorldFloat } from './StableRandom';

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
/** Street-wall fit floor: a CBD mass squeezed thinner than this is a fence, not a building — reject. */
const MIN_STREETWALL_DEPTH = 8;
/** Baseline circle-proxy spacing factor between parcels (see Occupancy.free). */
export const OCCUPANCY_FACTOR = 0.62;
/**
 * Street-wall spacing for CBD tower pairs: EXACT footprints, not circle proxies. The circle
 * circumscribing a large rectangle is so conservative that at 0.62 it refused legal side-by-side
 * parcels and left 14% of CBD lots empty; a blanket smaller factor instead let whole towers land
 * inside each other. So tight (street-wall) pairs are separated by a real 2D OBB test: two
 * street-wall masses may ABUT — real Joburg blocks are party-wall continuous — up to this much
 * measured interpenetration, and no further. tools/qa/frontage-meter.ts audits the outcome.
 */
export const STREETWALL_MAX_OVERLAP = 1.5;
/**
 * Exact-footprint spacing for residential pairs: the suburbs version of the street-wall rule.
 * The circle proxy refused legal side-by-side houses for the same reason it refused towers —
 * a circle circumscribing a 45×25 house claims a whole second stand of empty ground. Houses do
 * NOT abut (no party walls in the suburbs): two residential footprints must keep this much
 * measured clear gap between their walls, tested by the same 2D SAT the CBD uses (rects grown by
 * the gap, then required disjoint). tools/qa/frontage-meter.ts audits the outcome per district.
 */
export const RESIDENTIAL_MIN_GAP = 1.5;

/**
 * Separating-axis interpenetration depth of two parcel footprints in the XZ plane: 0 when the
 * OBBs do not touch, otherwise the smallest translation that would separate them (exact for 2D
 * OBBs — all four face axes are tested). Shared by the occupancy grid, its mirror in
 * CityGen.test, and the QA meter, so the packing rule has exactly one definition.
 */
export function footprintOverlapXZ(
  a: { x: number; z: number; width: number; depth: number; heading: number },
  b: { x: number; z: number; width: number; depth: number; heading: number },
): number {
  let depth = Infinity;
  for (const rect of [a, b]) {
    const c = Math.cos(rect.heading); const s = Math.sin(rect.heading);
    const other = rect === a ? b : a;
    const oc = Math.cos(other.heading); const os = Math.sin(other.heading);
    // rect's local axes in world space (matches commitBuilding's rotation convention).
    for (const [ax, az, half] of [[c, -s, rect.width / 2], [s, c, rect.depth / 2]] as const) {
      const centreDistance = Math.abs((b.x - a.x) * ax + (b.z - a.z) * az);
      const otherHalf = Math.abs(oc * ax - os * az) * other.width / 2 + Math.abs(os * ax + oc * az) * other.depth / 2;
      const overlap = half + otherHalf - centreDistance;
      if (overlap <= 0) return 0; // separating axis found
      if (overlap < depth) depth = overlap;
    }
  }
  return depth;
}
/** Per-cell hard cap on buildings — bounds both draw calls and per-cell generation cost.
 *  Raised 64 → 160 for the CBD-density pass: at 64, one third of every committed CBD building
 *  (545 of them) was silently dropped at bucketing, so the empty-lot fixes could never reach the
 *  street. Raised again 160 → 256 for the suburbs pass: with houses at real-erf pitch the inner
 *  residential cells (Doornfontein, Fordsburg — cells they share with CBD towers) hit 160 and
 *  silently dropped whole streets of houses, taking residential frontage DOWN as density went up
 *  (at 160: 16 capped cells; at 256: 5, all tower-heavy CBD ring cells). Cells still merge to a
 *  handful of draw calls per material; the cost is triangles and per-cell generation time, which
 *  the frame-budgeted streamer already spreads. */
export const CELL_BUILDING_CAP = 256;
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

const seeded = stablePositionRandom;

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
  // CBD lots are sized against THIS map's block grid, not real-world erf sheets: the old 26–44 ×
  // 22–38 authored metres became 56–95 u × 48–82 u after the map shrink — wider than most CBD
  // blocks — so 57% of CBD slots died in fitFootprint and single monsters ate whole block faces.
  // At 16–28 × 12–26 (35–60 u × 26–56 u) several towers stand per block face, which is both the
  // density fix and the actual scale of a Joburg CBD stand. Yard 0.6: the street wall meets the
  // pavement (the face still clears ROAD_CLEARANCE by over 1.5 u). Accept 1: the owner's rule is
  // that the CBD has no empty lots — a slot only stays empty when geometry genuinely refuses it.
  'commercial-highrise': { style: 'downtown', lot: [16, 28], depth: [12, 26], yard: 0.6, accept: 1 },
  'commercial-strip': { style: 'mixed-use', lot: [12, 22], depth: [14, 22], yard: 2.2, accept: 0.9 },
  // Residential stands re-sized against THIS map's block grid for the suburbs-density pass (the
  // same fix the CBD got): the old 15–25 authored lots became 32–54 u (44–73 m) stands after the
  // map shrink — triple a real Joburg erf — so one mansion ate three stands of kerb and every
  // rejection lost a whole mansion-width of street. At 10–18 (21–39 u) several houses pack each
  // block face. Yard 3 (~9 m building line) brings the face toward the street the way a suburb
  // actually sits. Accept cap raised 0.82 → 0.9: houses are the norm, empty stands the exception;
  // the density scaling in acceptance() keeps a floor AND this cap.
  residential: { style: 'suburban', lot: [10, 18], depth: [7, 11], yard: 3, accept: 0.95 },
  industrial: { style: 'industrial', lot: [26, 46], depth: [22, 40], yard: 3, accept: 0.72 },
  estate: { style: 'estate', lot: [60, 110], depth: [30, 52], yard: 10, accept: 0.78 },
  rural: { style: 'rural', lot: [40, 80], depth: [8, 14], yard: 12, accept: 0.28 },
};

/** Placement probability for a zone at a point, scaled by the local OSM building density. */
function acceptance(zone: Exclude<Zone, 'none'>, density: number): number {
  const base = ZONE_SHAPE[zone].accept;
  // Floor 0.8, curve shifted up: even the sleepiest suburb packs its streets (the owner's rule —
  // houses are the norm, empty stands the exception); the density term still differentiates busy
  // districts, and the cap leaves every suburb the odd genuinely vacant stand.
  if (zone === 'residential') return Math.min(base, Math.max(0.8, 0.45 + density / 400));
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

/**
 * The map's own named petrol stations (crafted-first rule): ModelScatter's landmarkForecourtPass
 * stands a real forecourt on verge slots 16–31u off the road beside each pin — and it runs with
 * parcels already fixed, so PARCELS must not claim that verge first. This reserve lives here (not
 * in RESERVED_PADS) because scatter's own craftedBlocks() checks those pads: a shared reserve
 * would block the very forecourt it exists to protect. The suburbs-density pass packed the shore
 * lanes and buried the Bayshore star until this. A labelled star must always have petrol under it.
 */
const FUEL_LANDMARK_RESERVES = LANDMARKS.filter((entry) => entry.kind === 'fuel');
/** Candidates sit up to ~33u from the pin; scatter's circle test then needs forecourt-footprint
 *  (18u) + house-circumradius of air beyond that — 52 is the Kelvin-Yard class of claim. */
const FUEL_LANDMARK_RESERVE_RADIUS = 52;

/** True when (x, z) is inside a reserved anchor pad or a manicured site footprint (kept clear). */
function isBlocked(x: number, z: number, radius: number): boolean {
  for (const pad of RESERVED_PADS) if ((pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2) return true;
  for (const site of MANICURED_FOOTPRINTS) if ((site.x - x) ** 2 + (site.z - z) ** 2 < (site.radius + radius) ** 2) return true;
  for (const pin of FUEL_LANDMARK_RESERVES) if ((pin.x - x) ** 2 + (pin.z - z) ** 2 < (FUEL_LANDMARK_RESERVE_RADIUS + radius) ** 2) return true;
  return false;
}

/** Stations need the complete circumscribed footprint radius, unlike the looser visual spacing used by
 *  generic anchor pads, because a platform corner hidden under a building would recreate the reported bug. */
function stationBlocks(x: number, z: number, radius: number): boolean {
  return RAILWAY_STATION_SITES.some((station) => (station.x - x) ** 2 + (station.z - z) ** 2 < (RAILWAY_STATION_CLEARANCE + radius) ** 2);
}

/** One parcel footprint as the occupancy grid keeps it. `rect` is present on exact-packed parcels
 *  (CBD street wall, residential), which are separated by real 2D SAT instead of the circle proxy.
 *  `gap` is that parcel's spacing demand: negative = interpenetration allowed up to -gap (party
 *  walls), positive = at least this much measured clear air between the walls. */
interface OccupancyEntry { x: number; z: number; r: number; rect?: { x: number; z: number; width: number; depth: number; heading: number }; gap?: number; }

/** The spacing a zone demands of the exact footprint test, or undefined for the circle proxy. */
export function zonePackingGap(zone: Zone): number | undefined {
  if (zone === 'commercial-highrise') return -STREETWALL_MAX_OVERLAP;
  if (zone === 'residential') return RESIDENTIAL_MIN_GAP;
  return undefined;
}

/** A footprint rect grown by `pad` on each axis (pad/2 per side) — SAT on grown rects being
 *  disjoint is exactly "the real rects keep pad of clear air on some separating axis". */
function grownRect(rect: NonNullable<OccupancyEntry['rect']>, pad: number): NonNullable<OccupancyEntry['rect']> {
  return { x: rect.x, z: rect.z, width: rect.width + pad, depth: rect.depth + pad, heading: rect.heading };
}

/** Coarse occupancy grid so parcels from different roads don't stack at intersections.
 *  Two exact-packed entries (both carrying a rect) are separated by the real footprint test at
 *  the stricter of their two gap demands — CBD pairs may abut up to STREETWALL_MAX_OVERLAP of
 *  measured interpenetration (party walls), residential pairs must keep RESIDENTIAL_MIN_GAP of
 *  clear air; every other pair keeps the conservative circle rule. Symmetric in the pair, so the
 *  rule is order-independent and CityGen.test can assert it over unordered pairs. */
class Occupancy {
  private cells = new Map<string, OccupancyEntry[]>();
  private maxRadius = 0;
  constructor(private cell = 64) {}
  private key(x: number, z: number): string { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  free(x: number, z: number, r: number, rect?: OccupancyEntry['rect'], gap = 0): boolean {
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    const reach = Math.max(1, Math.ceil(((r + this.maxRadius) * OCCUPANCY_FACTOR + 1.5) / this.cell) + 1);
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
      for (const other of this.cells.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (rect && other.rect) {
          // Exact packing: circles circumscribing big rectangles refuse legal side-by-side
          // neighbours, and a naively smaller factor buries buildings inside each other.
          const need = Math.max(gap, other.gap ?? 0);
          // Circles clear by the demanded air: rect gap >= centre distance - r1 - r2 >= need.
          if ((other.x - x) ** 2 + (other.z - z) ** 2 >= (other.r + r + Math.max(0, need)) ** 2) continue;
          if (need <= 0) { if (footprintOverlapXZ(rect, other.rect) > -need) return false; continue; }
          if (footprintOverlapXZ(grownRect(rect, need), grownRect(other.rect, need)) > 0) return false;
          continue;
        }
        const min = (other.r + r) * OCCUPANCY_FACTOR + 1.5;
        if ((other.x - x) ** 2 + (other.z - z) ** 2 < min * min) return false;
      }
    }
    return true;
  }
  add(x: number, z: number, r: number, rect?: OccupancyEntry['rect'], gap = 0): void {
    const key = this.key(x, z);
    const entry: OccupancyEntry = { x, z, r, rect, gap };
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(entry); else this.cells.set(key, [entry]);
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

/** Fit a mass behind an anchored front face without ever pulling that face back toward the street.
 *
 *  `packed` (CBD street wall + residential): the deep lots on tight street grids reach across
 *  thin blocks onto the rear/cross street — and the uniform shrink-then-reject schedule below
 *  threw away 56% of CBD lots, which is where the empty kerbs came from. A packed fit gives up
 *  DEPTH first and keeps the full frontage width (a 30u-wide mass squeezed to 14u deep IS a
 *  Joburg street-wall building; a wide shallow house is a real suburban plan), rejecting only
 *  below MIN_STREETWALL_DEPTH; the uniform schedule then still runs as the fallback for masses
 *  whose WIDTH is what overhangs a cross street. */
function fitFootprint(
  faceX: number, faceZ: number, nX: number, nZ: number,
  width0: number, depth0: number, heading: number, packed = false,
): FittedFootprint | undefined {
  if (packed) {
    // Widths are tried full-first, then progressively narrower: a junction mouth or a thin block
    // that refuses the seeded width still deserves a narrow corner stand rather than bare kerb —
    // the diagnostic showed "no footprint fits" was the single biggest source of empty suburban
    // kerb (28% of all residential frontage samples) once the lots themselves were right-sized.
    for (const widthScale of [1, 0.72, 0.5]) {
      const width = Math.max(width0 * widthScale, MIN_STREETWALL_DEPTH);
      let depth = depth0;
      while (depth >= MIN_STREETWALL_DEPTH) {
        const x = faceX + nX * (depth / 2); const z = faceZ + nZ * (depth / 2);
        if (footprintRoadClearance(x, z, width, depth, heading) >= ROAD_CLEARANCE
          && footprintRailwayClearance(x, z, width, depth, heading) >= RAILWAY_BUILDING_CLEARANCE) {
          return { x, z, width, depth };
        }
        depth *= SHRINK_FACTOR;
      }
      if (width <= MIN_STREETWALL_DEPTH) break; // already at the floor: narrower scales change nothing
    }
  }
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
  const x = stableWorldFloat(fit.x); const z = stableWorldFloat(fit.z);
  const width = stableWorldFloat(fit.width); const depth = stableWorldFloat(fit.depth);
  heading = stableWorldFloat(heading);
  if (Math.abs(x) > HALF_WORLD - 20 || Math.abs(z) > HALF_WORLD - 20) return false;
  const c = Math.cos(heading); const s = Math.sin(heading);
  for (const fx of [-0.5, 0, 0.5]) for (const fz of [-0.5, 0, 0.5]) {
    const sampleX = x + fx * width * c + fz * depth * s;
    const sampleZ = z - fx * width * s + fz * depth * c;
    if (UNBUILT_POLYGON_GROUPS.some((polygons) => pointInAnyPolygon(polygons, sampleX, sampleZ))) return false;
  }
  const radius = Math.hypot(width, depth) / 2;
  // Exact-packed parcels carry their rect: CBD pairs may abut (STREETWALL_MAX_OVERLAP), houses
  // pack to a measured RESIDENTIAL_MIN_GAP of clear air instead of a circle-proxy stand-off.
  const packingGap = zonePackingGap(zone);
  const rect = packingGap !== undefined ? { x, z, width, depth, heading } : undefined;
  if (isBlocked(x, z, radius * 0.6) || stationBlocks(x, z, radius) || !occ.free(x, z, radius, rect, packingGap)) return false;
  occ.add(x, z, radius, rect, packingGap);
  out.push({
    x, z, heading, width, depth,
    height: stableWorldFloat(buildingHeight(zone, density, seeded(seedX, seedZ, 30 + salt), style)),
    style, zone,
    variant: Math.floor(seeded(seedX, seedZ, 40 + salt) * 997),
  });
  return true;
}

/** OSM `building=*` value -> the zone/style a real dam-shore footprint masses as. */
const REAL_FOOTPRINT_ZONE: Record<string, Exclude<Zone, 'none'>> = {
  house: 'residential', detached: 'residential', residential: 'residential', bungalow: 'residential',
  semidetached_house: 'residential', apartments: 'residential', hut: 'residential', cabin: 'residential',
  commercial: 'commercial-strip', retail: 'commercial-strip', hotel: 'commercial-strip',
  industrial: 'industrial', warehouse: 'industrial', shed: 'industrial', service: 'industrial',
  boathouse: 'industrial', garage: 'industrial', garages: 'industrial', farm_auxiliary: 'rural',
  barn: 'rural', farm: 'rural', church: 'commercial-strip', school: 'commercial-strip',
};
const REAL_FOOTPRINT_STYLE: Record<string, BuildingStyle> = {
  commercial: 'mixed-use', retail: 'mixed-use', hotel: 'mixed-use', church: 'mixed-use', school: 'mixed-use',
  industrial: 'industrial', warehouse: 'industrial', shed: 'industrial', boathouse: 'industrial',
  garage: 'industrial', garages: 'industrial', service: 'industrial',
  barn: 'rural', farm: 'rural', farm_auxiliary: 'rural',
};
/** A real footprint stands where it really stands, so it is allowed nearer a kerb than a
 *  procedural mass — real plots front the street closely and the shore lanes are narrow. It still
 *  has to clear the carriageway itself, which CityGen.test asserts citywide at 1 unit. */
const REAL_FOOTPRINT_ROAD_CLEARANCE = 1.2;

const INFILL_ACCEPT: Partial<Record<Exclude<Zone, 'none'>, number>> = {
  // CBD infill stays modest ON PURPOSE: the per-cell cap is the binding budget in the CBD, and a
  // rear-infill mass spends a cap slot that buys no street frontage — the thing this pass exists
  // to fill. Street-wall commits come first; infill takes what's left.
  'commercial-highrise': 0.35,
  'commercial-strip': 0.45,
  // Suburbs-density pass: more than half of eligible stands carry a back-yard cottage/flatlet —
  // the granny-flat/backroom pattern that makes real Joburg stands read full from the street.
  residential: 0.55,
  industrial: 0.3,
};

/**
 * The REAL dam-shore buildings, laid down BEFORE the procedural frontage pass.
 *
 * These are traced OSM footprints from Deneysville, Refengkgotso and the marina frontage
 * (mapData.REAL_FOOTPRINTS) — the actual houses, the actual boat sheds, at their actual positions
 * and angles. They go first so they win every conflict: the occupancy grid then makes the
 * procedural pass infill AROUND the real village instead of laying a synthetic suburb over it.
 * Everything else (road/railway clearance, unbuilt polygons, the world edge) is checked exactly as
 * for a procedural mass, so a real footprint that would sit in the water or across a street is
 * still refused rather than shipped.
 */
function layoutRealFootprints(occ: Occupancy, out: GeneratedBuilding[]): void {
  for (const f of REAL_FOOTPRINTS) {
    const zone: Exclude<Zone, 'none'> = REAL_FOOTPRINT_ZONE[f.kind] ?? 'residential';
    const style = REAL_FOOTPRINT_STYLE[f.kind] ?? 'suburban';
    // A real footprint is already the right size and angle; it is never shrunk to fit, only refused.
    if (footprintRoadClearance(f.x, f.z, f.w, f.d, f.heading) < REAL_FOOTPRINT_ROAD_CLEARANCE) continue;
    if (footprintRailwayClearance(f.x, f.z, f.w, f.d, f.heading) < RAILWAY_BUILDING_CLEARANCE) continue;
    commitBuilding({ x: f.x, z: f.z, width: f.w, depth: f.d }, f.heading, zone, 120, style, f.x, f.z, 7, occ, out);
  }
}

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

    // Street-wall lot arithmetic (CBD): the building takes 90–98% of its lot with 2–8% side gaps,
    // so built neighbours read as one continuous block face — real Joburg CBD blocks have no side
    // yards. Residential is packed too — houses take 80–94% of the stand with 4–12% side gaps
    // (a driveway, not a vacant lot). Everywhere else keeps the 72–92% building / 12–28% gap rhythm.
    const streetWall = zone === 'commercial-highrise';
    const packed = streetWall || zone === 'residential';
    const lot = lerp(shape.lot[0], shape.lot[1], seeded(frontX, frontZ, 11)) * LAYOUT_SCALE;
    const depth0 = lerp(shape.depth[0], shape.depth[1], seeded(frontX, frontZ, 12)) * LAYOUT_SCALE;
    const width0 = lot * (streetWall ? 0.9 + seeded(frontX, frontZ, 13) * 0.08
      : packed ? 0.8 + seeded(frontX, frontZ, 13) * 0.14
        : 0.72 + seeded(frontX, frontZ, 13) * 0.2);
    const gap = lot * (streetWall ? 0.02 + seeded(frontX, frontZ, 14) * 0.06
      : packed ? 0.04 + seeded(frontX, frontZ, 14) * 0.08
        : 0.12 + seeded(frontX, frontZ, 14) * 0.16);
    // Street-wall pitch stays at the full lot+gap: the building already fills ~94% of it, so a
    // tighter pitch would only make the occupancy grid refuse every second lot.
    const pitchScale = zone === 'rural' ? 1 : zone === 'estate' ? 0.95 : streetWall ? 1 : 0.85;
    target = (lot + gap) * pitchScale; // denser frontage in built districts; rural spacing stays open

    // The Vaal shore stays a holiday coast, not a packed suburb: inside the beach band the
    // scatter's promenade profile (slipways, kiosks, the seafront venue trio) shares the kerb
    // with houses, and at full suburban acceptance the houses crowd every last venue out — the
    // interiors suite caught seafront-restaurant vanishing citywide. Same 130u pad as
    // ModelScatter.nearCoast (mirrored here: importing it would cycle the modules).
    const coastBand = zone === 'residential'
      && BEACH_POLYGONS.some((beach) => frontX > beach.minX - 130 && frontX < beach.maxX + 130 && frontZ > beach.minZ - 130 && frontZ < beach.maxZ + 130);
    if (seeded(frontX, frontZ, 20) > acceptance(zone, district.density) * (coastBand ? 0.55 : 1)) continue;

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
    const fit = fitFootprint(faceX, faceZ, nX, nZ, width0, depth0, heading, packed);
    // A dead packed slot (a junction mouth, a rail reserve, an occupied corner) retries a
    // short step later instead of skipping a whole lot pitch of kerb — the walker's slot phase is
    // part of the deterministic seed stream either way.
    if (!fit) { if (packed) target = 6 * LAYOUT_SCALE; continue; }
    const style = buildingStyle(zone, district.density, frontX, frontZ);
    if (!commitBuilding(fit, heading, zone, district.density, style, frontX, frontZ, 0, occ, out)) { if (packed) target = 6 * LAYOUT_SCALE; continue; }

    // Eligible urban lots can carry a second, smaller mass behind the street building. It stays
    // deterministic and must still be in the same zone and pass every normal clearance/blocker rule.
    const infillAccept = INFILL_ACCEPT[zone] ?? 0;
    if (infillAccept > 0 && seeded(frontX, frontZ, 70) < infillAccept) {
      const infillDepth = depth0 * (0.65 + seeded(frontX, frontZ, 71) * 0.18);
      const infillWidth = width0 * (0.7 + seeded(frontX, frontZ, 72) * 0.18);
      const infillGap = (2.5 + seeded(frontX, frontZ, 73) * 3) * LAYOUT_SCALE;
      const infillFaceX = faceX + nX * (fit.depth + infillGap);
      const infillFaceZ = faceZ + nZ * (fit.depth + infillGap);
      const infill = fitFootprint(infillFaceX, infillFaceZ, nX, nZ, infillWidth, infillDepth, heading, packed);
      if (infill && classifyZone(infill.x, infill.z, road.width) === zone) {
        commitBuilding(infill, heading, zone, district.density, style, frontX, frontZ, 100, occ, out);
      }
    }
  }
}

/** The citywide parcel layout as a chunked pass: yields its completed fraction every few hundred
 *  roads so a staged boot can paint between chunks (this is one of the two largest main-thread
 *  blocks on mobile). Iteration order is untouched — the layout stays identical to a full drain. */
export function* parcelStages(): Generator<number> {
  if (parcelCells) return;
  const out: GeneratedBuilding[] = [];
  const occ = new Occupancy();
  layoutRealFootprints(occ, out);
  const stride = Math.max(60, Math.ceil(GENERATED_ROADS.length / 24));
  for (let ri = 0; ri < GENERATED_ROADS.length; ri++) {
    if (ri > 0 && ri % stride === 0) yield ri / GENERATED_ROADS.length;
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
  for (const fraction of parcelStages()) void fraction; // synchronous drain
}

/**
 * Install a pre-baked canonical parcel list (see tools/bake) in place of the live layout pass:
 * parcelStages()/generateCell()/allBuildings() then serve the baked city. The list is exactly what
 * parcelStages emitted at bake time (already capped per cell — bake.test.ts holds the two paths
 * identical), so re-bucketing it reproduces parcelCells verbatim. A layout that already ran wins —
 * hydrating after the fact would discard the world the caller has been handed pieces of.
 */
export function hydrateParcels(buildings: GeneratedBuilding[]): boolean {
  if (parcelCells) return false;
  const cells = new Map<string, GeneratedBuilding[]>();
  for (const building of buildings) {
    const key = `${Math.floor(building.x / CELL_SIZE)},${Math.floor(building.z / CELL_SIZE)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(building); else cells.set(key, [building]);
  }
  allParcels = buildings;
  parcelCells = cells;
  return true;
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
