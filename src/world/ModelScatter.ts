/**
 * Model scatter pass (owner's rule A: source → destination; rule B: crafted-first).
 *
 * The 53-model structure library (src/world/models) is scattered across the generated map to fill
 * the empty veld, coast, suburbs, industrial belts and parks with SA structures + foliage. Like
 * CityGen this is a PURE function of committed data — the OSM roads/landuse/coast polygons, the
 * zoning layer, and positional seeds. There is NO hand-placed coordinate, and no Math.random/Date:
 * a cell scattered, disposed and re-scattered yields byte-identical placements (the streaming
 * contract the runtime City relies on).
 *
 * Crafted-first (rule B): the reserved anchor pads, manicured sites and the procedural CityGen
 * buildings all claim their ground FIRST; scatter flows deterministically around them (skips any
 * slot overlapping them, and never overhangs a road — the same footprint/road-corridor test the
 * procedural buildings use). Two passes:
 *   1. Frontage scatter — walk each road, drop a zone-appropriate structure or street tree on the
 *      verge facing the street (rural farmsteads, suburb houses/civic, commercial/industrial verge
 *      furniture, coastal promenade cafes).
 *   2. Area scatter — grid-sample farm / park / beach polygons and fill them with foliage (heavy)
 *      plus a sparse structure (farmhouses in fields, pavilions in parks, loungers on beaches).
 *
 * The result is bucketed onto the CELL_SIZE chunk grid so the runtime streams one cell at a time
 * (see City.updateBuildingChunks), baking each cell's models into a handful of merged draw calls.
 *
 * Pure data + pure functions (the catalog metadata only — placement never calls a builder), so
 * tests and the headless build report consume it freely.
 */
import {
  AERODROME_POLYGONS,
  BEACH_POLYGONS,
  FARM_POLYGONS,
  GREEN_POLYGONS,
  GENERATED_ROADS,
  MAP_WORLD_SIZE,
  pointInPolygon,
  pointInAnyPolygon,
  WATER_POLYGONS,
  type GeneratedRoad,
  type MapPolygon,
} from './mapData';
import { classifyZone, type Zone } from './data/zoning';
import { RESERVED_PADS } from './placements';
import { MANICURED_FOOTPRINTS } from './data/manicured';
import { MODEL_INDEX } from './models/catalog';
import { CELL_SIZE, allBuildings, footprintRoadClearance } from './CityGen';

/** One placed model: which catalog builder to run, where, and the seed/variant it builds from. */
export interface ScatteredModel {
  name: string;
  x: number;
  z: number;
  /** Yaw (radians, quarter-snapped) so the model faces its street and its AABB collider stays valid. */
  heading: number;
  /** Deterministic build seed (position hash) — same slot always builds the same model. */
  seed: number;
  variant: number;
}

const HALF_WORLD = MAP_WORLD_SIZE / 2;

/** Deterministic positional hash in [0,1) — same (x, z, salt) always yields the same value. */
function seeded(x: number, z: number, salt = 0): number {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
}

/** Per-cell hard cap on scattered models — bounds per-cell generation cost + draw calls. */
export const SCATTER_CELL_CAP = 120;
/** A structure footprint must clear the carriageway + apron by this (units) — reuses CityGen's rule. */
export const STRUCT_ROAD_CLEARANCE = 2.5;
/** Foliage may hug the verge but never a live lane (keeps trunks off the tar). */
export const FOLIAGE_ROAD_CLEARANCE = 0.7;
/** Frontage verge line: one apron beyond the kerb, matching the sidewalk setback. */
const VERGE_CLEARANCE = 3.05;
/** Arc-length pitch (units) between frontage placement attempts. */
const FRONTAGE_PITCH = 22;

// ---- Weighted model pick -----------------------------------------------------------------------

interface Weighted { name: string; weight: number; }

/** Seeded weighted pick over a candidate list; deterministic in `roll` ∈ [0,1). */
function pickWeighted(items: readonly Weighted[], roll: number): string | undefined {
  let total = 0;
  for (const item of items) total += item.weight;
  if (total <= 0) return undefined;
  let cursor = roll * total;
  for (const item of items) { cursor -= item.weight; if (cursor < 0) return item.name; }
  return items[items.length - 1]?.name;
}

