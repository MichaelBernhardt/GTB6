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
  besideRoad,
  FARM_POLYGONS,
  GREEN_POLYGONS,
  GENERATED_ROADS,
  LANDMARKS,
  MAP_WORLD_SIZE,
  nearestRoadSpot,
  pointInPolygon,
  pointInAnyPolygon,
  RAILWAY_STATION_SITES,
  WATER_POLYGONS,
  type GeneratedRoad,
  type MapPolygon,
} from './mapData';
import { classifyZone, type Zone } from './data/zoning';
import { RESERVED_PADS } from './placements';
import { MANICURED_FOOTPRINTS } from './data/manicured';
import { MODEL_INDEX } from './models/catalog';
import { CELL_SIZE, RAILWAY_STATION_CLEARANCE, allBuildings, footprintRailwayClearance, footprintRoadClearance } from './CityGen';
import { stablePositionRandom, stableWorldFloat } from './StableRandom';
import { FATTEST_TRUNK_RADIUS, TREE_SPECIES } from './FoliageAssets';
import { buildCityNavPaths, ROAD_NETWORK } from './roadPaths';
import { PLAYER } from '../config';

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

const seeded = stablePositionRandom;

/** Per-cell hard cap on scattered models — bounds per-cell generation cost + draw calls. Raised
 *  120 → 170 with the denser profiles: scattered models bake into per-cell merged draw calls, so
 *  the extra 50 is one-off cell-generation cost, not per-frame cost, and the occupancy grid still
 *  bounds true overlap. */
export const SCATTER_CELL_CAP = 170;
/** A structure footprint must clear the carriageway + apron by this (units) — reuses CityGen's rule. */
export const STRUCT_ROAD_CLEARANCE = 2.5;
/** Foliage may hug the verge but never a live lane (keeps trunks off the tar). */
export const FOLIAGE_ROAD_CLEARANCE = 0.7;
/**
 * A SOLID TRUNK NEVER STANDS IN A PEDESTRIAN LANE.
 *
 * An authored tree's trunk is a SOLID prop (City.trunkProp) — a wall that stops a body and stops a
 * car — so where a scattered tree lands is a gameplay fact, not dressing. FOLIAGE_ROAD_CLEARANCE
 * only holds trunks off the road SURFACE, and that is not the same question: the walk polylines the
 * ped nav graph routes on are DECIMATED to every second sample (see roadPaths.buildCityNavPaths), so
 * through a bend a walk segment chords across the verge and runs several units off the kerb. The pine
 * that forced this rule sat 5.91 u clear of the built road edge and 1.33 u from the segment peds walk:
 * legal by every surface test the pass had, and an invisible wall in the middle of a pedestrian lane.
 *
 * The clearance is the widest trunk in the library plus a whole body, so a ped (or the player)
 * following the lane never has to resolve a blocked step against wood, plus 0.1 u of margin so the
 * rule is not decided on the last bit of a float. Purely geometric, so it stays deterministic by
 * construction — no roll, no ordering dependence.
 */
export const WALK_LINE_TRUNK_CLEARANCE = FATTEST_TRUNK_RADIUS + PLAYER.radius + 0.1;
/** Frontage verge line: one apron beyond the kerb, matching the sidewalk setback. */
const VERGE_CLEARANCE = 3.05;
/** Arc-length pitch (units) between frontage placement attempts. */
const FRONTAGE_PITCH = 16;

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
 * furniture along rural roads. Accepts are tuned dense enough that streets read inhabited, while
 * the occupancy grid + per-model spacing still stop scatter crowding the procedural buildings.
 */
