import * as THREE from 'three';
import { PLAYER, WORLD_SIZE } from '../config';
import type { BaseQuality, District } from '../types';
import { BuildingArchitecture, type BuildingStyle } from './BuildingArchitecture';
import {
  COASTLINE,
  COAST_CORRIDOR,
  districtAt as generatedDistrictAt,
  elevationMetresAt,
  regionalMetresAt,
  HAS_ELEVATION,
  GENERATED_ROADS,
  GENERATED_RAILWAYS,
  GENERATED_TRACKS,
  GREEN_POLYGONS,
  DIRT_POLYGONS,
  FARM_POLYGONS,
  HARBOUR_POINT,
  JUNCTION_SURFACES,
  junctionPaves,
  junctionReach,
  METRES_PER_UNIT,
  OCEAN_POLYGON,
  pointInPolygon,
  WATER_POLYGONS,
  type MapPolygon,
  type MapPt,
} from './mapData';
import { OCEAN_Y } from './coast';
import { HILLBROW_TOWER_SPOT, PONTE_SPOT, RESERVED_PADS, WATER_TOWER_SPOT } from './placements';
import { CELL_SIZE, ensureParcels, generateCell, type GeneratedBuilding } from './CityGen';
import { ensureScatter, scatterCell, type ScatteredModel } from './ModelScatter';
import { buildModel, MODEL_INDEX } from './models/catalog';
import { RESOLVED_MANICURED_SITES, type ResolvedManicuredSite } from './data/manicured';
import { addInstancedChunks, cellDistance, ChunkStore, ChunkVisibility, CHUNK_HYSTERESIS, CHUNK_VISIBLE_RANGE, DETAIL_HYSTERESIS, DETAIL_VISIBLE_RANGE, type InstanceItem } from './ChunkVisibility';
import { applyGrassShader, createFacadeGlowTexture, createFacadeTexture, createGeneratedSurfaceTexture, createGrassTexture, createSidewalkTexture, createSignMesh, createSurfaceTexture, FACADE_VARIANTS } from './ProceduralMaterials';
import { GeometryBaker, mergeStaticGeometry } from './StaticGeometry';
import { bridgeIslands, buildNavGraph, type NavGraph, type NavPath, type NavPoint } from '../systems/NavGraph';
import { PropRegistry } from '../systems/PropSystem';
import { CITY_JUNCTIONS, type JunctionDefinition, signalHoldsDriver, signalSlowFactor, SIGNAL_STOP_APPROACH, UrbanInfrastructure } from './UrbanInfrastructure';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createWater, waterTier, type WaterHandle, type WaterSite } from './Water';
import { registerPowered } from './powerGrid';

/** XZ AABB with a real vertical span: `height` above `y0`. `y0` is world-space; when omitted the collider is
 *  grounded on the terrain under its centre (the flat-world registrations keep working untouched). */
/** A world collider footprint. minX/maxX/minZ/maxZ are always the ENCLOSING axis-aligned box — used for the
 *  spatial-hash broad phase and cheap rejects. When `heading` is set the true footprint is an ORIENTED
 *  rectangle centred on the AABB centre, rotated by `heading`, with local half-extents (hw, hd); the narrow
 *  phase tests against that so a building rotated to a diagonal street stops you at its wall, never at the
 *  corner of an oversized AABB. Axis-aligned (or quarter-snapped) colliders leave `heading` undefined so the
 *  fast AABB path stays exact. */
export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; height: number; y0?: number; heading?: number; hw?: number; hd?: number; }
export const colliderBase = (box: Collider): number => box.y0 ?? terrainHeightAt((box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2);
export const colliderTop = (box: Collider): number => colliderBase(box) + box.height;

/** Circle (x, z, radius) vs a collider's XZ footprint. Exact for both axis-aligned boxes and, via the
 *  oriented-rectangle narrow phase, buildings/models rotated to any heading. */
export function colliderOverlapsXZ(box: Collider, x: number, z: number, radius: number): boolean {
  // Broad phase: the stored min/max encloses the footprint either way, so this rejects distant queries cheaply.
  if (x + radius <= box.minX || x - radius >= box.maxX || z + radius <= box.minZ || z - radius >= box.maxZ) return false;
  if (box.heading === undefined) return true; // axis-aligned: the AABB overlap is already exact
  // Narrow phase: bring the circle centre into the box's local frame (inverse of the placement rotation
  // wx = cx + lx·c + lz·s; wz = cz − lx·s + lz·c), then measure to the local rectangle [-hw,hw]×[-hd,hd].
  const cx = (box.minX + box.maxX) / 2; const cz = (box.minZ + box.maxZ) / 2;
  const c = Math.cos(box.heading); const s = Math.sin(box.heading);
  const dx = x - cx; const dz = z - cz;
  const lx = dx * c - dz * s; const lz = dx * s + dz * c;
  const ex = lx - Math.max(-box.hw!, Math.min(box.hw!, lx));
  const ez = lz - Math.max(-box.hd!, Math.min(box.hd!, lz));
  return ex * ex + ez * ez < radius * radius;
}

/** Pure y-aware occupancy: a collider blocks the band (y0, y1) only when its own span crosses it. */
export function collidersBlock(colliders: readonly Collider[], x: number, z: number, radius: number, y0: number, y1: number): boolean {
  return colliders.some((box) => colliderBase(box) < y1 && colliderTop(box) > y0 && colliderOverlapsXZ(box, x, z, radius));
}

/** Highest collider top at or below feetY + stepUp under the query circle; undefined when nothing is underfoot. */
export function highestColliderTop(colliders: readonly Collider[], x: number, z: number, feetY: number, radius = 0.35): number | undefined {
  const limit = feetY + PLAYER.stepUp; let best: number | undefined;
  for (const box of colliders) {
    if (!colliderOverlapsXZ(box, x, z, radius)) continue;
    const top = colliderTop(box);
    if (top <= limit && (best === undefined || top > best)) best = top;
  }
  return best;
}
export interface RoadPoint { x: number; z: number; }
export interface RoadsidePoint extends RoadPoint { inwardX: number; inwardZ: number; width: number; }
export interface RoadPose { position: THREE.Vector3; heading: number; }
export interface RoadDefinition { name: string; width: number; closed?: boolean; points: RoadPoint[]; }
export type SurfaceKind = 'auto' | 'terrain' | 'road' | 'sidewalk';

export const ROAD_SURFACE_OFFSET = 0.15;
export const SIDEWALK_RISE = 0.22;
/** How far the ground mesh sinks beneath an inland water body's surface, so dams/ponds read as basins
 *  instead of a flat sheet coplanar with the land (the original z-fighting the relief pass set out to kill). */
export const WATER_BASIN_DEPTH = 2.6;
export const STOP_LINE_DEPTH = 0.6; // thickness (along travel) of an intersection stop bar — bold, reads as the feature
/** Pavement begins just behind the kerb and ends exactly at the walkable-band query boundary. */
export const SIDEWALK_INNER_EDGE = 0.38;
export const SIDEWALK_WIDTH = 3.12;
export const SIDEWALK_CENTER = SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH / 2;
const SIDEWALK_UV_LENGTH = 48; // one procedural tile contains sixteen 3u-deep paving bays
const CLIP_PROBE_SPACING = 3; // narrower than the smallest road: a crossing cannot hide between probes

/** True when (x, z) sits on any paved junction surface — used to blank lane markings there so a 4-way reads
 *  as one clean intersection instead of two ribbons' edge/centre lines crossing in an X. Same shape the
 *  renderer bakes (see junctionPaves), so paving and marking blackout line up exactly. */
function insideJunction(x: number, z: number): boolean {
  for (const surface of JUNCTION_SURFACES) if (junctionPaves(surface, x, z)) return true;
  return false;
}

/**
 * Land relief from the map JSON's SRTM heightgrid, DETRENDED so it's usable as world Y (raw metres put
 * Johannesburg's ~1760 m plateau a mile above the synthetic 0 m ocean — see mapData's elevation section).
 * We split elevation into a heavily-blurred REGIONAL trend and the fine LOCAL residual (raw − regional):
 *   - REGIONAL is subtracted OUT (scale 0): this brings the whole plateau DOWN to tidily meet the ocean
 *     at Y≈0, and — crucially — the big coastal escarpment lives entirely in this discarded trend, so it
 *     never reaches the output as a cliff. (Dial this up for a hint of large-scale height back.)
 *   - LOCAL is exaggerated (×2), turning the otherwise-flat plateau into rolling hills around that shared
 *     zero. Capped either side first, so the blur's overshoot at the escarpment kink can't spike.
 * Result: a hilly world centred on sea level, land below 0 wherever water wants depth. Bilinearly
 * interpolated (mapData) so the whole-metre source data reads as smooth slopes, not 1 m terraces.
 * Everything downstream (roads, buildings, water, props, colliders, ped & vehicle grounding, bullets)
 * samples this one function, so relief propagates for free.
 */
export const TERRAIN_REGIONAL_SCALE = 0; // subtract the broad plateau/coast trend out entirely (land meets ocean at 0)
export const TERRAIN_LOCAL_SCALE = 2.0; // fine residual: metres → units (exaggerate the flat land into hills)
/** Cap on the local residual (metres) BEFORE exaggeration, so the blur's overshoot at the steep synthetic
 *  escarpment kink can't blow up into a spike; gentle CBD undulation is well under this. */
export const TERRAIN_LOCAL_CAP = 18;
/** Coastline vertices sorted by z, for a per-z land/sea boundary lookup: the synthetic shore meanders
 *  across x by ~1.6 km, so a single global coast x would sink real coastal land (roads, beach) below sea
 *  level. terrain crosses 0 at coastlineXAt(z); seaward of it the ground sinks into the seabed slope. */
const COAST_BY_Z: readonly MapPt[] = COASTLINE.length ? [...COASTLINE].sort((a, b) => a.z - b.z) : [];

/** The coastline x at world z (interpolated), i.e. where the land meets the sea on this east-west line. */
function coastlineXAt(z: number): number {
  const pts = COAST_BY_Z; const n = pts.length;
  if (n === 0) return Number.NEGATIVE_INFINITY;
  if (z <= pts[0]!.z) return pts[0]!.x;
  if (z >= pts[n - 1]!.z) return pts[n - 1]!.x;
  let lo = 0; let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid]!.z <= z) lo = mid; else hi = mid; }
  const a = pts[lo]!; const b = pts[hi]!;
  return a.x + (b.x - a.x) * ((z - a.z) / (b.z - a.z || 1));
}

/** Coastal beach/seabed profile: the sand's landward crest sits just above sea level and the ground slopes
 *  continuously down to SEA_FLOOR_Y at the map's west edge — never flat, so the waving ocean can't z-fight
 *  it, and it's a sandy sea floor all the way out (for diving later). */
export const BEACH_TOP_Y = 1.5;
export const SEA_FLOOR_Y = -30;
/** How far inland (east of the OSM coastline) the sand's landward crest sits. */
export const BEACH_INLAND = 40;
/** How far the ocean surface reaches past the shoreline into the beach, so waves lap up and down the slope. */
export const BEACH_WATER_INLAND = 60;

/** The detrended, exaggerated, capped land relief at a point (before any coastal fade). */
function landRelief(x: number, z: number): number {
  const regional = regionalMetresAt(x, z);
  let local = elevationMetresAt(x, z) - regional;
  if (local > TERRAIN_LOCAL_CAP) local = TERRAIN_LOCAL_CAP;
  else if (local < -TERRAIN_LOCAL_CAP) local = -TERRAIN_LOCAL_CAP;
  return regional * TERRAIN_REGIONAL_SCALE + local * TERRAIN_LOCAL_SCALE;
}

function analyticTerrainHeightAt(x: number, z: number): number {
  if (!HAS_ELEVATION) return 0;
  const eastX = COAST_CORRIDOR?.eastX;
  // Fast path — well inland of any coast: full relief, no per-z coastline lookup.
  if (eastX === undefined || x >= eastX) return landRelief(x, z);
  const beachTopX = coastlineXAt(z) + BEACH_INLAND; // landward crest of the sand
  // Seaward of the sand crest: one continuous sand slope from +BEACH_TOP_Y down to SEA_FLOOR_Y at the map
  // edge. Always sloped, never flat — the ocean surface laps it without z-fighting, and it's a sandy sea
  // floor all the way out.
  if (x < beachTopX) {
    const westEdge = -WORLD_SIZE / 2;
    const t = beachTopX > westEdge ? Math.min(1, (beachTopX - x) / (beachTopX - westEdge)) : 0;
    return BEACH_TOP_Y + (SEA_FLOOR_Y - BEACH_TOP_Y) * t;
  }
  // Coastal land: rise from the sand crest (+BEACH_TOP_Y) up to full inland relief at the city edge. The
  // relief contribution is floored at 0 so the mean-zero relief's negative lobes can't drag the immediate
  // hinterland below the waterline and flood the beach; genuine relief (hills) still comes through.
  const f = (x - beachTopX) / (eastX - beachTopX);
  return BEACH_TOP_Y * (1 - f) + Math.max(0, landRelief(x, z)) * f;
}

// --- Rendered-surface grid ----------------------------------------------------
// The ground is DRAWN as a tessellated mesh that linearly interpolates between its ~70u vertices, while
// the analytic sampler above is smooth — mid-triangle the two diverge by up to ~1m. Anything grounded or
// placed by the analytic value therefore floats/sinks relative to what's on screen (bare tree trunks and
// the player show it plainly). buildGround captures the exact vertex heights into this grid; terrainHeightAt
// then samples it so the mesh, player, props, foliage, buildings, colliders and bullets share one surface.
let terrainGrid: Float32Array | null = null;
let terrainGridN = 0; // vertices per side
let terrainGridStep = 1; // world units between vertices
const TERRAIN_GRID_MIN = -WORLD_SIZE / 2;

/** Publish the ground mesh's vertex-height grid as the authoritative terrain surface (called by buildGround). */
export function setTerrainGrid(grid: Float32Array, verticesPerSide: number, step: number): void {
  terrainGrid = grid; terrainGridN = verticesPerSide; terrainGridStep = step;
}

/** Bilinear sample of the drawn ground grid — matches the rendered surface to within a triangle's twist. */
function sampleTerrainGrid(x: number, z: number): number {
  const n = terrainGridN; const g = terrainGrid!;
  let c = (x - TERRAIN_GRID_MIN) / terrainGridStep; let r = (z - TERRAIN_GRID_MIN) / terrainGridStep;
  c = c < 0 ? 0 : c > n - 1 ? n - 1 : c; r = r < 0 ? 0 : r > n - 1 ? n - 1 : r;
  const c0 = Math.floor(c); const r0 = Math.floor(r);
  const c1 = c0 + 1 < n ? c0 + 1 : c0; const r1 = r0 + 1 < n ? r0 + 1 : r0;
  const fc = c - c0; const fr = r - r0;
  const h00 = g[r0 * n + c0]!; const h10 = g[r0 * n + c1]!; const h01 = g[r1 * n + c0]!; const h11 = g[r1 * n + c1]!;
  // TRIANGLE interpolation matching the PlaneGeometry ground mesh (diagonal (col+1,row)-(col,row+1)), not
  // bilinear — so this returns the EXACT drawn surface. Bilinear diverged from the faceted mesh by the
  // cell twist, which exceeds the road's 0.055 lift and let the ground poke up through the tar.
  if (fc + fr <= 1) return h00 + (h10 - h00) * fc + (h01 - h00) * fr;
  return h11 + (h01 - h11) * (1 - fc) + (h10 - h11) * (1 - fr);
}

/** The one terrain height everything shares. Once the ground mesh is built this returns the exact DRAWN
 *  surface (so nothing floats/sinks against it); before then it falls back to the smooth analytic relief. */
export function terrainHeightAt(x: number, z: number): number {
  return terrainGrid ? sampleTerrainGrid(x, z) : analyticTerrainHeightAt(x, z);
}

/** District ownership comes from the generated map's place nodes (nearest centre). */
export const districtAt = generatedDistrictAt;

/** The driveable road network — straight from the generated OSM map. */
export const ROAD_NETWORK: RoadDefinition[] = GENERATED_ROADS.map((road) => ({ name: road.name, width: road.width, points: road.points }));
/** Off-road dirt tracks: rendered as narrow unpaved strips, not part of the nav graph. */
export const TRACK_NETWORK: RoadDefinition[] = GENERATED_TRACKS.map((track) => ({ name: track.name, width: track.width, points: track.points }));
/** Passenger rail lines: ballast + rails + sleepers, never driveable, outside every nav graph. */
export const RAILWAY_NETWORK: Array<{ name: string; points: RoadPoint[] }> =
  GENERATED_RAILWAYS.map((line) => ({ name: line.name, points: line.points }));
/** Rail-to-rail centre spacing (u) — reads as SA cape gauge at game scale. */
export const RAIL_GAUGE = 1.6;
/** Gravel ballast bed width (u). */
export const RAIL_BALLAST_WIDTH = 5.2;

const seeded = (x: number, z: number, salt = 0): number => {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
};

