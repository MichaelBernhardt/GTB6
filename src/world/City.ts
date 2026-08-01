import * as THREE from 'three';
import { PLAYER, WORLD_SIZE } from '../config';
import { bootMark } from '../core/BootTimeline';
import type { BaseQuality, District } from '../types';
import { BuildingArchitecture, foundationTiers, frontFacadeSpansAt, frontFacadeZAt, gableSurfaceAt, massingTopAt, roofSurfaceAt, scaleBoxFacadeUvs, widestFrontFacadeSpanAt, type BuildingStyle, type EntranceTag, type GableSpec, type MassingTier } from './BuildingArchitecture';
import {
  BEACH_POLYGONS,
  COASTLINE,
  COAST_CORRIDOR,
  distanceToRailwayCorridor,
  distanceToRoadEdge,
  districtAt as generatedDistrictAt,
  baseMetresAt,
  regionalMetresAt,
  ridgeMetresAt,
  HAS_ELEVATION,
  GENERATED_ROADS,
  GENERATED_RAILWAYS,
  GENERATED_PATHS,
  GENERATED_TRACKS,
  GREEN_POLYGONS,
  DIRT_POLYGONS,
  FARM_POLYGONS,
  JUNCTION_SURFACES,
  junctionPaves,
  junctionReach,
  METRES_PER_UNIT,
  OCEAN_POLYGON,
  pointInPolygon,
  RAILWAY_CORRIDOR_HALF_WIDTH,
  RAILWAY_LEVEL_CROSSINGS,
  RAILWAY_STATION_SITES,
  ROAD_BUILD_MARGIN,
  STATION_PLATFORM_OFFSET,
  STATION_PLATFORM_WIDTH,
  platformSideFits,
  stationPlatformLength,
  WATER_POLYGONS,
  type MapPolygon,
} from './mapData';
import { damSignedDistance } from './damField';
import { beachBands, farWaterOutline, isSandZ, OCEAN_Y, shoreColourAt, WATER_HORIZON_BLEND, WATER_HORIZON_CLEARANCE } from './coast';
import { buildAirport } from './Airport';
import { BEACHFRONT } from './beachfront';
import { buildPleasurePier } from './models/pier';
import { HILLBROW_TOWER_SPOT, PONTE_SPOT, RESERVED_PADS, WATER_TOWER_SPOT } from './placements';
import { boardText, parcelBuildingName, scatterBuildingName } from './buildingIdentity';
import { CELL_SIZE, parcelStages, RAILWAY_STATION_CLEARANCE, generateCell, type GeneratedBuilding } from './CityGen';
import { scatterCell, scatterStages, type ScatteredModel } from './ModelScatter';
import { buildModel, MODEL_INDEX } from './models/catalog';
import type { BuiltModel } from './models/kit';
import { RESOLVED_MANICURED_SITES, type ResolvedManicuredSite } from './data/manicured';
import { addInstancedChunks, BUILDING_VISIBLE_RANGE, cellDistance, cellsWithinRange, ChunkStore, ChunkVisibility, CHUNK_HYSTERESIS, DETAIL_HYSTERESIS, DETAIL_VISIBLE_RANGE, type InstanceItem } from './ChunkVisibility';
import { applyGrassShader, applySnowShader, createFacadeGlowTexture, createFacadeTexture, createFootpathAlphaTexture, createGeneratedSurfaceTexture, createGrassTexture, createSidewalkTexture, createSignMesh, createSurfaceTexture, createTrackSurfaceTexture, facadeWorldTile, FACADE_VARIANTS } from './ProceduralMaterials';
import { POTHOLE_SEGMENTS, potholeRimAt, potholeVertexRadius, RIM_MIN_SPAN, type PotholeHazard } from './PotholeShape';
import { GeometryBaker, mergeStaticGeometry } from './StaticGeometry';
import { bridgeIslands, buildNavGraph, type NavGraph, type NavPath, type NavPoint } from '../systems/NavGraph';
import { PropRegistry } from '../systems/PropSystem';
import { CITY_JUNCTIONS, type JunctionDefinition, signalHoldsDriver, signalSlowFactor, SIGNAL_STOP_APPROACH, UrbanInfrastructure } from './UrbanInfrastructure';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createWater, waterTier, type WaterHandle, type WaterSite } from './Water';
import { registerPowered } from './powerGrid';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from './data/neighbourhoods';
import { foundationIdentityForDistrict, type FoundationIdentity } from './data/foundations';

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
/**
 * ONE TRUNK, AS A CIRCLE.
 *
 * A tree's gameplay volume is the trunk and only the trunk, and a trunk is round — so it is registered
 * in the PROP grid (a circle in a 12 u hash) rather than pushed onto City.colliders as a rectangle.
 * Three reasons, all of them the difference between a fix and a regression:
 *
 *   COST. `props.blocked` is already called on every player, ped and vehicle move, so a trunk in that
 *   grid adds no new query — only a couple of entries in one bucket. City.colliders is append-only for
 *   the life of the session and is scanned per bucket by the player's per-frame clamp AND by
 *   supportHeight; adding thousands of trunk rectangles to it would tax both forever, for a volume
 *   nobody can stand on.
 *
 *   SHAPE. A circle cannot produce the invisible corner an oversized rectangle does.
 *
 *   ONE MODEL. Roadside trees (UrbanInfrastructure) and park trees (addParkTree) have always been
 *   'tree' props, which is already wired to the vehicle response: solid tier, so a car is stopped and
 *   takes SOLID_PROP_DAMAGE_FACTOR damage (harder than a wall) instead of felling it like a bin.
 *   Scattered trees join that, so there is one tree collision rule in the game, not two.
 */
export interface TrunkProp { x: number; z: number; radius: number; height: number; }

/** The trunk prop of an authored library tree, or undefined for anything else — procedural
 *  undergrowth (hedges, aloes, bougainvillea) keeps its tiers to itself and stays passable, and a
 *  trunk under SOLID_TRUNK_MIN_DIAMETER declares no tier at all. */
export function trunkProp(built: BuiltModel, x: number, z: number): TrunkProp | undefined {
  if (built.group.userData.treeSpecies === undefined) return undefined;
  const trunk = built.tiers[0];
  if (!trunk) return undefined;
  return {
    x, z,
    radius: Math.max(trunk.maxX - trunk.minX, trunk.maxZ - trunk.minZ) / 2,
    height: trunk.y1 - trunk.y0,
  };
}

export interface RoadPoint { x: number; z: number; }
export interface RoadsidePoint extends RoadPoint { inwardX: number; inwardZ: number; width: number; }
export interface RoadPose { position: THREE.Vector3; heading: number; }
export interface RoadDefinition { name: string; width: number; closed?: boolean; points: RoadPoint[]; }
export type SurfaceKind = 'auto' | 'terrain' | 'road' | 'sidewalk';

export const STOREFRONT_SIGNS = ['KOTA & CHIPS', 'HAIR BY BONGI', 'MZANSI FONES', 'BRAAI 2 GO', 'EISH EXPRESS', 'LOAD SHED CAFE'] as const;
export const INDUSTRIAL_SIGNS = ['PANELBEATERS', 'GENERATOR GUYS', 'TYRES & SONS', 'WELDING NOW-NOW'] as const;

/** Deterministic local-business labels: a tiny fixed vocabulary keeps the sign atlas bounded while
 * giving repeated procedural blocks an unmistakably Johannesburg street-level identity. */
export function storefrontSignLabel(variant: number): string {
  return STOREFRONT_SIGNS[((variant % STOREFRONT_SIGNS.length) + STOREFRONT_SIGNS.length) % STOREFRONT_SIGNS.length]!;
}

export function industrialSignLabel(variant: number): string {
  return INDUSTRIAL_SIGNS[((variant % INDUSTRIAL_SIGNS.length) + INDUSTRIAL_SIGNS.length) % INDUSTRIAL_SIGNS.length]!;
}

/** World units per UV repeat on foundation/retaining-wall concrete. The concrete texture carries
 *  its own 10x repeat, so this is 3 u per visible concrete tile — the mid-point of the per-face
 *  pitches the unscaled boxes used to show. See the foundation pass in buildOneBuilding. */
export const FOUNDATION_UV_TILE = { width: 30, height: 30 };

export const ROAD_SURFACE_OFFSET = 0.15;
export const SIDEWALK_RISE = 0.22;
/** How far the ground mesh sinks beneath an inland water body's surface, so dams/ponds read as basins
 *  instead of a flat sheet coplanar with the land (the original z-fighting the relief pass set out to kill). */
export const WATER_BASIN_DEPTH = 2.6;
export const STOP_LINE_DEPTH = 0.6; // thickness (along travel) of an intersection stop bar — bold, reads as the feature
/** Pavement begins just behind the kerb and ends exactly at the walkable-band query boundary. */
export const SIDEWALK_INNER_EDGE = 0.38;
/** Derived from ROAD_BUILD_MARGIN, not declared beside it, so the pavement the renderer LAYS and the
 *  road footprint every clearance rule MEASURES can never disagree. Widening the pavement now widens
 *  the footprint that rail, station platforms and roadside placement are all held clear of. */
export const SIDEWALK_WIDTH = ROAD_BUILD_MARGIN - SIDEWALK_INNER_EDGE;
export const SIDEWALK_CENTER = SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH / 2;
/** The verge line: where addRoadsidePoints and buildStreetlampPoints put every furniture anchor, as a
 *  distance beyond the kerb. Note it sits only 0.45u inside the pavement's outer edge, so a pass that
 *  steps OUTWARD from it is stepping onto the grass — see UrbanInfrastructure's kerb-distance table. */
export const ROADSIDE_OFFSET = 3.05;
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
/** The synthetic northern mountain range rides ABOVE the detrend split (mapData ships its metres
 *  separately and detrends only the base terrain), scaled straight to world Y — ~1250 m of crest
 *  becomes ~400 u of in-game mountain, dwarfing the ±36 u local hills while the CBD feels nothing. */
export const TERRAIN_RIDGE_SCALE = 0.32;
/** Raw composite metres ASL where the mountain tops turn snowy. The shared map renderer paints the
 *  same contour (MAP_SNOWLINE_METRES in src/ui/mapRender.ts — kept equal by a unit test). */
export const SNOWLINE_METRES = 2400;
/** Base terrain the range rises from (~the plateau) — maps SNOWLINE_METRES into in-game Y. */
export const RIDGE_BASE_METRES = 1730;
/** In-game Y where snow begins (fbm-dithered in the ground shader; full cover one band higher). */
export const SNOW_Y = (SNOWLINE_METRES - RIDGE_BASE_METRES) * TERRAIN_RIDGE_SCALE;
// The per-latitude shoreline lookup (COAST_BY_Z / coastlineXAt) is GONE. It answered "which x is the
// shore at this z", which is a question only a straight coast has an answer to; on a drowned dendritic
// valley it returned one arbitrary crossing out of the thirty a scanline makes, and every consumer
// inherited that. The terrain moved to the signed distance field one pass ago; buildBeach was the last
// caller and now shares the same field, so the envelope has no callers left.

/** Coastal beach/seabed profile: the sand's landward crest sits just above sea level and the ground slopes
 *  continuously down to SEA_FLOOR_Y at the map's west edge — never flat, so the waving ocean can't z-fight
 *  it, and it's a sandy sea floor all the way out (for diving later). */
export const BEACH_TOP_Y = 1.5;
export const SEA_FLOOR_Y = -30;
/**
 * How far inland (east of the mapped shoreline) the drawdown strand's landward crest sits.
 *
 * 40 units used to be the whole exposed shore, and on a single linear ramp from +BEACH_TOP_Y at
 * the crest to SEA_FLOOR_Y at the map edge the coloured banding above the waterline collapsed into
 * an average of TWELVE units — sixteen metres — so a reservoir shore whose whole point is its
 * bathtub ring read on foot as a featureless plain. The strand is now the width a real drawdown
 * strand is (this reservoir swung from near-empty in 2025 to over 102% in 2026), and the profile
 * below is split so that width is spent above the water rather than under it.
 */
export const BEACH_INLAND = 132;
/** Run (units) the bed uses to fall from the waterline to SEA_FLOOR_Y at latitudes where the shoreline
 *  is already west of the map edge — there is no in-map run left to spend, and a wall reads as a cliff. */
export const BED_OFFMAP_RUN = 620;
/** How far past the waterline the drawn bed sheet carries where the shore sits west of the map edge,
 *  so the strand and its lip are drawn rather than dropping into empty space. */
export const BED_OFFMAP_OVERHANG = 900;
/** How far past the world square (in z) the bed sheet runs, so standing in a dry corner and looking
 *  along the shore does not show the sheet's own end. */
export const BED_Z_OVERRUN = 600;
/**
 * How far inland of the strand crest the bed sheet fades into the surrounding veld and stops.
 *
 * The sheet used to run from the map edge to a per-latitude crest line — a solid pale sheet 1,600
 * units wide down the whole west side, drawn over ridges, over dry veld and over latitudes the dam
 * never reaches (at z = -4,400 the reservoir is 800 units off-map and the sheet still covered the
 * NW corner). On foot that was a featureless pan from the shore to the farm corridor, which is the
 * cheap half of the "blackness" complaint: not darkness, ABSENCE — no grass, no scrub, no foliage
 * colour, one flat tone to the horizon. It is now clipped to the shore band by the signed distance
 * field, so everything further inland is ordinary ground again, and the last stretch of it fades to
 * VELD_TONE so the clip line is a colour match rather than a seam.
 */