const FRONTAGE: Partial<Record<Zone, FrontageProfile>> = {
  residential: {
    yard: 5, structAccept: 0.6,
    structures: [
      { name: 'face-brick-house', weight: 30 }, { name: 'tin-roof-house', weight: 10 },
      { name: 'townhouse-row', weight: 12 }, { name: 'apartment-block', weight: 8 },
      { name: 'semi-detached-house', weight: 14 }, { name: 'walk-up-flats', weight: 8 }, { name: 'rdp-row', weight: 10 },
      { name: 'spaza-shop', weight: 10 }, { name: 'church', weight: 3 }, { name: 'mosque', weight: 2 },
      { name: 'school', weight: 2 }, { name: 'community-hall', weight: 2 }, { name: 'strip-mall', weight: 4 },
    ],
    treeAccept: 0.72,
    trees: [
      { name: 'jacaranda', weight: 30 }, { name: 'shade-tree', weight: 22 }, { name: 'gum', weight: 12 },
      { name: 'bougainvillea', weight: 10 }, { name: 'hedge-unit', weight: 14 },
    ],
  },
  estate: {
    yard: 9, structAccept: 0.62,
    structures: [
      { name: 'sandton-villa', weight: 34 }, { name: 'face-brick-house', weight: 14 }, { name: 'townhouse-row', weight: 8 },
    ],
    treeAccept: 0.78,
    trees: [
      { name: 'jacaranda', weight: 24 }, { name: 'shade-tree', weight: 28 }, { name: 'pine', weight: 12 },
      { name: 'hedge-unit', weight: 26 }, { name: 'bougainvillea', weight: 8 },
    ],
  },
  'commercial-strip': {
    yard: 3, structAccept: 0.65,
    structures: [
      { name: 'strip-mall', weight: 26 }, { name: 'spaza-shop', weight: 16 }, { name: 'office-block', weight: 14 },
      { name: 'mixed-use-corner', weight: 18 }, { name: 'parking-garage', weight: 5 },
      { name: 'filling-station', weight: 8 }, { name: 'taxi-rank', weight: 6 }, { name: 'big-box', weight: 4 },
    ],
    treeAccept: 0.4,
    trees: [{ name: 'jacaranda', weight: 20 }, { name: 'shade-tree', weight: 16 }, { name: 'billboard', weight: 10 }, { name: 'cell-tower', weight: 4 }],
  },
  'commercial-highrise': {
    yard: 2.5, structAccept: 0.55,
    structures: [
      { name: 'office-block', weight: 30 }, { name: 'mixed-use-corner', weight: 18 }, { name: 'parking-garage', weight: 7 },
      { name: 'walk-up-flats', weight: 7 }, { name: 'strip-mall', weight: 12 }, { name: 'taxi-rank', weight: 8 }, { name: 'spaza-shop', weight: 6 },
    ],
    treeAccept: 0.35,
    trees: [{ name: 'jacaranda', weight: 24 }, { name: 'shade-tree', weight: 14 }, { name: 'billboard', weight: 8 }],
  },
  industrial: {
    yard: 4, structAccept: 0.65,
    structures: [
      { name: 'warehouse', weight: 30 }, { name: 'factory-sawtooth', weight: 16 }, { name: 'tank-farm', weight: 8 },
      { name: 'container-stack', weight: 12 }, { name: 'scrapyard', weight: 8 }, { name: 'big-box', weight: 6 },
      { name: 'workshop-row', weight: 18 }, { name: 'logistics-depot', weight: 12 },
      { name: 'substation', weight: 3 }, { name: 'water-tower', weight: 3 },
    ],
    treeAccept: 0.3,
    trees: [{ name: 'billboard', weight: 16 }, { name: 'cell-tower', weight: 8 }, { name: 'gum', weight: 12 }],
  },
  rural: {
    yard: 12, structAccept: 0.36,
    structures: [
      { name: 'farmhouse', weight: 22 }, { name: 'barn', weight: 16 }, { name: 'tin-roof-house', weight: 12 },
      { name: 'farm-worker-cottages', weight: 14 },
      { name: 'tractor-shed', weight: 12 }, { name: 'kraal', weight: 10 }, { name: 'grain-silo', weight: 6 },
      { name: 'windpomp', weight: 6 }, { name: 'padstal', weight: 5 }, { name: 'water-tower', weight: 2 },
      { name: 'church', weight: 3 }, { name: 'spaza-shop', weight: 6 },
    ],
    treeAccept: 0.5,
    trees: [{ name: 'acacia', weight: 34 }, { name: 'aloe', weight: 14 }, { name: 'veld-grass', weight: 24 }, { name: 'gum', weight: 8 }],
  },
};