// ---- Placement profiles (which models suit which context) --------------------------------------

interface FrontageProfile {
  /** Setback (units) from the verge to the model's front face. */
  yard: number;
  /** Probability a frontage slot receives a STRUCTURE (else it may still get a street tree). */
  structAccept: number;
  structures: readonly Weighted[];
  /** Probability an un-built slot receives a street/verge tree instead. */
  treeAccept: number;
  trees: readonly Weighted[];
}

/**
 * Frontage catalogue per map zone. Structure weights follow the model `spacing` metadata for
 * rarity too (a filling-station has spacing 260, so it self-limits regardless of weight), but the
 * weights keep the common case common: houses in suburbs, sheds in the industrial belt, veld
 * furniture along rural roads. Kept deliberately sparse (low accept) so scatter ENRICHES the
 * procedural buildings rather than crowding every metre of kerb.
 */
const FRONTAGE: Partial<Record<Zone, FrontageProfile>> = {
  residential: {
    yard: 5, structAccept: 0.5,
    structures: [
      { name: 'face-brick-house', weight: 30 }, { name: 'tin-roof-house', weight: 10 },
      { name: 'townhouse-row', weight: 12 }, { name: 'apartment-block', weight: 8 },
      { name: 'spaza-shop', weight: 10 }, { name: 'church', weight: 3 }, { name: 'mosque', weight: 2 },
      { name: 'school', weight: 2 }, { name: 'community-hall', weight: 2 }, { name: 'strip-mall', weight: 4 },
    ],
    treeAccept: 0.6,
    trees: [
      { name: 'jacaranda', weight: 30 }, { name: 'shade-tree', weight: 22 }, { name: 'gum', weight: 12 },
      { name: 'bougainvillea', weight: 10 }, { name: 'hedge-unit', weight: 14 },
    ],
  },
  estate: {
    yard: 9, structAccept: 0.55,
    structures: [
      { name: 'sandton-villa', weight: 34 }, { name: 'face-brick-house', weight: 14 }, { name: 'townhouse-row', weight: 8 },
    ],
    treeAccept: 0.7,
    trees: [
      { name: 'jacaranda', weight: 24 }, { name: 'shade-tree', weight: 28 }, { name: 'pine', weight: 12 },
      { name: 'hedge-unit', weight: 26 }, { name: 'bougainvillea', weight: 8 },
    ],
  },
  'commercial-strip': {
    yard: 3, structAccept: 0.55,
    structures: [
      { name: 'strip-mall', weight: 26 }, { name: 'spaza-shop', weight: 16 }, { name: 'office-block', weight: 14 },
      { name: 'filling-station', weight: 8 }, { name: 'taxi-rank', weight: 6 }, { name: 'big-box', weight: 4 },
    ],
    treeAccept: 0.28,
    trees: [{ name: 'jacaranda', weight: 20 }, { name: 'shade-tree', weight: 16 }, { name: 'billboard', weight: 10 }, { name: 'cell-tower', weight: 4 }],
  },
  'commercial-highrise': {
    yard: 2.5, structAccept: 0.4,
    structures: [
      { name: 'office-block', weight: 30 }, { name: 'strip-mall', weight: 12 }, { name: 'taxi-rank', weight: 8 }, { name: 'spaza-shop', weight: 6 },
    ],
    treeAccept: 0.22,
    trees: [{ name: 'jacaranda', weight: 24 }, { name: 'shade-tree', weight: 14 }, { name: 'billboard', weight: 8 }],
  },
  industrial: {
    yard: 4, structAccept: 0.55,
    structures: [
      { name: 'warehouse', weight: 30 }, { name: 'factory-sawtooth', weight: 16 }, { name: 'tank-farm', weight: 8 },
      { name: 'container-stack', weight: 12 }, { name: 'scrapyard', weight: 8 }, { name: 'big-box', weight: 6 },
      { name: 'substation', weight: 3 }, { name: 'water-tower', weight: 3 },
    ],
    treeAccept: 0.18,
    trees: [{ name: 'billboard', weight: 16 }, { name: 'cell-tower', weight: 8 }, { name: 'gum', weight: 12 }],
  },
  rural: {
    yard: 12, structAccept: 0.28,
    structures: [
      { name: 'farmhouse', weight: 22 }, { name: 'barn', weight: 16 }, { name: 'tin-roof-house', weight: 12 },
      { name: 'tractor-shed', weight: 12 }, { name: 'kraal', weight: 10 }, { name: 'grain-silo', weight: 6 },
      { name: 'windpomp', weight: 6 }, { name: 'padstal', weight: 5 }, { name: 'water-tower', weight: 2 },
      { name: 'church', weight: 3 }, { name: 'spaza-shop', weight: 6 },
    ],
    treeAccept: 0.4,
    trees: [{ name: 'acacia', weight: 34 }, { name: 'aloe', weight: 14 }, { name: 'veld-grass', weight: 24 }, { name: 'gum', weight: 8 }],
  },
};