export const SHORE_VELD_BLEND = 190;
/**
 * WHERE THE PAINTED STRAND STOPS, at the resorts and everywhere else.
 *
 * BEACH_INLAND is the TERRAIN: 132 units of ground climbing out of the water, and it is not moving
 * (the profile, the venue crests and the bake all hang off it). What was wrong is that the SHEET was
 * painted as exposed lake bed for that whole width plus SHORE_VELD_BLEND behind it — 322 units, 430
 * metres, of grit and bathtub ring round every bay in the reservoir. Measured in-engine it is the
 * single largest thing in most shore frames, it is why Grooteiland reads as a pan rather than as an
 * island, and it is why the west band reads as a pale plain rather than as veld.
 *
 * So the paint is separated from the profile. The natural shore now shows ~60 units of exposed bank
 * and greens over the next 60; the RESORT bands keep the full BEACH_INLAND + SHORE_VELD_BLEND, so
 * Misty Bay and Leboya Baai still have the wide warm beaches the owner picked the place for. The
 * geometry is untouched either way: same lattice, same vertices, same heights — only the colours
 * and how far east the sheet is worth drawing.
 */
export const STRAND_PAINT_INLAND = 60;
/** Width (units) over which the natural strand's paint fades into VELD_TONE. */
export const STRAND_PAINT_BLEND = 60;
/** Vertices per side of the drawn ground mesh. The bed sheet reuses this lattice EXACTLY (same x/z,
 *  same heights) so the two surfaces cannot interpenetrate — see buildBeach. */
export const GROUND_SEGMENTS = 256;
/** Lift of the bed sheet above the ground mesh. With the lattices shared the only disagreement left
 *  is which way each cell's diagonal runs, so this only has to beat the cell twist — but it also has
 *  to stay under the water's own 0.045, or the sheet's lip would stand proud of the waterline. */
export const BED_SHEET_LIFT = 0.022;
/** Where the terrain crosses the water surface, relative to the mapped shoreline (units, negative
 *  = seaward). Zero would put the rendered waterline exactly on the polyline; a few units seaward
 *  keeps the ocean's lapping edge over sand rather than over grass. */
export const WATERLINE_OFFSET = -6;
/** How far inland of the strand crest the coastal profile blends into the city's own relief
 *  (units). Measured from the WATERLINE, not from a fixed x, so the blend band follows the coast
 *  into every inlet and around every headland instead of cutting a straight seam across them. */
export const COAST_BLEND = 520;
/** How far the ocean surface reaches past the shoreline into the beach, so waves lap up and down the slope. */
export const BEACH_WATER_INLAND = 60;

/** The detrended, exaggerated, capped land relief at a point (before any coastal fade): the base
 *  terrain's regional/local split plus the mountain range riding above it at its own scale. */
function landRelief(x: number, z: number): number {
  const regional = regionalMetresAt(x, z);
  let local = baseMetresAt(x, z) - regional;
  if (local > TERRAIN_LOCAL_CAP) local = TERRAIN_LOCAL_CAP;
  else if (local < -TERRAIN_LOCAL_CAP) local = -TERRAIN_LOCAL_CAP;
  return regional * TERRAIN_REGIONAL_SCALE + local * TERRAIN_LOCAL_SCALE + ridgeMetresAt(x, z) * TERRAIN_RIDGE_SCALE;
}

/**
 * The smooth terrain profile, before the drawn mesh's grid is captured. Exported so the coast tests
 * can ask whether a given off-map point is above or below the waterline without a renderer.
 *
 * THE SEAM. The coastal profile used to be a function of x alone (distance east of a per-latitude
 * shoreline) and the inland blend ran from the sand crest to a fixed corridor line, so the imported
 * shore and the city's own relief met on a straight north-south seam. It is now a function of the
 * SIGNED DISTANCE TO THE WATERLINE, and the blend to full relief happens over a fixed band measured
 * from that same waterline. The consequences are all the ones we wanted:
 *   - a ridge peninsula between two drowned valleys is land, because it is outside the polygon;
 *   - Grooteiland is land, because an island is a hole in the polygon;
 *   - the transition band follows the coast rather than cutting across it, so there is no seam;
 *   - the bed slopes away from the waterline in every direction, so no shore is ever a wall.
 */