/** Dam-front override — used on any frontage near the reservoir, whatever the base zone.
 *  Palms and surf shacks are gone: a Vaal shore is gums and acacias down to a grass bank, with
 *  slipways, ski-boat sheds and caravan-park ablutions. */
const COAST_FRONTAGE: FrontageProfile = {
  yard: 4, structAccept: 0.58,
  structures: [
    { name: 'beach-cafe', weight: 16 }, { name: 'ice-cream-kiosk', weight: 16 }, { name: 'pier-kiosk', weight: 10 },
    { name: 'pavilion', weight: 10 }, { name: 'ablutions', weight: 8 }, { name: 'boat-shed', weight: 10 },
    { name: 'seafront-cafe', weight: 10 }, { name: 'seafront-bar', weight: 7 }, { name: 'seafront-restaurant', weight: 7 },
  ],
  treeAccept: 0.78,
  trees: [{ name: 'gum', weight: 30 }, { name: 'acacia', weight: 22 }, { name: 'aloe', weight: 14 }, { name: 'veld-grass', weight: 18 }],
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
  step: 18, foliageAccept: 0.6,
  foliage: [{ name: 'acacia', weight: 30 }, { name: 'veld-grass', weight: 40 }, { name: 'aloe', weight: 18 }],
  structAccept: 0.055,
  structures: [
    { name: 'farmhouse', weight: 12 }, { name: 'barn', weight: 14 }, { name: 'kraal', weight: 12 },
    { name: 'grain-silo', weight: 8 }, { name: 'windpomp', weight: 10 }, { name: 'tractor-shed', weight: 8 },
    { name: 'tin-roof-house', weight: 8 }, { name: 'farm-worker-cottages', weight: 10 },
  ],
};

const AREA_PARK: AreaProfile = {
  step: 13, foliageAccept: 0.68,
  foliage: [
    { name: 'shade-tree', weight: 28 }, { name: 'jacaranda', weight: 20 }, { name: 'pine', weight: 20 },
    { name: 'gum', weight: 14 }, { name: 'landmark-tree', weight: 6 },
  ],
  structAccept: 0.025,
  structures: [
    { name: 'pavilion', weight: 16 }, { name: 'ice-cream-kiosk', weight: 12 }, { name: 'sports-ground', weight: 4 },
    { name: 'reservoir', weight: 4 }, { name: 'ablutions', weight: 6 },
  ],
};

const AREA_BEACH: AreaProfile = {
  step: 11, foliageAccept: 0.5,
  foliage: [{ name: 'veld-grass', weight: 34 }, { name: 'gum', weight: 18 }, { name: 'aloe', weight: 20 }, { name: 'agave', weight: 10 }],
  structAccept: 0.08,
  structures: [
    { name: 'beach-loungers', weight: 24 }, { name: 'boat-shed', weight: 14 }, { name: 'lifeguard-tower', weight: 8 },
    { name: 'ice-cream-kiosk', weight: 12 }, { name: 'ablutions', weight: 6 }, { name: 'beach-cafe', weight: 6 },
    { name: 'seafront-cafe', weight: 5 },
  ],
};

// ---- Occupancy + blockers ----------------------------------------------------------------------

interface Placed { x: number; z: number; footR: number; spacing: number; name: string; }

/** Coarse occupancy grid: a candidate is free when it overlaps no placed footprint and keeps the
 *  model's own `spacing` from any same-model neighbour. */