/**
 * Unit-denominated layout spacings were authored against the 2.94 m/unit (6000u) map. They must
 * track the map footprint so real-world density stays constant at any TARGET_SIZE: without this,
 * a scale-up would sample more nav nodes / sidewalk points per road (squaring the nav-graph build
 * cost) and space roadside buildings closer in real terms. LAYOUT_SCALE is 1.0 at the old scale
 * and 3.0 at the 18000u parity scale, so ROAD_SAMPLE_SPACING/NAV joins hold the same *real* pitch.
 */
const LAYOUT_SCALE = 2.94 / METRES_PER_UNIT;
export const ROAD_SAMPLE_SPACING = Math.round(12 * LAYOUT_SCALE);
/** Sub-step (world units) the road/track SURFACE mesh is re-tessellated to, independent of the coarser nav
 *  sampling — small enough (vs the ~70u ground-mesh cells) that the tar hugs the relief and the faceted
 *  ground can't crease up through it between samples. Only the visual strip densifies; nav is untouched. */
export const ROAD_STRIP_SUBSTEP = 8;
/** Streetlamp pitch: a lamp every ~36u of road, alternating kerbs — the classic staggered layout that
 *  lines the whole map like the old hand-authored city. Scaled with the footprint so the real-world
 *  pitch (~35m) holds at any TARGET_SIZE, exactly like ROAD_SAMPLE_SPACING and the nav joins. */
export const STREETLAMP_SPACING = Math.round(12 * LAYOUT_SCALE);
/** Even the narrowest generated streets (6u residential) get lit; only sub-road dirt tracks stay dark. */
export const STREETLAMP_MIN_WIDTH = 6;
export const VEHICLE_NAV_JOIN = Math.round(15 * LAYOUT_SCALE);
export const PED_NAV_JOIN = Math.round(18 * LAYOUT_SCALE);
/** Static geometry merges per material per grid cell this size, keeping frustum culling useful.
 *  Tied to CityGen.CELL_SIZE so the on-demand building grid and the static merge grid are identical. */
export const MERGE_CHUNK_SIZE = CELL_SIZE;
/** Lakes/dams at least this large (units²) get the tiered wavy/reflective water treatment. */
export const PREMIUM_WATER_AREA = 3200;
/** Time (ms) per frame spent generating on-demand building chunks. A short stream-in is preferable to
 *  repeatedly consuming a quarter of a 60fps frame and turning initial traversal into visible hitches. */
export const BUILD_FRAME_BUDGET_MS = 2;

export function sampleRoadPath(points: RoadPoint[], closed: boolean, spacing: number): RoadPoint[] {
  const source = closed ? [...points, points[0]].filter((point): point is RoadPoint => Boolean(point)) : points;
  const output: RoadPoint[] = [];
  for (let segment = 0; segment < source.length - 1; segment++) {
    const start = source[segment]; const end = source[segment + 1]; if (!start || !end) continue;
    const distance = Math.hypot(end.x - start.x, end.z - start.z); const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 0; step < steps; step++) { const t = step / steps; output.push({ x: THREE.MathUtils.lerp(start.x, end.x, t), z: THREE.MathUtils.lerp(start.z, end.z, t) }); }
  }
  if (!closed && source.at(-1)) output.push({ ...source.at(-1)! });
  return output;
}

export function offsetRoadPath(points: RoadPoint[], offset: number, closed: boolean): RoadPoint[] {
  return points.map((point, index) => {
    const previous = points[index === 0 ? (closed ? points.length - 1 : 0) : index - 1] ?? point;
    const next = points[index === points.length - 1 ? (closed ? 0 : points.length - 1) : index + 1] ?? point;
    const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
    return { x: point.x - dz / length * offset, z: point.z + dx / length * offset };
  });
}

/**
 * Clear portions of a path segment, with binary-refined transitions.  Long street runs remain one
 * quad; only the neighbourhood of a crossing is sampled.  Keeping this pure makes the clipping rule
 * independently testable (and avoids the old all-or-nothing 36u gaps around intersections).
 */
export function clearPathIntervals(length: number, blockedAt: (distance: number) => boolean, probeSpacing = CLIP_PROBE_SPACING): Array<[number, number]> {
  if (length <= 1e-6) return [];
  const steps = Math.max(1, Math.ceil(length / Math.max(0.1, probeSpacing)));
  const intervals: Array<[number, number]> = [];
  let previous = 0; let blocked = blockedAt(0); let openStart = blocked ? undefined : 0;
  for (let step = 1; step <= steps; step++) {
    const distance = length * step / steps; const nextBlocked = blockedAt(distance);
    if (nextBlocked !== blocked) {
      let low = previous; let high = distance;
      for (let iteration = 0; iteration < 9; iteration++) {
        const mid = (low + high) / 2;
        if (blockedAt(mid) === blocked) low = mid; else high = mid;
      }
      const edge = (low + high) / 2;
      if (blocked) openStart = edge;
      else if (openStart !== undefined && edge - openStart > 0.08) intervals.push([openStart, edge]);
    }
    previous = distance; blocked = nextBlocked;
  }
  if (!blocked && openStart !== undefined && length - openStart > 0.08) intervals.push([openStart, length]);
  return intervals;
}

/** Pure builder for the nav-graph source polylines: one lane pair and one sidewalk pair per road,
 *  sampled exactly like the rendered geometry so waypoints sit on the drawn lanes and sidewalks. */
export function buildCityNavPaths(network: RoadDefinition[] = ROAD_NETWORK): { lanes: NavPath[]; walks: NavPath[] } {
  const lanes: NavPath[] = []; const walks: NavPath[] = [];
  for (const definition of network) {
    const closed = definition.closed ?? false;
    const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
    lanes.push({ points: offsetRoadPath(sampled, -definition.width * 0.23, closed), closed });
    lanes.push({ points: offsetRoadPath(sampled, definition.width * 0.23, closed).reverse(), closed });
    for (const side of [-1, 1]) walks.push({ points: offsetRoadPath(sampled, side * (definition.width / 2 + SIDEWALK_CENTER), closed).filter((_, index) => index % 2 === 0), closed });
  }
  return { lanes, walks };
}

/** Pure builder for the staggered streetlamp anchors: walk each road's centreline by arc length and drop
 *  a lamp every STREETLAMP_SPACING, alternating kerbs (the classic staggered layout that lines the whole
 *  map). Distance-based, so the pitch is identical on a short residential stub and a long arterial — the
 *  fix for the old per-point modulo stride, which lit only the odd wide road and skipped the suburbs.
 *  Each anchor carries the roadsidePoint shape (x/z on the verge + inward normal over the carriageway +
 *  road width) so UrbanInfrastructure aims each fixture's arm exactly as it does the verge furniture.
 *  Exported so placement is unit-testable without constructing a City (which needs THREE + textures). */
export function buildStreetlampPoints(network: RoadDefinition[] = ROAD_NETWORK): RoadsidePoint[] {
  const lamps: RoadsidePoint[] = [];
  for (const definition of network) {
    if (definition.width < STREETLAMP_MIN_WIDTH) continue; // only sub-road dirt tracks stay dark
    const closed = definition.closed ?? false;
    const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
    const source = closed ? [...sampled, sampled[0]].filter((point): point is RoadPoint => Boolean(point)) : sampled;
    const offset = definition.width / 2 + 3.05; // verge line, same setback as the roadside furniture
    let travelled = 0; let next = STREETLAMP_SPACING / 2; let side: -1 | 1 = 1; // first lamp half a span in
    for (let segment = 0; segment < source.length - 1; segment++) {
      const start = source[segment]; const end = source[segment + 1]; if (!start || !end) continue;
      const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz); if (length < 1e-4) continue;
      const normalX = -dz / length; const normalZ = dx / length; // left-hand normal of the local road direction
      while (next <= travelled + length) {
        const t = (next - travelled) / length;
        const cx = start.x + dx * t; const cz = start.z + dz * t; // point on the centreline
        lamps.push({
          x: cx + normalX * offset * side, z: cz + normalZ * offset * side,
          inwardX: -normalX * side, inwardZ: -normalZ * side, width: definition.width, // inward faces back over the road
        });
        side = side === 1 ? -1 : 1; next += STREETLAMP_SPACING;
      }
      travelled += length;
    }
  }
  return lamps;
}

interface IndexedSegment { ax: number; az: number; bx: number; bz: number; half: number; surface: number; }

/** Uniform grid over the sampled road segments: every distance/on-road query goes through this
 *  instead of scanning ~4000 polylines. Distances are exact up to `reach`, clamped beyond it. */
class RoadIndex {
  private cells = new Map<string, IndexedSegment[]>();
  constructor(private cell = 36, private reach = 64) {}

  addSurface(points: RoadPoint[], width: number, surface: number): void {
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index]!; const b = points[index + 1]!;
      const segment: IndexedSegment = { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: width / 2, surface };
      const pad = segment.half + this.reach;
      const minX = Math.floor((Math.min(a.x, b.x) - pad) / this.cell); const maxX = Math.floor((Math.max(a.x, b.x) + pad) / this.cell);
      const minZ = Math.floor((Math.min(a.z, b.z) - pad) / this.cell); const maxZ = Math.floor((Math.max(a.z, b.z) + pad) / this.cell);
      for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
        const key = `${cx},${cz}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(segment); else this.cells.set(key, [segment]);
      }
    }
  }

  /** Distance beyond the nearest road edge (negative inside a road), capped at `reach`. */
  edgeDistance(x: number, z: number, exclude = -1): number {
    let best: number = this.reach;
    for (const segment of this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`) ?? []) {
      if (segment.surface === exclude) continue;
      const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az; const lengthSq = dx * dx + dz * dz || 1;
      const t = THREE.MathUtils.clamp(((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq, 0, 1);
      const distance = Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t)) - segment.half;
      if (distance < best) best = distance;
    }
    return best;
  }

  onRoad(x: number, z: number, margin: number, exclude = -1): boolean {
    return this.edgeDistance(x, z, exclude) <= margin;
  }
}

/** Directed-lane junction-turn tuning (see buildVehicleNav). A candidate cross-link A→B survives only if
 *  B is comfortably ahead of A and of B's own flow (VEHICLE_TURN_AHEAD_MIN), the two lanes aren't near
 *  head-to-head (VEHICLE_TURN_DOT_MIN, allows up to ~100° turns), and the straight A→B segment stays on
 *  the tar at every interior sample (VEHICLE_TURN_ONROAD_MARGIN inside the kerb). The on-road test is what
 *  kills the diagonal that chords across a junction corner over the sidewalk/poles. */
export const VEHICLE_TURN_AHEAD_MIN = 0.35;
export const VEHICLE_TURN_DOT_MIN = -0.2;
export const VEHICLE_TURN_ONROAD_MARGIN = -0.5;
export const VEHICLE_TURN_SAMPLES = 3;

/** Gate for one directed junction turn A→B, given the node table, per-node forward tangents and a road
 *  index to test the connecting segment against the carriageway. */
function vehicleTurnAllowed(from: number, to: number, nodes: NavPoint[], tangents: NavPoint[], roadIndex: RoadIndex): boolean {
  const a = nodes[from]; const b = nodes[to]; const ta = tangents[from]; const tb = tangents[to];
  if (!a || !b || !ta || !tb) return false;
  const dx = b.x - a.x; const dz = b.z - a.z; const length = Math.hypot(dx, dz); if (length < 1e-6) return false;
  const ux = dx / length; const uz = dz / length;
  if (ta.x * ux + ta.z * uz < VEHICLE_TURN_AHEAD_MIN) return false; // B must sit ahead of A's flow (no reach-back diagonal)
  if (tb.x * ux + tb.z * uz < VEHICLE_TURN_AHEAD_MIN) return false; // and the move must enter B going roughly B's way
  if (ta.x * tb.x + ta.z * tb.z < VEHICLE_TURN_DOT_MIN) return false; // reject near-U-turn junction links
  for (let sample = 1; sample <= VEHICLE_TURN_SAMPLES; sample++) { // every interior point must stay on the carriageway
    const t = sample / (VEHICLE_TURN_SAMPLES + 1);
    if (!roadIndex.onRoad(a.x + dx * t, a.z + dz * t, VEHICLE_TURN_ONROAD_MARGIN)) return false;
  }
  return true;
}

/** Adds a directed edge a→b to a graph's adjacency (no duplicates), skipping self-loops. */
function addDirectedEdge(edges: number[][], a: number, b: number): void {
  const neighbors = edges[a]; if (a === b || !neighbors || neighbors.includes(b)) return;
  neighbors.push(b);
}

/** Builds the DIRECTED vehicle nav graph: one-way lanes (so cars keep South-African left, never drive the
 *  wrong way up a lane) with junction cross-links gated by vehicleTurnAllowed (legal, on-tar turns only —
 *  no diagonal chords over poles). Self-contained (builds its own carriageway index from the road network)
 *  so it runs at field-init time before buildRoads and is unit-testable without constructing a City.
 *  Adds an explicit U-turn at every non-closed road terminus so a directed lane is never a dead-end sink. */
export function buildVehicleNav(network: RoadDefinition[] = ROAD_NETWORK): NavGraph {
  const roadIndex = new RoadIndex();
  for (const definition of network) {
    const sampled = sampleRoadPath(definition.points, definition.closed ?? false, ROAD_SAMPLE_SPACING);
    roadIndex.addSurface(sampled, definition.width, 0);
  }
  const { lanes } = buildCityNavPaths(network);
  const graph = buildNavGraph(lanes, VEHICLE_NAV_JOIN, {
    directed: true,
    crossLink: (from, to, nodes, tangents) => vehicleTurnAllowed(from, to, nodes, tangents, roadIndex),
  });
  // buildCityNavPaths emits lanes in pairs — index 2k = lane A (forward), 2k+1 = lane B (reversed) of road k.
  // At each end of an open road, lane A and lane B sit ~one carriageway apart, so end→opposite-start is a clean
  // physical U-turn. These are the only links out of a cul-de-sac tip (the ~180° turn is rejected as a normal
  // cross-link), and they guarantee every node keeps an out-edge.
  const nodeBase: number[] = []; let accumulated = 0;
  for (const lane of lanes) { nodeBase.push(accumulated); accumulated += lane.points.length; }
  for (let pair = 0; pair * 2 + 1 < lanes.length; pair++) {
    const laneA = lanes[pair * 2]!; const laneB = lanes[pair * 2 + 1]!;
    if (laneA.closed || laneB.closed) continue; // closed loops have no terminus
    const baseA = nodeBase[pair * 2]!; const baseB = nodeBase[pair * 2 + 1]!;
    const endA = baseA + laneA.points.length - 1; const endB = baseB + laneB.points.length - 1;
    addDirectedEdge(graph.edges, endA, baseB); // far end: arrive on A, U-turn onto B heading back
    addDirectedEdge(graph.edges, endB, baseA); // near end: arrive on B, U-turn onto A heading out
  }
  return bridgeIslands(graph);
}

/** Cell size for the signalised-junction spatial index (see City.signalStops). Comfortably larger than any
 *  junction's influence radius (widest/2 + SIGNAL_STOP_APPROACH), so buckets stay small. */
const SIGNAL_CELL = 48;
/** Width of the walkable sidewalk band beyond a road edge — a point this far off the tar reads as pavement. */
const SIDEWALK_BAND = SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH;
/** Sidewalk-point grid for ambient ped wander goals within ~500u of the ped — short, reachable A* solves.
 *  Crowd distribution is handled by the census bubble (cull-far/spawn-near), not by long wander hops. */
const WANDER_CELL = 120;
const WANDER_REACH_CELLS = 4;

const FACADE_RANGES: Record<BuildingStyle, [number, number]> = { downtown: [0, 6], residential: [6, 4], industrial: [10, 2], estate: [6, 4] };
const BUILDING_PALETTES: Record<BuildingStyle, number[]> = {
  downtown: [0x9db1ba, 0xa3563f, 0xd0c4a4, 0x99a4a9, 0x93a9b0],
  residential: [0xdfb094, 0x8f4f3a, 0xe6d1a2, 0xa8bcc4, 0xa3563f],
  industrial: [0xa2a6a2, 0xb5924c, 0xb5a28c],
  estate: [0xe3d7bf, 0xd8cdb6, 0xcbbfa0, 0xe6d1a2, 0xdcc9a6],
};

const GENERIC_AREA_NAMES = new Set(['park', 'grass', 'forest', 'wood', 'scrub', 'golf_course', 'nature_reserve', 'green', 'water', 'brownfield', 'mine_dump']);