/** Coastal promenade override — used on any frontage near a beach, whatever the base zone. */
const COAST_FRONTAGE: FrontageProfile = {
  yard: 4, structAccept: 0.5,
  structures: [
    { name: 'beach-cafe', weight: 20 }, { name: 'ice-cream-kiosk', weight: 18 }, { name: 'pier-kiosk', weight: 12 },
    { name: 'pavilion', weight: 12 }, { name: 'ablutions', weight: 8 }, { name: 'surf-shack', weight: 10 },
  ],
  treeAccept: 0.7,
  trees: [{ name: 'palm', weight: 40 }, { name: 'agave', weight: 16 }, { name: 'aloe', weight: 14 }],
};

interface AreaProfile {
  /** Grid pitch (units) between sample points; occupancy + spacing thin it further. */
  step: number;
  /** Probability a valid grid point receives foliage. */
  foliageAccept: number;
  foliage: readonly Weighted[];
  /** Probability a valid grid point receives a (rarer) structure instead. */
  structAccept: number;
  structures: readonly Weighted[];
}

const AREA_FARM: AreaProfile = {
  step: 20, foliageAccept: 0.5,
  foliage: [{ name: 'acacia', weight: 30 }, { name: 'veld-grass', weight: 40 }, { name: 'aloe', weight: 18 }],
  structAccept: 0.04,
  structures: [
    { name: 'farmhouse', weight: 12 }, { name: 'barn', weight: 14 }, { name: 'kraal', weight: 12 },
    { name: 'grain-silo', weight: 8 }, { name: 'windpomp', weight: 10 }, { name: 'tractor-shed', weight: 8 }, { name: 'tin-roof-house', weight: 8 },
  ],
};

const AREA_PARK: AreaProfile = {
  step: 15, foliageAccept: 0.55,
  foliage: [
    { name: 'shade-tree', weight: 28 }, { name: 'jacaranda', weight: 20 }, { name: 'pine', weight: 20 },
    { name: 'gum', weight: 14 }, { name: 'landmark-tree', weight: 6 },
  ],
  structAccept: 0.015,
  structures: [
    { name: 'pavilion', weight: 16 }, { name: 'ice-cream-kiosk', weight: 12 }, { name: 'sports-ground', weight: 4 },
    { name: 'reservoir', weight: 4 }, { name: 'ablutions', weight: 6 },
  ],
};

const AREA_BEACH: AreaProfile = {
  step: 12, foliageAccept: 0.4,
  foliage: [{ name: 'palm', weight: 30 }, { name: 'agave', weight: 22 }, { name: 'aloe', weight: 20 }],
  structAccept: 0.06,
  structures: [
    { name: 'beach-loungers', weight: 24 }, { name: 'surf-shack', weight: 14 }, { name: 'lifeguard-tower', weight: 8 },
    { name: 'ice-cream-kiosk', weight: 12 }, { name: 'ablutions', weight: 6 }, { name: 'beach-cafe', weight: 6 },
  ],
};

// ---- Occupancy + blockers ----------------------------------------------------------------------

interface Placed { x: number; z: number; footR: number; spacing: number; name: string; }