class ScatterOccupancy {
  private cells = new Map<string, Placed[]>();
  private maxFootR = 0;
  constructor(private cell = 32) {}
  private key(x: number, z: number): string { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  free(x: number, z: number, footR: number, spacing: number, name: string): boolean {
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    const reach = Math.max(1, Math.ceil(Math.max(footR + this.maxFootR, spacing) / this.cell) + 1);
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
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
    this.maxFootR = Math.max(this.maxFootR, footR);
  }
}

/** Reserved anchor pads + manicured sites — the crafted claims scatter must keep clear (rule B). */
function craftedBlocks(x: number, z: number, radius: number): boolean {
  for (const pad of RESERVED_PADS) if ((pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2) return true;
  for (const site of MANICURED_FOOTPRINTS) if ((site.x - x) ** 2 + (site.z - z) ** 2 < (site.radius + radius) ** 2) return true;
  return false;
}

function stationBlocks(x: number, z: number, radius: number): boolean {
  return RAILWAY_STATION_SITES.some((station) => (station.x - x) ** 2 + (station.z - z) ** 2 < (RAILWAY_STATION_CLEARANCE + radius) ** 2);
}

/** Spatial grid over the procedural CityGen building footprints so scatter never lands on one. */
class BuildingIndex {
  private cells = new Map<string, Array<{ x: number; z: number; r: number }>>();
  private ready = false;
  private maxRadius = 0;
  constructor(private cell = 40) {}
  private build(): void {
    for (const b of allBuildings()) {
      const r = Math.hypot(b.width, b.depth) / 2;
      const key = `${Math.floor(b.x / this.cell)},${Math.floor(b.z / this.cell)}`;
      const bucket = this.cells.get(key);
      const item = { x: b.x, z: b.z, r };
      if (bucket) bucket.push(item); else this.cells.set(key, [item]);
      this.maxRadius = Math.max(this.maxRadius, r);
    }
    this.ready = true;
  }
  blocks(x: number, z: number, radius: number): boolean {
    if (!this.ready) this.build();
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    const reach = Math.max(1, Math.ceil((radius + this.maxRadius) / this.cell) + 1);
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
      for (const b of this.cells.get(`${cx + dx},${cz + dz}`) ?? []) {
        if ((b.x - x) ** 2 + (b.z - z) ** 2 < (b.r + radius) ** 2) return true;
      }
    }
    return false;
  }
}

/** The species that build into a solid trunk. Read straight off TREE_SPECIES so a newly authored
 *  species owes the walk-lane clearance the day it is added to the library, not the day somebody
 *  remembers to extend a list here. */
const SOLID_TREE_NAMES: ReadonlySet<string> = new Set(TREE_SPECIES);

interface WalkSegment { ax: number; az: number; bx: number; bz: number; }

/**
 * The pedestrian walk polylines, hashed once for the whole scatter.
 *
 * They are STATIC — a pure function of the generated road network — and the scatter asks about them
 * for every tree candidate citywide, so the build is lazy (nothing pays for it unless a tree is
 * actually considered) and happens exactly once per process. Each segment is filed into every cell
 * its bounding box touches rather than into the cell of its midpoint: the decimated walk polyline
 * contains 40 u+ chords, and a midpoint hash would let a long segment miss the very bend it cuts
 * across. With the segments supercovered, a 3x3 neighbourhood at CELL 24 u is EXACT for any query
 * radius below 24 u, which WALK_LINE_TRUNK_CLEARANCE (1.6 u) comfortably is — so the query stays
 * nine bucket lookups and a handful of point-segment distances, not a scan.
 */
class WalkLineIndex {
  private cells: Map<string, WalkSegment[]> | undefined;
  constructor(private cell = 24) {}

  private build(): Map<string, WalkSegment[]> {
    const cells = new Map<string, WalkSegment[]>();
    for (const path of buildCityNavPaths(ROAD_NETWORK).walks) {
      for (let index = 0; index < path.points.length - 1; index++) {
        const a = path.points[index]!; const b = path.points[index + 1]!;
        const segment: WalkSegment = { ax: a.x, az: a.z, bx: b.x, bz: b.z };
        const minX = Math.floor(Math.min(a.x, b.x) / this.cell); const maxX = Math.floor(Math.max(a.x, b.x) / this.cell);
        const minZ = Math.floor(Math.min(a.z, b.z) / this.cell); const maxZ = Math.floor(Math.max(a.z, b.z) / this.cell);
        for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
          const key = `${cx},${cz}`; const bucket = cells.get(key);
          if (bucket) bucket.push(segment); else cells.set(key, [segment]);
        }
      }
    }
    return cells;
  }