export function analyticTerrainHeightAt(x: number, z: number): number {
  if (!HAS_ELEVATION) return 0;
  const eastX = COAST_CORRIDOR?.eastX;
  // Fast path — well inland of any coast: full relief, no distance-field lookup.
  if (eastX === undefined || x >= eastX) return landRelief(x, z);
  // Distance to the waterline, positive on land. WATERLINE_OFFSET keeps the rendered lapping edge
  // a few units over sand rather than over grass, exactly as before.
  const d = damSignedDistance(x, z) + WATERLINE_OFFSET;
  if (d <= 0) {
    // THE BED. Falls away from the waterline to SEA_FLOOR_Y over a fixed run, in every direction —
    // around an island, into an inlet, out past the map edge. No per-latitude special case left.
    const t = Math.min(1, -d / BED_OFFMAP_RUN);
    return OCEAN_Y + (SEA_FLOOR_Y - OCEAN_Y) * t;
  }
  if (d < BEACH_INLAND) {
    // THE STRAND. The whole BEACH_INLAND width is spent above the water, so the drawdown ring reads.
    const t = 1 - d / BEACH_INLAND;
    return BEACH_TOP_Y + (OCEAN_Y - BEACH_TOP_Y) * t;
  }
  // THE BLEND. Crest -> full inland relief over COAST_BLEND units of distance from the waterline.
  // Floored at 0 so the mean-zero relief's negative lobes cannot drag the hinterland under water.
  const f = Math.min(1, (d - BEACH_INLAND) / COAST_BLEND);
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

/**
 * IS THIS POINT IN WATER? Tested against the water SHAPES, never their bounding envelopes.
 *
 * The dam is a drowned dendritic valley: its bbox contains ridge peninsulas, inlets and the islands
 * of Grooteiland, all of which are dry land. So the dam is asked through its signed-distance field
 * (damField), with the same WATERLINE_OFFSET the terrain itself uses to decide bed from strand —
 * which makes "water" here mean exactly the ground the bed sheet drowns, no second opinion. Authored
 * inland pans and lakes are point-in-polygon, since the ground mesh is carved down inside those very
 * polygons.
 */
export function inWater(x: number, z: number): boolean {
  if (damSignedDistance(x, z) + WATERLINE_OFFSET <= 0) return true;
  return WATER_POLYGONS.some((polygon) => pointInPolygon(polygon, x, z));
}

/** District ownership comes from the generated map's place nodes (nearest centre). */
export const districtAt = generatedDistrictAt;

/** The driveable road network — straight from the generated OSM map. */
export const ROAD_NETWORK: RoadDefinition[] = GENERATED_ROADS.map((road) => ({ name: road.name, width: road.width, points: road.points }));
/** Off-road dirt tracks: rendered as narrow unpaved strips, not part of the nav graph. */
export const TRACK_NETWORK: RoadDefinition[] = GENERATED_TRACKS.map((track) => ({ name: track.name, width: track.width, points: track.points }));
/** Footpaths and trails: rendered as worn desire lines. Outside the road index and every nav graph —
 *  see GENERATED_PATHS for why a metre and a half of trodden earth must not read as carriageway. */
export const PATH_NETWORK: RoadDefinition[] = GENERATED_PATHS.map((path) => ({ name: path.name, width: path.width, points: path.points }));
/** How much of a footpath's mapped width is actually bare earth. OSM gives every path the same
 *  nominal 3 u; a trodden line is nearer half that, and at full width they read as dirt roads. */
export const FOOTPATH_WIDTH_SCALE = 0.58;
/** Lift of the HIGHEST draped landuse sheet — the park/veld lawn. (Mine dumps and tilled fields
 *  drape lower, at 0.04, so a park laid over one still wins.) Every unpaved way has to be laid
 *  ABOVE this or the sheet paints over it — see TRACK_SURFACE_OFFSET. */
export const GROUND_COVER_LIFT = 0.05;
/**
 * Lift of the unpaved surfaces over the terrain, in world units.
 *
 * These must clear GROUND_COVER_LIFT. Dirt tracks used to sit at 0.04, one centimetre UNDER the 0.05
 * park/veld drape, so every track running through a green polygon was painted over by the lawn laid
 * on top of it — a quarter of all track length on the map, and most of the mountain two-tracks, which
 * live in the Melville Koppies parks the range was sited over. The stand at (-752,-2162) is a five-unit
 * Dirt track on the range with no dirt anywhere in a 28-unit transect; the identical track at
 * (-3326,2453), which is NOT in a park, renders. Footpaths are worse: 84% of their length is inside a
 * green polygon, so laying them below the drape would have shipped a footpath system that is invisible
 * exactly where footpaths are.
 *
 * Order, lowest first: ground cover 0.05 < footpath < dirt track < tar 0.15. So a road always wins
 * where one crosses a track, a track wins over a path, and both win over the lawn they cross.
 */
export const TRACK_SURFACE_OFFSET = 0.075;
export const FOOTPATH_SURFACE_OFFSET = 0.065;
/** Passenger rail lines: ballast + rails + sleepers, never driveable, outside every nav graph. */
export const RAILWAY_NETWORK: Array<{ name: string; points: RoadPoint[] }> =
  GENERATED_RAILWAYS.map((line) => ({ name: line.name, points: line.points }));
/** Rail-to-rail centre spacing (u) — reads as SA cape gauge at game scale. */
export const RAIL_GAUGE = 1.6;
/** Gravel ballast bed width (u). */
export const RAIL_BALLAST_WIDTH = RAILWAY_CORRIDOR_HALF_WIDTH * 2;

/**
 * GROUND-DRAPE ORDER, lowest first. Every sheet laid flat on the terrain competes for the same
 * millimetres, and the one laid lower simply disappears under the one laid higher:
 *
 *   0.04  mine dump / tilled field   0.05  park + veld lawn   0.065 footpath   0.075 dirt track
 *   0.09  RAIL BALLAST in the open   0.15  tar               0.162 junction paving
 *   0.185 road markings              0.21  RAIL BALLAST over tar    0.37 sidewalk    0.43 over pavement
 *
 * The rail bed is the one sheet with no fixed rung: it rides RAIL_SURFACE_CLEARANCE above whatever is
 * already laid where it is, so it wins everywhere without having to be higher than everything.
 *
 * The ballast used to be laid at 0.045 — five millimetres UNDER the 0.05 park/veld sheet, so every
 * stretch of line running through a green polygon was painted over by the lawn on top of it. That is
 * the identical defect PR #110 found in the dirt tracks (laid at 0.04, one centimetre under the same
 * sheet) and fixed for tracks and footpaths only; rail had it too and kept it. RAIL_BED_LIFT clears
 * the whole landuse stack, and clears the unpaved ways as well, so a track crossing a line reads as
 * running over the formation rather than through it.
 */
export const RAIL_BED_LIFT = 0.09;
/**
 * How far the formation rides above a PAVED surface it crosses — the tar of a carriageway (0.15, so
 * the bed lands at 0.21, above the 0.185 markings) or the raised pavement beside it (0.37 → 0.43).
 *
 * The old comment on buildRailways claimed level crossings "come free" because the bed rode just above
 * the tar. It did not: the bed sat 0.105 BELOW the tar and only the rails cleared it, by a single
 * centimetre, so a crossing rendered as two z-fighting metal slivers on bare asphalt.
 */
const RAIL_SURFACE_CLEARANCE = 0.06;
/** Ballast vertex pitch. Finer than ROAD_STRIP_SUBSTEP so the bed can follow the kerb step at a
 *  crossing instead of interpolating across it and sinking under the pavement. */
const RAIL_BED_SUBSTEP = 3;
/** Offsets railBedLift looks across for the surface it must clear — the bed's own half-width, on both
 *  axes, so the height it picks covers the whole strip rather than just the vertex it was asked about. */
const RAIL_BED_LIFT_PROBES: ReadonlyArray<readonly [number, number]> = [
  [RAILWAY_CORRIDOR_HALF_WIDTH, 0], [-RAILWAY_CORRIDOR_HALF_WIDTH, 0],
  [0, RAILWAY_CORRIDOR_HALF_WIDTH], [0, -RAILWAY_CORRIDOR_HALF_WIDTH],
];
/** Sleeper and rail-head heights above the ballast surface, whatever height the ballast is riding at. */
const SLEEPER_RISE = 0.03;
const RAIL_HEAD_RISE = 0.115;
/** How far back from the track a level crossing's stop bar is painted, clear of the ballast. */
const LEVEL_CROSSING_SETBACK = 6;

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
/** Only the streets immediately visible from the spawn block hold the loading gate. The rest of the
 *  1.5km building ring streams behind the menu, so players reach a responsive city much sooner. */
export const WARM_BUILDING_RANGE = 240;
/** Loading is the one safe moment to spend half a 60fps frame baking geometry. Normal traversal keeps
 *  the conservative 2ms budget above, while this turns hundreds of one-item frames into a short pass. */
export const WARM_BUILD_FRAME_BUDGET_MS = 8;
/** requestAnimationFrame pauses in background tabs and some headless browsers. A bounded fallback
 *  keeps required-world loading making progress without spinning or monopolising the main thread. */
export const WARM_BUILD_YIELD_FALLBACK_MS = 50;

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
    const offset = definition.width / 2 + ROADSIDE_OFFSET; // verge line, same setback as the roadside furniture
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

/** Pre-baked vehicle nav EDGES (see tools/bake): when installed before a City is constructed, its
 *  field initializer pairs them with live-resampled lane nodes instead of running buildVehicleNav —
 *  the edges are the expensive part (every junction turn is gated by on-tar sampling), while the
 *  nodes are a ~20ms resample of the road network. Bake determinism is held by bake.test.ts, so the
 *  adopted graph is exactly what the builder would have produced. The loader installs this before
 *  the City exists — it is never swapped mid-game. */
let bakedVehicleEdges: number[][] | undefined;
export function installBakedVehicleNav(edges: number[][]): void {
  bakedVehicleEdges = edges;
}

/** The baked-edge graph, or undefined when no bake is installed or the node count disagrees with
 *  this build's road network (a stale artifact — the live builder runs instead). */
function adoptBakedVehicleNav(): NavGraph | undefined {
  const edges = bakedVehicleEdges;
  if (!edges) return undefined;
  const nodes: NavPoint[] = [];
  for (const lane of buildCityNavPaths(ROAD_NETWORK).lanes) for (const point of lane.points) nodes.push({ x: point.x, z: point.z });
  if (nodes.length !== edges.length) return undefined;
  return { nodes, edges };
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

const BUILDING_PALETTES: Record<BuildingStyle, number[]> = {
  downtown: [0x9db1ba, 0xa3563f, 0xd0c4a4, 0x99a4a9, 0x93a9b0],
  'mixed-use': [0xc8b083, 0xa3563f, 0xd7c8a5, 0x7f9799, 0xb98a58, 0x8f6a55],
  'dense-residential': [0xb58a6c, 0xc6b899, 0xa66c54, 0xd4c6a9, 0x8d9a96, 0x9f785d],
  suburban: [0xdfb094, 0x8f4f3a, 0xe6d1a2, 0xa8bcc4, 0xa3563f],
  industrial: [0xa2a6a2, 0xb5924c, 0xb5a28c],
  estate: [0xe3d7bf, 0xd8cdb6, 0xcbbfa0, 0xe6d1a2, 0xdcc9a6],
  rural: [0xc7aa7b, 0x9d6b4e, 0xd0bd91, 0x8e9a87, 0xb8895f],
};

const GENERIC_AREA_NAMES = new Set(['park', 'grass', 'forest', 'wood', 'scrub', 'golf_course', 'nature_reserve', 'green', 'water', 'brownfield', 'mine_dump']);
const PARK_TREE_SPECIES = ['shade-tree', 'jacaranda', 'shade-tree', 'gum', 'pine'] as const;

/** One step of the staged city build: the label for the loading bar and the build fraction 0..1. */
export interface CityBuildStage { label: string; fraction: number }

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
  private buildingVisibleRange = BUILDING_VISIBLE_RANGE;
  private visibilityFocusX = 0;
  private visibilityFocusZ = 0;
  private buildingCells = new Map<string, THREE.Group>();
  private buildingColliderCells = new Set<string>();
  private buildQueue: Array<[number, number]> = [];
  private queuedCells = new Set<string>();
  /** The cell currently being baked, a few buildings at a time, across frames (spreads the cost). */
  private pending?: { key: string; cellX: number; cellZ: number; specs: GeneratedBuilding[]; index: number; models: ScatteredModel[]; modelIndex: number; baker: GeometryBaker; colliders: Collider[]; trunks: TrunkProp[]; group: THREE.Group };
  /** Where the building meshes for the current build go (a per-building local group, rotated to face
   *  its street, then merged into the cell). Defaults to the root group for up-front geometry. */
  private target: THREE.Group = this.group;
  colliders: Collider[] = [];
  props = new PropRegistry();
  potholes: PotholeHazard[] = []; // road features, not props: no collider, cars rattle over them
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
  vehicleNav: NavGraph = adoptBakedVehicleNav() ?? buildVehicleNav(ROAD_NETWORK); // directed one-way lanes (left-hand); pedNav stays undirected
  pedNav: NavGraph = bridgeIslands(buildNavGraph(buildCityNavPaths(ROAD_NETWORK).walks, PED_NAV_JOIN));
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
  /** Current lit-window emissive level, so a facade material created mid-flight is born already lit
   *  (see setFacadeGlow). The day/night cycle owns the value; City only remembers it. */
  private facadeGlow = 0;
  private asphalt = createGeneratedSurfaceTexture('/textures/asphalt-gpt.jpg', 'asphalt', 1);
  private concrete = createGeneratedSurfaceTexture('/textures/concrete-gpt.jpg', 'concrete', 10);
  private foundationMaterial = new THREE.MeshStandardMaterial({ color: 0xb4b3aa, map: this.concrete, roughness: 0.92 });
  private neighbourhoodFoundationMaterials = new Map<string, { wall: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial }>();
  private foundationJointMaterial = new THREE.MeshStandardMaterial({ color: 0x343a39, map: this.concrete, roughness: 0.94 });
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
  // Unpaved ways tile ACROSS the strip: repeat (1, 2) puts one texture width edge-to-edge — which is
  // what keeps a farm track's two wheel ruts running down it instead of tiling into a chequerboard —
  // and one length every 9 u (createRoadStrip writes v = distance / 18).
  private dirtTrack = createTrackSurfaceTexture('track', 2);
  private footpath = createTrackSurfaceTexture('path', 2);
  private footpathAlpha = createFootpathAlphaTexture(2);
  /** The dam bed's own map — near-neutral, so the vertex palette in coast.ts reaches the screen
   *  unmultiplied instead of being re-tinted golden by the beach sand texture (see C5).
   *  Repeat 1, NOT 14: buildBeach writes uv = world/9, so 14 tiled the grain every 64 cm and the
   *  whole shore averaged out to one flat fill — from a roof at Misty Bay the beach had literally no
   *  texture in it, which is most of why the band read as a painted desert rather than as ground. */
  private damBed = createSurfaceTexture('dambed', 1);
  private facades = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeTexture(style));
  private facadeGlows = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeGlowTexture(style));
  private roofMaterial = new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, metalness: 0.08 });
  private waterSites: WaterSite[] = [];
  private waterHandle?: WaterHandle;
  private waterMood?: { hour: number; sun: THREE.Vector3; color: THREE.Color };
  private architecture: BuildingArchitecture;
  private infrastructure!: UrbanInfrastructure; // assigned in buildStages (constructor drains it, or the staged boot walks it)
  private parkTreeSites: Array<{ x: number; z: number; seed: number }> = [];
  private treeAssetsInstalled = false;

  /** `staged: true` skips the build here so an async caller can walk buildStages() itself,
   *  yielding to the frame loop between stages (loading bar moves, watchdogs stay happy).
   *  The default drains synchronously — tests and tools construct a finished city in one call. */
  constructor(scene: THREE.Scene, quality: BaseQuality = 'medium', staged = false) {
    bootMark('city: fields ready'); // field initializers above already built nav graphs + textures
    this.group.name = 'Joburg'; scene.add(this.group);
    this.architecture = new BuildingArchitecture(this.group);
    if (!staged) for (const stage of this.buildStages(quality)) void stage;
  }

  /** The city build as labelled stages: each yield announces the work the NEXT next() performs
   *  and reports the build fraction (weights from measured stage cost). The two whole-map layout
   *  passes are themselves chunked, so no single next() blocks the thread for long. Labels feed
   *  the loading bar; bootMark timestamps feed the boot timeline / error card. */
  *buildStages(quality: BaseQuality): Generator<CityBuildStage> {
    yield { label: 'Surveying the parcels', fraction: 0 }; bootMark('city: parcels');
    for (const f of parcelStages()) yield { label: 'Surveying the parcels', fraction: f * 0.28 };
    yield { label: 'Scattering the veld', fraction: 0.28 }; bootMark('city: scatter');
    for (const f of scatterStages()) yield { label: 'Scattering the veld', fraction: 0.28 + f * 0.4 };
    yield { label: 'Grading the ground', fraction: 0.68 }; bootMark('city: ground'); this.buildGround();
    yield { label: 'Laying the roads', fraction: 0.69 }; bootMark('city: roads'); this.buildRoads();
    yield { label: 'Filling the dams', fraction: 0.85 }; bootMark('city: water'); this.buildWaterBodies();
    yield { label: 'Tracing the coast', fraction: 0.85 }; bootMark('city: coast'); this.buildCoast();
    yield { label: 'Planting the parks', fraction: 0.86 }; bootMark('city: parks'); this.buildParks();
    yield { label: 'Raising the landmarks', fraction: 0.87 }; bootMark('city: landmarks'); this.buildLandmarks();
    yield { label: 'Paving the airfield', fraction: 0.87 }; bootMark('city: airfield'); this.buildAirfield();
    yield { label: 'Building street infrastructure', fraction: 0.88 }; bootMark('city: infrastructure');
    this.infrastructure = new UrbanInfrastructure(
      this.group,
      this.chunkStore,
      this.detailStore,
      this.roadsidePoints,
      this.streetlampPoints,
      (x, z, radius) => this.collides(x, z, radius) || this.isReserved(x, z, radius)
        || distanceToRailwayCorridor(x, z) < radius + 0.6,
      (x, z, margin) => this.isOnRoad(x, z, margin),
      (point) => this.isPavementDrawn(point),
      this.props,
      // The surface actually DRAWN at (x, z) — not "pavement everywhere". sidewalkHeightAt is
      // terrain + ROAD_SURFACE_OFFSET + SIDEWALK_RISE unconditionally, with no test for whether any
      // paving exists there, while the paving ribbon stops at ROAD_BUILD_MARGIN. Every furniture pass
      // that steps outward off the verge line therefore stood on a slab that isn't drawn and hung a
      // full kerb height (0.37u = 50cm) above the grass under it. surfaceHeightAt answers honestly, so
      // the streetscape is grounded on the same surface the player and the peds walk on.
      (x, z) => this.surfaceHeightAt(x, z),
    );
    yield { label: 'Merging the city blocks', fraction: 0.91 }; bootMark('city: merge');
    mergeStaticGeometry(this.group, MERGE_CHUNK_SIZE, this.chunkStore); // water is built after the merge: its meshes stay live for per-frame animation
    yield { label: 'Filling the pools', fraction: 0.97 }; bootMark('city: water tier'); this.setWaterQuality(quality);
    bootMark('city: done');
  }

  /** Finish tree-dependent city construction only after loadTreeLibrary() validates the required GLB.
   *  Park trees join the normal merged world chunks; roadside trees retain per-variant instancing. */
  installTreeAssets(): void {
    if (this.treeAssetsInstalled) return;
    const parks = new THREE.Group(); parks.name = 'Authored park trees'; this.group.add(parks);
    for (const site of this.parkTreeSites) this.addParkTree(site.x, site.z, site.seed, parks);
    mergeStaticGeometry(parks, MERGE_CHUNK_SIZE, this.chunkStore);
    parks.removeFromParent();
    this.infrastructure.installTreeAssets();
    this.treeAssetsInstalled = true;
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
    // Grid lookup instead of scanning all signalised junctions per car per frame: each junction is bucketed into
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

  /** True when a signalised junction is within `radius`. Reuses the robot grid so blackout traffic
   *  does not linearly scan every city signal for every active vehicle on every simulation step. */
  signalNearby(position: THREE.Vector3, radius = 24): boolean {
    const cells = (this.signalCells ??= this.buildSignalIndex());
    const cx = Math.floor(position.x / SIGNAL_CELL); const cz = Math.floor(position.z / SIGNAL_CELL);
    const reach = Math.max(0, Math.ceil(radius / SIGNAL_CELL)); const radiusSq = radius * radius;
    for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
      const bucket = cells.get(`${cx + dx},${cz + dz}`);
      if (bucket?.some((junction) => (junction.x - position.x) ** 2 + (junction.z - position.z) ** 2 < radiusSq)) return true;
    }
    return false;
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

  /** Quality-tier streaming rings, changeable live: the staggered culling walk re-evaluates every
   *  chunk against the new ranges within a few frames, no rebuild. Potato passes the pulled-in
   *  pair; every other tier restores the defaults. */
  setStreamRanges(world: number, detail: number, buildings = BUILDING_VISIBLE_RANGE): void {
    this.chunkCulling.setRange(world);
    this.detailCulling.setRange(detail);
    this.buildingVisibleRange = buildings;
    // A live tier change must not finish the old wider queue after its budget has been pulled inward.
    this.buildQueue = this.buildQueue.filter(([cx, cz]) => cellDistance(this.visibilityFocusX, this.visibilityFocusZ, cx, cz, MERGE_CHUNK_SIZE) <= buildings);
    this.queuedCells = new Set(this.buildQueue.map(([cx, cz]) => `${cx},${cz}`));
  }

  /** Frame-budgeted distance culling: chunks near the focus join the scene, far ones detach (with
   *  hysteresis). Geometry is kept in memory, so re-entering a chunk costs nothing. Colliders, nav
   *  graphs, the minimap and the map overlay are data, not scene geometry — culling never touches
   *  them. Water stays global: each surface is a bounded per-site mesh that frustum culling already
   *  handles, and the premium dams double as the always-visible distant-water representation.
   *  Model streaming can be held behind the required-asset loading gate while static chunks cull. */
  updateVisibility(focus: THREE.Vector3, streamModels = true): void {
    this.visibilityFocusX = focus.x; this.visibilityFocusZ = focus.z;
    this.chunkCulling.update(focus.x, focus.z);
    this.detailCulling.update(focus.x, focus.z);
    this.infrastructure.updateVisibility(focus.x, focus.z);
    if (streamModels) this.updateBuildingChunks(focus.x, focus.z);
  }

  /** Build the player's immediate neighbourhood before play begins. The wider city keeps streaming under
   *  the normal frame budget, but these closest cells are ready before the loading gate opens. */
  async warmInitialBuildings(focus: THREE.Vector3, onProgress: (complete: number, total: number) => void): Promise<void> {
    const range = Math.min(WARM_BUILDING_RANGE, this.buildingVisibleRange);
    const targets = cellsWithinRange(focus.x, focus.z, range, MERGE_CHUNK_SIZE).map((cell) => cell.key);
    const readyCount = (): number => targets.reduce((count, key) => count + Number(this.buildingCells.has(key)), 0);
    let complete = readyCount(); onProgress(complete, targets.length);
    while (complete < targets.length) {
      this.updateBuildingChunks(focus.x, focus.z, WARM_BUILD_FRAME_BUDGET_MS);
      complete = readyCount(); onProgress(complete, targets.length);
      if (complete < targets.length) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true; clearTimeout(fallback); resolve();
          };
          const fallback = setTimeout(done, WARM_BUILD_YIELD_FALLBACK_MS);
          requestAnimationFrame(done);
        });
      }
    }
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

  /**
   * Window glow for every facade material there is, and for every facade material there ever will be.
   *
   * D4, "large empty unlit areas". Facade materials are created LAZILY, one per `style-facadeIndex`
   * pair, the first time a chunk containing that pair is streamed in — and DayNight used to take a
   * one-time snapshot of the map at construction and walk that array every frame. Anything whose
   * style/variant pair had not been built by the time the day/night cycle came up therefore had its
   * emissiveIntensity left at the 0 it was constructed with, permanently: dark windows at midnight,
   * for good, however long you stood there.
   *
   * And the map is EMPTY when DayNight is constructed — building chunks stream in afterwards — so the
   * snapshot was a zero-length array and the loop over it did nothing at all. Counted in-engine
   * (tools/qa/shore/facades.py): 0 facade materials at boot, still 0 after two teleports, 19 by the
   * time the tour reached the third town. Not one window in the world had ever lit up. On the dam
   * shore at 22:00, pixels over 120/255 go from 0.01% of the frame to 2.85% once the level is pushed
   * instead of the list walked; those towns had been rendering as unlit black slabs.
   *
   * Storing the level instead of the list fixes both halves: existing materials are updated here, and
   * a material born later is constructed already carrying it (see the facade cache in buildBuilding).
   */
  setFacadeGlow(intensity: number): void {
    this.facadeGlow = intensity;
    for (const material of this.buildingMaterial.values()) material.emissiveIntensity = intensity;
  }

  streetlightLampsXZ(): Float32Array { return this.infrastructure.lampsXZ; }

  setStreetlightGlow(factor: number): void { this.infrastructure.setLampGlow(factor); }

  isPark(x: number, z: number): boolean {
    return GREEN_POLYGONS.some((polygon) => pointInPolygon(polygon, x, z));
  }

  /** Standing in real water — see the module-level `inWater`. */
  isWater(x: number, z: number): boolean { return inWater(x, z); }

  /** Anchor pads (spawn, shops, mission markers…) that procedural placement must keep clear. */
  isReserved(x: number, z: number, radius: number): boolean {
    return RESERVED_PADS.some((pad) => (pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2)
      || RAILWAY_STATION_SITES.some((station) => (station.x - x) ** 2 + (station.z - z) ** 2 < (RAILWAY_STATION_CLEARANCE + radius) ** 2);
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

  /** Whether the building/scatter chunk cell under a point has actually been BUILT this session.
   *  Doors derive from map data, not geometry, so a doorway can otherwise offer a prompt on a
   *  building that is not there yet — E on a steel frame standing on bare sand teleported the player
   *  into the interior of an invisible building. The interiors rung gates its offer on this. */
  hasBuiltStructuresAt(x: number, z: number): boolean {
    return this.buildingCells.has(`${Math.floor(x / MERGE_CHUNK_SIZE)},${Math.floor(z / MERGE_CHUNK_SIZE)}`);
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

  /** True when the pavement ribbon is actually DRAWN alongside this roadside point.
   *  createClippedSidewalkStrip removes the strip's WHOLE width for the span in which a crossing road
   *  touches any of its three lateral probes, so "inside the sidewalk band" (isOnSidewalk, a band query
   *  that knows nothing about the clip) is not the same as "there is paving here": beside a crossing there
   *  is a notch of bare ground that every height query still reports at pavement level. A prop grounded on
   *  the pavement plane inside one of those hangs a kerb height above the grass, so the furniture that
   *  relies on the slab being there asks this first. Same three lateral probes and same 0.035 margin as the
   *  clip, and the clip bisects its own edges to ~0.006u, so a point test is as exact as the ribbon.
   *  Cheap enough for a placement pass: three grid lookups, no geometry. */
  isPavementDrawn(point: RoadsidePoint): boolean {
    for (const lateral of [SIDEWALK_INNER_EDGE, SIDEWALK_CENTER, SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH]) {
      const step = ROADSIDE_OFFSET - lateral; // the roadside point sits at ROADSIDE_OFFSET; inward runs at the carriageway
      if (this.isOnRoad(point.x + point.inwardX * step, point.z + point.inwardZ * step, 0.035)) return false;
    }
    return true;
  }

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
    const SEGMENTS = GROUND_SEGMENTS;
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
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.groundGrass, roughness: 0.96 });
    applySnowShader(groundMat, { snowY: SNOW_Y, rockY: SNOW_Y * 0.55 }); // veld → rock → snow up the northern range
    const ground = new THREE.Mesh(geometry, groundMat);
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
    // Unpaved ways. The track map already carries its own earth tone, so the tint stays near-white
    // rather than multiplying the ruts away. The footpath is alpha-TESTED, not blended: the fray has
    // to survive in the opaque pass, where it needs no depth sorting against the ground it lies on.
    const dirtMat = new THREE.MeshStandardMaterial({ color: 0xf2ece2, map: this.dirtTrack, roughness: 0.98 });
    dirtMat.name = 'dirt-track';
    const pathMat = new THREE.MeshStandardMaterial({
      color: 0xf2ece2, map: this.footpath, alphaMap: this.footpathAlpha, alphaTest: 0.5, roughness: 0.99,
    });
    pathMat.name = 'footpath';
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
      const strip = this.createRoadStrip(sampled, definition.width, dirtMat, TRACK_SURFACE_OFFSET, false);
      strip.receiveShadow = true; this.group.add(strip);
    }
    // Footpaths and trails: a desire line worn through the veld. Same draped strip as everything else
    // here, at a fraction of the mapped width and with a frayed alpha edge, and — unlike the tracks
    // above — never entered into the road index (see PATH_NETWORK). One shared material, so the
    // per-chunk merge collapses all 200-odd of them into one mesh per occupied cell.
    for (const definition of PATH_NETWORK) {
      const sampled = this.samplePath(definition.points, false, ROAD_SAMPLE_SPACING);
      const strip = this.createRoadStrip(sampled, definition.width * FOOTPATH_WIDTH_SCALE, pathMat, FOOTPATH_SURFACE_OFFSET, false);
      strip.receiveShadow = true; this.group.add(strip);
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

  /**
   * Lift of the rail formation over the terrain at (x, z).
   *
   * The bed rides a few centimetres above whatever surface is already laid there, and the game's own
   * surface query is what knows which surface that is: the tar on a carriageway, the raised pavement
   * on a footway, bare ground in the open. Expressed as a lift over the TERRAIN because that is what
   * the strip builder adds it to.
   *
   * Following the surface rather than picking a constant is what makes a level crossing whole. A fixed
   * lift tuned to clear the tar still leaves the track buried under the 0.37 pavement on both kerbs, so
   * the crossing renders as a carriageway of visible track with the rails vanishing at each kerb —
   * a smaller version of the same "partially covered" complaint.
   */
  private railBedLift(x: number, z: number): number {
    // Taken as the HIGHEST surface within the bed's own half-width, not the one directly underfoot.
    // createRoadStrip carries heights only at the strip's two edges and interpolates between them, so
    // a vertex that has just cleared the tar would drag the whole cross-section down through the road
    // it is crossing — measured, the bed sagged to the marking layer for the last few units of every
    // shallow-angle crossing and z-fought with it. Reaching a corridor half-width outward also gives
    // the crossing a short raised approach, which is what a crossing has.
    let surface = this.surfaceHeightAt(x, z) - terrainHeightAt(x, z);
    for (const [ox, oz] of RAIL_BED_LIFT_PROBES) {
      const px = x + ox; const pz = z + oz;
      surface = Math.max(surface, this.surfaceHeightAt(px, pz) - terrainHeightAt(px, pz));
    }
    return Math.max(RAIL_BED_LIFT, surface + RAIL_SURFACE_CLEARANCE);
  }

  /** Passenger rail: a draped ballast strip with instanced sleepers and twin rails, laid above the
   *  landuse drapes it crosses and above the tar wherever it crosses a carriageway. */
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
      const bed = this.densifyPath(sampled, RAIL_BED_SUBSTEP, false);
      const ballast = this.createRoadStrip(bed, RAIL_BALLAST_WIDTH, ballastMat, (x, z) => this.railBedLift(x, z), false);
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
          matrix.compose(new THREE.Vector3(x, this.terrainHeightAt(x, z) + this.railBedLift(x, z) + RAIL_HEAD_RISE, z), quaternion, new THREE.Vector3(0.16, 0.14, length + 0.3));
          railTransforms.push(matrix.clone());
        }
        const sleepers = Math.max(1, Math.round(length / 2.6));
        for (let s = 0; s < sleepers; s++) {
          const t = (s + 0.5) / sleepers;
          const x = start.x + dx * t; const z = start.z + dz * t;
          matrix.compose(new THREE.Vector3(x, this.terrainHeightAt(x, z) + this.railBedLift(x, z) + SLEEPER_RISE, z), quaternion, new THREE.Vector3(2.4, 0.07, 0.55));
          sleeperTransforms.push(matrix.clone());
        }
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addInstanced(box, railMat, railTransforms, { receive: true });
    this.addInstanced(box, sleeperMat, sleeperTransforms, { receive: true });
    this.buildLevelCrossings();

    const platformMaterials = {
      concrete: new THREE.MeshStandardMaterial({ color: 0xb8b7ae, map: this.concrete, roughness: 0.94 }),
      tactile: new THREE.MeshStandardMaterial({ color: 0xe0b72f, roughness: 0.78 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x2f3a3e, metalness: 0.72, roughness: 0.38 }),
      roof: new THREE.MeshStandardMaterial({ color: 0x3c6772, metalness: 0.38, roughness: 0.5 }),
      seat: new THREE.MeshStandardMaterial({ color: 0x7a3f2e, roughness: 0.72 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x83aeb6, transparent: true, opacity: 0.42, roughness: 0.18, metalness: 0.08 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xffe6a3, emissive: 0xffd66f, emissiveIntensity: 1.7, roughness: 0.28 }),
    };
    registerPowered(platformMaterials.lamp, 0xffd66f, 0x292b2b);
    for (const station of RAILWAY_STATION_SITES) this.buildRailwayStation(station, platformMaterials);
  }

  /**
   * A stop bar painted across each approach of every place a line genuinely crosses a carriageway.
   *
   * These are the crossings the deconfliction deliberately did NOT design away: where rail and road
   * run together one of them gives, but where they cross at an angle the line has to get to the other
   * side, and a level crossing on a Metrorail line is honest Johannesburg. Marking the approaches is
   * what makes it read as a crossing from a car rather than as track lying loose over the tar.
   */
  private buildLevelCrossings(): void {
    if (RAILWAY_LEVEL_CROSSINGS.length === 0) return;
    const barMat = new THREE.MeshStandardMaterial({ color: 0xf2f0e6, roughness: 0.82 });
    const transforms: THREE.Matrix4[] = [];
    const matrix = new THREE.Matrix4();
    // Measured from roadHeightAt, which already carries ROAD_SURFACE_OFFSET — so this is the height
    // over the TAR, not over the terrain. Above the markings (which sit 0.035 over the tar) and below
    // the rail formation crossing it (RAIL_SURFACE_CLEARANCE, 0.06).
    const lift = 0.045;
    for (const crossing of RAILWAY_LEVEL_CROSSINGS) {
      for (const approach of [-1, 1]) {
        // Set back from the track along the ROAD, far enough to clear the ballast at any crossing angle.
        const x = crossing.x + crossing.roadDirX * approach * LEVEL_CROSSING_SETBACK;
        const z = crossing.z + crossing.roadDirZ * approach * LEVEL_CROSSING_SETBACK;
        if (distanceToRoadEdge(x, z) > 0) continue; // set back off the end of the road: no bar to paint
        const span = Math.min(crossing.roadHalf, 14); // one bar per approach lane group, never absurd
        const quaternion = this.surfaceSegmentQuaternion(
          x - crossing.roadDirZ * span, z + crossing.roadDirX * span,
          x + crossing.roadDirZ * span, z - crossing.roadDirX * span, 'road',
        );
        matrix.compose(
          new THREE.Vector3(x, this.roadHeightAt(x, z) + lift, z), quaternion,
          new THREE.Vector3(STOP_LINE_DEPTH, 0.02, span * 2),
        );
        transforms.push(matrix.clone());
      }
    }
    this.addInstanced(new THREE.BoxGeometry(1, 1, 1), barMat, transforms, { receive: true });
  }

  /** Two level, walkable platforms with tactile edges, shelters, benches, lights, and station signs.
   *  Sites are projected onto a real rail segment in mapData, keeping every platform track-aligned. */
  private buildRailwayStation(
    station: (typeof RAILWAY_STATION_SITES)[number],
    materials: {
      concrete: THREE.Material; tactile: THREE.Material; metal: THREE.Material; roof: THREE.Material;
      seat: THREE.Material; glass: THREE.Material; lamp: THREE.Material;
    },
  ): void {
    const heading = Math.atan2(station.dirX, station.dirZ);
    const c = Math.cos(heading); const s = Math.sin(heading);
    const length = stationPlatformLength(station.name);
    const width = STATION_PLATFORM_WIDTH; const offset = STATION_PLATFORM_OFFSET;
    const toWorld = (lx: number, lz: number): RoadPoint => ({
      x: station.x + lx * c + lz * s,
      z: station.z - lx * s + lz * c,
    });
    let hMin = Infinity; let hMax = -Infinity;
    for (const side of [-1, 1]) {
      for (const lx of [side * (offset - width / 2), side * (offset + width / 2)]) {
        for (const lz of [-length / 2, 0, length / 2]) {
          const point = toWorld(lx, lz); const height = terrainHeightAt(point.x, point.z);
          hMin = Math.min(hMin, height); hMax = Math.max(hMax, height);
        }
      }
    }
    const baseY = hMax + 0.03; const platformTop = 0.32;
    const platformBottom = hMin - baseY - 0.14; const platformHeight = platformTop - platformBottom;
    const group = new THREE.Group(); group.name = station.name;
    group.position.set(station.x, baseY, station.z); group.rotation.y = heading;

    for (const side of [-1, 1]) {
      const platformX = side * offset;
      // Last resort only. Siting already slid this stop along its line to a spot where both slabs fit
      // (platformSideFits, measured against the road AS BUILT), so a side is dropped here only where no
      // such spot exists anywhere within the slide limit — a station wedged in the CBD grid with a
      // carriageway hard against the track. Anything that reads as a half-built station means siting
      // failed, not that this test is too strict.
      if (!platformSideFits(station.x, station.z, station.dirX, station.dirZ, side as 1 | -1, length)) continue;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(width, platformHeight, length), materials.concrete);
      slab.position.set(platformX, (platformTop + platformBottom) / 2, 0); slab.receiveShadow = true; group.add(slab);
      const edgeX = side * (offset - width / 2 + 0.16);
      const tactile = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.045, length - 1), materials.tactile);
      tactile.position.set(edgeX, platformTop + 0.025, 0); tactile.receiveShadow = true; group.add(tactile);

      const roof = new THREE.Mesh(new THREE.BoxGeometry(width - 0.55, 0.2, 21), materials.roof);
      roof.position.set(platformX, 3.45, 0); roof.castShadow = true; group.add(roof);
      for (const z of [-8.5, 0, 8.5]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.13, 3.15, 0.13), materials.metal);
        post.position.set(platformX, 1.8, z); post.castShadow = true; group.add(post);
      }
      for (const z of [-6.2, 6.2]) {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.05, 4.2), materials.glass);
        pane.position.set(side * (offset + width / 2 - 0.18), 1.42, z); group.add(pane);
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.14, 2.2), materials.seat);
        seat.position.set(platformX, 0.86, z); seat.castShadow = true; group.add(seat);
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.82, 2.2), materials.seat);
        back.position.set(side * (offset + 0.34), 1.2, z); back.castShadow = true; group.add(back);
      }

      const nameBoard = createSignMesh(
        new THREE.PlaneGeometry(5.8, 1.25), station.name.toUpperCase(), '#e0b72f',
        { background: '#183b46', doubleSide: true, powered: true },
      );
      nameBoard.position.set(platformX, 2.45, -7.5); nameBoard.rotation.y = Math.PI / 2; group.add(nameBoard);
      for (const z of [-length / 2 + 4, length / 2 - 4]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 3.6, 10), materials.metal);
        pole.position.set(platformX, 2.1, z); pole.castShadow = true; group.add(pole);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), materials.lamp);
        lamp.position.set(platformX, 3.93, z); group.add(lamp);
      }

      this.colliders.push(this.tierToWorldCollider(
        { minX: platformX - width / 2, maxX: platformX + width / 2, minZ: -length / 2, maxZ: length / 2, y0: platformBottom, y1: platformTop },
        station.x, station.z, heading, baseY,
      ));
    }
    this.group.add(group);
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
    // Walked as ROUTES rather than as the flat roadPoints list (which is exactly these routes
    // concatenated) purely so each hole can read the bearing of the lane it sits in: PotholeShape
    // stretches it along the traffic that broke the tar, and that is the one thing about a hole's
    // shape that its own coordinates cannot tell you.
    for (const route of this.trafficRoutes) {
      for (let index = 0; index < route.length; index++) {
        const point = route[index]!;
        if (seeded(point.x, point.z, 55) <= 0.96) continue;
        const x = point.x + (seeded(point.x, point.z, 56) - 0.5) * 3;
        const z = point.z + (seeded(point.x, point.z, 57) - 0.5) * 3;
        if (!this.isOnRoad(x, z, -2)) continue;
        if (CITY_JUNCTIONS.some((junction) => Math.hypot(x - junction.x, z - junction.z) < 16)) continue;
        const back = route[Math.max(0, index - 1)]!; const forward = route[Math.min(route.length - 1, index + 1)]!;
        const runX = forward.x - back.x; const runZ = forward.z - back.z;
        this.potholes.push({
          x, z,
          r: 1.1 + seeded(point.x, point.z, 58) * 0.9,
          axis: runX === 0 && runZ === 0 ? 0 : Math.atan2(runZ, runX),
        });
      }
    }
    // Each pothole is DRAPED onto the road surface (every vertex sampled at roadHeightAt) rather than a flat
    // disc laid at its centre's height — so on a slope, or across a crease where the tar steps to a steeper
    // pitch, it hugs the surface instead of the road rising up and swallowing half of it. Double-sided so
    // winding never culls them; merged into two meshes so they fold into the chunked road buckets.
    const holeParts: THREE.BufferGeometry[] = []; const rimParts: THREE.BufferGeometry[] = [];
    for (const pothole of this.potholes) {
      holeParts.push(this.drapedPotholeDisc(pothole, 0.03));
      const rim = this.drapedPotholeRing(pothole, 0.036);
      if (rim) rimParts.push(rim);
    }
    if (!holeParts.length) return;
    const holeMesh = new THREE.Mesh(mergeGeometries(holeParts, false), new THREE.MeshBasicMaterial({ color: 0x0d1113, side: THREE.DoubleSide }));
    this.group.add(holeMesh);
    if (!rimParts.length) return;
    const rimMesh = new THREE.Mesh(mergeGeometries(rimParts, false), new THREE.MeshBasicMaterial({ color: 0x3f4649, side: THREE.DoubleSide }));
    this.group.add(rimMesh);
  }

  /** A pothole's dark shape: a fan of POTHOLE_SEGMENTS wedges, every vertex draped onto the road so it
   *  follows slopes and crease transitions instead of a flat plane the tar swallows. The fan's outer
   *  edge rides PotholeShape's outline rather than a constant radius, so the silhouette the player
   *  sees is the same irregular edge Game and JoziFlowSystem measure their clearances against.
   *
   *  The disc used to carry a second ring at 0.55r to sharpen the drape. Measured across all 1361
   *  potholes, the terrain pokes through the fan on 10 of them against 4 with the extra ring — the
   *  median hole sits inside one terrain-grid triangle, where the surface is planar and the ring buys
   *  exactly nothing. It cost 40 triangles on every hole in the city to rescue six, so it is gone and
   *  the budget went into the silhouette instead. */
  private drapedPotholeDisc(hole: PotholeHazard, lift: number): THREE.BufferGeometry {
    const SEG = POTHOLE_SEGMENTS;
    const positions: number[] = [hole.x, this.roadHeightAt(hole.x, hole.z) + lift, hole.z]; // centre = index 0
    for (let s = 0; s < SEG; s++) {
      const ang = (s / SEG) * Math.PI * 2; const rad = potholeVertexRadius(hole, s);
      const x = hole.x + Math.cos(ang) * rad; const z = hole.z + Math.sin(ang) * rad;
      positions.push(x, this.roadHeightAt(x, z) + lift, z);
    }
    const indices: number[] = [];
    for (let s = 0; s < SEG; s++) { const s1 = (s + 1) % SEG; indices.push(0, 1 + s, 1 + s1); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
    return geometry;
  }

  /** A pothole's broken-tar collar, draped onto the road like the shape it surrounds. Its width varies
   *  around the circumference and closes entirely where the tar still holds: those segments emit no
   *  quad at all rather than a degenerate one, which is what pays for the finer tessellation. Returns
   *  null when a hole's collar closes the whole way round. */
  private drapedPotholeRing(hole: PotholeHazard, lift: number): THREE.BufferGeometry | null {
    const SEG = POTHOLE_SEGMENTS; const positions: number[] = []; const indices: number[] = [];
    const spans: number[] = [];
    for (let s = 0; s < SEG; s++) {
      const ang = (s / SEG) * Math.PI * 2; const c = Math.cos(ang); const sn = Math.sin(ang);
      const rim = potholeRimAt(hole, s); spans.push(rim.outer - rim.inner);
      for (const rad of [rim.inner, rim.outer]) { const x = hole.x + c * rad; const z = hole.z + sn * rad; positions.push(x, this.roadHeightAt(x, z) + lift, z); }
    }
    for (let s = 0; s < SEG; s++) {
      const s1 = (s + 1) % SEG;
      if (spans[s]! < RIM_MIN_SPAN * hole.r && spans[s1]! < RIM_MIN_SPAN * hole.r) continue;
      const a = s * 2; const b = s * 2 + 1; const c = s1 * 2; const d = s1 * 2 + 1; indices.push(a, c, b, b, c, d);
    }
    if (!indices.length) return null;
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
      const offset = side * (width / 2 + ROADSIDE_OFFSET); const path = this.offsetPath(points, offset, closed);
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

  /** `y` may be a per-point lift, for a strip whose height over the terrain varies along its run
   *  (the rail formation, which rides higher across a carriageway than it does through the veld). */
  private createRoadStrip(input: RoadPoint[], width: number, material: THREE.Material, y: number | ((x: number, z: number) => number), closed: boolean): THREE.Mesh {
    const points = this.densifyPath(input, ROAD_STRIP_SUBSTEP, closed); // hug the relief between the coarse nav samples
    const vertices: number[] = []; const uvs: number[] = []; const indices: number[] = []; let distance = 0;
    const sides = this.offsetPath(points, width / 2, closed); const opposite = this.offsetPath(points, -width / 2, closed);
    const liftAt = typeof y === 'function' ? y : (): number => y;
    // A FIXED raised lift is sunk back to tar level where the strip lies on a carriageway, so a raised
    // surface cannot stand proud in the middle of a road. A PER-POINT lift is the caller doing that
    // arithmetic itself — the rail formation deliberately rides over the tar at a level crossing — so
    // it is taken as given.
    const sinkOnRoad = typeof y !== 'function';
    for (let index = 0; index < points.length; index++) {
      if (index > 0) { const previous = points[index - 1]; const point = points[index]; if (previous && point) distance += Math.hypot(point.x - previous.x, point.z - previous.z); }
      const left = sides[index]; const right = opposite[index]; if (!left || !right) continue;
      const leftLift = liftAt(left.x, left.z); const rightLift = liftAt(right.x, right.z);
      const leftOffset = sinkOnRoad && leftLift > ROAD_SURFACE_OFFSET && this.isOnRoad(left.x, left.z) ? ROAD_SURFACE_OFFSET : leftLift;
      const rightOffset = sinkOnRoad && rightLift > ROAD_SURFACE_OFFSET && this.isOnRoad(right.x, right.z) ? ROAD_SURFACE_OFFSET : rightLift;
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

  /** The Vaalpunt Dam graft: a dark bed, the reservoir registered as one premium far-water site
   *  (planar mirror on high, cheaper tiers below), a drivable sand/rock shore along the waterline, and
   *  a small harbour apron. Built before the static merge so seabed/shore/apron chunk-cull with the rest;
   *  the ocean surface itself is a live water site (see buildWaterBodies' premium dams). */
  private buildCoast(): void {
    if (!OCEAN_POLYGON) return;

    // The ocean surface: one huge premium water site. Its shape is shoved BEACH_WATER_INLAND past the
    // shoreline so the water laps up INTO the sloping sand — as the waves rise and fall, the waterline runs
    // in and out over the slope like a tide. The sandy sea floor is the terrain itself (see buildBeach and
    // analyticTerrainHeightAt's continuous slope), so there's no flat seabed plane to z-fight the swell.
    //
    // The RENDERED outline is not the mapgen polygon: mapgen closes the dam ~4.2 km past the west edge,
    // which is inside the fog AND inside the camera's far plane, so the closure showed from the shore as
    // a dead-level water/sky line. farWaterOutline keeps the real shoreline and carries the far side out
    // past the far plane instead (see coast.ts). OCEAN_POLYGON itself is untouched — areas, stats and the
    // minimap still read the surveyed polygon.
    // width/depth/centre stay the SURVEYED dam: they drive the planar mirror's proximity throttle
    // (Water.reflectorShouldRender), and a bounding rect stretched to the horizon would hold the
    // mirror at full rate from every street in the city.
    const ocean = OCEAN_POLYGON;
    this.waterSites.push({
      kind: 'ocean', x: ocean.cx + BEACH_WATER_INLAND, y: OCEAN_Y, z: ocean.cz,
      width: ocean.maxX - ocean.minX, depth: ocean.maxZ - ocean.minZ,
      shape: farWaterOutline(COASTLINE, WORLD_SIZE / 2, WATER_HORIZON_CLEARANCE, WATER_HORIZON_BLEND, BEACH_WATER_INLAND),
    });

    this.buildBeach();
    this.buildBeachfront();
  }

  /** The dam bed and its drawdown strand: a single draped sheet from the grass line out to the west
   *  map edge, stuck to the terrain (which slopes from +BEACH_TOP_Y down to SEA_FLOOR_Y). Vertex-
   *  coloured rather than uniformly golden — silt below the waterline, a bleached bathtub ring right
   *  above it, pale drawdown grit above that, and proper resort sand ONLY inside the beach z-bands
   *  (see coast.ts shoreColourAt). A reservoir that swings between near-empty and 102% full looks
   *  like this; a seaside does not. */
  private buildBeach(): void {
    if (COASTLINE.length < 2 || !OCEAN_POLYGON) return;
    const bands = beachBands(BEACH_POLYGONS);
    const half = WORLD_SIZE / 2;
    // THE SHEET NOW LIVES ON THE GROUND MESH'S OWN LATTICE. It used to be a 45 x 26 unit fan between
    // the map edge and a per-latitude crest, i.e. a second triangulation of the same terrain at a
    // different pitch — so wherever the ground was convex the sheet's chords cut the corner and sank
    // beneath it, and the golden DRY-VELD ground poked up through the shore in hard-edged wedges.
    // That, not the palette, is what "the shore renders golden" was: measured in-engine, the pixel at
    // the player's feet on the strand was rgb(216,196,125), hue 47, saturation 0.42 — and repainting
    // every vertex of the sheet did not change it by one unit, because the sheet was not what you were
    // looking at. Sharing the lattice makes the two surfaces agree at every vertex, so a small lift
    // is enough to settle the order for good.
    const step = WORLD_SIZE / GROUND_SEGMENTS;
    // The painted band is WIDE at the two resorts and NARROW everywhere else (see STRAND_PAINT_INLAND):
    // one lookup by z, used both for how far the paint ramps and for how far the sheet is worth drawing.
    // Past the sheet the ordinary ground mesh takes over, with its grass texture and its own colour —
    // which is the point, because the sheet's dambed grain is exposed lake bed and the veld is not.
    const paintInland = (z: number): number => (isSandZ(z, bands) ? BEACH_INLAND : STRAND_PAINT_INLAND);
    const paintBlend = (z: number): number => (isSandZ(z, bands) ? SHORE_VELD_BLEND : STRAND_PAINT_BLEND);
    const paintLimit = (z: number): number => paintInland(z) + paintBlend(z);
    const inlandLimit = Math.max(BEACH_INLAND + SHORE_VELD_BLEND, STRAND_PAINT_INLAND + STRAND_PAINT_BLEND);
    const i0 = -Math.ceil(BED_OFFMAP_OVERHANG / step);
    const j0 = -Math.ceil(BED_Z_OVERRUN / step);
    const j1 = GROUND_SEGMENTS - j0;
    // East limit: the furthest east the water reaches, plus the whole inland band, in whole cells.
    const i1 = Math.min(GROUND_SEGMENTS, Math.ceil((OCEAN_POLYGON.maxX + inlandLimit + half) / step) + 1);
    const cols = i1 - i0 + 1;
    const gx = (i: number): number => -half + i * step;
    /** Signed distance to the waterline and the inland fade, per lattice point (built once, reused). */
    const dist = new Float32Array(cols * (j1 - j0 + 1));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) dist[(j - j0) * cols + (i - i0)] = damSignedDistance(gx(i), gx(j)) + WATERLINE_OFFSET;
    }
    const at = (i: number, j: number): number => dist[(j - j0) * cols + (i - i0)]!;
    // A cell is drawn when any corner is inside the shore band, or when it is off the west edge (past
    // the square there is no ground mesh at all, so the sheet is the only thing covering the bed).
    const wanted = (i: number, j: number): boolean => {
      if (i < i0 || j < j0 || i >= i1 || j >= j1) return false;
      if (gx(i) < -half || gx(j) < -half || gx(j + 1) > half) return true;
      const limit = Math.max(paintLimit(gx(j)), paintLimit(gx(j + 1)));
      return at(i, j) < limit || at(i + 1, j) < limit
        || at(i, j + 1) < limit || at(i + 1, j + 1) < limit;
    };
    const positions: number[] = []; const uvs: number[] = []; const colors: number[] = []; const indices: number[] = [];
    const index = new Map<number, number>();
    const vertex = (i: number, j: number): number => {
      const key = (i - i0) * 100000 + (j - j0);
      const found = index.get(key); if (found !== undefined) return found;
      const x = gx(i); const z = gx(j);
      // Inside the square the captured grid IS this lattice, so terrainHeightAt returns the ground
      // mesh's own vertex height exactly; outside it the grid clamps, so use the analytic profile.
      const inGrid = x >= -half && x <= half && z >= -half && z <= half;
      const y = inGrid ? terrainHeightAt(x, z) : analyticTerrainHeightAt(x, z);
      const d = at(i, j);
      const fade = Math.min(1, Math.max(0, (d - paintInland(z)) / paintBlend(z)));
      const id = positions.length / 3;
      positions.push(x, y + BED_SHEET_LIFT, z); uvs.push(x / 9, z / 9);
      const [cr, cg, cb] = shoreColourAt(y, z, OCEAN_Y, bands, fade);
      colors.push(cr, cg, cb);
      index.set(key, id);
      return id;
    };
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      if (!wanted(i, j)) continue;
      const a = vertex(i, j); const b = vertex(i + 1, j); const c = vertex(i, j + 1); const e = vertex(i + 1, j + 1);
      indices.push(a, b, c, b, e, c);
    }
    if (indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const normals = geometry.attributes.normal.array; let sumY = 0;
    for (let i = 1; i < normals.length; i += 3) sumY += normals[i]!;
    if (sumY < 0) { for (let i = 0; i < indices.length; i += 3) { const t = indices[i]!; indices[i] = indices[i + 2]!; indices[i + 2] = t; } geometry.setIndex(indices); geometry.computeVertexNormals(); }
    // White base colour AND a near-neutral map: the vertex colours ARE the palette, and BOTH the
    // tint and the texture multiply into them. Using the golden beach `sand` map here was the whole
    // of C5 — it pushed the shore from grey-brown (saturation ~0.19) to golden (~0.57).
    // polygonOffset is the belt to the shared lattice's braces: 0.022 of a unit is thin cover at
    // 2 km, so bias the depth as well and let the shore win the tie at every distance.
    const sand = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, map: this.damBed, roughness: 0.97,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    sand.receiveShadow = true; sand.userData.far = true; // the always-visible dam bed, carries to the horizon
    this.group.add(sand);
  }

  /** The dam-front manicure (replaces the old placeholder harbour slab): the Deneys Quay
   *  pleasure pier + paved quay forecourt, water's-edge venue strips at the quay and Leboya Baai,
   *  beach clutter (loungers, lifeguard tower, towels) and moored boats — all placed from the
   *  pure plan in beachfront.ts, whose pads CityGen/ModelScatter already keep clear. Venues and
   *  clutter reuse the catalog path (buildOneModel) so slope plinths + oriented colliders come
   *  for free; boats float at the waterline instead of sitting on the seabed terrain. */
  private buildBeachfront(): void {
    const plan = BEACHFRONT;
    if (plan.apron) { // paved quay forecourt draped over the shore terrain
      const { minX, maxX, minZ, maxZ } = plan.apron;
      const polygon: MapPolygon = {
        name: 'Deneys Quay apron', kind: 'beach', minX, maxX, minZ, maxZ,
        points: [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }],
        cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, area: (maxX - minX) * (maxZ - minZ),
      };
      this.addGroundCover(polygon, new THREE.MeshStandardMaterial({ color: 0x9c9a90, map: this.concrete, roughness: 0.92 }), 0.07);
    }
    if (plan.pier) {
      const { x, z, length, width, sign } = plan.pier;
      const heading = Math.PI / 2; // entrance (local +z) faces east onto the quay; the deck runs west over the water
      const pier = buildPleasurePier(Math.floor(seeded(x, z, 55) * 1e6), { length, width, sign });
      pier.group.position.set(x, 0, z); pier.group.rotation.y = heading;
      this.group.add(pier.group);
      for (const tier of pier.tiers) this.colliders.push(this.tierToWorldCollider(tier, x, z, heading, 0));
    }
    for (const spot of [...plan.venues, ...plan.clutter]) {
      const { group, colliders, trunk } = this.buildOneModel(spot);
      this.group.add(group); this.colliders.push(...colliders);
      if (trunk) this.props.register('tree', trunk.x, trunk.z, trunk.radius, trunk.height); // built once, never streamed
    }
    for (const boat of plan.boats) {
      const built = buildModel(boat.name, boat.seed, { variant: boat.variant });
      built.group.position.set(boat.x, OCEAN_Y + 0.03, boat.z); built.group.rotation.y = boat.heading;
      this.group.add(built.group);
      for (const tier of built.tiers) this.colliders.push(this.tierToWorldCollider(tier, boat.x, boat.z, boat.heading, OCEAN_Y));
    }
    if (plan.towels.length) { // bright towels: one instanced batch per colour on the dry sand
      const towelGeometry = new THREE.BoxGeometry(1, 1, 1);
      const colors = [0xd9634a, 0x3e8ca8, 0xe0c23c, 0xd88ab0];
      const byColor: THREE.Matrix4[][] = colors.map(() => []);
      const up = new THREE.Vector3(0, 1, 0);
      for (const towel of plan.towels) {
        const matrix = new THREE.Matrix4().compose(
          new THREE.Vector3(towel.x, terrainHeightAt(towel.x, towel.z) + 0.05, towel.z),
          new THREE.Quaternion().setFromAxisAngle(up, towel.heading),
          new THREE.Vector3(0.95, 0.05, 1.85),
        );
        byColor[towel.color % colors.length]!.push(matrix);
      }
      colors.forEach((color, index) => {
        if (byColor[index]!.length) this.addInstanced(towelGeometry, new THREE.MeshStandardMaterial({ color, roughness: 0.96 }), byColor[index]!, { receive: true });
      });
    }
  }

  // ---- Parks & green space (generated landuse polygons) ----------------------

  private buildParks(): void {
    // Grass colour is baked into the map (see createGrassTexture), so the material tint stays neutral white.
    // Every green landuse the map paints green renders as lush grass — including wild types (reserve/scrub/wood)
    // for now — so the world matches the map. (`polygon.manicured` is still carried for a future custom pass.)
    const parkMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.grassLush, roughness: 0.95 });
    this.grassWind = applyGrassShader(parkMaterial, { wind: true }); // lush lawns: macro detile + wind ripple
    applySnowShader(parkMaterial, { snowY: SNOW_Y, rockY: SNOW_Y * 0.55 }); // veld draped up the range whitens with the ground under it
    const dirtMaterial = new THREE.MeshStandardMaterial({ color: 0xb59d5a, map: this.sand, roughness: 0.97 });
    for (const polygon of GREEN_POLYGONS) {
      this.addGroundCover(polygon, parkMaterial, GROUND_COVER_LIFT); // drapes onto the relief
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
      if (this.isOnRoad(x, z, 2.4) || this.isReserved(x, z, 2) || distanceToRailwayCorridor(x, z) < 0.7) continue; // parks can straddle the rails: no trunks on the ballast
      if (terrainHeightAt(x, z) > SNOW_Y * 0.55) continue; // no leafy park trees above the range's rock line
      this.parkTreeSites.push({ x, z, seed: attempt + Math.round(polygon.cx) });
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
  private updateBuildingChunks(focusX: number, focusZ: number, budgetMs = BUILD_FRAME_BUDGET_MS): void {
    const size = MERGE_CHUNK_SIZE; const range = this.buildingVisibleRange;
    for (const { cellX: cx, cellZ: cz, key } of cellsWithinRange(focusX, focusZ, range, size)) {
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
    while (performance.now() - start < budgetMs) {
      if (!this.pending) {
        if (this.buildQueue.length === 0) break;
        this.buildQueue.sort((a, b) => cellDistance(focusX, focusZ, a[0], a[1], size) - cellDistance(focusX, focusZ, b[0], b[1], size));
        const [cx, cz] = this.buildQueue.shift()!; const key = `${cx},${cz}`;
        this.queuedCells.delete(key);
        if (this.buildingCells.has(key)) continue;
        this.pending = { key, cellX: cx, cellZ: cz, specs: generateCell(cx, cz), index: 0, models: scatterCell(cx, cz), modelIndex: 0, baker: new GeometryBaker(), colliders: [], trunks: [], group: this.buildingStore.groupForKey(key) };
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
        const { group, colliders, trunk } = this.buildOneModel(pending.models[pending.modelIndex++]!);
        pending.baker.addObject(group);
        group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
        pending.colliders.push(...colliders);
        if (trunk) pending.trunks.push(trunk);
      }
      if (pending.index >= pending.specs.length && pending.modelIndex >= pending.models.length) { // cell complete: one cheap merge, register colliders once
        pending.baker.finalize(pending.group);
        // Colliders AND trunk props are registered behind the same once-per-cell gate: this cell's
        // geometry is disposed and rebuilt every time the player leaves and returns, and a trunk
        // registered per rebuild would grow the prop grid without bound.
        if (!this.buildingColliderCells.has(pending.key)) {
          for (const collider of pending.colliders) this.colliders.push(collider);
          for (const trunk of pending.trunks) this.props.register('tree', trunk.x, trunk.z, trunk.radius, trunk.height);
          this.buildingColliderCells.add(pending.key);
        }
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
    const { width: w, depth: d, height: h, style, variant: sourceVariant } = spec;
    const district = generatedDistrictAt(spec.x, spec.z);
    // One coherent architecture/facade language per neighbourhood. Both selectors reuse the
    // existing finite variant sets, so streamed geometry/material budgets do not grow.
    const variant = neighbourhoodBuildingVariant(district, sourceVariant);
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
    const facadeIndex = neighbourhoodFacadeIndex(district, style, sourceVariant);
    const palette = BUILDING_PALETTES[style];
    const color = palette[facadeIndex % palette.length] ?? 0x9aa4a8;
    const materialKey = `${style}-${facadeIndex}`; let facade = this.buildingMaterial.get(materialKey);
    // emissiveIntensity starts at the CURRENT window-glow level, not 0: this material may be born at
    // midnight, halfway across the map from wherever the cycle last walked the list (see setFacadeGlow).
    if (!facade) { facade = new THREE.MeshStandardMaterial({ color, map: this.facades[facadeIndex], emissive: 0xffffff, emissiveMap: this.facadeGlows[facadeIndex], emissiveIntensity: this.facadeGlow, roughness: 0.72, metalness: style === 'downtown' || style === 'mixed-use' ? 0.12 : 0.02 }); this.buildingMaterial.set(materialKey, facade); }
    const profile = this.architecture.build({ x: 0, z: 0, width: w, depth: d, height: h, style, variant, facade, roof: this.roofMaterial, facadeTile: facadeWorldTile(facadeIndex) });
    const foundations = foundationTiers(profile.tiers, -plinthDrop);
    const foundationIdentity = foundationIdentityForDistrict(district);
    const foundationMaterials = this.foundationMaterialsFor(foundationIdentity);
    for (const foundation of foundations) {
      const foundationW = foundation.maxX - foundation.minX; const foundationH = foundation.y1 - foundation.y0; const foundationD = foundation.maxZ - foundation.minZ;
      // World-pitched concrete: a plain box face spans 0..1 UV whatever its size, so two abutting
      // foundation tiers of different depths used to change concrete scale 1.8x across one
      // continuous retaining wall (the MARTIAL x SMAL corner). Every face at least one
      // FOUNDATION_UV_TILE wide/tall now shares one world pitch; smaller faces clamp to a single
      // whole repeat — the pre-fix look — because a fractional repeat samples an arbitrary
      // sub-window of the photo and renders whole short walls flat grey (owner-reported when this
      // briefly shipped unfloored).
      const mesh = new THREE.Mesh(
        scaleBoxFacadeUvs(new THREE.BoxGeometry(foundationW, foundationH, foundationD), foundationW, foundationH, foundationD, FOUNDATION_UV_TILE),
        foundationMaterials.wall);
      mesh.position.set((foundation.minX + foundation.maxX) / 2, (foundation.y0 + foundation.y1) / 2, (foundation.minZ + foundation.maxZ) / 2);
      mesh.receiveShadow = true; group.add(mesh);
      this.addFoundationCharacter(group, foundation, foundationIdentity, foundationMaterials.accent, sourceVariant);
    }
    const detailed = style === 'downtown' || style === 'mixed-use' || style === 'dense-residential' || variant % 2 === 0;
    this.addLedge(profile.tiers, Math.min(h - 0.5, 3.6));
    if (profile.entrance) this.addEntrance(style, profile.entrance);
    if (detailed && style === 'dense-residential') this.addBalconies(0, w, h, profile.tiers);
    // The name on the board is the building's ONE identity — the same derivation the interiors
    // feature puts on the E prompt (see buildingIdentity.ts). A building with no tagged entrance
    // never opens, so it keeps the old generic-business vocabulary.
    const boardName = profile.entrance ? boardText(parcelBuildingName(spec.x, spec.z, style, profile.entrance.kind)) : undefined;
    if (style === 'industrial') this.addIndustrialDetail(0, 0, w, d, h, variant, profile.tiers, profile.gables, boardName);
    if (detailed && (style === 'downtown' || style === 'mixed-use' || style === 'dense-residential')) this.addStreetLevelDetail(0, w, style, variant, profile.tiers, boardName);
    this.addRoofEquipment(0, 0, w, d, h, profile.tiers, profile.gables, style, variant);
    if (style === 'downtown' && h > 48 && variant % 4 === 0) this.addRoofSign(0, 0, w, d, profile.tiers, profile.gables, variant);
    group.position.set(spec.x, baseY, spec.z); group.rotation.y = spec.heading;
    const colliders = profile.tiers.map((tier) => this.tierToWorldCollider(tier, spec.x, spec.z, spec.heading, baseY));
    // On a real slope the base is raised above the downhill ground; give the plinth a collider so you can't
    // walk into the gap under the building. Skip on near-flat ground (no gap) to keep the collider count down.
    if (hMax - hMin > PLAYER.stepUp) {
      colliders.push(...foundations.map((foundation) => this.tierToWorldCollider(foundation, spec.x, spec.z, spec.heading, baseY)));
    }
    this.target = previousTarget; this.architecture.retarget(this.group);
    return { group, colliders };
  }

  private foundationMaterialsFor(identity: FoundationIdentity): { wall: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial } {
    let materials = this.neighbourhoodFoundationMaterials.get(identity.id);
    if (materials) return materials;
    const wall = new THREE.MeshStandardMaterial({ color: identity.wall, map: this.concrete, roughness: 0.94 });
    wall.name = `${identity.id} retaining wall`;
    const accent = new THREE.MeshStandardMaterial({ color: identity.accent, map: this.concrete, roughness: 0.88 });
    accent.name = `${identity.id} retaining detail`;
    materials = { wall, accent };
    this.neighbourhoodFoundationMaterials.set(identity.id, materials);
    return materials;
  }

  /**
   * Break up the tall blank podiums created when a level building meets Joburg's slopes. Detail is
   * attached only to the street-facing wall, shares a tiny material cache and is merged into the
   * streamed building cell, so the treatment adds no object churn or collision work at runtime.
   */
  private addFoundationCharacter(
    group: THREE.Group,
    foundation: MassingTier,
    identity: FoundationIdentity,
    accent: THREE.Material,
    variant: number,
  ): void {
    if (foundation.kind === 'wall') return;
    const width = foundation.maxX - foundation.minX;
    const height = foundation.y1 - foundation.y0;
    if (width < 2.2 || height < 2.25) return;
    const centreX = (foundation.minX + foundation.maxX) / 2;
    const frontZ = foundation.maxZ + 0.075;
    const piece = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      x: number,
      y: number,
      z: number,
      cast = false,
    ): void => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    // A cap and a bounded set of retaining joints give even the tallest cut a human scale.
    piece(new THREE.BoxGeometry(width + 0.24, 0.2, 0.24), this.foundationJointMaterial, centreX, -0.18, frontZ);
    const rawJointCount = Math.floor((height - 1.1) / 3.15);
    const jointCount = Math.min(8, rawJointCount);
    const jointSpacing = rawJointCount > jointCount ? (height - 0.7) / (jointCount + 1) : 3.15;
    for (let joint = 1; joint <= jointCount; joint++) {
      const y = -joint * jointSpacing;
      if (y <= foundation.y0 + 0.35) break;
      piece(new THREE.BoxGeometry(width + 0.16, 0.16, 0.2), this.foundationJointMaterial, centreX, y, frontZ);
    }

    const detailY = Math.max(foundation.y0 + 0.85, -1.35);
    if (identity.treatment === 'vents') {
      const count = Math.max(1, Math.min(4, Math.floor(width / 5)));
      for (let index = 0; index < count; index++) {
        const x = centreX + (index - (count - 1) / 2) * Math.min(4.2, width / count);
        piece(new THREE.BoxGeometry(1.35, 0.62, 0.15), this.foundationJointMaterial, x, detailY, frontZ + 0.06);
      }
      return;
    }
    if (identity.treatment === 'mural') {
      const count = Math.max(2, Math.min(5, Math.floor(width / 3.4)));
      const panelWidth = Math.min(2.35, (width - 0.8) / count);
      for (let index = 0; index < count; index++) {
        const x = centreX + (index - (count - 1) / 2) * (panelWidth + 0.28);
        const y = detailY - ((index + variant) % 2) * 0.22;
        piece(
          new THREE.BoxGeometry(panelWidth, 1.35 + ((index + variant) % 3) * 0.2, 0.12),
          (index + variant) % 3 === 1 ? this.foundationJointMaterial : accent,
          x, y, frontZ + 0.07,
        );
      }
      return;
    }
    if (identity.treatment === 'hazard') {
      const count = Math.max(2, Math.min(8, Math.floor(width / 2.2)));
      const segment = Math.min(1.5, (width - 0.6) / count);
      for (let index = 0; index < count; index += 2) {
        const x = centreX + (index - (count - 1) / 2) * segment;
        piece(new THREE.BoxGeometry(segment * 0.88, 0.42, 0.14), accent, x, detailY, frontZ + 0.07);
      }
      return;
    }
    // Estate, suburban and Vaal walls get planted vertical bays instead of urban graphics.
    const count = Math.max(2, Math.min(5, Math.floor(width / 4.6)));
    for (let index = 0; index < count; index++) {
      const x = centreX + (index - (count - 1) / 2) * Math.min(4.4, width / count);
      const bayHeight = Math.min(2.2, height - 0.55);
      piece(new THREE.BoxGeometry(0.5, bayHeight, 0.42), accent, x, -bayHeight / 2 - 0.15, frontZ + 0.12, true);
    }
  }

  /** Build one scattered catalog model at the origin, then place + face it exactly like a building.
   *  Foliage registers no rectangle colliders — you brush through leaves, and a canopy rectangle would
   *  wall off half a park — but an authored trunk thick enough to be wood (SOLID_TRUNK_MIN_DIAMETER)
   *  comes back as a 'tree' prop for the caller to register, exactly like the roadside and park trees.
   *  Every structure registers its (true-3D, standable-aware) tier colliders. */
  private buildOneModel(spec: ScatteredModel): { group: THREE.Group; colliders: Collider[]; trunk?: TrunkProp } {
    const def = MODEL_INDEX.get(spec.name);
    // Every model a person can walk into gets its ONE name handed to the builder, so the board it
    // paints is the name the interiors feature will put on the prompt (see buildingIdentity.ts).
    const signName = def?.interior ? boardText(scatterBuildingName(spec.x, spec.z, def.interior.family, def.interior.kind, spec.name)) : undefined;
    const built = buildModel(spec.name, spec.seed, { variant: spec.variant, signName });
    const foliage = def?.category === 'foliage';
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
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX + 1.4, plinthH, maxZ - minZ + 1.4), this.foundationMaterial);
      plinth.position.set((minX + maxX) / 2, 0.2 - plinthH / 2, (minZ + maxZ) / 2); plinth.receiveShadow = true; built.group.add(plinth);
      colliders.push(this.tierToWorldCollider({ minX: minX - 0.7, maxX: maxX + 0.7, minZ: minZ - 0.7, maxZ: maxZ + 0.7, y0: -plinthDrop, y1: 0 }, spec.x, spec.z, spec.heading, baseY));
    }
    return { group: built.group, colliders, trunk: foliage ? trunkProp(built, spec.x, spec.z) : undefined };
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

  private addLedge(tiers: readonly MassingTier[], y: number): void {
    if (tiers.length === 0) return;
    const material = new THREE.MeshStandardMaterial({ color: 0xd0cec1, roughness: 0.76 });
    const minX = Math.min(...tiers.map((tier) => tier.minX)); const maxX = Math.max(...tiers.map((tier) => tier.maxX));
    for (const span of frontFacadeSpansAt(tiers, y, minX, maxX)) {
      const ledge = new THREE.Mesh(new THREE.BoxGeometry(span.maxX - span.minX, 0.24, 0.18), material);
      ledge.position.set((span.minX + span.maxX) / 2, y, span.z + 0.04); ledge.castShadow = true; this.target.add(ledge);
    }
  }

  /** The leaf and its canopy, hung on the entrance the architecture TAGGED. The tag is the single
   *  source: nothing here recomputes where the door is, so the door the player walks up to and the
   *  door the interior feature opens are the same fact by construction.
   *
   *  WHAT gets drawn is the tag's own `kind`, because every family carries a tag now and a glazed
   *  office leaf on a warehouse is a door the player does not believe. A works gets a corrugated
   *  roller shutter on a concrete apron; a house gets a painted timber leaf under a stoep roof on
   *  posts; a lobby and a shopfront keep the glazed leaf and the steel canopy they always had. */
  private addEntrance(style: BuildingStyle, entrance: EntranceTag): void {
    const { x, width: w, height: h, z } = entrance;
    // The sill stays where it always was; a shortened head lowers the lintel, never the threshold.
    const y = 0.17 + h / 2;
    if (entrance.kind === 'dock') {
      const shutter = new THREE.MeshStandardMaterial({ color: 0x8b9095, metalness: 0.55, roughness: 0.62 });
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), shutter); leaf.position.set(x, y, z + 0.02); this.target.add(leaf);
      // Corrugation: the ribs are what makes a grey rectangle read as a roller door from the street.
      for (let rib = 0; rib < 7; rib++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.07, 0.07), shutter);
        bar.position.set(x, y - h / 2 + 0.3 + rib * (h - 0.6) / 6, z + 0.1); this.target.add(bar);
      }
      const guide = new THREE.MeshStandardMaterial({ color: 0x3d4548, metalness: 0.5, roughness: 0.5 });
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.18, h + 0.4, 0.22), guide);
        rail.position.set(x + side * (w / 2 + 0.09), (h + 0.4) / 2, z + 0.11); rail.castShadow = true; this.target.add(rail);
      }
      const hood = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, 0.42, 0.42), guide); hood.position.set(x, h + 0.4, z + 0.2); hood.castShadow = true; this.target.add(hood);
      // The apron the lorry backs onto — the flat lip that says a vehicle belongs here. Thick and
      // sunk to the plinth line, so on a parcel that falls away it reads as a kerb rather than a
      // floating plane (it is decorative: the foundation pass owns the ground under the building).
      const apron = new THREE.Mesh(new THREE.BoxGeometry(w + 1.6, 0.34, 2.0), new THREE.MeshStandardMaterial({ color: 0x8e8c86, roughness: 0.95 }));
      apron.position.set(x, 0.18, z + 1.0); apron.receiveShadow = true; this.target.add(apron);
      return;
    }
    if (entrance.kind === 'porch') {
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w, 1.5), h, 0.1), new THREE.MeshStandardMaterial({ color: 0x5d4632, roughness: 0.78 }));
      leaf.position.set(x, y, z + 0.02); this.target.add(leaf);
      // Side lights either side of the leaf, where the opening is wide enough to have them.
      if (w > 2.2) {
        const light = new THREE.MeshStandardMaterial({ color: 0x3f6672, roughness: 0.2, metalness: 0.1 });
        const paneW = (w - 1.6) / 2;
        for (const side of [-1, 1]) {
          const pane = new THREE.Mesh(new THREE.BoxGeometry(paneW, h * 0.62, 0.08), light);
          pane.position.set(x + side * (0.75 + paneW / 2 + 0.05), y + 0.2, z + 0.02); this.target.add(pane);
        }
      }
      // A stoep roof on two posts, only where the wall is tall enough to carry it.
      if (h > 2.7) {
        const timber = new THREE.MeshStandardMaterial({ color: 0x6b5137, roughness: 0.85 });
        const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 1.4, 0.14, 1.6), new THREE.MeshStandardMaterial({ color: 0x8a3f2e, roughness: 0.8 }));
        roof.position.set(x, h + 0.18, z + 0.8); roof.rotation.x = -0.07; roof.castShadow = true; this.target.add(roof);
        for (const side of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, h + 0.1, 8), timber);
          post.position.set(x + side * (w / 2 + 0.5), (h + 0.1) / 2, z + 1.45); post.castShadow = true; this.target.add(post);
        }
      }
      const step = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.32, 0.9), new THREE.MeshStandardMaterial({ color: 0xb3ad9f, roughness: 0.92 }));
      step.position.set(x, 0.18, z + 0.45); step.receiveShadow = true; this.target.add(step);
      return;
    }
    const glass = new THREE.MeshPhysicalMaterial({ color: style === 'industrial' ? 0x4a5353 : 0x3a6672, roughness: 0.16, metalness: 0.18, clearcoat: 0.6 });
    const door = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), glass); door.position.set(x, y, z + 0.02); this.target.add(door);
    if (h < 2.7) return;
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.18, 1.5), new THREE.MeshStandardMaterial({ color: 0x30383a, metalness: 0.45, roughness: 0.42 })); canopy.position.set(x, h + 0.25, z + 0.7); canopy.castShadow = true; this.target.add(canopy);
  }

  private addBalconies(x: number, w: number, h: number, tiers: readonly MassingTier[]): void {
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x3c4546, metalness: 0.58, roughness: 0.4 });
    for (let y = 4.4; y < h - 1; y += 3.2) {
      const centreX = x + w * 0.22; const floorW = w * 0.38; const facadeZ = frontFacadeZAt(tiers, centreX, y, floorW / 2); if (facadeZ === undefined) continue;
      const floor = new THREE.Mesh(new THREE.BoxGeometry(floorW, 0.14, 1.35), new THREE.MeshStandardMaterial({ color: 0xbdb9aa, roughness: 0.85 })); floor.position.set(centreX, y, facadeZ + 0.62); floor.castShadow = true; this.target.add(floor);
      for (const px of [-w * 0.18, 0, w * 0.18]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), railMaterial); rail.position.set(centreX + px, y + 0.45, facadeZ + 1.16); this.target.add(rail); }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 0.07, 0.07), railMaterial); bar.position.set(centreX, y + 0.84, facadeZ + 1.16); this.target.add(bar);
    }
  }

  private addIndustrialDetail(x: number, z: number, w: number, d: number, h: number, variant: number, tiers: readonly MassingTier[], gables: readonly GableSpec[], boardName?: string): void {
    const shutterH = Math.min(5, h * 0.48); const shutterY = shutterH / 2 + 0.2;
    const shutterSpan = widestFrontFacadeSpanAt(tiers, shutterY, x - w / 2, x + w / 2, 3.2);
    if (shutterSpan) {
      const shutterX = (shutterSpan.minX + shutterSpan.maxX) / 2;
      const shutterW = Math.min(w * 0.42, shutterSpan.maxX - shutterSpan.minX - 0.55);
      const shutterColors = [0x5e6868, 0x4c5960, 0x75644e, 0x485b51];
      const shutter = new THREE.Mesh(new THREE.BoxGeometry(shutterW, shutterH, 0.14), new THREE.MeshStandardMaterial({ color: shutterColors[variant % shutterColors.length], roughness: 0.52, metalness: 0.45 }));
      shutter.name = 'procedural-industrial-shutter'; shutter.position.set(shutterX, shutterY, shutterSpan.z + 0.03); this.target.add(shutter);

      // The sign gets its own high-wall probe: a low annex may carry the shutter while a taller,
      // slightly recessed shed behind it is the only valid wall above. If no high span exists, mount
      // the board across the shutter header so every factory still has an identity at street level.
      const desiredSignY = Math.min(h - 0.7, shutterH + 1.05);
      const signSpan = widestFrontFacadeSpanAt(tiers, desiredSignY, x - w / 2, x + w / 2, 3.2) ?? shutterSpan;
      const signY = signSpan === shutterSpan && frontFacadeZAt(tiers, shutterX, desiredSignY, Math.min(3, shutterW / 2)) === undefined
        ? shutterH - 0.45
        : desiredSignY;
      const signW = Math.min(7.5, signSpan.maxX - signSpan.minX - 0.45);
      const signX = THREE.MathUtils.clamp(shutterX, signSpan.minX + signW / 2, signSpan.maxX - signW / 2);
      const accent = variant % 2 ? '#f0ae43' : '#72d8d2';
      const sign = createSignMesh(new THREE.PlaneGeometry(signW, 1.2), boardName ?? industrialSignLabel(variant), accent, { powered: variant % 3 === 0 });
      sign.name = 'procedural-industrial-sign'; sign.position.set(signX, signY, signSpan.z + 0.08); this.target.add(sign);
    }
    for (const side of [-1, 1]) {
      // Whirlybird vents pierce the roof surface at their own spot (flat annex or gable slope alike).
      const ventX = x + side * w * 0.24;
      const surface = roofSurfaceAt(tiers, gables, ventX, z); if (surface === undefined) continue;
      const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.58, 1.7, 16), new THREE.MeshStandardMaterial({ color: 0x555e60, metalness: 0.6, roughness: 0.48 })); vent.position.set(ventX, surface + 0.55, z); this.target.add(vent);
    }
    if (variant % 3 === 0) {
      const stackX = x - w * 0.28; const stackZ = z - d * 0.18; const stackH = Math.min(10, h * 0.7);
      const stackBase = (roofSurfaceAt(tiers, gables, stackX, stackZ) ?? h + 0.2) - 0.5; // sunk into the roof under it
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.05, stackH, 20), new THREE.MeshStandardMaterial({ color: 0x7a665d, roughness: 0.72, metalness: 0.16 })); stack.position.set(stackX, stackBase + stackH / 2, stackZ); stack.castShadow = true; this.target.add(stack);
      for (let band = 0; band < 3; band++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.91 - band * 0.05, 0.08, 8, 20), new THREE.MeshStandardMaterial({ color: 0x363f42, metalness: 0.7, roughness: 0.38 })); ring.rotation.x = Math.PI / 2; ring.position.set(stack.position.x, stackBase + 1.2 + band * 2.2, stack.position.z); this.target.add(ring); }
    }
    if (variant % 4 === 0) this.addRoofSign(x, z, w, d, tiers, gables, variant);
  }

  private addStreetLevelDetail(x: number, w: number, style: BuildingStyle, variant: number, tiers: readonly MassingTier[], boardName?: string): void {
    const frame = new THREE.MeshStandardMaterial({ color: 0x273235, metalness: 0.55, roughness: 0.38 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x315f68, roughness: 0.12, metalness: 0.18, clearcoat: 0.7 });
    const bays = Math.max(2, Math.min(5, Math.floor(w / 5)));
    for (let bay = 0; bay < bays; bay++) {
      const px = x - w * 0.39 + bay * (w * 0.78 / Math.max(1, bays - 1));
      if (Math.abs(px - x) < Math.min(3, w * 0.18)) continue;
      const commercial = style === 'downtown' || style === 'mixed-use';
      const windowW = Math.min(3.2, w / bays * 0.62); const windowY = commercial ? 1.55 : 1.65;
      const facadeZ = frontFacadeZAt(tiers, px, windowY, windowW / 2); if (facadeZ === undefined) continue;
      const window = new THREE.Mesh(new THREE.BoxGeometry(windowW, commercial ? 2.35 : 1.65, 0.09), glass); window.position.set(px, windowY, facadeZ + 0.025); this.target.add(window);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(Math.min(3.5, w / bays * 0.68), 0.1, 0.18), frame); sill.position.set(px, 0.4, facadeZ + 0.06); this.target.add(sill);
    }
    if (style === 'downtown' || style === 'mixed-use' || variant % 3 === 0) {
      const colors = [0xc8503f, 0x2f7774, 0xd4a438, 0x586f91];
      const awningX = x + w * 0.22; const awningW = w * 0.46; const facadeZ = frontFacadeZAt(tiers, awningX, 3.1, awningW / 2);
      if (facadeZ !== undefined) {
        const awning = new THREE.Mesh(new THREE.BoxGeometry(awningW, 0.15, 1.25), new THREE.MeshStandardMaterial({ color: colors[variant % colors.length], roughness: 0.7 }));
        awning.position.set(awningX, 3.1, facadeZ + 0.58); awning.rotation.x = -0.12; awning.castShadow = true; this.target.add(awning);
      }
    }
    if (style === 'downtown' || style === 'mixed-use') {
      const signX = x - w * 0.2; const signW = Math.min(6.4, w * 0.34); const signY = 3.82;
      const facadeZ = frontFacadeZAt(tiers, signX, signY, signW / 2);
      if (facadeZ !== undefined) {
        const accents = ['#f0ae43', '#72d8d2', '#ef6556', '#74e392'];
        const sign = createSignMesh(new THREE.PlaneGeometry(signW, 1.05), boardName ?? storefrontSignLabel(variant), accents[variant % accents.length] ?? '#f0ae43', { powered: variant % 2 === 0 });
        sign.name = 'procedural-storefront-sign'; sign.position.set(signX, signY, facadeZ + 0.08); this.target.add(sign);
      }
    }
  }

  /** AC units, fans and the aerial mast sit on the flat roof directly under their own spot — anchoring
   *  them at the building-wide roofY left them hovering high over lower wings of stepped massings
   *  (roofY can be a stack, silo or ridge far above the roof at the unit's XZ). */
  private addRoofEquipment(x: number, z: number, w: number, d: number, h: number, tiers: readonly MassingTier[], gables: readonly GableSpec[], style: BuildingStyle, variant: number): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x596467, metalness: 0.62, roughness: 0.46 });
    const units = style === 'downtown' ? 2 : style === 'mixed-use' || style === 'industrial' ? 1 : 0;
    for (let index = 0; index < units; index++) {
      const ux = x - w * 0.18 + index * 2.4; const uz = z - d * 0.2;
      const base = this.flatRoofUnder(tiers, gables, ux, uz, 0.85, 0.68); if (base === undefined) continue;
      const unit = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.05, 1.35), metal); unit.position.set(ux, base + 0.525, uz); unit.castShadow = true; this.target.add(unit);
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 16), new THREE.MeshStandardMaterial({ color: 0x263033, metalness: 0.75, roughness: 0.35 })); fan.rotation.x = Math.PI / 2; fan.position.set(unit.position.x, base + 0.545, unit.position.z - 0.7); this.target.add(fan);
    }
    if (h > 42 && variant % 3 === 1) {
      const mastBase = this.flatRoofUnder(tiers, gables, x + w * 0.2, z, 0.3, 0.3);
      if (mastBase !== undefined) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.1, 8, 10), metal); mast.position.set(x + w * 0.2, mastBase + 4, z); this.target.add(mast);
        const beaconMaterial = new THREE.MeshStandardMaterial({ color: 0xff4b3e, emissive: 0xff1f16, emissiveIntensity: 2 });
        registerPowered(beaconMaterial, 0xff4b3e, 0x3a1a16);
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), beaconMaterial); beacon.position.set(mast.position.x, mastBase + 8.05, z); this.target.add(beacon);
      }
    }
  }

  /** Flat roof height under a footprint (half-extents hw/hd around the spot), or undefined when the
   *  spot hangs off the massing, straddles tiers of different heights, or is buried under a gable. */
  private flatRoofUnder(tiers: readonly MassingTier[], gables: readonly GableSpec[], x: number, z: number, hw: number, hd: number): number | undefined {
    let base: number | undefined;
    for (const cx of [x - hw, x + hw]) for (const cz of [z - hd, z + hd]) {
      const top = massingTopAt(tiers, cx, cz); if (top === undefined) return undefined;
      if (base === undefined) base = top;
      else if (Math.abs(top - base) > 0.25) return undefined;
      else base = Math.max(base, top);
    }
    if (base === undefined) return undefined;
    const pitched = gableSurfaceAt(gables, x, z);
    if (pitched !== undefined && pitched > base + 0.1) return undefined;
    return base;
  }

  /** Rooftop billboard standing on a real roof: hosted by the tallest tier wide enough to carry both
   *  posts, at that tier's own front edge — placing it at the parcel edge at roofY left signs hanging
   *  in the air beside setback towers and over podium edges. */
  private addRoofSign(x: number, z: number, w: number, d: number, tiers: readonly MassingTier[], gables: readonly GableSpec[], variant: number): void {
    let host: MassingTier | undefined;
    for (const tier of tiers) {
      if (tier.minX > x - 3.2 || tier.maxX < x + 3.2) continue;
      if (!host || tier.y1 > host.y1) host = tier;
    }
    if (!host) return;
    const frontZ = Math.min(host.maxZ, z + d / 2);
    const postBase = (px: number) => Math.max(host!.y1, gableSurfaceAt(gables, px, frontZ - 0.2) ?? host!.y1);
    const baseY = Math.max(postBase(x - 3), postBase(x + 3));
    const names = ['CHICKEN LEKKER', 'MR VRRR PHAA', 'PIK-A-PAY', 'DEBONERS']; const accent = variant % 2 ? '#72d8d2' : '#f0ae43';
    const sign = createSignMesh(new THREE.PlaneGeometry(Math.min(12, w * 0.7), 3), names[variant % names.length] ?? 'CHICKEN LEKKER', accent, { powered: true }); sign.position.set(x, baseY + 3.2, frontZ + 0.1); this.target.add(sign);
    for (const px of [-3, 3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 8), new THREE.MeshStandardMaterial({ color: 0x343b3d, metalness: 0.7 })); post.position.set(x + px, baseY + 1.5, frontZ); this.target.add(post); }
  }

  private addParkTree(x: number, z: number, seed: number, target: THREE.Group): void {
    if (this.isOnRoad(x, z, 2.4)) return; // parks can overlap roads: no trunks on the tar
    const species = PARK_TREE_SPECIES[Math.abs(Math.trunc(seed)) % PARK_TREE_SPECIES.length]!;
    const built = buildModel(species, seed);
    const trunk = trunkProp(built, x, z);
    if (trunk) this.props.register('tree', trunk.x, trunk.z, trunk.radius, trunk.height);
    built.group.position.set(x, terrainHeightAt(x, z), z); // sit on the terrain, not the flat plane
    built.group.rotation.y = seed * 2.399963229728653;
    target.add(built.group);
  }

  // ---- Airport (see world/Airport.ts) ----------------------------------------

  /** O.R. Tambourine Regional: runway/taxiway/apron, terminal + tower + hangars, fence and parked
   *  aircraft. The runway and taxiway are rendered surfaces ONLY — they are never registered in the
   *  road index or nav graphs, so NPC traffic, peds and spawns stay off the field. */
  private buildAirfield(): void {
    buildAirport({
      group: this.group, colliders: this.colliders, props: this.props,
      asphalt: this.asphalt, concrete: this.concrete,
      ground: (x, z) => terrainHeightAt(x, z),
      strip: (points, width, material, lift) => this.createRoadStrip(points, width, material, lift, false),
      addInstanced: (geometry, material, transforms, shadows) => this.addInstanced(geometry, material, transforms, shadows),
      isOnRoad: (x, z, margin = 0) => this.isOnRoad(x, z, margin),
    });
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