/** Coarse occupancy grid: a candidate is free when it overlaps no placed footprint and keeps the
 *  model's own `spacing` from any same-model neighbour. */
class ScatterOccupancy {
  private cells = new Map<string, Placed[]>();
  constructor(private cell = 32) {}
  private key(x: number, z: number): string { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  free(x: number, z: number, footR: number, spacing: number, name: string): boolean {
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const other of this.cells.get(`${cx + dx},${cz + dz}`) ?? []) {
        const d2 = (other.x - x) ** 2 + (other.z - z) ** 2;
        if (d2 < (other.footR + footR) ** 2) return false;               // footprints never overlap
        if (other.name === name && d2 < Math.max(spacing, other.spacing) ** 2) return false; // honour min separation
      }
    }
    return true;
  }
  add(x: number, z: number, footR: number, spacing: number, name: string): void {
    const key = this.key(x, z);
    const bucket = this.cells.get(key);
    const item: Placed = { x, z, footR, spacing, name };
    if (bucket) bucket.push(item); else this.cells.set(key, [item]);
  }
}

/** Reserved anchor pads + manicured sites — the crafted claims scatter must keep clear (rule B). */
function craftedBlocks(x: number, z: number, radius: number): boolean {
  for (const pad of RESERVED_PADS) if ((pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2) return true;
  for (const site of MANICURED_FOOTPRINTS) if ((site.x - x) ** 2 + (site.z - z) ** 2 < (site.radius + radius) ** 2) return true;
  return false;
}

/** Spatial grid over the procedural CityGen building footprints so scatter never lands on one. */
class BuildingIndex {
  private cells = new Map<string, Array<{ x: number; z: number; r: number }>>();
  private ready = false;
  constructor(private cell = 40) {}
  private build(): void {
    for (const b of allBuildings()) {
      const r = Math.hypot(b.width, b.depth) / 2;
      const key = `${Math.floor(b.x / this.cell)},${Math.floor(b.z / this.cell)}`;
      const bucket = this.cells.get(key);
      const item = { x: b.x, z: b.z, r };
      if (bucket) bucket.push(item); else this.cells.set(key, [item]);
    }
    this.ready = true;
  }
  blocks(x: number, z: number, radius: number): boolean {
    if (!this.ready) this.build();
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const b of this.cells.get(`${cx + dx},${cz + dz}`) ?? []) {
        if ((b.x - x) ** 2 + (b.z - z) ** 2 < (b.r + radius) ** 2) return true;
      }
    }
    return false;
  }
}

// ---- Coast proximity ---------------------------------------------------------------------------

/** True near a beach (padded bbox) — promotes any frontage there to the coastal promenade set.
 *  Exported so the scatter test can assert coast-exclusive models never stray inland. */
export function nearCoast(x: number, z: number): boolean {
  for (const beach of BEACH_POLYGONS) {
    if (x > beach.minX - 130 && x < beach.maxX + 130 && z > beach.minZ - 130 && z < beach.maxZ + 130) return true;
  }
  return false;
}

// ---- The scatter build (memoized, deterministic) -----------------------------------------------

let allScatter: ScatteredModel[] | undefined;
let scatterCells: Map<string, ScatteredModel[]> | undefined;

/** Shared acceptance test for a candidate model at (x, z, heading): bounds, roads, crafted claims,
 *  procedural buildings and prior scatter. Returns true and CLAIMS the slot when accepted. */
function tryPlace(
  name: string, x: number, z: number, heading: number, roadClear: number,
  occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[],
): boolean {
  const def = MODEL_INDEX.get(name);
  if (!def) return false;
  const w = def.maxFootprint.w; const d = def.maxFootprint.d;
  if (Math.abs(x) > HALF_WORLD - 20 || Math.abs(z) > HALF_WORLD - 20) return false;
  // The decision context is read at the frontage/grid point, but the model lands here — so re-check
  // the hard exclusions (water, runway, road corridor) at the actual centre, where a set-back could
  // otherwise drift a mass off the buildable ground.
  if (pointInAnyPolygon(WATER_POLYGONS, x, z) || pointInAnyPolygon(AERODROME_POLYGONS, x, z)) return false;
  if (footprintRoadClearance(x, z, w, d, heading) < roadClear) return false;
  const footR = Math.hypot(w, d) / 2;
  if (craftedBlocks(x, z, footR * 0.7)) return false;
  if (buildings.blocks(x, z, footR * 0.85)) return false;
  if (!occ.free(x, z, footR, def.spacing, name)) return false;
  occ.add(x, z, footR, def.spacing, name);
  out.push({ name, x, z, heading, seed: Math.floor(seeded(x, z, 91) * 1_000_003), variant: Math.floor(seeded(x, z, 92) * def.variants) });
  return true;
}