  /** True when (x, z) is within `clearance` of any walk segment. */
  blocks(x: number, z: number, clearance: number): boolean {
    const cells = this.cells ??= this.build();
    const cx = Math.floor(x / this.cell); const cz = Math.floor(z / this.cell);
    const limit = clearance * clearance;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const segment of cells.get(`${cx + dx},${cz + dz}`) ?? []) {
        const sx = segment.bx - segment.ax; const sz = segment.bz - segment.az;
        const lengthSquared = sx * sx + sz * sz;
        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - segment.ax) * sx + (z - segment.az) * sz) / lengthSquared));
        const offX = x - (segment.ax + sx * t); const offZ = z - (segment.az + sz * t);
        if (offX * offX + offZ * offZ < limit) return true;
      }
    }
    return false;
  }
}

const walkLines = new WalkLineIndex();

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
  x = stableWorldFloat(x); z = stableWorldFloat(z); heading = stableWorldFloat(heading);
  const def = MODEL_INDEX.get(name);
  if (!def) return false;
  const w = def.maxFootprint.w; const d = def.maxFootprint.d;
  if (Math.abs(x) > HALF_WORLD - 20 || Math.abs(z) > HALF_WORLD - 20) return false;
  // The decision context is read at the frontage/grid point, but the model lands here — so re-check
  // the hard exclusions (water, runway, road/rail corridors) at the actual centre, where a set-back could
  // otherwise drift a mass off the buildable ground.
  if (pointInAnyPolygon(WATER_POLYGONS, x, z) || pointInAnyPolygon(AERODROME_POLYGONS, x, z)) return false;
  // Solid wood may not stand in a pedestrian lane. Gated on the species set first, so only the models
  // that actually build a trunk collider pay for the walk-line lookup (see WALK_LINE_TRUNK_CLEARANCE).
  if (SOLID_TREE_NAMES.has(name) && walkLines.blocks(x, z, WALK_LINE_TRUNK_CLEARANCE)) return false;
  if (footprintRoadClearance(x, z, w, d, heading) < roadClear) return false;
  if (footprintRailwayClearance(x, z, w, d, heading) < roadClear) return false;
  const footR = Math.hypot(w, d) / 2;
  if (stationBlocks(x, z, footR)) return false;
  if (craftedBlocks(x, z, footR * 0.7)) return false;
  if (buildings.blocks(x, z, footR)) return false;
  if (!occ.free(x, z, footR, def.spacing, name)) return false;
  occ.add(x, z, footR, def.spacing, name);
  out.push({ name, x, z, heading, seed: Math.floor(seeded(x, z, 91) * 1_000_003), variant: Math.floor(seeded(x, z, 92) * def.variants) });
  return true;
}

/** Clearances (units beyond the kerb) tried in order until a 27x24 forecourt clears the carriageway. */
const LANDMARK_FORECOURT_OFFSETS = [16, 20, 25, 31] as const;

/**
 * The forecourts the MAP already promises.
 *
 * `joburg-map.json` carries a landmark of kind 'fuel' — a filling station the OSM extract found on
 * the dam shore — and the in-game map (mapRender's landmark layer) draws it as a labelled gold star.
 * A labelled star with nothing under it is worse than no star at all: the owner drove to that exact
 * spot looking for petrol and found bare veld. So the scatter puts a real forecourt there.
 *
 * It runs FIRST, before the frontage walk, because of the owner's crafted-first rule: a site the map
 * names outranks a procedurally chosen verge slot, and claiming the ground first means the frontage
 * pass flows around it instead of having to be pushed aside.
 *
 * Placed through the SAME tryPlace() as every other model — the same water, aerodrome, road, railway,
 * crafted-pad, building and occupancy tests — so a landmark with nowhere legal to take a forecourt
 * simply does not get one, rather than dropping a canopy into the dam. The nearer side of the road
 * to the landmark is tried first, so the station lands on the side the map meant.
 */