export class City {
  group = new THREE.Group();
  /** Per-cell chunk groups on the MERGE_CHUNK_SIZE grid: every piece of static world geometry
   *  (merged meshes and per-cell instanced props) lives in one, so distance culling can detach it. */
  private chunkStore = new ChunkStore(this.group, MERGE_CHUNK_SIZE);
  private chunkCulling = new ChunkVisibility(this.chunkStore);
  /** Tighter second tier for street micro-detail (markings, curbs, potholes, tactile paving,
   *  furniture…): sub-pixel long before its 1200u range, so it culls far earlier than the world. */
  private detailStore = new ChunkStore(this.group, MERGE_CHUNK_SIZE);
  private detailCulling = new ChunkVisibility(this.detailStore, DETAIL_VISIBLE_RANGE, DETAIL_HYSTERESIS);
  /** On-demand building tier: buildings are GENERATED per cell as the player approaches (frame-budgeted)
   *  and their geometry disposed beyond the far radius — regenerable identically from CityGen's seeds. */
  private buildingStore = new ChunkStore(this.group, MERGE_CHUNK_SIZE);
  private buildingCells = new Map<string, THREE.Group>();
  private buildingColliderCells = new Set<string>();
  private buildQueue: Array<[number, number]> = [];
  private queuedCells = new Set<string>();
  /** The cell currently being baked, a few buildings at a time, across frames (spreads the cost). */
  private pending?: { key: string; cellX: number; cellZ: number; specs: GeneratedBuilding[]; index: number; models: ScatteredModel[]; modelIndex: number; baker: GeometryBaker; colliders: Collider[]; group: THREE.Group };
  /** Where the building meshes for the current build go (a per-building local group, rotated to face
   *  its street, then merged into the cell). Defaults to the root group for up-front geometry. */
  private target: THREE.Group = this.group;
  colliders: Collider[] = [];
  props = new PropRegistry();
  potholes: Array<{ x: number; z: number; r: number }> = []; // road features, not props: no collider, cars rattle over them
  roadPoints: RoadPoint[] = [];
  sidewalkPoints: RoadPoint[] = [];
  roadsidePoints: RoadsidePoint[] = [];
  /** Staggered streetlamp anchors, one every STREETLAMP_SPACING of road, alternating kerbs. Kept apart
   *  from the verge roadsidePoints so lamp pitch is set by arc length, not the coarser roadside stride. */
  streetlampPoints: RoadsidePoint[] = buildStreetlampPoints(ROAD_NETWORK);
  roadPaths: RoadPoint[][] = [];
  /** Sampled rail centrelines (world XZ) — the train system runs along these. */
  railPaths: RoadPoint[][] = [];
  trafficRoutes: RoadPoint[][] = [];
  private navPaths = buildCityNavPaths(ROAD_NETWORK);
  vehicleNav: NavGraph = buildVehicleNav(ROAD_NETWORK); // directed one-way lanes (left-hand); pedNav stays undirected
  pedNav: NavGraph = bridgeIslands(buildNavGraph(this.navPaths.walks, PED_NAV_JOIN));
  private roadSurfaces: Array<{ points: RoadPoint[]; width: number; closed: boolean }> = [];
  private roadIndex = new RoadIndex();
  /** Tight sibling used only while baking kerbs/paving. The general index keeps a 64u query halo for
   *  gameplay distance checks; probing that broad bucket millions of times during load is needless. */
  private roadClipIndex = new RoadIndex(36, 6);
  private signalCells?: Map<string, JunctionDefinition[]>; // lazily-built junction spatial index for signalStops
  private sidewalkGrid?: Map<string, RoadPoint[]>; // lazily-built sidewalk-point grid for local ped wander goals
  private colliderCells = new Map<string, number[]>();
  private colliderCellSize = 48;
  private collidersIndexed = 0;
  private buildingMaterial = new Map<string, THREE.MeshStandardMaterial>();
  private asphalt = createGeneratedSurfaceTexture('/textures/asphalt-gpt.jpg', 'asphalt', 1);
  private concrete = createGeneratedSurfaceTexture('/textures/concrete-gpt.jpg', 'concrete', 10);
  private sidewalk = createSidewalkTexture();
  // Default veld ground: the same dry turf as wild parks. Ground uses 0..1 plane UVs, so repeat = WORLD_SIZE/6
  // gives the same ~6u tile as the world-space park lawns. Macro-detiled in the shader, no wind on the open ground.
  private groundGrass = createGrassTexture('dry', WORLD_SIZE / 6);
  // Park/lawn turf tiles in WORLD space (draped park UVs are raw x,z), so repeat = 1/metres-per-tile — one tile
  // ~6u regardless of polygon size, giving consistent blade density everywhere. See buildParks.
  private grassLush = createGrassTexture('lush', 1 / 6);
  private farmSoil = createGrassTexture('soil', 1 / 6); // tilled-field earth for farmland polygons
  private grassWind?: { advance(dt: number): void };
  private sand = createSurfaceTexture('sand', 14);
  private facades = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeTexture(style));
  private facadeGlows = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeGlowTexture(style));
  private roofMaterial = new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, metalness: 0.08 });
  private waterSites: WaterSite[] = [];
  private waterHandle?: WaterHandle;
  private waterMood?: { hour: number; sun: THREE.Vector3; color: THREE.Color };
  private architecture: BuildingArchitecture;
  private infrastructure: UrbanInfrastructure;

  constructor(scene: THREE.Scene, quality: BaseQuality = 'medium') {
    this.group.name = 'Joburg'; scene.add(this.group);
    this.architecture = new BuildingArchitecture(this.group);
    ensureParcels(); // build the citywide parcel layout now (during load), not on the first frame
    ensureScatter(); // and the scattered structure/foliage layout (same on-demand streaming path)
    this.buildGround(); this.buildRoads(); this.buildWaterBodies(); this.buildCoast(); this.buildParks(); this.buildLandmarks();
    this.infrastructure = new UrbanInfrastructure(
      this.group,
      this.chunkStore,
      this.detailStore,
      this.roadsidePoints,
      this.streetlampPoints,
      (x, z, radius) => this.collides(x, z, radius) || this.isReserved(x, z, radius),
      (x, z, margin) => this.isOnRoad(x, z, margin),
      this.props,
      (x, z) => this.sidewalkHeightAt(x, z),
    );
    mergeStaticGeometry(this.group, MERGE_CHUNK_SIZE, this.chunkStore); // water is built after the merge: its meshes stay live for per-frame animation
    this.setWaterQuality(quality);
  }

  update(dt: number): void {
    this.waterHandle?.update(dt);
    this.infrastructure.update(dt);
    this.grassWind?.advance(dt);
  }

  /** True when an AI driver at (position, heading) should hold for a non-green robot at the signalised
   *  junction it is approaching. Only CITY_JUNCTIONS carry robots, and the check reads the same phase
   *  clock the lenses animate on, so drivers stop exactly when the light the player sees turns red. */
  signalStops(position: THREE.Vector3, heading: number): boolean {
    const clock = this.infrastructure.signalClock;
    // Grid lookup instead of scanning all ~3800 junctions per car per frame: each junction is bucketed into
    // every cell its influence radius touches, so the driver's single cell holds every robot that could stop it.
    const cells = (this.signalCells ??= this.buildSignalIndex());
    const bucket = cells.get(`${Math.floor(position.x / SIGNAL_CELL)},${Math.floor(position.z / SIGNAL_CELL)}`);
    if (!bucket) return false;
    for (const junction of bucket) {
      if (signalHoldsDriver(junction, position.x, position.z, heading, clock)) return true;
    }
    return false;
  }

  /** Graded version of signalStops for smooth deceleration: 1 = cruise, easing to 0 as the nearest robot on
   *  the driver's axis approaches its hold line (so drivers slow sooner instead of stopping dead at the box). */
  signalSlowFactor(position: THREE.Vector3, heading: number): number {
    const clock = this.infrastructure.signalClock;
    const cells = (this.signalCells ??= this.buildSignalIndex());
    const bucket = cells.get(`${Math.floor(position.x / SIGNAL_CELL)},${Math.floor(position.z / SIGNAL_CELL)}`);
    if (!bucket) return 1;
    let factor = 1;
    for (const junction of bucket) factor = Math.min(factor, signalSlowFactor(junction, position.x, position.z, heading, clock));
    return factor;
  }

  /** Buckets every signalised junction into the SIGNAL_CELL grid, padded by its influence radius
   *  (widest/2 + approach), so signalStops resolves with one cell lookup. Built once, lazily. */
  private buildSignalIndex(): Map<string, JunctionDefinition[]> {
    const cells = new Map<string, JunctionDefinition[]>();
    for (const junction of CITY_JUNCTIONS) {
      const reach = junction.widest / 2 + SIGNAL_STOP_APPROACH;
      const minX = Math.floor((junction.x - reach) / SIGNAL_CELL); const maxX = Math.floor((junction.x + reach) / SIGNAL_CELL);
      const minZ = Math.floor((junction.z - reach) / SIGNAL_CELL); const maxZ = Math.floor((junction.z + reach) / SIGNAL_CELL);
      for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
        const key = `${cx},${cz}`; const bucket = cells.get(key);
        if (bucket) bucket.push(junction); else cells.set(key, [junction]);
      }
    }
    return cells;
  }

  /** Frame-budgeted distance culling: chunks near the focus join the scene, far ones detach (with
   *  hysteresis). Geometry is kept in memory, so re-entering a chunk costs nothing. Colliders, nav
   *  graphs, the minimap and the map overlay are data, not scene geometry — culling never touches
   *  them. Water stays global: each surface is a bounded per-site mesh that frustum culling already
   *  handles, and the premium dams double as the always-visible distant-water representation.
   *  Model streaming can be held behind the required-asset loading gate while static chunks cull. */
  updateVisibility(focus: THREE.Vector3, streamModels = true): void {
    this.chunkCulling.update(focus.x, focus.z);
    this.detailCulling.update(focus.x, focus.z);
    if (streamModels) this.updateBuildingChunks(focus.x, focus.z);
  }

  /** (Re)builds every water surface for the given quality tier; safe to call live from the pause menu.
   *  The old handle disposes its geometries, materials, and the planar mirror's render target. */
  setWaterQuality(quality: BaseQuality): void {
    this.waterHandle?.dispose();
    this.waterHandle = createWater(this.waterSites, waterTier(quality));
    this.group.add(this.waterHandle.group);
    if (this.waterMood) this.waterHandle.setMood(this.waterMood.hour, this.waterMood.sun, this.waterMood.color);
  }

  /** Day/night hook: tints the water and aims its specular sun/moon; called from the same path that drives the sky. */
  setWaterMood(hour: number, sunDirection: THREE.Vector3, sunColor: THREE.Color): void {
    this.waterMood ??= { hour: 0, sun: new THREE.Vector3(), color: new THREE.Color() };
    this.waterMood.hour = hour; this.waterMood.sun.copy(sunDirection); this.waterMood.color.copy(sunColor);
    this.waterHandle?.setMood(hour, sunDirection, sunColor);
  }

  districtAt(x: number, z: number): District { return districtAt(x, z); }

  /** Shared facade materials (buildings are merged per material): the day/night cycle animates their emissiveIntensity for lit windows. */
  facadeMaterials(): THREE.MeshStandardMaterial[] { return [...this.buildingMaterial.values()]; }

  streetlightLampsXZ(): Float32Array { return this.infrastructure.lampsXZ; }

  setStreetlightGlow(factor: number): void { this.infrastructure.setLampGlow(factor); }

  isPark(x: number, z: number): boolean {
    return GREEN_POLYGONS.some((polygon) => pointInPolygon(polygon, x, z));
  }

  /** Anchor pads (spawn, shops, mission markers…) that procedural placement must keep clear. */
  isReserved(x: number, z: number, radius: number): boolean {
    return RESERVED_PADS.some((pad) => (pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2);
  }

  /** Ground-band test kept for peds/vehicles/nav: identical to the flat-world behaviour for anything rooted at street level. */
  collides(x: number, z: number, radius: number): boolean {
    if (Math.abs(x) > WORLD_SIZE / 2 - radius || Math.abs(z) > WORLD_SIZE / 2 - radius) return true;
    if (this.props.blocked(x, z, radius)) return true;
    return this.overlapsCollider(x, z, radius);
  }

  /** True 3D occupancy: world bounds, standing props and colliders whose vertical span crosses (y0, y1).
   *  The player's 3D physics goes through here; the linear collidersBlock is fine for the single player. */
  collidesAt(x: number, z: number, radius: number, y0: number, y1: number): boolean {
    if (Math.abs(x) > WORLD_SIZE / 2 - radius || Math.abs(z) > WORLD_SIZE / 2 - radius) return true;
    if (this.props.blockedBetween(x, z, radius, y0, y1, (px, pz) => this.surfaceHeightAt(px, pz))) return true;
    // Grid lookup, not a scan of the whole (append-only, ever-growing) collider list — otherwise the player's
    // per-frame clamp cost climbs with every cell ever visited and the framerate decays as you drive around.
    this.indexNewColliders();
    const bucket = this.colliderCells.get(`${Math.floor(x / this.colliderCellSize)},${Math.floor(z / this.colliderCellSize)}`);
    if (bucket) for (const index of bucket) {
      const box = this.colliders[index]!;
      if (colliderBase(box) < y1 && colliderTop(box) > y0 && colliderOverlapsXZ(box, x, z, radius)) return true;
    }
    return false;
  }

  /** Colliders are appended by shops/safehouses after construction: index incrementally on demand. */
  private indexNewColliders(): void {
    for (; this.collidersIndexed < this.colliders.length; this.collidersIndexed++) {
      const box = this.colliders[this.collidersIndexed]!;
      const pad = this.colliderCellSize / 2; // indexed into every cell it can affect: queries stay single-cell for radii up to half a cell
      const minX = Math.floor((box.minX - pad) / this.colliderCellSize); const maxX = Math.floor((box.maxX + pad) / this.colliderCellSize);
      const minZ = Math.floor((box.minZ - pad) / this.colliderCellSize); const maxZ = Math.floor((box.maxZ + pad) / this.colliderCellSize);
      for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
        const key = `${cx},${cz}`;
        const bucket = this.colliderCells.get(key);
        if (bucket) bucket.push(this.collidersIndexed); else this.colliderCells.set(key, [this.collidersIndexed]);
      }
    }
  }

  /** Fast ground-band occupancy for the many peds/vehicles/nav queries: the spatial grid keeps each
   *  query single-cell, and the y-span filter matches collides()'s (ground, ground+2) band so a
   *  floating setback tier over an open plaza doesn't block the street the way a podium wall does. */
  /** Cheap line-of-sight proxy: true when a building/wall collider straddles the straight ground line
   *  between two points. Buildings only — thin props are ignored, so it never falsely reports a spot in the
   *  open as hidden. Used to spawn ambient agents where a structure blocks the player's view of the spot. */
  sightBlocked(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax; const dz = bz - az; const dist = Math.hypot(dx, dz);
    if (dist < 2) return false;
    const steps = Math.min(160, Math.ceil(dist / 3)); // ~3u samples along the ray, capped for the far end of the spawn ring
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.overlapsCollider(ax + dx * t, az + dz * t, 0.4)) return true;
    }
    return false;
  }

  private overlapsCollider(x: number, z: number, radius: number): boolean {
    this.indexNewColliders();
    const ground = terrainHeightAt(x, z);
    const key = `${Math.floor(x / this.colliderCellSize)},${Math.floor(z / this.colliderCellSize)}`;
    for (const index of this.colliderCells.get(key) ?? []) {
      const box = this.colliders[index]!;
      if (colliderBase(box) < ground + 2 && colliderTop(box) > ground && colliderOverlapsXZ(box, x, z, radius)) return true;
    }
    return false;
  }

  clampMove(from: THREE.Vector3, desired: THREE.Vector3, radius: number): THREE.Vector3 {
    const output = desired.clone();
    if (this.collides(output.x, from.z, radius)) output.x = from.x;
    if (this.collides(output.x, output.z, radius)) output.z = from.z;
    return output;
  }

  /** Player-grade clamp: geometry blocks only where it crosses the capsule band above the step allowance,
   *  so a curb is walked up while a wall at head height still stops you — and a roof edge doesn't. */
  clampMoveAt(from: THREE.Vector3, desired: THREE.Vector3, radius: number, height = PLAYER.height): THREE.Vector3 {
    const y0 = from.y + PLAYER.stepUp; const y1 = from.y + height;
    const output = desired.clone();
    if (this.collidesAt(output.x, from.z, radius, y0, y1)) output.x = from.x;
    if (this.collidesAt(output.x, output.z, radius, y0, y1)) output.z = from.z;
    return output;
  }

  /** Highest standable surface whose top sits at or below feetY + stepUp: stacked building tiers, containers
   *  and flat-topped props, falling back to the walkable ground. Feeds the player's landing/edge physics. */
  supportHeight(x: number, z: number, feetY: number, radius = 0.35): number {
    // Grid lookup for the same reason as collidesAt: the player calls this every frame and the collider
    // list only grows, so a full scan makes the framerate decay the longer you play.
    this.indexNewColliders();
    const limit = feetY + PLAYER.stepUp; let best = -Infinity;
    const bucket = this.colliderCells.get(`${Math.floor(x / this.colliderCellSize)},${Math.floor(z / this.colliderCellSize)}`);
    if (bucket) for (const index of bucket) {
      const box = this.colliders[index]!;
      if (!colliderOverlapsXZ(box, x, z, radius)) continue;
      const top = colliderTop(box);
      if (top <= limit && top > best) best = top;
    }
    const propTop = this.props.supportTop(x, z, radius, feetY + PLAYER.stepUp, (px, pz) => this.surfaceHeightAt(px, pz));
    return Math.max(this.surfaceHeightAt(x, z), best, propTop ?? -Infinity);
  }

  terrainHeightAt(x: number, z: number): number { return terrainHeightAt(x, z); }

  roadHeightAt(x: number, z: number): number { return terrainHeightAt(x, z) + ROAD_SURFACE_OFFSET; }

  sidewalkHeightAt(x: number, z: number): number { return terrainHeightAt(x, z) + ROAD_SURFACE_OFFSET + SIDEWALK_RISE; }

  isOnSidewalk(x: number, z: number): boolean {
    // Grid lookup instead of scanning ~4000 road polylines every ped/frame: edgeDistance already subtracts each
    // segment's half-width, so "beyond the tar but within the sidewalk band" is a single grid query.
    const edge = this.roadIndex.edgeDistance(x, z);
    return edge > 0 && edge <= SIDEWALK_BAND;
  }

  /** A random sidewalk point within ~400u of (x, z), for local ped wander goals — keeps each A* solve short
   *  and reachable instead of routing citywide. Widens the search if the immediate area has no sidewalk, and
   *  returns undefined only when the map has none anywhere near (caller falls back to its own choice list). */
  wanderTarget(x: number, z: number, rng: () => number = Math.random): RoadPoint | undefined {
    const grid = (this.sidewalkGrid ??= this.buildSidewalkGrid());
    const cx = Math.floor(x / WANDER_CELL); const cz = Math.floor(z / WANDER_CELL);
    for (let reach = WANDER_REACH_CELLS; reach <= WANDER_REACH_CELLS + 8; reach++) {
      const candidates: RoadPoint[] = [];
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        const bucket = grid.get(`${cx + dx},${cz + dz}`); if (bucket) candidates.push(...bucket);
      }
      if (candidates.length) return candidates[Math.floor(rng() * candidates.length)];
    }
    return undefined;
  }

  private buildSidewalkGrid(): Map<string, RoadPoint[]> {
    const grid = new Map<string, RoadPoint[]>();
    for (const point of this.sidewalkPoints) {
      const key = `${Math.floor(point.x / WANDER_CELL)},${Math.floor(point.z / WANDER_CELL)}`;
      const bucket = grid.get(key); if (bucket) bucket.push(point); else grid.set(key, [point]);
    }
    return grid;
  }

  surfaceHeightAt(x: number, z: number, preferred: SurfaceKind = 'auto'): number {
    if (preferred === 'terrain') return this.terrainHeightAt(x, z);
    if (preferred === 'road') return this.roadHeightAt(x, z);
    if (preferred === 'sidewalk') return this.sidewalkHeightAt(x, z);
    if (this.isOnRoad(x, z)) return this.roadHeightAt(x, z);
    if (this.isOnSidewalk(x, z)) return this.sidewalkHeightAt(x, z);
    // Generated parks are near-flat GREEN_POLYGON lawns (buildParks); no raised-planter offset here.
    return this.terrainHeightAt(x, z);
  }

  surfaceNormalAt(x: number, z: number, preferred: SurfaceKind = 'auto', sample = 1.5): THREE.Vector3 {
    const left = this.surfaceHeightAt(x - sample, z, preferred); const right = this.surfaceHeightAt(x + sample, z, preferred);
    const back = this.surfaceHeightAt(x, z - sample, preferred); const front = this.surfaceHeightAt(x, z + sample, preferred);
    return new THREE.Vector3(left - right, sample * 2, back - front).normalize();
  }

  private surfaceSegmentQuaternion(startX: number, startZ: number, endX: number, endZ: number, surface: SurfaceKind): THREE.Quaternion {
    const forward = new THREE.Vector3(endX - startX, this.surfaceHeightAt(endX, endZ, surface) - this.surfaceHeightAt(startX, startZ, surface), endZ - startZ).normalize();
    const normal = this.surfaceNormalAt((startX + endX) / 2, (startZ + endZ) / 2, surface);
    const right = new THREE.Vector3().crossVectors(normal, forward).normalize(); const up = new THREE.Vector3().crossVectors(forward, right).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward));
  }

  private buildGround(): void {
    // A tessellated grass sheet displaced by the heightgrid — the relief every wired system samples via
    // terrainHeightAt. Segment pitch (~70u at 256) oversamples the ~140u heightgrid cells for smooth slopes.
    // Flagged `far` so it never culls: the always-visible earth that carries to the horizon behind the fog.
    const SEGMENTS = 256;
    const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2); // into the XZ plane, +Y up — vertex (x, 0, z) now maps straight to world XZ
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const n = SEGMENTS + 1; const step = WORLD_SIZE / SEGMENTS; const min = -WORLD_SIZE / 2;
    const grid = new Float32Array(n * n); // captured vertex heights → the shared physics/placement surface
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const z = pos.getZ(i);
      let y = analyticTerrainHeightAt(x, z);
      if (this.inWater(x, z)) y -= WATER_BASIN_DEPTH; // sink inland dam/pond beds below their water surface
      pos.setY(i, y);
      grid[Math.round((z - min) / step) * n + Math.round((x - min) / step)] = y;
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals(); // real normals so slopes catch the light instead of reading flat
    setTerrainGrid(grid, n, step); // from here, terrainHeightAt returns this exact drawn surface
    const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.groundGrass, roughness: 0.96 }));
    ground.receiveShadow = true;
    ground.userData.far = true;
    this.group.add(ground);
  }

  private buildRoads(): void {
    const roadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.asphalt, roughness: 0.9, metalness: 0.02 });
    const centerMat = new THREE.MeshStandardMaterial({ color: 0xe7c564, roughness: 0.74 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xdedbc9, roughness: 0.8 });
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xf0eee5, map: this.sidewalk, roughness: 0.96, metalness: 0 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xd5d1c4, map: this.concrete, roughness: 0.9 });
    const gutterMat = new THREE.MeshStandardMaterial({ color: 0x4b504d, roughness: 0.96 });
    const dirtMat = new THREE.MeshStandardMaterial({ color: 0x7a6547, map: this.sand, roughness: 0.98 });
    const dashTransforms: THREE.Matrix4[] = []; const edgeTransforms: THREE.Matrix4[] = [];

    // Geometry is deliberately two-pass.  Previously each sidewalk was emitted as its road entered the
    // index, so it could not see roads processed later and long raised triangles bridged straight across
    // them.  Index every paved road and track first; the render pass can then clip against the complete city.
    const paved = ROAD_NETWORK.map((definition) => {
      const closed = definition.closed ?? false;
      const sampled = this.samplePath(definition.points, closed, ROAD_SAMPLE_SPACING);
      const surface = this.roadSurfaces.length;
      this.roadIndex.addSurface(sampled, definition.width, surface);
      this.roadClipIndex.addSurface(sampled, definition.width, surface);
      this.roadSurfaces.push({ points: sampled, width: definition.width, closed });
      return { definition, closed, sampled, surface };
    });
    const tracks = TRACK_NETWORK.map((definition) => {
      const sampled = this.samplePath(definition.points, false, ROAD_SAMPLE_SPACING);
      const surface = this.roadSurfaces.length;
      this.roadIndex.addSurface(sampled, definition.width, surface);
      this.roadClipIndex.addSurface(sampled, definition.width, surface);
      this.roadSurfaces.push({ points: sampled, width: definition.width, closed: false });
      return { definition, sampled };
    });

    for (const { definition, closed, sampled, surface } of paved) {
      const mapPath = sampled.map((point) => ({ ...point }));
      if (closed && mapPath[0]) mapPath.push({ ...mapPath[0] });
      this.roadPaths.push(mapPath);
      const leftLane = this.offsetPath(sampled, -definition.width * 0.23, closed);
      const rightLane = this.offsetPath(sampled, definition.width * 0.23, closed).reverse();
      this.trafficRoutes.push(leftLane, rightLane);
      this.roadPoints.push(...leftLane, ...rightLane);
      const leftWalk = this.offsetPath(sampled, -(definition.width / 2 + SIDEWALK_CENTER), closed);
      const rightWalk = this.offsetPath(sampled, definition.width / 2 + SIDEWALK_CENTER, closed);
      // Raised, panelled sidewalks are clipped against every OTHER road surface.  The owning road is
      // excluded, allowing the paving to hug its kerb while ending cleanly at crossing carriageways.
      for (const walk of [leftWalk, rightWalk]) {
        const sidewalk = this.createClippedSidewalkStrip(walk, surface, sidewalkMat, closed);
        sidewalk.receiveShadow = true; this.group.add(sidewalk);
      }
      const road = this.createRoadStrip(sampled, definition.width, roadMat, ROAD_SURFACE_OFFSET, closed); road.receiveShadow = true; road.name = definition.name; this.group.add(road);
      // Markings only on the wider carriageways: the generated map has many 6u lanes that read better bare.
      if (definition.width >= 9) this.addRoadMarkings(sampled, definition.width, closed, dashTransforms, definition.width >= 11 ? edgeTransforms : undefined);
      this.sidewalkPoints.push(...leftWalk.filter((_, index) => index % 2 === 0), ...rightWalk.filter((_, index) => index % 2 === 0));
      this.addRoadsidePoints(sampled, definition.width, closed);
    }
    // Off-road dirt tracks: narrow unpaved strips — no markings, sidewalks, curbs or nav lanes.
    for (const { definition, sampled } of tracks) {
      const strip = this.createRoadStrip(sampled, definition.width, dirtMat, 0.04, false); strip.receiveShadow = true; this.group.add(strip);
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addInstanced(box, centerMat, dashTransforms, {});
    this.addInstanced(box, edgeMat, edgeTransforms, {});
    const curbTransforms: THREE.Matrix4[] = []; const gutterTransforms: THREE.Matrix4[] = [];
    for (let index = 0; index < ROAD_NETWORK.length; index++) {
      const surface = this.roadSurfaces[index]!;
      this.addCurbs(surface.points, surface.width, surface.closed, index, curbTransforms, gutterTransforms);
    }
    this.buildJunctionSidewalks(sidewalkMat, curbTransforms, gutterTransforms); // corner tiles + kerb/gutter wraps join the instanced runs below
    this.addInstanced(box, curbMat, curbTransforms, { cast: true, receive: true });
    this.addInstanced(box, gutterMat, gutterTransforms, { receive: true });
    this.buildJunctionSurfaces(roadMat);
    this.buildStopLines();
    this.buildIntersections();
    this.buildPotholes();
    this.buildRailways();
  }

  /** Passenger rail: a draped ballast strip with instanced sleepers and twin rails. Level crossings
   *  come free — the rail bed rides just above the tar where a line crosses a carriageway. */
  private buildRailways(): void {
    if (RAILWAY_NETWORK.length === 0) return;
    const ballastMat = new THREE.MeshStandardMaterial({ color: 0x6b625a, map: this.sand, roughness: 0.98 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.42, metalness: 0.6 });
    const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x453527, roughness: 0.95 });
    const railTransforms: THREE.Matrix4[] = []; const sleeperTransforms: THREE.Matrix4[] = [];
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion();
    const RAIL_PITCH = 12; // chord length for the rail boxes: follows the relief without instance spam
    for (const line of RAILWAY_NETWORK) {
      const sampled = this.samplePath(line.points, false, ROAD_SAMPLE_SPACING);
      const ballast = this.createRoadStrip(sampled, RAIL_BALLAST_WIDTH, ballastMat, 0.045, false);
      ballast.receiveShadow = true; this.group.add(ballast);
      this.railPaths.push(sampled.map((point) => ({ ...point })));
      const chords = this.densifyPath(sampled, RAIL_PITCH, false);
      for (let index = 0; index < chords.length - 1; index++) {
        const start = chords[index]; const end = chords[index + 1]; if (!start || !end) continue;
        const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz);
        if (length < 0.5) continue;
        const normalX = -dz / length; const normalZ = dx / length;
        quaternion.copy(this.surfaceSegmentQuaternion(start.x, start.z, end.x, end.z, 'terrain'));
        const midX = (start.x + end.x) / 2; const midZ = (start.z + end.z) / 2;
        for (const side of [-1, 1]) {
          const x = midX + normalX * side * (RAIL_GAUGE / 2); const z = midZ + normalZ * side * (RAIL_GAUGE / 2);
          matrix.compose(new THREE.Vector3(x, this.terrainHeightAt(x, z) + 0.16, z), quaternion, new THREE.Vector3(0.16, 0.14, length + 0.3));
          railTransforms.push(matrix.clone());
        }
        const sleepers = Math.max(1, Math.round(length / 2.6));
        for (let s = 0; s < sleepers; s++) {
          const t = (s + 0.5) / sleepers;
          const x = start.x + dx * t; const z = start.z + dz * t;
          matrix.compose(new THREE.Vector3(x, this.terrainHeightAt(x, z) + 0.075, z), quaternion, new THREE.Vector3(2.4, 0.07, 0.55));
          sleeperTransforms.push(matrix.clone());
        }
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addInstanced(box, railMat, railTransforms, { receive: true });
    this.addInstanced(box, sleeperMat, sleeperTransforms, { receive: true });
  }

  /** Paves every real crossing (T / cross / multi-way) with a filled asphalt disc laid just over the
   *  carriageways, unifying the overlapping ribbons into one clean surface and burying the z-fight
   *  seams that made 4-ways read as an "X of two planes". Uses the SAME asphalt material as the roads,
   *  so mergeStaticGeometry folds these into the existing per-cell road buckets — no extra draw calls,
   *  just triangles that cull with their chunk. Sizing + placement are map-derived and deterministic. */
  private buildJunctionSurfaces(roadMat: THREE.Material): void {
    const lift = ROAD_SURFACE_OFFSET + 0.012; // above the ribbons (buries the seam) but below dashes (~0.088) and zebra (0.09)
    const parts: THREE.BufferGeometry[] = [];
    // Arm strips pave each carriageway across the node; a central disc unifies the rounded middle. Both are
    // tessellated and DRAPED onto the terrain (not laid flat at the node's centre) so the crossing stays glued
    // to sloped ground. They overlap by design, so once draped they'd be near-coplanar and z-fight — stagger
    // each part by a hair of extra lift (arms first, disc on top) so the top surface always wins cleanly.
    const STAGGER = 0.004; // per-layer depth separation, tiny enough to stay under the dash/zebra markings
    for (const surface of JUNCTION_SURFACES) {
      const reach = junctionReach(surface); // half-length of each arm strip: spans past the far kerb of the widest road
      let layer = 0;
      for (const arm of surface.arms) {
        const strip = new THREE.PlaneGeometry(arm.width, reach * 2, 2, Math.max(2, Math.ceil(reach * 2 / ROAD_STRIP_SUBSTEP)));
        strip.rotateX(-Math.PI / 2); strip.rotateY(Math.atan2(arm.dirX, arm.dirZ)); // align the strip's length with the carriageway
        strip.translate(surface.x, 0, surface.z); this.drapeGeometryToTerrain(strip, lift + layer * STAGGER); parts.push(strip); layer++;
      }
      const disc = new THREE.CircleGeometry(surface.radius, 24); // on top of the arms so the centre reads as one clean surface
      disc.rotateX(-Math.PI / 2); disc.translate(surface.x, 0, surface.z); this.drapeGeometryToTerrain(disc, lift + layer * STAGGER); parts.push(disc);
    }
    const merged = parts.length ? mergeGeometries(parts, false) : null;
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, roadMat); mesh.receiveShadow = true; this.group.add(mesh);
  }

  /** Outer-corner footpath at a two-road bend (degree-2 junction of two different roads). Each road's strip
   *  stops with a square cut at its road's end, leaving an L-shaped hole on the OUTSIDE of the bend (the
   *  inside is covered by the strips overlapping). Fill it with three pieces in the strips' own band frame:
   *  a continuation of each road's band from its strip end to the other band's edge (two side bits, which
   *  also carry that road's kerb + gutter around the corner), plus the corner square where the two bands
   *  cross (no gutter). Same tile scale and grain as the strips; terrain-draped a hair above them. */
  private buildJunctionSidewalks(material: THREE.Material, curbTransforms: THREE.Matrix4[], gutterTransforms: THREE.Matrix4[]): void {
    const parts: THREE.BufferGeometry[] = [];
    const quaternion = new THREE.Quaternion(); const matrix = new THREE.Matrix4();
    const armOf = (arm: { dirX: number; dirZ: number; width: number }): { dx: number; dz: number; w: number; ang: number } =>
      ({ dx: arm.dirX, dz: arm.dirZ, w: arm.width, ang: Math.atan2(arm.dirZ, arm.dirX) });
    for (const surface of JUNCTION_SURFACES) {
      if (surface.degree !== 2 || surface.outwardArms.length !== 2) continue; // bends only: both roads END here
      let a = armOf(surface.outwardArms[0]!); let b = armOf(surface.outwardArms[1]!);
      let sector = b.ang - a.ang; if (sector < 0) sector += Math.PI * 2;
      if (sector >= Math.PI) { const swap = a; a = b; b = swap; sector = Math.PI * 2 - sector; } // a→b CCW spans the bend's INSIDE
      if (sector < 0.35 || sector > Math.PI - 0.08) continue; // hairpins/straights leave no usable outer corner
      // Band frame on the OUTER side: nA/nB are each road's sidewalk normals pointing away from the inside.
      // Coordinates (sA, sB) = signed distance from the node past each road's kerb side; lines of constant
      // sA/sB run parallel to the respective road, so every edge below is parallel or square to a road.
      const nax = a.dz; const naz = -a.dx; const nbx = -b.dz; const nbz = b.dx;
      const det = nax * nbz - naz * nbx; if (Math.abs(det) < 1e-3) continue;
      const jna = surface.x * nax + surface.z * naz; const jnb = surface.x * nbx + surface.z * nbz;
      const at = (sa: number, sb: number): [number, number] =>
        [((jna + sa) * nbz - naz * (jnb + sb)) / det, (nax * (jnb + sb) - (jna + sa) * nbx) / det];
      const kappa = -Math.cos(sector); // nA·nB: where each strip's square end-cut sits in the other band's coordinate
      const inA = a.w / 2 + SIDEWALK_INNER_EDGE; const outA = inA + SIDEWALK_WIDTH;
      const inB = b.w / 2 + SIDEWALK_INNER_EDGE; const outB = inB + SIDEWALK_WIDTH;
      const positions: number[] = []; const uvs: number[] = []; const indices: number[] = [];
      /** One flat piece from 4 (sA,sB) corners in cyclic order, UV-mapped in the given road's strip frame. */
      const piece = (corners: Array<[number, number]>, road: { dx: number; dz: number }, nx: number, nz: number, inner: number): void => {
        const world = corners.map(([sa, sb]) => at(sa, sb));
        const [x0, z0] = world[0]!; const [x1, z1] = world[1]!; const [x2, z2] = world[2]!;
        if ((x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0) > 0) world.reverse(); // wind the face upward
        const base = positions.length / 3;
        for (const [x, z] of world) {
          const along = (x - surface.x) * road.dx + (z - surface.z) * road.dz;
          const perp = (x - surface.x) * nx + (z - surface.z) * nz;
          positions.push(x, this.sidewalkHeightAt(x, z) + 0.003, z);
          uvs.push((perp - inner) / SIDEWALK_WIDTH, along / SIDEWALK_UV_LENGTH); // the road's own strip tiling
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      };
      piece([[inA, inB], [outA, inB], [outA, outB], [inA, outB]], a, nax, naz, inA); // corner square (no gutter)
      // Side bits: each road's band continued from its strip's square end-cut (the line sB = κ·sA for road A)
      // out to where the corner square starts. Flush with the strip on one side and the square on the other.
      if (kappa * outA < inB - 0.05) piece([[inA, kappa * inA], [outA, kappa * outA], [outA, inB], [inA, inB]], a, nax, naz, inA);
      if (kappa * outB < inA - 0.05) piece([[kappa * inB, inB], [inA, inB], [inA, outB], [kappa * outB, outB]], b, nbx, nbz, inB);
      // Carry each road's kerb + gutter around the outer corner so the road edge reads continuous: from the
      // square end of its own run to the far face of the other road's kerb (gutter: to the other gutter line).
      const bar = (from: [number, number], to: [number, number], width: number, height: number, lift: number, out: THREE.Matrix4[]): void => {
        const [x0, z0] = from; const [x1, z1] = to;
        const span = Math.hypot(x1 - x0, z1 - z0); if (span < 0.12) return;
        const mx = (x0 + x1) / 2; const mz = (z0 + z1) / 2;
        quaternion.copy(this.surfaceSegmentQuaternion(x0, z0, x1, z1, 'road'));
        matrix.compose(new THREE.Vector3(mx, this.roadHeightAt(mx, mz) + lift, mz), quaternion, new THREE.Vector3(width, height, span));
        out.push(matrix.clone());
      };
      const kerbA = a.w / 2 + 0.22; const kerbB = b.w / 2 + 0.22;
      if (kappa * kerbA < b.w / 2 + 0.31) bar(at(kerbA, kappa * kerbA), at(kerbA, b.w / 2 + 0.41), 0.38, SIDEWALK_RISE, SIDEWALK_RISE / 2, curbTransforms);
      if (kappa * kerbB < a.w / 2 + 0.31) bar(at(kappa * kerbB, kerbB), at(a.w / 2 + 0.41, kerbB), 0.38, SIDEWALK_RISE, SIDEWALK_RISE / 2, curbTransforms);
      const gutA = a.w / 2 - 0.11; const gutB = b.w / 2 - 0.11;
      // Gutter wraps ride slightly higher than the road-run gutters so they draw on top of the junction paving.
      if (kappa * gutA < b.w / 2 - 0.1) bar(at(gutA, kappa * gutA), at(gutA, b.w / 2), 0.22, 0.018, 0.03, gutterTransforms);
      if (kappa * gutB < a.w / 2 - 0.1) bar(at(kappa * gutB, gutB), at(a.w / 2, gutB), 0.22, 0.018, 0.03, gutterTransforms);
      if (!indices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      parts.push(geometry);
    }
    const merged = parts.length ? mergeGeometries(parts, false) : null;
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, material); mesh.receiveShadow = true; this.group.add(mesh);
  }

  /** Push every vertex of an already-XZ-placed geometry onto the terrain (+ lift), so a flat paved shape
   *  drapes over the relief. Recomputes normals for correct lighting on the new slopes. */
  private drapeGeometryToTerrain(geometry: THREE.BufferGeometry, lift: number): void {
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeightAt(pos.getX(i), pos.getZ(i)) + lift);
    pos.needsUpdate = true; geometry.computeVertexNormals();
  }

  /** SA-style intersection stop bars: a solid transverse white line across each STOPPING approach, set just
   *  outside the paved junction mouth and spanning the inbound half of the carriageway (left-hand traffic, so
   *  the near lane is offset to the -dz,+dx side of the outward bearing). Which approaches stop is decided by
   *  road hierarchy in computeStopLines — the continuous main road at an uncontrolled T gets none. Same paint
   *  as the zebra crossings, merged into one mesh so mergeStaticGeometry folds it into the chunked buckets. */
  private buildStopLines(): void {
    const paint = new THREE.MeshStandardMaterial({ color: 0xe9e6d6, roughness: 0.78 });
    const lift = ROAD_SURFACE_OFFSET + 0.035; // marking layer: above the junction disc (0.067) and dashes
    const bars: THREE.BufferGeometry[] = [];
    for (const surface of JUNCTION_SURFACES) {
      const setback = junctionReach(surface) + STOP_LINE_DEPTH / 2 + 0.5; // clear of the paved junction, at the approach mouth
      for (const line of surface.stopLines) {
        const half = line.width / 2; // paint only the inbound lane(s) — the near half of the carriageway
        const cx = surface.x + line.dirX * setback + -line.dirZ * (line.width / 4);
        const cz = surface.z + line.dirZ * setback + line.dirX * (line.width / 4);
        const bar = new THREE.BoxGeometry(half, 0.02, STOP_LINE_DEPTH); // x spans the lane, z is the bar's thickness
        bar.rotateY(Math.atan2(line.dirX, line.dirZ)); // local +z onto the road bearing, +x across it
        bar.translate(cx, terrainHeightAt(cx, cz) + lift, cz);
        bars.push(bar);
      }
    }
    const merged = bars.length ? mergeGeometries(bars, false) : null;
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, paint); mesh.receiveShadow = true; this.group.add(mesh);
  }

  private buildPotholes(): void {
    for (const point of this.roadPoints) {
      if (seeded(point.x, point.z, 55) <= 0.96) continue;
      const x = point.x + (seeded(point.x, point.z, 56) - 0.5) * 3;
      const z = point.z + (seeded(point.x, point.z, 57) - 0.5) * 3;
      if (!this.isOnRoad(x, z, -2)) continue;
      if (CITY_JUNCTIONS.some((junction) => Math.hypot(x - junction.x, z - junction.z) < 16)) continue;
      this.potholes.push({ x, z, r: 1.1 + seeded(point.x, point.z, 58) * 0.9 });
    }
    // Each pothole is DRAPED onto the road surface (every vertex sampled at roadHeightAt) rather than a flat
    // disc laid at its centre's height — so on a slope, or across a crease where the tar steps to a steeper
    // pitch, it hugs the surface instead of the road rising up and swallowing half of it. Double-sided so
    // winding never culls them; merged into two meshes so they fold into the chunked road buckets.
    const holeParts: THREE.BufferGeometry[] = []; const rimParts: THREE.BufferGeometry[] = [];
    for (const pothole of this.potholes) {
      holeParts.push(this.drapedPotholeDisc(pothole.x, pothole.z, pothole.r, 0.03));
      rimParts.push(this.drapedPotholeRing(pothole.x, pothole.z, pothole.r, pothole.r * 1.22, 0.036));
    }
    if (!holeParts.length) return;
    const holeMesh = new THREE.Mesh(mergeGeometries(holeParts, false), new THREE.MeshBasicMaterial({ color: 0x0d1113, side: THREE.DoubleSide }));
    const rimMesh = new THREE.Mesh(mergeGeometries(rimParts, false), new THREE.MeshBasicMaterial({ color: 0x3f4649, side: THREE.DoubleSide }));
    this.group.add(holeMesh, rimMesh);
  }

  /** A pothole's dark disc, tessellated (centre + two radial rings × 14) and draped onto the road so it
   *  follows slopes and crease transitions instead of a flat plane the tar swallows. */
  private drapedPotholeDisc(cx: number, cz: number, r: number, lift: number): THREE.BufferGeometry {
    const SEG = 14;
    const positions: number[] = [cx, this.roadHeightAt(cx, cz) + lift, cz]; // centre = index 0
    for (const rad of [r * 0.55, r]) for (let s = 0; s < SEG; s++) {
      const ang = (s / SEG) * Math.PI * 2; const x = cx + Math.cos(ang) * rad; const z = cz + Math.sin(ang) * rad;
      positions.push(x, this.roadHeightAt(x, z) + lift, z);
    }
    const indices: number[] = [];
    for (let s = 0; s < SEG; s++) { const s1 = (s + 1) % SEG; indices.push(0, 1 + s, 1 + s1); } // centre fan to the inner ring
    for (let s = 0; s < SEG; s++) { const s1 = (s + 1) % SEG; const a = 1 + s; const b = 1 + s1; const c = 1 + SEG + s; const d = 1 + SEG + s1; indices.push(a, c, b, b, c, d); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
    return geometry;
  }

  /** A pothole's grey rim ring, draped onto the road like the disc. */
  private drapedPotholeRing(cx: number, cz: number, rIn: number, rOut: number, lift: number): THREE.BufferGeometry {
    const SEG = 14; const positions: number[] = []; const indices: number[] = [];
    for (let s = 0; s < SEG; s++) {
      const ang = (s / SEG) * Math.PI * 2; const c = Math.cos(ang); const sn = Math.sin(ang);
      for (const rad of [rIn, rOut]) { const x = cx + c * rad; const z = cz + sn * rad; positions.push(x, this.roadHeightAt(x, z) + lift, z); }
    }
    for (let s = 0; s < SEG; s++) { const s1 = (s + 1) % SEG; const a = s * 2; const b = s * 2 + 1; const c = s1 * 2; const d = s1 * 2 + 1; indices.push(a, c, b, b, c, d); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
    return geometry;
  }

  /** Instanced street micro-detail, re-bucketed into one InstancedMesh per detail-tier cell
   *  (position read from each transform) so the short-range culling tier can drop far cells
   *  instead of vertex-shading the whole map. */
  private addInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, transforms: THREE.Matrix4[], shadows: { cast?: boolean; receive?: boolean }): void {
    const items: InstanceItem[] = transforms.map((matrix) => ({ x: matrix.elements[12]!, z: matrix.elements[14]!, matrix }));
    addInstancedChunks(this.detailStore, geometry, material, items, shadows);
  }

  private buildIntersections(): void {
    const paint = new THREE.MeshStandardMaterial({ color: 0xe9e6d6, roughness: 0.78 });
    for (const { x, z, angle, widest } of CITY_JUNCTIONS) {
      const span = widest / 2 + 2.5;
      for (let stripe = -span; stripe <= span; stripe += 2.5) {
        const px = x + Math.cos(angle) * stripe; const pz = z - Math.sin(angle) * stripe;
        const crossing = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.025, Math.min(6.2, widest * 0.45)), paint);
        crossing.position.set(px, terrainHeightAt(px, pz) + 0.09, pz); crossing.rotation.y = angle; this.group.add(crossing);
      }
    }
    this.buildTactileCorners();
  }

  isOnRoad(x: number, z: number, margin = 0): boolean {
    return this.roadIndex.onRoad(x, z, margin);
  }

  /** Distance beyond the nearest road edge — negative on the tar, capped at the index reach. */
  roadEdgeDistance(x: number, z: number): number {
    return this.roadIndex.edgeDistance(x, z);
  }

  nearestRoadPose(position: THREE.Vector3): RoadPose {
    let bestRoute = this.trafficRoutes[0] ?? []; let bestIndex = 0; let bestDistance = Infinity;
    for (const route of this.trafficRoutes) for (let index = 0; index < route.length; index++) {
      const point = route[index]; if (!point) continue; const distance = (point.x - position.x) ** 2 + (point.z - position.z) ** 2;
      if (distance < bestDistance) { bestDistance = distance; bestRoute = route; bestIndex = index; }
    }
    const point = bestRoute[bestIndex] ?? { x: 0, z: 0 }; const next = bestRoute[Math.min(bestIndex + 1, bestRoute.length - 1)] ?? bestRoute[Math.max(0, bestIndex - 1)] ?? point;
    return { position: new THREE.Vector3(point.x, this.roadHeightAt(point.x, point.z), point.z), heading: Math.atan2(next.x - point.x, next.z - point.z) };
  }

  roadPoseAwayFrom(position: THREE.Vector3, minimum: number, maximum: number): RoadPose {
    const candidates = this.roadPoints.filter((point) => { const distance = Math.hypot(point.x - position.x, point.z - position.z); return distance >= minimum && distance <= maximum; });
    const point = candidates[Math.floor(Math.random() * candidates.length)] ?? this.roadPoints[0] ?? { x: 0, z: 0 };
    return this.nearestRoadPose(new THREE.Vector3(point.x, 0, point.z));
  }

  private samplePath(points: RoadPoint[], closed: boolean, spacing: number): RoadPoint[] { return sampleRoadPath(points, closed, spacing); }

  private offsetPath(points: RoadPoint[], offset: number, closed: boolean): RoadPoint[] { return offsetRoadPath(points, offset, closed); }

  private addRoadsidePoints(points: RoadPoint[], width: number, closed: boolean): void {
    for (const side of [-1, 1] as const) {
      const offset = side * (width / 2 + 3.05); const path = this.offsetPath(points, offset, closed);
      path.forEach((point, index) => {
        if (index % 2 !== 0) return;
        const previous = points[index === 0 ? (closed ? points.length - 1 : 0) : index - 1] ?? points[index] ?? point;
        const next = points[index === points.length - 1 ? (closed ? 0 : points.length - 1) : index + 1] ?? points[index] ?? point;
        const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
        const normalX = -dz / length; const normalZ = dx / length;
        this.roadsidePoints.push({ x: point.x, z: point.z, inwardX: -normalX * side, inwardZ: -normalZ * side, width });
      });
    }
  }

  private addCurbs(rawPoints: RoadPoint[], width: number, closed: boolean, surface: number, transforms: THREE.Matrix4[], gutters: THREE.Matrix4[]): void {
    // Re-tessellate to the road-strip pitch so the kerb hugs the road's curve (short chords, not 36u nav
    // segments cutting the corner) and each kerb box is short enough to follow the relief without jutting.
    const points = this.densifyPath(rawPoints, ROAD_STRIP_SUBSTEP, closed);
    const segmentCount = closed ? points.length : points.length - 1;
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion();
    for (let index = 0; index < segmentCount; index++) {
      const start = points[index]; const end = points[(index + 1) % points.length]; if (!start || !end) continue;
      const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz); if (length < 0.5) continue;
      const normalX = -dz / length; const normalZ = dx / length;
      for (const side of [-1, 1]) {
        const offset = side * (width / 2 + 0.22);
        const intervals = clearPathIntervals(length, (distance) => {
          const t = distance / length;
          const x = THREE.MathUtils.lerp(start.x, end.x, t) + normalX * offset;
          const z = THREE.MathUtils.lerp(start.z, end.z, t) + normalZ * offset;
          return this.roadClipIndex.onRoad(x, z, 0.12, surface);
        });
        for (const [from, to] of intervals) {
          const span = to - from; if (span < 0.1) continue;
          const middle = (from + to) / 2; const t0 = from / length; const t1 = to / length;
          const x = start.x + dx * middle / length + normalX * offset;
          const z = start.z + dz * middle / length + normalZ * offset;
          const ax = THREE.MathUtils.lerp(start.x, end.x, t0) + normalX * offset;
          const az = THREE.MathUtils.lerp(start.z, end.z, t0) + normalZ * offset;
          const bx = THREE.MathUtils.lerp(start.x, end.x, t1) + normalX * offset;
          const bz = THREE.MathUtils.lerp(start.z, end.z, t1) + normalZ * offset;
          quaternion.copy(this.surfaceSegmentQuaternion(ax, az, bx, bz, 'road'));
          matrix.compose(new THREE.Vector3(x, this.roadHeightAt(x, z) + SIDEWALK_RISE / 2, z), quaternion, new THREE.Vector3(0.38, SIDEWALK_RISE, span));
          transforms.push(matrix.clone());

          // A narrow recessed drainage ribbon visually separates pale kerb from tar and makes even
          // unmarked residential streets read as finished, maintained road edges.
          const gutterOffset = side * (width / 2 - 0.11);
          const gx = start.x + dx * middle / length + normalX * gutterOffset;
          const gz = start.z + dz * middle / length + normalZ * gutterOffset;
          matrix.compose(new THREE.Vector3(gx, this.roadHeightAt(gx, gz) + 0.012, gz), quaternion, new THREE.Vector3(0.22, 0.018, span));
          gutters.push(matrix.clone());
        }
      }
    }
  }

  private buildTactileCorners(): void {
    const patchTransforms: THREE.Matrix4[] = []; const bumpTransforms: THREE.Matrix4[] = [];
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion();
    for (const junction of CITY_JUNCTIONS) {
      const reach = junction.widest / 2 + 3.4;
      const forward = new THREE.Vector3(Math.sin(junction.angle), 0, Math.cos(junction.angle)); const right = new THREE.Vector3(forward.z, 0, -forward.x);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), junction.angle);
      for (const forwardSide of [-1, 1]) for (const rightSide of [-1, 1]) {
        const center = new THREE.Vector3(junction.x, 0, junction.z).addScaledVector(forward, forwardSide * reach).addScaledVector(right, rightSide * reach);
        if (this.isOnRoad(center.x, center.z, 0.4)) continue; // corner landed on tar: no tactile paving in a lane
        center.y = this.sidewalkHeightAt(center.x, center.z) + 0.04; // sit the paving on the raised kerb
        matrix.compose(center, quaternion, new THREE.Vector3(2.5, 0.09, 1.65)); patchTransforms.push(matrix.clone());
        for (let row = -1; row <= 1; row++) for (let column = -2; column <= 2; column++) {
          const local = new THREE.Vector3(column * 0.38, 0.09, row * 0.38).applyQuaternion(quaternion);
          matrix.makeTranslation(center.x + local.x, center.y + local.y, center.z + local.z); bumpTransforms.push(matrix.clone());
        }
      }
    }
    const tactile = new THREE.MeshStandardMaterial({ color: 0xd0a744, roughness: 0.82 });
    this.addInstanced(new THREE.BoxGeometry(1, 1, 1), tactile, patchTransforms, { receive: true });
    this.addInstanced(new THREE.CylinderGeometry(0.09, 0.11, 0.07, 10), tactile, bumpTransforms, {});
  }

  /** Raised pavement ribbon with every cross-street interval removed from the actual triangles. */
  private createClippedSidewalkStrip(points: RoadPoint[], surface: number, material: THREE.Material, closed: boolean): THREE.Mesh {
    const vertices: number[] = []; const uvs: number[] = []; const indices: number[] = [];
    const left = this.offsetPath(points, SIDEWALK_WIDTH / 2, closed);
    const right = this.offsetPath(points, -SIDEWALK_WIDTH / 2, closed);
    const segmentCount = closed ? points.length : points.length - 1;
    let travelled = 0;
    for (let index = 0; index < segmentCount; index++) {
      const centerA = points[index]; const centerB = points[(index + 1) % points.length];
      const leftA = left[index]; const leftB = left[(index + 1) % left.length];
      const rightA = right[index]; const rightB = right[(index + 1) % right.length];
      if (!centerA || !centerB || !leftA || !leftB || !rightA || !rightB) continue;
      const length = Math.hypot(centerB.x - centerA.x, centerB.z - centerA.z); if (length < 1e-4) continue;
      const intervals = clearPathIntervals(length, (distance) => {
        const t = distance / length;
        const lx = THREE.MathUtils.lerp(leftA.x, leftB.x, t); const lz = THREE.MathUtils.lerp(leftA.z, leftB.z, t);
        const rx = THREE.MathUtils.lerp(rightA.x, rightB.x, t); const rz = THREE.MathUtils.lerp(rightA.z, rightB.z, t);
        for (const across of [0, 0.5, 1]) {
          const x = THREE.MathUtils.lerp(lx, rx, across); const z = THREE.MathUtils.lerp(lz, rz, across);
          if (this.roadClipIndex.onRoad(x, z, 0.035, surface)) return true;
        }
        return false;
      });
      for (const [from, to] of intervals) {
        // Subdivide the clear interval so the paving hugs the relief between the coarse (36u) nav samples —
        // a flat quad over a steep crease lets the ground poke up through the walk despite its 0.31 lift.
        const span = to - from; const steps = Math.max(1, Math.ceil(span / ROAD_STRIP_SUBSTEP));
        const crossAt = (dist: number): { lx: number; lz: number; rx: number; rz: number } => {
          const t = dist / length;
          return {
            lx: THREE.MathUtils.lerp(leftA.x, leftB.x, t), lz: THREE.MathUtils.lerp(leftA.z, leftB.z, t),
            rx: THREE.MathUtils.lerp(rightA.x, rightB.x, t), rz: THREE.MathUtils.lerp(rightA.z, rightB.z, t),
          };
        };
        let prev = crossAt(from);
        for (let s = 1; s <= steps; s++) {
          const dist = from + span * (s / steps); const cur = crossAt(dist); const base = vertices.length / 3;
          vertices.push(
            prev.lx, this.sidewalkHeightAt(prev.lx, prev.lz), prev.lz,
            prev.rx, this.sidewalkHeightAt(prev.rx, prev.rz), prev.rz,
            cur.lx, this.sidewalkHeightAt(cur.lx, cur.lz), cur.lz,
            cur.rx, this.sidewalkHeightAt(cur.rx, cur.rz), cur.rz,
          );
          const vFrom = (travelled + dist - span * (1 / steps)) / SIDEWALK_UV_LENGTH; const vTo = (travelled + dist) / SIDEWALK_UV_LENGTH;
          uvs.push(0, vFrom, 1, vFrom, 0, vTo, 1, vTo);
          indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
          prev = cur;
        }
      }
      travelled += length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  /** Linearly re-sample a polyline to at most `spacing` between points, so a surface built from it hugs the
   *  faceted ground instead of spanning cell creases. Keeps the original vertices; only inserts between them. */
  private densifyPath(points: RoadPoint[], spacing: number, closed: boolean): RoadPoint[] {
    const n = points.length; if (n < 2) return points;
    const out: RoadPoint[] = []; const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const a = points[i]!; const b = points[(i + 1) % n]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / spacing));
      for (let s = 0; s < steps; s++) { const t = s / steps; out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); }
    }
    if (!closed) out.push(points[n - 1]!);
    return out;
  }

  private createRoadStrip(input: RoadPoint[], width: number, material: THREE.Material, y: number, closed: boolean): THREE.Mesh {
    const points = this.densifyPath(input, ROAD_STRIP_SUBSTEP, closed); // hug the relief between the coarse nav samples
    const vertices: number[] = []; const uvs: number[] = []; const indices: number[] = []; let distance = 0;
    const sides = this.offsetPath(points, width / 2, closed); const opposite = this.offsetPath(points, -width / 2, closed);
    for (let index = 0; index < points.length; index++) {
      if (index > 0) { const previous = points[index - 1]; const point = points[index]; if (previous && point) distance += Math.hypot(point.x - previous.x, point.z - previous.z); }
      const left = sides[index]; const right = opposite[index]; if (!left || !right) continue;
      const leftOffset = y > ROAD_SURFACE_OFFSET && this.isOnRoad(left.x, left.z) ? ROAD_SURFACE_OFFSET : y;
      const rightOffset = y > ROAD_SURFACE_OFFSET && this.isOnRoad(right.x, right.z) ? ROAD_SURFACE_OFFSET : y;
      vertices.push(left.x, terrainHeightAt(left.x, left.z) + leftOffset, left.z, right.x, terrainHeightAt(right.x, right.z) + rightOffset, right.z); uvs.push(0, distance / 18, 1, distance / 18);
      if (index < points.length - 1) { const base = index * 2; indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1); }
    }
    if (closed && points.length > 2) { const last = (points.length - 1) * 2; indices.push(last, 0, last + 1, 0, 1, last + 1); }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  private addRoadMarkings(points: RoadPoint[], width: number, closed: boolean, dashTransforms: THREE.Matrix4[], edgeTransforms?: THREE.Matrix4[]): void {
    const segmentCount = closed ? points.length : points.length - 1;
    const quaternion = new THREE.Quaternion(); const matrix = new THREE.Matrix4();
    for (let index = 0; index < segmentCount; index++) {
      const start = points[index]; const end = points[(index + 1) % points.length]; if (!start || !end) continue;
      const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz); if (length < 0.5) continue;
      const midX = (start.x + end.x) / 2; const midZ = (start.z + end.z) / 2;
      quaternion.copy(this.surfaceSegmentQuaternion(start.x, start.z, end.x, end.z, 'road'));
      // Junctions are paved as one clean surface; a dash/edge line drawn through them makes the crossing read
      // as two overlapping roads (the "X"), so blank any marking that falls inside a junction footprint.
      if (index % 2 === 0 && !insideJunction(midX, midZ)) { matrix.compose(new THREE.Vector3(midX, this.roadHeightAt(midX, midZ) + 0.033, midZ), quaternion, new THREE.Vector3(0.24, 0.025, Math.min(6.4, length * 0.64))); dashTransforms.push(matrix.clone()); }
      if (!edgeTransforms) continue;
      const normalX = -dz / length; const normalZ = dx / length;
      for (const side of [-1, 1]) { const x = midX + normalX * side * (width / 2 - 0.72); const z = midZ + normalZ * side * (width / 2 - 0.72); if (insideJunction(x, z)) continue; matrix.compose(new THREE.Vector3(x, this.roadHeightAt(x, z) + 0.029, z), quaternion, new THREE.Vector3(0.13, 0.018, length + 0.35)); edgeTransforms.push(matrix.clone()); }
    }
  }

  // ---- Water bodies (generated lakes & dams) --------------------------------

  private polygonGeometry(polygon: MapPolygon): THREE.BufferGeometry {
    const shape = new THREE.Shape(polygon.points.map((point) => new THREE.Vector2(point.x - polygon.cx, -(point.z - polygon.cz))));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  }

  /** A ground-cover polygon (park lawn, mine dump) tessellated over a grid and DRAPED onto the terrain, so
   *  it hugs the relief instead of floating as a flat sheet over sloped/sunken ground. Vertices are absolute
   *  world coords (position the mesh at the origin). Returns null when the polygon is too small to grid —
   *  the caller falls back to a flat sheet parked at its centre's terrain height. */
  private drapedPolygonGeometry(polygon: MapPolygon, lift: number): THREE.BufferGeometry | null {
    const CELL = 22; // drape resolution (~a third of the ~70u ground-mesh pitch)
    const cols = Math.max(1, Math.ceil((polygon.maxX - polygon.minX) / CELL));
    const rows = Math.max(1, Math.ceil((polygon.maxZ - polygon.minZ) / CELL));
    const dx = (polygon.maxX - polygon.minX) / cols; const dz = (polygon.maxZ - polygon.minZ) / rows;
    const stride = cols + 1;
    const vid = new Array<number>(stride * (rows + 1)).fill(-1);
    const positions: number[] = []; const uvs: number[] = [];
    let n = 0;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const x = polygon.minX + c * dx; const z = polygon.minZ + r * dz;
      if (!pointInPolygon(polygon, x, z)) continue;
      vid[r * stride + c] = n++;
      positions.push(x, terrainHeightAt(x, z) + lift, z); uvs.push(x, z);
    }
    const indices: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = vid[r * stride + c]; const b = vid[r * stride + c + 1];
      const d = vid[(r + 1) * stride + c]; const e = vid[(r + 1) * stride + c + 1];
      if (a >= 0 && b >= 0 && d >= 0) indices.push(a, b, d);
      if (b >= 0 && e >= 0 && d >= 0) indices.push(b, e, d);
    }
    if (indices.length === 0) return null; // too small/thin for the grid — caller drops back to a flat sheet
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    // Grid winding depends on axis orientation; flip to face up if the normals came out pointing down.
    const normals = geometry.attributes.normal.array; let sumY = 0;
    for (let i = 1; i < normals.length; i += 3) sumY += normals[i]!;
    if (sumY < 0) { for (let i = 0; i < indices.length; i += 3) { const t = indices[i]!; indices[i] = indices[i + 2]!; indices[i + 2] = t; } geometry.setIndex(indices); geometry.computeVertexNormals(); }
    return geometry;
  }

  /** Add a draped ground-cover sheet (park/dump), falling back to a flat sheet at its centre's terrain
   *  height when the polygon is too small to tessellate. */
  private addGroundCover(polygon: MapPolygon, material: THREE.Material, lift: number): void {
    const draped = this.drapedPolygonGeometry(polygon, lift);
    const mesh = draped ? new THREE.Mesh(draped, material) : new THREE.Mesh(this.polygonGeometry(polygon), material);
    if (!draped) mesh.position.set(polygon.cx, terrainHeightAt(polygon.cx, polygon.cz) + lift, polygon.cz);
    mesh.receiveShadow = true; this.group.add(mesh);
  }

  private buildWaterBodies(): void {
    const bedMaterial = new THREE.MeshStandardMaterial({ color: 0x1c3a3e, roughness: 0.95 });
    for (const polygon of WATER_POLYGONS) {
      // Sit each inland water body on the terrain of its basin (the ground mesh is carved down by
      // WATER_BASIN_DEPTH inside the same polygon, so the surface floats above a real sunk bed).
      const surfaceY = terrainHeightAt(polygon.cx, polygon.cz) + 0.045;
      if (polygon.area >= PREMIUM_WATER_AREA) {
        // Big dams get the tiered treatment (waves/reflections per quality) over a dark bed for depth.
        const bed = new THREE.Mesh(this.polygonGeometry(polygon), bedMaterial);
        bed.position.set(polygon.cx, surfaceY - WATER_BASIN_DEPTH + 0.02, polygon.cz); this.group.add(bed);
        this.waterSites.push({
          kind: 'ocean', x: polygon.cx, y: surfaceY, z: polygon.cz,
          width: polygon.maxX - polygon.minX, depth: polygon.maxZ - polygon.minZ,
          shape: polygon.points,
        });
      } else {
        // Small ponds stay on the cheap rippling basin whatever the quality (perf policy: there are dozens).
        this.waterSites.push({ kind: 'pond', x: polygon.cx, y: surfaceY, z: polygon.cz, radius: Math.max(3, Math.sqrt(polygon.area / Math.PI) * 0.9) });
      }
    }
  }

  /** True when the point is inside a generated water polygon (keeps buildings/trees dry). */
  private inWater(x: number, z: number): boolean {
    return WATER_POLYGONS.some((polygon) => pointInPolygon(polygon, x, z));
  }

  // ---- Coast: ocean fancy-water + beach/rock shore --------------------------

  /** The Atlantic seaboard graft: a dark seabed, the ocean registered as one premium far-water site
   *  (planar mirror on high, cheaper tiers below), a drivable sand/rock shore along the waterline, and
   *  a small harbour apron. Built before the static merge so seabed/shore/apron chunk-cull with the rest;
   *  the ocean surface itself is a live water site (see buildWaterBodies' premium dams). */
  private buildCoast(): void {
    if (!OCEAN_POLYGON) return;
    const ocean = OCEAN_POLYGON;

    // The ocean surface: one huge premium water site. Its shape is shoved BEACH_WATER_INLAND past the
    // shoreline so the water laps up INTO the sloping sand — as the waves rise and fall, the waterline runs
    // in and out over the slope like a tide. The sandy sea floor is the terrain itself (see buildBeach and
    // analyticTerrainHeightAt's continuous slope), so there's no flat seabed plane to z-fight the swell.
    this.waterSites.push({
      kind: 'ocean', x: ocean.cx + BEACH_WATER_INLAND, y: OCEAN_Y, z: ocean.cz,
      width: ocean.maxX - ocean.minX, depth: ocean.maxZ - ocean.minZ,
      shape: ocean.points.map((point) => ({ x: point.x + BEACH_WATER_INLAND, z: point.z })),
    });

    this.buildBeach();
    this.buildHarbourApron();
  }

  /** The sandy sea floor: a single draped sheet from the sand crest out to the west map edge, stuck to the
   *  terrain (which slopes from +BEACH_TOP_Y down to SEA_FLOOR_Y). Replaces the old flat seabed + shore
   *  ribbon — a continuous slope the ocean laps over without z-fighting, and a real bottom to dive to. */
  private buildBeach(): void {
    if (COASTLINE.length < 2) return;
    const westEdge = -WORLD_SIZE / 2;
    const zs = COASTLINE.map((point) => point.z);
    const zMin = Math.min(...zs); const zMax = Math.max(...zs);
    const CELL = 45; const COLS = 48;
    const rows = Math.max(1, Math.ceil((zMax - zMin) / CELL));
    const dzRow = (zMax - zMin) / rows;
    const positions: number[] = []; const uvs: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const z = zMin + r * dzRow;
      const crest = coastlineXAt(z) + BEACH_INLAND + 3; // a touch past the crest so the sand tucks under the grass
      for (let c = 0; c <= COLS; c++) {
        const x = westEdge + (c / COLS) * (crest - westEdge); // columns fan from the map edge to the meandering crest
        positions.push(x, terrainHeightAt(x, z) + 0.03, z); uvs.push(x / 9, z / 9);
      }
    }
    const stride = COLS + 1; const indices: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < COLS; c++) {
      const a = r * stride + c; const b = r * stride + c + 1; const d = (r + 1) * stride + c; const e = (r + 1) * stride + c + 1;
      indices.push(a, b, d, b, e, d);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const normals = geometry.attributes.normal.array; let sumY = 0;
    for (let i = 1; i < normals.length; i += 3) sumY += normals[i]!;
    if (sumY < 0) { for (let i = 0; i < indices.length; i += 3) { const t = indices[i]!; indices[i] = indices[i + 2]!; indices[i + 2] = t; } geometry.setIndex(indices); geometry.computeVertexNormals(); }
    const sand = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xd8c8a0, map: this.sand, roughness: 0.97 }));
    sand.receiveShadow = true; sand.userData.far = true; // the always-visible sea floor, carries to the horizon
    this.group.add(sand);
  }

  /** Trivial dock apron where Kaapstad Quay meets the sea: a flat concrete slab at the waterline.
   *  Placeholder for the Stage-3 harbour manicure (cranes, jetties, moored boats). */
  private buildHarbourApron(): void {
    if (!HARBOUR_POINT) return;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(52, 34), new THREE.MeshStandardMaterial({ color: 0x8f8c85, map: this.concrete, roughness: 0.9 }));
    apron.rotation.x = -Math.PI / 2; apron.position.set(HARBOUR_POINT.x + 18, OCEAN_Y + 0.02, HARBOUR_POINT.z); apron.receiveShadow = true;
    this.group.add(apron);
  }

  // ---- Parks & green space (generated landuse polygons) ----------------------

  private buildParks(): void {
    // Grass colour is baked into the map (see createGrassTexture), so the material tint stays neutral white.
    // Every green landuse the map paints green renders as lush grass — including wild types (reserve/scrub/wood)
    // for now — so the world matches the map. (`polygon.manicured` is still carried for a future custom pass.)
    const parkMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.grassLush, roughness: 0.95 });
    this.grassWind = applyGrassShader(parkMaterial, { wind: true }); // lush lawns: macro detile + wind ripple
    const dirtMaterial = new THREE.MeshStandardMaterial({ color: 0xb59d5a, map: this.sand, roughness: 0.97 });
    for (const polygon of GREEN_POLYGONS) {
      this.addGroundCover(polygon, parkMaterial, 0.05); // drapes onto the relief
      this.plantParkTrees(polygon);
      if (!GENERIC_AREA_NAMES.has(polygon.name.toLowerCase()) && polygon.area > 4000) this.addParkSign(polygon);
    }
    for (const polygon of DIRT_POLYGONS) this.addGroundCover(polygon, dirtMaterial, 0.04); // mine dumps: Joburg's pale gold heaps, now draped on the terrain
    const farmMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.farmSoil, roughness: 0.97 }); // tilled dark-soil fields; plain like the default ground (no wind)
    for (const polygon of FARM_POLYGONS) this.addGroundCover(polygon, farmMaterial, 0.04);
  }

  private plantParkTrees(polygon: MapPolygon): void {
    const target = Math.round(THREE.MathUtils.clamp(polygon.area / 2600, 2, 12));
    let planted = 0;
    for (let attempt = 0; attempt < target * 5 && planted < target; attempt++) {
      const x = polygon.minX + seeded(polygon.cx + attempt, polygon.cz, 31) * (polygon.maxX - polygon.minX);
      const z = polygon.minZ + seeded(polygon.cx, polygon.cz + attempt, 32) * (polygon.maxZ - polygon.minZ);
      if (!pointInPolygon(polygon, x, z) || this.inWater(x, z)) continue;
      if (this.isOnRoad(x, z, 2.4) || this.isReserved(x, z, 2)) continue;
      this.addParkTree(x, z, attempt + Math.round(polygon.cx));
      planted++;
    }
  }

  private addParkSign(polygon: MapPolygon): void {
    const spot = polygon.points[0]!;
    if (this.isOnRoad(spot.x, spot.z, 1.2)) return;
    const baseY = terrainHeightAt(spot.x, spot.z); // sit the board and posts on the terrain
    const nameBoard = createSignMesh(new THREE.PlaneGeometry(5.8, 1.25), polygon.name.toUpperCase(), '#d9b64b', { doubleSide: true });
    nameBoard.position.set(spot.x, baseY + 1.7, spot.z); this.group.add(nameBoard);
    for (const px of [-2.3, 2.3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.4, 10), new THREE.MeshStandardMaterial({ color: 0x354143, metalness: 0.62 })); post.position.set(spot.x + px, baseY + 1.2, spot.z); this.group.add(post); }
    this.props.register('sign', spot.x, spot.z, 0.2, 2.4);
  }

  // ---- Buildings (procedural massing fed by district densities) ---------------

  /** Up-front, never-culled civic landmarks + the manicured special sites (Stage 1: one stadium bowl).
   *  The citywide procedural buildings are NOT built here — they stream in per cell (see updateBuildingChunks). */
  private buildLandmarks(): void {
    this.buildPonte();
    this.buildHillbrowTower();
    this.buildWaterTower();
    for (const site of RESOLVED_MANICURED_SITES) this.buildManicuredSite(site);
  }

  /** Runs one manicured site's named generator at its data-derived anchor. New generators (mansions,
   *  the padstal, the pier…) plug in here as Stage 2/3 adds entries to data/manicured.ts. */
  private buildManicuredSite(site: ResolvedManicuredSite): void {
    if (site.generator === 'stadiumBowl') this.buildStadiumBowl(site);
  }

  /** Placeholder oval stadium bowl: a raked seating ring of stacked box segments around a pitch,
   *  proving the manicure hook end-to-end. Fully procedural from the site's params. */
  private buildStadiumBowl(site: ResolvedManicuredSite): void {
    const rx = site.params?.radiusX ?? 76; const rz = site.params?.radiusZ ?? 60;
    const wallH = site.params?.wall ?? 20; const tiers = Math.max(1, Math.round(site.params?.tiers ?? 3));
    const concrete = new THREE.MeshStandardMaterial({ color: 0xbfc4c2, roughness: 0.82 });
    const stand = new THREE.MeshStandardMaterial({ color: 0x3f6f9c, roughness: 0.7 });
    const pitch = new THREE.MeshStandardMaterial({ color: 0x3f7a41, roughness: 0.95 });
    const bowl = new THREE.Group(); bowl.position.set(site.x, terrainHeightAt(site.x, site.z), site.z);
    const segments = 40;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ca = Math.cos(a); const sa = Math.sin(a);
      for (let t = 0; t < tiers; t++) {
        const scale = 1 + t * 0.16;
        const y = wallH * (t + 0.5) / tiers * 0.55;
        const px = ca * rx * scale; const pz = sa * rz * scale;
        const seg = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(rx, rz) / segments * 1.5 * scale, wallH / tiers, 7 + t * 2.2), t % 2 ? stand : concrete);
        seg.position.set(px, y + wallH * 0.18, pz); seg.rotation.y = -a; seg.castShadow = true; seg.receiveShadow = true; bowl.add(seg);
      }
    }
    const field = new THREE.Mesh(new THREE.CircleGeometry(1, 48), pitch); field.scale.set(rx * 0.82, rz * 0.82, 1); field.rotation.x = -Math.PI / 2; field.position.y = 0.05; bowl.add(field);
    this.group.add(bowl);
    // Ring collider approximated as a hollow box border so players can't drive through the stands.
    for (const [ox, oz, w, d] of [[0, rz, rx * 2, 6], [0, -rz, rx * 2, 6], [rx, 0, 6, rz * 2], [-rx, 0, 6, rz * 2]] as const) {
      this.colliders.push({ minX: site.x + ox - w / 2, maxX: site.x + ox + w / 2, minZ: site.z + oz - d / 2, maxZ: site.z + oz + d / 2, y0: 0, height: wallH });
    }
  }

  // ---- On-demand building chunk streaming ------------------------------------

  /**
   * Per frame: queue near cells for generation, dispose far cells, and bake pending cells under the
   * frame budget. Buildings are baked a few at a time (each ~1ms of geometry work) so a whole dense
   * cell streams in over several frames instead of hitching; the per-cell merge that keeps draw calls
   * low is one cheap finalize step. Geometry beyond the far radius is disposed and regenerates
   * identically from CityGen's seeds on re-approach.
   */
  private updateBuildingChunks(focusX: number, focusZ: number): void {
    const size = MERGE_CHUNK_SIZE; const range = CHUNK_VISIBLE_RANGE;
    const minX = Math.floor((focusX - range) / size); const maxX = Math.floor((focusX + range) / size);
    const minZ = Math.floor((focusZ - range) / size); const maxZ = Math.floor((focusZ + range) / size);
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      if (cellDistance(focusX, focusZ, cx, cz, size) > range) continue;
      const key = `${cx},${cz}`;
      if (this.buildingCells.has(key) || this.queuedCells.has(key)) continue;
      this.queuedCells.add(key); this.buildQueue.push([cx, cz]);
    }
    // Dispose finished cells that fell out of range; abort a pending cell that did the same.
    const toDispose: string[] = [];
    for (const [key, group] of this.buildingCells) {
      if (cellDistance(focusX, focusZ, group.userData.cellX as number, group.userData.cellZ as number, size) > range + CHUNK_HYSTERESIS) toDispose.push(key);
    }
    for (const key of toDispose) this.disposeBuildingCell(key);
    if (this.pending && cellDistance(focusX, focusZ, this.pending.cellX, this.pending.cellZ, size) > range + CHUNK_HYSTERESIS) this.abortPending();

    const start = performance.now();
    while (performance.now() - start < BUILD_FRAME_BUDGET_MS) {
      if (!this.pending) {
        if (this.buildQueue.length === 0) break;
        this.buildQueue.sort((a, b) => cellDistance(focusX, focusZ, a[0], a[1], size) - cellDistance(focusX, focusZ, b[0], b[1], size));
        const [cx, cz] = this.buildQueue.shift()!; const key = `${cx},${cz}`;
        this.queuedCells.delete(key);
        if (this.buildingCells.has(key)) continue;
        this.pending = { key, cellX: cx, cellZ: cz, specs: generateCell(cx, cz), index: 0, models: scatterCell(cx, cz), modelIndex: 0, baker: new GeometryBaker(), colliders: [], group: this.buildingStore.groupForKey(key) };
      }
      const pending = this.pending;
      // One item per budget slice — procedural buildings first, then the scattered structures/foliage;
      // both feed the same per-cell baker so the whole cell still collapses to a handful of draw calls.
      if (pending.index < pending.specs.length) {
        const { group, colliders } = this.buildOneBuilding(pending.specs[pending.index++]!);
        pending.baker.addObject(group);
        group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); // baker cloned the geometry
        pending.colliders.push(...colliders);
      } else if (pending.modelIndex < pending.models.length) {
        const { group, colliders } = this.buildOneModel(pending.models[pending.modelIndex++]!);
        pending.baker.addObject(group);
        group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
        pending.colliders.push(...colliders);
      }
      if (pending.index >= pending.specs.length && pending.modelIndex >= pending.models.length) { // cell complete: one cheap merge, register colliders once
        pending.baker.finalize(pending.group);
        if (!this.buildingColliderCells.has(pending.key)) { for (const collider of pending.colliders) this.colliders.push(collider); this.buildingColliderCells.add(pending.key); }
        this.buildingCells.set(pending.key, pending.group);
        this.pending = undefined;
      }
    }
  }

  /** Drop a half-baked pending cell (its group holds no merged meshes yet) so it can regenerate later. */
  private abortPending(): void {
    if (!this.pending) return;
    this.buildingStore.parent.remove(this.pending.group);
    this.buildingStore.groups.delete(this.pending.key);
    this.pending = undefined;
  }

  /** Free a cell's building geometry and detach it; colliders are kept (append-only), so a later
   *  regeneration reproduces identical meshes and reuses the already-registered colliders. */
  private disposeBuildingCell(key: string): void {
    const group = this.buildingCells.get(key);
    if (!group) return;
    group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
    this.buildingStore.parent.remove(group);
    this.buildingStore.groups.delete(key);
    this.buildingCells.delete(key);
  }

  /** Build one building at the origin inside its own group, then rotate it to face its street and
   *  place it. Returns the group (unmerged) and its world-space collision tiers. */
  private buildOneBuilding(spec: GeneratedBuilding): { group: THREE.Group; colliders: Collider[] } {
    const group = new THREE.Group();
    const previousTarget = this.target; this.target = group; this.architecture.retarget(group);
    const { width: w, depth: d, height: h, style, variant } = spec;
    // Fit the building to sloped terrain: sample the footprint corners, sit the massing on the HIGHEST
    // corner (so nothing sinks into a rising slope), and drop a concrete plinth past the LOWEST corner so
    // the raised base stays buried in the ground on the downhill side instead of floating over a gap.
    const cs = Math.cos(spec.heading); const sn = Math.sin(spec.heading);
    let hMax = -Infinity; let hMin = Infinity;
    // Sample a 3×3 grid over the footprint (not just corners) so a bulge in the coarse ground mesh between
    // corners can't poke up through the floor; sit on the max, bury the plinth to the min.
    for (const fx of [-0.5, 0, 0.5]) for (const fz of [-0.5, 0, 0.5]) {
      const lx = fx * w; const lz = fz * d;
      const sampleH = terrainHeightAt(spec.x + lx * cs + lz * sn, spec.z - lx * sn + lz * cs);
      if (sampleH > hMax) hMax = sampleH; if (sampleH < hMin) hMin = sampleH;
    }
    const baseY = hMax;
    const plinthDrop = baseY - hMin + 1.8; // from the building base down past the lowest corner, buried
    const plinthH = plinthDrop + 0.2;
    const parcel = new THREE.Mesh(new THREE.BoxGeometry(w + 6, plinthH, d + 6), new THREE.MeshStandardMaterial({ color: 0xb4b3aa, map: this.concrete, roughness: 0.92 })); parcel.position.set(0, 0.2 - plinthH / 2, 0); parcel.receiveShadow = true; group.add(parcel);
    const [rangeBase, rangeCount] = FACADE_RANGES[style];
    const facadeIndex = rangeBase + variant % rangeCount;
    const palette = BUILDING_PALETTES[style];
    const color = palette[facadeIndex % palette.length] ?? 0x9aa4a8;
    const materialKey = `${style}-${facadeIndex}`; let facade = this.buildingMaterial.get(materialKey);
    if (!facade) { facade = new THREE.MeshStandardMaterial({ color, map: this.facades[facadeIndex], emissive: 0xffffff, emissiveMap: this.facadeGlows[facadeIndex], emissiveIntensity: 0, roughness: 0.72, metalness: style === 'downtown' ? 0.12 : 0.02 }); this.buildingMaterial.set(materialKey, facade); }
    const profile = this.architecture.build({ x: 0, z: 0, width: w, depth: d, height: h, style, variant, facade, roof: this.roofMaterial });
    const detailed = style === 'downtown' || variant % 2 === 0;
    this.addLedge(0, 0, w * 1.025, d * 1.025, Math.min(h - 0.5, 3.6));
    if (detailed) this.addEntrance(0, 0, w, d, style);
    if (detailed && style === 'residential') this.addBalconies(0, 0, w, d, h);
    if (style === 'industrial') this.addIndustrialDetail(0, 0, w, d, h, profile.roofY, variant);
    if (detailed && (style === 'downtown' || style === 'residential')) this.addStreetLevelDetail(0, 0, w, d, style, variant);
    this.addRoofEquipment(0, 0, w, d, h, profile.roofY, style, variant);
    if (style === 'downtown' && h > 48 && variant % 4 === 0) this.addRoofSign(0, 0, w, d, profile.roofY, variant);
    group.position.set(spec.x, baseY, spec.z); group.rotation.y = spec.heading;
    const colliders = profile.tiers.map((tier) => this.tierToWorldCollider(tier, spec.x, spec.z, spec.heading, baseY));
    // On a real slope the base is raised above the downhill ground; give the plinth a collider so you can't
    // walk into the gap under the building. Skip on near-flat ground (no gap) to keep the collider count down.
    if (hMax - hMin > PLAYER.stepUp) {
      colliders.push(this.tierToWorldCollider({ minX: -(w + 6) / 2, maxX: (w + 6) / 2, minZ: -(d + 6) / 2, maxZ: (d + 6) / 2, y0: -plinthDrop, y1: 0 }, spec.x, spec.z, spec.heading, baseY));
    }
    this.target = previousTarget; this.architecture.retarget(this.group);
    return { group, colliders };
  }

  /** Build one scattered catalog model at the origin, then place + face it exactly like a building.
   *  Foliage never registers colliders (thin trunks, dense instancing) — you brush through leaves;
   *  every structure registers its (true-3D, standable-aware) tier colliders. */
  private buildOneModel(spec: ScatteredModel): { group: THREE.Group; colliders: Collider[] } {
    const built = buildModel(spec.name, spec.seed, { variant: spec.variant });
    const foliage = MODEL_INDEX.get(spec.name)?.category === 'foliage';
    // Footprint from the model's massing tiers (local AABB union).
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const tier of built.tiers) { minX = Math.min(minX, tier.minX); maxX = Math.max(maxX, tier.maxX); minZ = Math.min(minZ, tier.minZ); maxZ = Math.max(maxZ, tier.maxZ); }
    const structure = !foliage && minX < maxX;
    let baseY = terrainHeightAt(spec.x, spec.z); let hMin = baseY;
    if (structure) {
      // Fit a scattered STRUCTURE to sloped terrain like a building: sit on the highest footprint corner so
      // nothing sinks in, and level up from the lowest with a plinth (foliage just plants at its centre).
      const cs = Math.cos(spec.heading); const sn = Math.sin(spec.heading); let hMax = -Infinity; hMin = Infinity;
      for (const fx of [minX, (minX + maxX) / 2, maxX]) for (const fz of [minZ, (minZ + maxZ) / 2, maxZ]) {
        const cornerH = terrainHeightAt(spec.x + fx * cs + fz * sn, spec.z - fx * sn + fz * cs);
        if (cornerH > hMax) hMax = cornerH; if (cornerH < hMin) hMin = cornerH;
      }
      baseY = hMax;
    }
    built.group.position.set(spec.x, baseY, spec.z); built.group.rotation.y = spec.heading;
    const colliders = foliage ? [] : built.tiers.map((tier) => this.tierToWorldCollider(tier, spec.x, spec.z, spec.heading, baseY));
    if (structure && baseY - hMin > PLAYER.stepUp) {
      // Concrete levelling pad under the footprint, buried past the low corner, with a collider so you can't
      // walk into the raised understory on the downhill side.
      const plinthDrop = baseY - hMin + 1.2; const plinthH = plinthDrop + 0.2;
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX + 1.4, plinthH, maxZ - minZ + 1.4), new THREE.MeshStandardMaterial({ color: 0xb4b3aa, map: this.concrete, roughness: 0.92 }));
      plinth.position.set((minX + maxX) / 2, 0.2 - plinthH / 2, (minZ + maxZ) / 2); plinth.receiveShadow = true; built.group.add(plinth);
      colliders.push(this.tierToWorldCollider({ minX: minX - 0.7, maxX: maxX + 0.7, minZ: minZ - 0.7, maxZ: maxZ + 0.7, y0: -plinthDrop, y1: 0 }, spec.x, spec.z, spec.heading, baseY));
    }
    return { group: built.group, colliders };
  }

  /** Transform a local massing tier (axis-aligned) by an arbitrary heading into a world collider. The
   *  min/max is always the enclosing AABB (broad phase); when the heading isn't a quarter turn the collider
   *  also carries the true oriented rectangle (centre wx/wz, half-extents hw/hd, heading) so the narrow phase
   *  hugs a diagonally-aligned building's actual walls. Quarter turns keep the AABB exact, so they stay pure
   *  AABBs. Shared by the procedural buildings and the scattered catalog models. */
  private tierToWorldCollider(tier: { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number }, x: number, z: number, heading: number, baseY = 0): Collider {
    const c = Math.cos(heading); const s = Math.sin(heading);
    const lx = (tier.minX + tier.maxX) / 2; const lz = (tier.minZ + tier.maxZ) / 2;
    const hw = (tier.maxX - tier.minX) / 2; const hd = (tier.maxZ - tier.minZ) / 2;
    const wx = x + lx * c + lz * s; const wz = z - lx * s + lz * c;
    const nx = Math.abs(hw * c) + Math.abs(hd * s); const nz = Math.abs(hw * s) + Math.abs(hd * c);
    const box: Collider = { minX: wx - nx, maxX: wx + nx, minZ: wz - nz, maxZ: wz + nz, y0: tier.y0 + baseY, height: tier.y1 - tier.y0 };
    // Quarter turn (c≈0 or s≈0)? Enclosing AABB == oriented box, so keep the cheap exact AABB path.
    if (Math.abs(c) > 1e-4 && Math.abs(s) > 1e-4) { box.heading = heading; box.hw = hw; box.hd = hd; }
    return box;
  }

  private addLedge(x: number, z: number, w: number, d: number, y: number): void {
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.24, d), new THREE.MeshStandardMaterial({ color: 0xd0cec1, roughness: 0.76 })); ledge.position.set(x, y, z); ledge.castShadow = true; this.target.add(ledge);
  }

  private addEntrance(x: number, z: number, w: number, d: number, style: BuildingStyle): void {
    const glass = new THREE.MeshPhysicalMaterial({ color: style === 'industrial' ? 0x4a5353 : 0x3a6672, roughness: 0.16, metalness: 0.18, clearcoat: 0.6 });
    const doorW = Math.min(5.5, w * 0.32); const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, 3.1, 0.12), glass); door.position.set(x, 1.72, z + d / 2 + 0.08); this.target.add(door);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(doorW + 1.2, 0.18, 1.5), new THREE.MeshStandardMaterial({ color: 0x30383a, metalness: 0.45, roughness: 0.42 })); canopy.position.set(x, 3.35, z + d / 2 + 0.72); canopy.castShadow = true; this.target.add(canopy);
  }

  private addBalconies(x: number, z: number, w: number, d: number, h: number): void {
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x3c4546, metalness: 0.58, roughness: 0.4 });
    for (let y = 4.4; y < h - 1; y += 3.2) {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(w * 0.38, 0.14, 1.35), new THREE.MeshStandardMaterial({ color: 0xbdb9aa, roughness: 0.85 })); floor.position.set(x + w * 0.22, y, z + d / 2 + 0.62); floor.castShadow = true; this.target.add(floor);
      for (const px of [-w * 0.18, 0, w * 0.18]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), railMaterial); rail.position.set(x + w * 0.22 + px, y + 0.45, z + d / 2 + 1.16); this.target.add(rail); }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 0.07, 0.07), railMaterial); bar.position.set(x + w * 0.22, y + 0.84, z + d / 2 + 1.16); this.target.add(bar);
    }
  }

  private addIndustrialDetail(x: number, z: number, w: number, d: number, h: number, roofY: number, variant: number): void {
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, Math.min(5, h * 0.48), 0.14), new THREE.MeshStandardMaterial({ color: 0x5e6868, roughness: 0.52, metalness: 0.45 })); shutter.position.set(x, Math.min(5, h * 0.48) / 2 + 0.2, z + d / 2 + 0.09); this.target.add(shutter);
    for (const side of [-1, 1]) { const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.58, 1.7, 16), new THREE.MeshStandardMaterial({ color: 0x555e60, metalness: 0.6, roughness: 0.48 })); vent.position.set(x + side * w * 0.24, h + 1, z); this.target.add(vent); }
    if (variant % 3 === 0) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.05, Math.min(10, h * 0.7), 20), new THREE.MeshStandardMaterial({ color: 0x7a665d, roughness: 0.72, metalness: 0.16 })); stack.position.set(x - w * 0.28, h + Math.min(10, h * 0.7) / 2, z - d * 0.18); stack.castShadow = true; this.target.add(stack);
      for (let band = 0; band < 3; band++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.91 - band * 0.05, 0.08, 8, 20), new THREE.MeshStandardMaterial({ color: 0x363f42, metalness: 0.7, roughness: 0.38 })); ring.rotation.x = Math.PI / 2; ring.position.set(stack.position.x, h + 2.2 + band * 2.2, stack.position.z); this.target.add(ring); }
    }
    if (variant % 4 === 0) this.addRoofSign(x, z, w, d, roofY, variant);
  }

  private addStreetLevelDetail(x: number, z: number, w: number, d: number, style: BuildingStyle, variant: number): void {
    const frame = new THREE.MeshStandardMaterial({ color: 0x273235, metalness: 0.55, roughness: 0.38 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x315f68, roughness: 0.12, metalness: 0.18, clearcoat: 0.7 });
    const bays = Math.max(2, Math.min(5, Math.floor(w / 5)));
    for (let bay = 0; bay < bays; bay++) {
      const px = x - w * 0.39 + bay * (w * 0.78 / Math.max(1, bays - 1));
      if (Math.abs(px - x) < Math.min(3, w * 0.18)) continue;
      const window = new THREE.Mesh(new THREE.BoxGeometry(Math.min(3.2, w / bays * 0.62), style === 'downtown' ? 2.35 : 1.65, 0.09), glass); window.position.set(px, style === 'downtown' ? 1.55 : 1.65, z + d / 2 + 0.075); this.target.add(window);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(Math.min(3.5, w / bays * 0.68), 0.1, 0.18), frame); sill.position.set(px, 0.4, z + d / 2 + 0.13); this.target.add(sill);
    }
    if (style === 'downtown' || variant % 3 === 0) {
      const colors = [0xc8503f, 0x2f7774, 0xd4a438, 0x586f91];
      const awning = new THREE.Mesh(new THREE.BoxGeometry(w * 0.46, 0.15, 1.25), new THREE.MeshStandardMaterial({ color: colors[variant % colors.length], roughness: 0.7 }));
      awning.position.set(x + w * 0.22, 3.1, z + d / 2 + 0.58); awning.rotation.x = -0.12; awning.castShadow = true; this.target.add(awning);
    }
  }

  private addRoofEquipment(x: number, z: number, w: number, d: number, h: number, roofY: number, style: BuildingStyle, variant: number): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x596467, metalness: 0.62, roughness: 0.46 });
    const units = style === 'downtown' ? 2 : style === 'industrial' ? 1 : 0;
    for (let index = 0; index < units; index++) {
      const unit = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.05, 1.35), metal); unit.position.set(x - w * 0.18 + index * 2.4, roofY + 0.52, z - d * 0.2); unit.castShadow = true; this.target.add(unit);
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 16), new THREE.MeshStandardMaterial({ color: 0x263033, metalness: 0.75, roughness: 0.35 })); fan.rotation.x = Math.PI / 2; fan.position.set(unit.position.x, roofY + 0.54, unit.position.z - 0.7); this.target.add(fan);
    }
    if (h > 42 && variant % 3 === 1) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.1, 8, 10), metal); mast.position.set(x + w * 0.2, roofY + 4, z); this.target.add(mast);
      const beaconMaterial = new THREE.MeshStandardMaterial({ color: 0xff4b3e, emissive: 0xff1f16, emissiveIntensity: 2 });
      registerPowered(beaconMaterial, 0xff4b3e, 0x3a1a16);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), beaconMaterial); beacon.position.set(mast.position.x, roofY + 8.05, z); this.target.add(beacon);
    }
  }

  private addRoofSign(x: number, z: number, w: number, d: number, h: number, variant: number): void {
    const names = ['CHICKEN LEKKER', 'MR VRRR PHAA', 'PIK-A-PAY', 'DEBONERS']; const accent = variant % 2 ? '#72d8d2' : '#f0ae43';
    const sign = createSignMesh(new THREE.PlaneGeometry(Math.min(12, w * 0.7), 3), names[variant % names.length] ?? 'CHICKEN LEKKER', accent, { powered: true }); sign.position.set(x, h + 3.2, z + d / 2 + 0.1); this.target.add(sign);
    for (const px of [-3, 3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 8), new THREE.MeshStandardMaterial({ color: 0x343b3d, metalness: 0.7 })); post.position.set(x + px, h + 1.5, z + d / 2); this.target.add(post); }
  }

  private addParkTree(x: number, z: number, variant: number): void {
    if (this.isOnRoad(x, z, 2.4)) return; // parks can overlap roads: no trunks on the tar
    this.props.register('tree', x, z, 0.5, 5.1);
    const tree = new THREE.Group(); tree.position.set(x, terrainHeightAt(x, z), z); // sit on the terrain, not the flat plane
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.55, 5.1, 16), new THREE.MeshStandardMaterial({ color: 0x60442f, roughness: 0.95 })); trunk.position.y = 2.55; trunk.castShadow = true; tree.add(trunk);
    const colors = [0x326d43, 0x3d7c49, 0x4b8650];
    const clusters: Array<[number, number, number, number]> = [[0, 6.2, 0, 2.2], [-1.35, 5.7, 0.25, 1.7], [1.2, 5.75, -0.2, 1.8], [0.2, 5.7, 1.1, 1.55]];
    clusters.forEach(([ox, oy, oz, scale], index) => { const crown = new THREE.Mesh(new THREE.SphereGeometry(scale, 20, 14), new THREE.MeshStandardMaterial({ color: colors[(variant + index) % colors.length], roughness: 0.9 })); crown.scale.y = 0.82; crown.position.set(ox, oy, oz); crown.castShadow = true; crown.receiveShadow = true; tree.add(crown); }); this.group.add(tree);
  }

  // ---- Landmarks -----------------------------------------------------------

  private buildPonte(): void {
    const x = PONTE_SPOT.x; const z = PONTE_SPOT.z; const height = 105; const radius = 24;
    const ponte = new THREE.Group(); ponte.position.set(x, terrainHeightAt(x, z), z); // sit on the terrain (matches its collider base below)
    ponte.userData.far = true; // skyline landmark: merged into the never-culled far bucket so the silhouette doesn't pop at the chunk radius
    const facadeTexture = this.facades[0]?.clone(); if (facadeTexture) { facadeTexture.repeat.set(8, 6); facadeTexture.needsUpdate = true; }
    const facade = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, map: facadeTexture, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40, 1, true), facade); shell.position.y = height / 2; shell.castShadow = true; shell.receiveShadow = true;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, height, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c3336, roughness: 0.9, side: THREE.DoubleSide })); core.position.y = height / 2;
    const roof = new THREE.Mesh(new THREE.RingGeometry(15, radius, 40), new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, side: THREE.DoubleSide })); roof.rotation.x = -Math.PI / 2; roof.position.y = height;
    const crown = createSignMesh(new THREE.CylinderGeometry(radius + 1, radius + 1, 8, 40, 1, true, 0, Math.PI), 'VODACOMB', '#e4372e', { doubleSide: true, powered: true }); crown.position.y = height + 4;
    ponte.add(shell, core, roof, crown); this.group.add(ponte);
    this.colliders.push({ minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, y0: this.terrainHeightAt(x, z), height });
  }

  private buildHillbrowTower(): void {
    const x = HILLBROW_TOWER_SPOT.x; const z = HILLBROW_TOWER_SPOT.z; const height = 90;
    const tower = new THREE.Group(); tower.position.set(x, terrainHeightAt(x, z), z);
    tower.userData.far = true; // skyline landmark: never culled, same as Ponte
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b4a8, roughness: 0.8 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.4, height, 24), concrete); shaft.position.y = height / 2; shaft.castShadow = true;
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(7.4, 6.2, 11, 24), new THREE.MeshStandardMaterial({ color: 0x8fa3ab, roughness: 0.5, metalness: 0.25 })); pod.position.y = height - 8; pod.castShadow = true;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.5, 16, 10), new THREE.MeshStandardMaterial({ color: 0x60686b, metalness: 0.7, roughness: 0.4 })); mast.position.y = height + 8;
    const label = createSignMesh(new THREE.PlaneGeometry(9, 1.6), 'TELKOM SORRY-4-LATE', '#8fd8e8', { doubleSide: true, powered: true }); label.position.y = height - 8; label.position.z = 7.5;
    tower.add(shaft, pod, mast, label); this.group.add(tower);
    this.props.register('monument', x, z, 4.4, height);
  }

  private buildWaterTower(): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x3d4b4e, metalness: 0.72, roughness: 0.38 });
    const tower = new THREE.Group(); tower.position.set(WATER_TOWER_SPOT.x, terrainHeightAt(WATER_TOWER_SPOT.x, WATER_TOWER_SPOT.z), WATER_TOWER_SPOT.z);
    for (const x of [-2.4, 2.4]) for (const z of [-2.4, 2.4]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.25, 14, 10), metal); leg.position.set(x, 7, z); leg.rotation.z = x * 0.014; tower.add(leg); this.props.register('post', tower.position.x + x, tower.position.z + z, 0.3, 14); }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 3.8, 5.2, 32), new THREE.MeshStandardMaterial({ color: 0x738b8d, metalness: 0.42, roughness: 0.52 })); tank.position.y = 15.3; tank.castShadow = true; tower.add(tank);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(4.6, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x80999a, metalness: 0.38, roughness: 0.5 })); cap.position.y = 17.9; cap.castShadow = true; tower.add(cap);
    const label = createSignMesh(new THREE.PlaneGeometry(6.8, 1.7), 'JOBURG WATER', '#e5c15b'); label.position.set(0, 15.8, 4.7); tower.add(label);
    const subLabel = createSignMesh(new THREE.PlaneGeometry(4.4, 1.1), '(EMPTY)', '#e5c15b'); subLabel.position.set(0, 14.3, 4.72); tower.add(subLabel); this.group.add(tower);
  }
}