/** Densely walk a road centreline once, yielding arc-length-spaced frontage anchors per side. */
function frontagePass(occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[]): void {
  for (let ri = 0; ri < GENERATED_ROADS.length; ri++) {
    const road = GENERATED_ROADS[ri]!;
    if (road.width < 6) continue;
    for (const side of [1, -1] as const) frontageSide(road, ri, side, occ, buildings, out);
  }
}

function frontageSide(road: GeneratedRoad, ri: number, side: 1 | -1, occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[]): void {
  const half = road.width / 2;
  let acc = seeded(ri, side, 7) * FRONTAGE_PITCH; // phase offset so slots don't align across parallel roads
  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i]!; const b = road.points[i + 1]!;
    const segX = b.x - a.x; const segZ = b.z - a.z; const length = Math.hypot(segX, segZ);
    if (length < 0.01) continue;
    const dirX = segX / length; const dirZ = segZ / length;
    for (acc += length; acc >= FRONTAGE_PITCH; acc -= FRONTAGE_PITCH) {
      const t = 1 - (acc - FRONTAGE_PITCH) / length; // walk-point within this segment
      if (t < 0 || t > 1) continue;
      const mx = a.x + segX * t; const mz = a.z + segZ * t;
      // inward normal (into the block) on this side, and the verge point one apron beyond the kerb
      const nX = side * -dirZ; const nZ = side * dirX;
      const frontX = mx + nX * (half + VERGE_CLEARANCE);
      const frontZ = mz + nZ * (half + VERGE_CLEARANCE);
      const coast = nearCoast(frontX, frontZ);
      const zone = classifyZone(frontX, frontZ, road.width);
      const profile = coast ? COAST_FRONTAGE : FRONTAGE[zone];
      if (!profile) continue;
      // Face the street: local +z (entrance) points back toward the road, aligned to the actual road
      // segment (oriented-box colliders follow it — diagonal streets get diagonally-set structures).
      const heading = Math.atan2(-nX, -nZ);

      const structRoll = seeded(frontX, frontZ, 20);
      if (structRoll < profile.structAccept) {
        const name = pickWeighted(profile.structures, seeded(frontX, frontZ, 21));
        if (name) {
          const footD = MODEL_INDEX.get(name)?.maxFootprint.d ?? 10;
          const cx = frontX + nX * (profile.yard + footD / 2);
          const cz = frontZ + nZ * (profile.yard + footD / 2);
          // The set-back must not cross the coast boundary — a coastal profile stays seaside, an
          // inland profile stays inland (keeps zone affinity honest at the centre, not just the verge).
          if (nearCoast(cx, cz) === coast && tryPlace(name, cx, cz, heading, STRUCT_ROAD_CLEARANCE, occ, buildings, out)) continue;
        }
      }
      // Un-built slot: try a street/verge tree right on the verge line (small road clearance).
      if (seeded(frontX, frontZ, 22) < profile.treeAccept) {
        const name = pickWeighted(profile.trees, seeded(frontX, frontZ, 23));
        if (name) tryPlace(name, frontX + nX * 0.6, frontZ + nZ * 0.6, seeded(frontX, frontZ, 24) * Math.PI * 2, FOLIAGE_ROAD_CLEARANCE, occ, buildings, out);
      }
    }
  }
}