function landmarkForecourtPass(occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[]): void {
  for (const landmark of LANDMARKS) {
    if (landmark.kind !== 'fuel') continue;
    const spot = nearestRoadSpot(landmark.x, landmark.z);
    const nearSide: 1 | -1 = Math.hypot(besideRoad(spot, 1, 4).x - landmark.x, besideRoad(spot, 1, 4).z - landmark.z)
      <= Math.hypot(besideRoad(spot, -1, 4).x - landmark.x, besideRoad(spot, -1, 4).z - landmark.z) ? 1 : -1;
    const sides: ReadonlyArray<1 | -1> = nearSide === 1 ? [1, -1] : [-1, 1];
    for (const clearance of LANDMARK_FORECOURT_OFFSETS) {
      let placed = false;
      for (const side of sides) {
        const at = besideRoad(spot, side, clearance);
        // Local +z is the entrance: buildFillingStation opens the apron, hangs the brand fascia and
        // stands the price totem on +z, so the forecourt has to face back at the carriageway.
        if (tryPlace('filling-station', at.x, at.z, Math.atan2(spot.x - at.x, spot.z - at.z), STRUCT_ROAD_CLEARANCE, occ, buildings, out)) { placed = true; break; }
      }
      if (placed) break;
    }
  }
}

/** Petrol coverage radius: an arterial stretch with no filling station within this is a hole. */
const FUEL_COVERAGE_RADIUS = 900;
/** Arc pitch (units) between forecourt attempts while walking an arterial to fill a hole. */
const FUEL_WALK_PITCH = 110;
/** Arterial width floor for the fuel walk — matches zoning's ARTERIAL_WIDTH; stations live on main roads. */
const FUEL_ARTERIAL_WIDTH = 13;

/**
 * THE PETROL NETWORK DOES NOT GET STARVED BY DENSITY.
 *
 * Filling stations used to exist only as an 8-weight lottery ticket in the commercial-strip
 * frontage profile. Procedural buildings claim their ground FIRST, so when the city-density pass
 * packed the strips with real buildings, the lottery slots that used to carry forecourts became
 * shops — the citywide network fell 19 → 11 and whole suburbs lost their petrol. The fuel feature
 * is gameplay infrastructure (the owner has driven to a mapped station and found bare veld before;
 * that class of bug is not allowed back), so coverage is now guaranteed by construction:
 *
 * After the frontage lottery has played out, walk every arterial at a fixed arc pitch and, wherever
 * NO station stands within FUEL_COVERAGE_RADIUS, try to seat a forecourt beside the kerb through
 * the same tryPlace() gauntlet as everything else (water, roads, rail, crafted pads, buildings,
 * spacing). Deterministic — fixed iteration order, no rolls — and self-limiting: the coverage test
 * plus the model's own 260 u spacing stop it carpeting the town, so it adds stations only where
 * densification (this pass or any future one) has starved a neighbourhood.
 */
function fuelNetworkPass(occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[]): void {
  const stations = out.filter((model) => model.name === 'filling-station').map(({ x, z }) => ({ x, z }));
  const covered = (x: number, z: number): boolean =>
    stations.some((station) => (station.x - x) ** 2 + (station.z - z) ** 2 < FUEL_COVERAGE_RADIUS ** 2);
  for (const road of GENERATED_ROADS) {
    if (road.width < FUEL_ARTERIAL_WIDTH) continue;
    let acc = 0;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i]!; const b = road.points[i + 1]!;
      const segX = b.x - a.x; const segZ = b.z - a.z; const length = Math.hypot(segX, segZ);
      if (length < 0.01) continue;
      const dirX = segX / length; const dirZ = segZ / length;
      for (acc += length; acc >= FUEL_WALK_PITCH; acc -= FUEL_WALK_PITCH) {
        const t = 1 - (acc - FUEL_WALK_PITCH) / length;
        if (t < 0 || t > 1) continue;
        const mx = a.x + segX * t; const mz = a.z + segZ * t;
        if (covered(mx, mz)) continue;
        if (classifyZone(mx, mz, road.width) === 'none') continue; // no forecourts in parks/water/airfield
        for (const clearance of LANDMARK_FORECOURT_OFFSETS) {
          let placed = false;
          for (const side of [1, -1] as const) {
            const nX = side * -dirZ; const nZ = side * dirX;
            const at = { x: mx + nX * (road.width / 2 + clearance), z: mz + nZ * (road.width / 2 + clearance) };
            // Local +z is the forecourt entrance (apron, fascia, totem) — face back at the carriageway.
            if (tryPlace('filling-station', at.x, at.z, Math.atan2(mx - at.x, mz - at.z), STRUCT_ROAD_CLEARANCE, occ, buildings, out)) {
              stations.push(at); placed = true; break;
            }
          }
          if (placed) break;
        }
      }
    }
  }
}

/** Densely walk a road centreline once, yielding arc-length-spaced frontage anchors per side. */
/** Chunked: yields its completed fraction every few hundred roads (the whole-map scatter is the
 *  single biggest boot block on mobile). Iteration order untouched — the layout stays identical. */
function* frontagePass(occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[]): Generator<number> {
  const stride = Math.max(60, Math.ceil(GENERATED_ROADS.length / 24));
  for (let ri = 0; ri < GENERATED_ROADS.length; ri++) {
    if (ri > 0 && ri % stride === 0) yield ri / GENERATED_ROADS.length;
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

/** Grid-sample a landuse polygon and fill it with foliage (+ sparse structures) from `profile`.
 *  Chunked per polygon: yields the completed fraction so the staged boot can paint mid-pass. */
function* areaPass(polygons: readonly MapPolygon[], profile: AreaProfile, occ: ScatterOccupancy, buildings: BuildingIndex, out: ScatteredModel[]): Generator<number> {
  for (let pi = 0; pi < polygons.length; pi++) {
    if (pi > 0 && pi % 8 === 0) yield pi / polygons.length;
    const poly = polygons[pi]!;
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

/** The citywide scatter layout as a chunked pass (fraction 0..1): the frontage walk dominates,
 *  the landuse fills follow. Same pass order as ever — determinism is untouched. */
export function* scatterStages(): Generator<number> {
  if (scatterCells) return;
  const out: ScatteredModel[] = [];
  const occ = new ScatterOccupancy();
  const buildings = new BuildingIndex();
  // Crafted claims are already fixed (RESERVED_PADS / MANICURED_FOOTPRINTS) and the procedural
  // buildings are indexed above — so both passes below flow deterministically AROUND them.
  landmarkForecourtPass(occ, buildings, out); // a handful of sites the map names; claims first
  for (const f of frontagePass(occ, buildings, out)) yield f * 0.7;
  fuelNetworkPass(occ, buildings, out); // then guarantee petrol coverage wherever the lottery starved it
  for (const f of areaPass(FARM_POLYGONS, AREA_FARM, occ, buildings, out)) yield 0.7 + f * 0.1;
  for (const f of areaPass(GREEN_POLYGONS, AREA_PARK, occ, buildings, out)) yield 0.8 + f * 0.15;
  for (const f of areaPass(BEACH_POLYGONS, AREA_BEACH, occ, buildings, out)) yield 0.95 + f * 0.05;

  const cells = new Map<string, ScatteredModel[]>();
  const canonical: ScatteredModel[] = [];
  for (const model of out) {
    const key = `${Math.floor(model.x / CELL_SIZE)},${Math.floor(model.z / CELL_SIZE)}`;
    const bucket = cells.get(key);
    if (bucket) {
      if (bucket.length < SCATTER_CELL_CAP) { bucket.push(model); canonical.push(model); }
    } else { cells.set(key, [model]); canonical.push(model); }
  }
  allScatter = canonical;
  scatterCells = cells;
}

/** Force the (memoized) citywide scatter layout to build now — call during load, not first frame. */
export function ensureScatter(): void {
  for (const fraction of scatterStages()) void fraction; // synchronous drain
}

/** Install a pre-baked canonical scatter list (see tools/bake) — the exact counterpart of
 *  CityGen.hydrateParcels: scatterStages()/scatterCell() then serve the baked layout. */
export function hydrateScatter(models: ScatteredModel[]): boolean {
  if (scatterCells) return false;
  const cells = new Map<string, ScatteredModel[]>();
  for (const model of models) {
    const key = `${Math.floor(model.x / CELL_SIZE)},${Math.floor(model.z / CELL_SIZE)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(model); else cells.set(key, [model]);
  }
  allScatter = models;
  scatterCells = cells;
  return true;
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