/** Grid-sample a landuse polygon and fill it with foliage (+ sparse structures) from `profile`. */
function areaPass(polygons: readonly MapPolygon[], profile: AreaProfile, occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[]): void {
  for (const poly of polygons) {
    for (let gx = poly.minX + profile.step * 0.5; gx < poly.maxX; gx += profile.step) {
      for (let gz = poly.minZ + profile.step * 0.5; gz < poly.maxZ; gz += profile.step) {
        // seeded jitter keeps the grid from reading as a lattice
        const x = gx + (seeded(gx, gz, 61) - 0.5) * profile.step * 0.9;
        const z = gz + (seeded(gx, gz, 62) - 0.5) * profile.step * 0.9;
        if (!pointInPolygon(poly, x, z)) continue;
        if (pointInAnyPolygon(WATER_POLYGONS, x, z)) continue;
        const heading = seeded(x, z, 63) * Math.PI * 2; // free rotation — fields/parks/beaches read natural, not 4-valued
        const roll = seeded(x, z, 64);
        if (roll < profile.structAccept) {
          const name = pickWeighted(profile.structures, seeded(x, z, 65));
          if (name && tryPlace(name, x, z, heading, STRUCT_ROAD_CLEARANCE, occ, buildings, out)) continue;
        }
        if (seeded(x, z, 66) < profile.foliageAccept) {
          const name = pickWeighted(profile.foliage, seeded(x, z, 67));
          if (name) tryPlace(name, x, z, heading, FOLIAGE_ROAD_CLEARANCE, occ, buildings, out);
        }
      }
    }
  }
}

function buildAllScatter(): void {
  const out: ScatteredModel[] = [];
  const occ = new ScatterOccupancy();
  const buildings = new BuildingIndex();
  // Crafted claims are already fixed (RESERVED_PADS / MANICURED_FOOTPRINTS) and the procedural
  // buildings are indexed above — so both passes below flow deterministically AROUND them.
  frontagePass(occ, buildings, out);
  areaPass(FARM_POLYGONS, AREA_FARM, occ, buildings, out);
  areaPass(GREEN_POLYGONS, AREA_PARK, occ, buildings, out);
  areaPass(BEACH_POLYGONS, AREA_BEACH, occ, buildings, out);

  const cells = new Map<string, ScatteredModel[]>();
  for (const model of out) {
    const key = `${Math.floor(model.x / CELL_SIZE)},${Math.floor(model.z / CELL_SIZE)}`;
    const bucket = cells.get(key);
    if (bucket) { if (bucket.length < SCATTER_CELL_CAP) bucket.push(model); }
    else cells.set(key, [model]);
  }
  allScatter = out;
  scatterCells = cells;
}

/** Force the (memoized) citywide scatter layout to build now — call during load, not first frame. */
export function ensureScatter(): void {
  if (!scatterCells) buildAllScatter();
}

/** Every scattered model across the whole map (capped per cell). Memoized; deterministic. */
export function allScatteredModels(): readonly ScatteredModel[] {
  ensureScatter();
  return allScatter!;
}

/**
 * The scattered models for one chunk cell — a pure function of (cellX, cellZ). Returns fresh spec
 * objects each call (identical by value) so generate → dispose → regenerate reproduces the cell.
 */
export function scatterCell(cellX: number, cellZ: number): ScatteredModel[] {
  ensureScatter();
  const bucket = scatterCells!.get(`${cellX},${cellZ}`);
  return bucket ? bucket.map((m) => ({ ...m })) : [];
}

/** Scatter summary for the headless build report. */
export function scatterStats(): {
  total: number;
  perCategory: Record<string, number>;
  perModel: Record<string, number>;
  cells: number;
  maxPerCell: number;
} {
  ensureScatter();
  const perCategory: Record<string, number> = {};
  const perModel: Record<string, number> = {};
  for (const m of allScatter!) {
    perModel[m.name] = (perModel[m.name] ?? 0) + 1;
    const cat = MODEL_INDEX.get(m.name)?.category ?? 'other';
    perCategory[cat] = (perCategory[cat] ?? 0) + 1;
  }
  let maxPerCell = 0;
  for (const bucket of scatterCells!.values()) maxPerCell = Math.max(maxPerCell, bucket.length);
  return { total: allScatter!.length, perCategory, perModel, cells: scatterCells!.size, maxPerCell };
}
