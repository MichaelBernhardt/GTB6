import * as THREE from 'three';
import { COLORS, WORLD_SIZE } from '../config';
import type { District, GameSettings } from '../types';
import { BuildingArchitecture, type BuildingStyle } from './BuildingArchitecture';
import {
  CBD_CENTER,
  districtAt as generatedDistrictAt,
  GENERATED_ROADS,
  GENERATED_TRACKS,
  GREEN_POLYGONS,
  DIRT_POLYGONS,
  METRES_PER_UNIT,
  nearestDistrict,
  pointInPolygon,
  WATER_POLYGONS,
  type MapPolygon,
} from './mapData';
import { HILLBROW_TOWER_SPOT, PONTE_SPOT, RESERVED_PADS, WATER_TOWER_SPOT } from './placements';
import { inBuildZone, TEST_BUILDING_BUDGET } from './data/cityBuild';
import { addInstancedChunks, ChunkStore, ChunkVisibility, DETAIL_HYSTERESIS, DETAIL_VISIBLE_RANGE, type InstanceItem } from './ChunkVisibility';
import { createFacadeGlowTexture, createFacadeTexture, createGeneratedSurfaceTexture, createSignMesh, createSurfaceTexture, FACADE_VARIANTS } from './ProceduralMaterials';
import { mergeStaticGeometry } from './StaticGeometry';
import { bridgeIslands, buildNavGraph, type NavGraph, type NavPath } from '../systems/NavGraph';
import { PropRegistry } from '../systems/PropSystem';
import { CITY_JUNCTIONS, UrbanInfrastructure } from './UrbanInfrastructure';
import { createWater, waterTier, type WaterHandle, type WaterSite } from './Water';
import { registerPowered } from './powerGrid';

export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; height: number; }
export interface RoadPoint { x: number; z: number; }
export interface RoadsidePoint extends RoadPoint { inwardX: number; inwardZ: number; width: number; }
export interface RoadPose { position: THREE.Vector3; heading: number; }
export interface RoadDefinition { name: string; width: number; closed?: boolean; points: RoadPoint[]; }

/** District ownership comes from the generated map's place nodes (nearest centre). */
export const districtAt = generatedDistrictAt;

/** The driveable road network — straight from the generated OSM map. */
export const ROAD_NETWORK: RoadDefinition[] = GENERATED_ROADS.map((road) => ({ name: road.name, width: road.width, points: road.points }));
/** Off-road dirt tracks: rendered as narrow unpaved strips, not part of the nav graph. */
export const TRACK_NETWORK: RoadDefinition[] = GENERATED_TRACKS.map((track) => ({ name: track.name, width: track.width, points: track.points }));

const seeded = (x: number, z: number, salt = 0): number => {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
};

/**
 * Unit-denominated layout spacings were authored against the 2.94 m/unit (6000u) map. They must
 * track the map footprint so real-world density stays constant at any TARGET_SIZE: without this,
 * the 6x scale-up to 36000u would sample 6x more nav nodes / sidewalk points per road (36x the
 * nav-graph build cost) and space roadside buildings 6x closer in real terms. LAYOUT_SCALE is 1.0
 * at the old scale and ~6.0 at 36000u, so ROAD_SAMPLE_SPACING/NAV joins hold the same *real* pitch.
 */
const LAYOUT_SCALE = 2.94 / METRES_PER_UNIT;
export const ROAD_SAMPLE_SPACING = Math.round(12 * LAYOUT_SCALE);
export const VEHICLE_NAV_JOIN = Math.round(15 * LAYOUT_SCALE);
export const PED_NAV_JOIN = Math.round(18 * LAYOUT_SCALE);
/** Static geometry merges per material per grid cell this size, keeping frustum culling useful. */
export const MERGE_CHUNK_SIZE = 976;
/** Lakes/dams at least this large (units²) get the tiered wavy/reflective water treatment. */
export const PREMIUM_WATER_AREA = 3200;
/** Absolute procedural-building ceiling for a fully-populated map (future full-city build).
 *  This round uses the smaller, CBD-scoped TEST_BUILDING_BUDGET from ./data/cityBuild. */
export const MAX_BUILDINGS = 1000;
/** Sidewalk apron beyond the road strip: wide roads get the full pavement, lanes a narrow one. */
export const sidewalkExtension = (width: number): number => (width >= 12 ? 7 : 5);

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

/** Pure builder for the nav-graph source polylines: one lane pair and one sidewalk pair per road,
 *  sampled exactly like the rendered geometry so waypoints sit on the drawn lanes and sidewalks. */
export function buildCityNavPaths(network: RoadDefinition[] = ROAD_NETWORK): { lanes: NavPath[]; walks: NavPath[] } {
  const lanes: NavPath[] = []; const walks: NavPath[] = [];
  for (const definition of network) {
    const closed = definition.closed ?? false;
    const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
    lanes.push({ points: offsetRoadPath(sampled, -definition.width * 0.23, closed), closed });
    lanes.push({ points: offsetRoadPath(sampled, definition.width * 0.23, closed).reverse(), closed });
    for (const side of [-1, 1]) walks.push({ points: offsetRoadPath(sampled, side * (definition.width / 2 + 2.2), closed).filter((_, index) => index % 2 === 0), closed });
  }
  return { lanes, walks };
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

const FACADE_RANGES: Record<BuildingStyle, [number, number]> = { downtown: [0, 6], residential: [6, 4], industrial: [10, 2] };
const BUILDING_PALETTES: Record<BuildingStyle, number[]> = {
  downtown: [0x9db1ba, 0xa3563f, 0xd0c4a4, 0x99a4a9, 0x93a9b0],
  residential: [0xdfb094, 0x8f4f3a, 0xe6d1a2, 0xa8bcc4, 0xa3563f],
  industrial: [0xa2a6a2, 0xb5924c, 0xb5a28c],
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
  colliders: Collider[] = [];
  props = new PropRegistry();
  potholes: Array<{ x: number; z: number; r: number }> = []; // road features, not props: no collider, cars rattle over them
  roadPoints: RoadPoint[] = [];
  sidewalkPoints: RoadPoint[] = [];
  roadsidePoints: RoadsidePoint[] = [];
  roadPaths: RoadPoint[][] = [];
  trafficRoutes: RoadPoint[][] = [];
  private navPaths = buildCityNavPaths(ROAD_NETWORK);
  vehicleNav: NavGraph = bridgeIslands(buildNavGraph(this.navPaths.lanes, VEHICLE_NAV_JOIN));
  pedNav: NavGraph = bridgeIslands(buildNavGraph(this.navPaths.walks, PED_NAV_JOIN));
  private roadSurfaces: Array<{ points: RoadPoint[]; width: number; closed: boolean }> = [];
  private roadIndex = new RoadIndex();
  private colliderCells = new Map<string, number[]>();
  private colliderCellSize = 48;
  private collidersIndexed = 0;
  private buildingMaterial = new Map<string, THREE.MeshStandardMaterial>();
  private asphalt = createGeneratedSurfaceTexture('/textures/asphalt-gpt.jpg', 'asphalt', 1);
  private concrete = createGeneratedSurfaceTexture('/textures/concrete-gpt.jpg', 'concrete', 10);
  private grass = createSurfaceTexture('grass', 22);
  private sand = createSurfaceTexture('sand', 14);
  private facades = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeTexture(style));
  private facadeGlows = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeGlowTexture(style));
  private roofMaterial = new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, metalness: 0.08 });
  private waterSites: WaterSite[] = [];
  private waterHandle?: WaterHandle;
  private waterMood?: { hour: number; sun: THREE.Vector3; color: THREE.Color };
  private architecture: BuildingArchitecture;
  private infrastructure: UrbanInfrastructure;

  constructor(scene: THREE.Scene, quality: GameSettings['quality'] = 'medium') {
    this.group.name = 'Joburg'; scene.add(this.group);
    this.architecture = new BuildingArchitecture(this.group);
    this.buildGround(); this.buildRoads(); this.buildWaterBodies(); this.buildParks(); this.buildDistricts();
    this.infrastructure = new UrbanInfrastructure(
      this.group,
      this.chunkStore,
      this.detailStore,
      this.roadsidePoints,
      (x, z, radius) => this.collides(x, z, radius) || this.isReserved(x, z, radius),
      (x, z, margin) => this.isOnRoad(x, z, margin),
      this.props,
    );
    mergeStaticGeometry(this.group, MERGE_CHUNK_SIZE, this.chunkStore); // water is built after the merge: its meshes stay live for per-frame animation
    this.setWaterQuality(quality);
  }

  update(dt: number): void {
    this.waterHandle?.update(dt);
    this.infrastructure.update(dt);
  }

  /** Frame-budgeted distance culling: chunks near the focus join the scene, far ones detach (with
   *  hysteresis). Geometry is kept in memory, so re-entering a chunk costs nothing. Colliders, nav
   *  graphs, the minimap and the map overlay are data, not scene geometry — culling never touches
   *  them. Water stays global: each surface is a bounded per-site mesh that frustum culling already
   *  handles, and the premium dams double as the always-visible distant-water representation. */
  updateVisibility(focus: THREE.Vector3): void {
    this.chunkCulling.update(focus.x, focus.z);
    this.detailCulling.update(focus.x, focus.z);
  }

  /** (Re)builds every water surface for the given quality tier; safe to call live from the pause menu.
   *  The old handle disposes its geometries, materials, and the planar mirror's render target. */
  setWaterQuality(quality: GameSettings['quality']): void {
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

  collides(x: number, z: number, radius: number): boolean {
    if (Math.abs(x) > WORLD_SIZE / 2 - radius || Math.abs(z) > WORLD_SIZE / 2 - radius) return true;
    if (this.props.blocked(x, z, radius)) return true;
    return this.overlapsCollider(x, z, radius);
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

  private overlapsCollider(x: number, z: number, radius: number): boolean {
    this.indexNewColliders();
    const key = `${Math.floor(x / this.colliderCellSize)},${Math.floor(z / this.colliderCellSize)}`;
    for (const index of this.colliderCells.get(key) ?? []) {
      const box = this.colliders[index]!;
      if (x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ) return true;
    }
    return false;
  }

  clampMove(from: THREE.Vector3, desired: THREE.Vector3, radius: number): THREE.Vector3 {
    const output = desired.clone();
    if (this.collides(output.x, from.z, radius)) output.x = from.x;
    if (this.collides(output.x, output.z, radius)) output.z = from.z;
    return output;
  }

  private buildGround(): void {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE), new THREE.MeshStandardMaterial({ color: COLORS.grass, map: this.grass, roughness: 0.96 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    ground.userData.far = true; // the always-visible far representation: 2 triangles of grass so the earth never vanishes beyond the chunk radius; fog carries it to the horizon
    this.group.add(ground);
  }

  private buildRoads(): void {
    const roadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.asphalt, roughness: 0.9, metalness: 0.02 });
    const centerMat = new THREE.MeshStandardMaterial({ color: 0xe7c564, roughness: 0.74 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xdedbc9, roughness: 0.8 });
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xa9aaa2, map: this.concrete, roughness: 0.92 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xc8c7bb, map: this.concrete, roughness: 0.88 });
    const dirtMat = new THREE.MeshStandardMaterial({ color: 0x7a6547, map: this.sand, roughness: 0.98 });
    const dashTransforms: THREE.Matrix4[] = []; const edgeTransforms: THREE.Matrix4[] = [];
    for (const definition of ROAD_NETWORK) {
      const closed = definition.closed ?? false;
      const sampled = this.samplePath(definition.points, closed, ROAD_SAMPLE_SPACING);
      this.roadIndex.addSurface(sampled, definition.width, this.roadSurfaces.length);
      this.roadSurfaces.push({ points: sampled, width: definition.width, closed });
      const mapPath = sampled.map((point) => ({ ...point }));
      if (closed && mapPath[0]) mapPath.push({ ...mapPath[0] });
      this.roadPaths.push(mapPath);
      const sidewalk = this.createRoadStrip(sampled, definition.width + sidewalkExtension(definition.width), sidewalkMat, 0.025, closed); sidewalk.receiveShadow = true; this.group.add(sidewalk);
      const road = this.createRoadStrip(sampled, definition.width, roadMat, 0.055, closed); road.receiveShadow = true; road.name = definition.name; this.group.add(road);
      if (definition.width >= 9) this.addRoadMarkings(sampled, definition.width, closed, dashTransforms, definition.width >= 11 ? edgeTransforms : undefined);
      const leftLane = this.offsetPath(sampled, -definition.width * 0.23, closed);
      const rightLane = this.offsetPath(sampled, definition.width * 0.23, closed).reverse();
      this.trafficRoutes.push(leftLane, rightLane);
      this.roadPoints.push(...leftLane, ...rightLane);
      const leftWalk = this.offsetPath(sampled, -(definition.width / 2 + 2.2), closed);
      const rightWalk = this.offsetPath(sampled, definition.width / 2 + 2.2, closed);
      this.sidewalkPoints.push(...leftWalk.filter((_, index) => index % 2 === 0), ...rightWalk.filter((_, index) => index % 2 === 0));
      this.addRoadsidePoints(sampled, definition.width, closed);
    }
    // Off-road dirt tracks: narrow unpaved strips — no markings, sidewalks, curbs or nav lanes.
    for (const track of TRACK_NETWORK) {
      const sampled = this.samplePath(track.points, false, ROAD_SAMPLE_SPACING);
      this.roadIndex.addSurface(sampled, track.width, this.roadSurfaces.length);
      this.roadSurfaces.push({ points: sampled, width: track.width, closed: false });
      const strip = this.createRoadStrip(sampled, track.width, dirtMat, 0.04, false); strip.receiveShadow = true; this.group.add(strip);
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addInstanced(box, centerMat, dashTransforms, {});
    this.addInstanced(box, edgeMat, edgeTransforms, {});
    const curbTransforms: THREE.Matrix4[] = [];
    for (let index = 0; index < ROAD_NETWORK.length; index++) {
      const surface = this.roadSurfaces[index]!;
      if (surface.width >= 9) this.addCurbs(surface.points, surface.width, surface.closed, index, curbTransforms);
    }
    this.addInstanced(box, curbMat, curbTransforms, { cast: true, receive: true });
    this.buildIntersections();
    this.buildPotholes();
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
    const holeItems: InstanceItem[] = []; const rimItems: InstanceItem[] = [];
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    for (const pothole of this.potholes) {
      const scale = new THREE.Vector3(pothole.r, pothole.r, 1);
      holeItems.push({ x: pothole.x, z: pothole.z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(pothole.x, 0.07, pothole.z), flat, scale) });
      rimItems.push({ x: pothole.x, z: pothole.z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(pothole.x, 0.072, pothole.z), flat, scale) });
    }
    addInstancedChunks(this.detailStore, new THREE.CircleGeometry(1, 14), new THREE.MeshBasicMaterial({ color: 0x0d1113 }), holeItems);
    addInstancedChunks(this.detailStore, new THREE.RingGeometry(1, 1.22, 14), new THREE.MeshBasicMaterial({ color: 0x3f4649 }), rimItems);
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
        const crossing = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.025, Math.min(6.2, widest * 0.45)), paint);
        crossing.position.set(x + Math.cos(angle) * stripe, 0.09, z - Math.sin(angle) * stripe); crossing.rotation.y = angle; this.group.add(crossing);
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
    return { position: new THREE.Vector3(point.x, 0, point.z), heading: Math.atan2(next.x - point.x, next.z - point.z) };
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

  private addCurbs(points: RoadPoint[], width: number, closed: boolean, surface: number, transforms: THREE.Matrix4[]): void {
    const segmentCount = closed ? points.length : points.length - 1;
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion();
    for (let index = 0; index < segmentCount; index++) {
      const start = points[index]; const end = points[(index + 1) % points.length]; if (!start || !end) continue;
      const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz); if (length < 0.5) continue;
      const midX = (start.x + end.x) / 2; const midZ = (start.z + end.z) / 2;
      if (CITY_JUNCTIONS.some((junction) => Math.hypot(midX - junction.x, midZ - junction.z) < junction.widest / 2 + 7)) continue;
      const normalX = -dz / length; const normalZ = dx / length; quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
      for (const side of [-1, 1]) {
        const offset = side * (width / 2 + 0.22);
        const crossesRoad = [0, 0.5, 1].some((t) => {
          const sx = THREE.MathUtils.lerp(start.x, end.x, t) + normalX * offset;
          const sz = THREE.MathUtils.lerp(start.z, end.z, t) + normalZ * offset;
          return this.roadIndex.onRoad(sx, sz, 1.2, surface);
        });
        if (crossesRoad) continue;
        matrix.compose(new THREE.Vector3(midX + normalX * offset, 0.15, midZ + normalZ * offset), quaternion, new THREE.Vector3(0.38, 0.22, length + 0.35)); transforms.push(matrix.clone());
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
        const center = new THREE.Vector3(junction.x, 0.24, junction.z).addScaledVector(forward, forwardSide * reach).addScaledVector(right, rightSide * reach);
        if (this.isOnRoad(center.x, center.z, 0.4)) continue; // corner landed on tar: no tactile paving in a lane
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

  private createRoadStrip(points: RoadPoint[], width: number, material: THREE.Material, y: number, closed: boolean): THREE.Mesh {
    const vertices: number[] = []; const uvs: number[] = []; const indices: number[] = []; let distance = 0;
    const sides = this.offsetPath(points, width / 2, closed); const opposite = this.offsetPath(points, -width / 2, closed);
    for (let index = 0; index < points.length; index++) {
      if (index > 0) { const previous = points[index - 1]; const point = points[index]; if (previous && point) distance += Math.hypot(point.x - previous.x, point.z - previous.z); }
      const left = sides[index]; const right = opposite[index]; if (!left || !right) continue;
      vertices.push(left.x, y, left.z, right.x, y, right.z); uvs.push(0, distance / 18, 1, distance / 18);
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
      const angle = Math.atan2(dx, dz); const midX = (start.x + end.x) / 2; const midZ = (start.z + end.z) / 2;
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      if (index % 2 === 0) { matrix.compose(new THREE.Vector3(midX, 0.088, midZ), quaternion, new THREE.Vector3(0.24, 0.025, Math.min(6.4, length * 0.64))); dashTransforms.push(matrix.clone()); }
      if (!edgeTransforms) continue;
      const normalX = -dz / length; const normalZ = dx / length;
      for (const side of [-1, 1]) { matrix.compose(new THREE.Vector3(midX + normalX * side * (width / 2 - 0.72), 0.084, midZ + normalZ * side * (width / 2 - 0.72)), quaternion, new THREE.Vector3(0.13, 0.018, length + 0.35)); edgeTransforms.push(matrix.clone()); }
    }
  }

  // ---- Water bodies (generated lakes & dams) --------------------------------

  private polygonGeometry(polygon: MapPolygon): THREE.BufferGeometry {
    const shape = new THREE.Shape(polygon.points.map((point) => new THREE.Vector2(point.x - polygon.cx, -(point.z - polygon.cz))));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  }

  private buildWaterBodies(): void {
    const bedMaterial = new THREE.MeshStandardMaterial({ color: 0x1c3a3e, roughness: 0.95 });
    for (const polygon of WATER_POLYGONS) {
      if (polygon.area >= PREMIUM_WATER_AREA) {
        // Big dams get the tiered treatment (waves/reflections per quality) over a dark bed for depth.
        const bed = new THREE.Mesh(this.polygonGeometry(polygon), bedMaterial);
        bed.position.set(polygon.cx, 0.012, polygon.cz); this.group.add(bed);
        this.waterSites.push({
          kind: 'ocean', x: polygon.cx, y: 0.045, z: polygon.cz,
          width: polygon.maxX - polygon.minX, depth: polygon.maxZ - polygon.minZ,
          shape: polygon.points,
        });
      } else {
        // Small ponds stay on the cheap rippling basin whatever the quality (perf policy: there are dozens).
        this.waterSites.push({ kind: 'pond', x: polygon.cx, y: 0.045, z: polygon.cz, radius: Math.max(3, Math.sqrt(polygon.area / Math.PI) * 0.9) });
      }
    }
  }

  /** True when the point is inside a generated water polygon (keeps buildings/trees dry). */
  private inWater(x: number, z: number): boolean {
    return WATER_POLYGONS.some((polygon) => pointInPolygon(polygon, x, z));
  }

  // ---- Parks & green space (generated landuse polygons) ----------------------

  private buildParks(): void {
    const parkMaterial = new THREE.MeshStandardMaterial({ color: 0x5f7a44, map: this.grass, roughness: 0.96 });
    const dryMaterial = new THREE.MeshStandardMaterial({ color: 0x8a8149, map: this.grass, roughness: 0.96 });
    const dirtMaterial = new THREE.MeshStandardMaterial({ color: 0xb59d5a, map: this.sand, roughness: 0.97 });
    for (const polygon of GREEN_POLYGONS) {
      const lawn = new THREE.Mesh(this.polygonGeometry(polygon), seeded(polygon.cx, polygon.cz, 12) < 0.5 ? parkMaterial : dryMaterial);
      lawn.position.set(polygon.cx, 0.018, polygon.cz); lawn.receiveShadow = true; this.group.add(lawn);
      this.plantParkTrees(polygon);
      if (!GENERIC_AREA_NAMES.has(polygon.name.toLowerCase()) && polygon.area > 4000) this.addParkSign(polygon);
    }
    for (const polygon of DIRT_POLYGONS) { // mine dumps: Joburg's pale gold heaps, flat until Phase 3 terrain
      const dump = new THREE.Mesh(this.polygonGeometry(polygon), dirtMaterial);
      dump.position.set(polygon.cx, 0.016, polygon.cz); dump.receiveShadow = true; this.group.add(dump);
    }
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
    const nameBoard = createSignMesh(new THREE.PlaneGeometry(5.8, 1.25), polygon.name.toUpperCase(), '#d9b64b', { doubleSide: true });
    nameBoard.position.set(spot.x, 1.7, spot.z); this.group.add(nameBoard);
    for (const px of [-2.3, 2.3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.4, 10), new THREE.MeshStandardMaterial({ color: 0x354143, metalness: 0.62 })); post.position.set(spot.x + px, 1.2, spot.z); this.group.add(post); }
    this.props.register('sign', spot.x, spot.z, 0.2, 2.4);
  }

  // ---- Buildings (procedural massing fed by district densities) ---------------

  private buildDistricts(): void {
    this.buildPonte();
    this.buildHillbrowTower();
    this.buildWaterTower();
    let variant = 0; let placed = 0;
    // This build round only masses the CBD test blocks around spawn (data-driven zones); the rest
    // of the 36000u map stays bare roads. Widen TEST_BUILDING_ZONES + rebuild to populate more.
    for (let index = 0; index < this.roadsidePoints.length && placed < TEST_BUILDING_BUDGET; index += 2) {
      const point = this.roadsidePoints[index]!;
      if (point.width < 7) continue;
      if (!inBuildZone(point.x, point.z)) continue;
      const district = nearestDistrict(point.x, point.z);
      // Downtown massing (tall towers) inside the CBD core and near Ponte; a residential ring
      // beyond the core gives a natural height gradient to drive through. CBD_CENTER is data-driven,
      // so this tracks the map: the OSM "building count" density alone under-reads the CBD skyline.
      const inCbdCore = Math.hypot(point.x - CBD_CENTER.x, point.z - CBD_CENTER.z) < 260;
      const style: BuildingStyle = district.density >= 350 || inCbdCore || Math.hypot(point.x - PONTE_SPOT.x, point.z - PONTE_SPOT.z) < 320 ? 'downtown'
        : district.density < 40 ? 'industrial' : 'residential';
      const acceptance = style === 'downtown' ? 0.62 : style === 'residential' ? Math.min(0.5, 0.14 + district.density / 900) : 0.26;
      if (seeded(point.x, point.z, 90) > acceptance) continue;
      const residential = style === 'residential'; const industrial = style === 'industrial';
      const w = industrial ? 14 + seeded(point.x, point.z, 2) * 10 : residential ? 8 + seeded(point.x, point.z, 3) * 6 : 9 + seeded(point.x, point.z, 4) * 7;
      const d = industrial ? 12 + seeded(point.x, point.z, 5) * 9 : residential ? 8 + seeded(point.x, point.z, 6) * 5 : 9 + seeded(point.x, point.z, 7) * 7;
      const h = industrial ? 8 + seeded(point.x, point.z, 8) * 10 : residential ? 6 + seeded(point.x, point.z, 9) * 9 : 24 + seeded(point.x, point.z, 10) * 60;
      // Roadside points sit 3.05 beyond the road edge; push the parcel centre out past the sidewalk apron.
      const setback = Math.max(w, d) / 2 + sidewalkExtension(point.width) / 2 + 0.9 - 3.05;
      const cx = point.x - point.inwardX * setback;
      const cz = point.z - point.inwardZ * setback;
      if (Math.abs(cx) > WORLD_SIZE / 2 - 20 || Math.abs(cz) > WORLD_SIZE / 2 - 20) continue;
      const radius = Math.hypot(w, d) / 2;
      if (this.roadIndex.edgeDistance(cx, cz) < Math.min(w, d) / 2 - 1.1) continue; // would hang into a street
      if (this.isReserved(cx, cz, radius + 1.5) || this.inWater(cx, cz) || this.isPark(cx, cz)) continue;
      if (this.overlapsCollider(cx, cz, radius + 1.2)) continue;
      this.addBuilding(cx, cz, w, d, h, style, variant++);
      placed++;
    }
  }

  private addBuilding(x: number, z: number, w: number, d: number, h: number, style: BuildingStyle, variant: number): void {
    const parcel = new THREE.Mesh(new THREE.BoxGeometry(w + 4, 0.2, d + 4), new THREE.MeshStandardMaterial({ color: 0xb4b3aa, map: this.concrete, roughness: 0.92 })); parcel.position.set(x, 0.1, z); parcel.receiveShadow = true; this.group.add(parcel);
    const [rangeBase, rangeCount] = FACADE_RANGES[style];
    const facadeIndex = rangeBase + variant % rangeCount;
    const palette = BUILDING_PALETTES[style];
    const color = palette[facadeIndex % palette.length] ?? 0x9aa4a8;
    const key = `${style}-${facadeIndex}`; let facade = this.buildingMaterial.get(key);
    if (!facade) { facade = new THREE.MeshStandardMaterial({ color, map: this.facades[facadeIndex], emissive: 0xffffff, emissiveMap: this.facadeGlows[facadeIndex], emissiveIntensity: 0, roughness: 0.72, metalness: style === 'downtown' ? 0.12 : 0.02 }); this.buildingMaterial.set(key, facade); }
    const profile = this.architecture.build({ x, z, width: w, depth: d, height: h, style, variant, facade, roof: this.roofMaterial });
    // Full trim on downtown towers and every other building elsewhere: keeps the merged-mesh budget sane at city scale.
    const detailed = style === 'downtown' || variant % 2 === 0;
    this.addLedge(x, z, w * 1.025, d * 1.025, Math.min(h - 0.5, 3.6));
    if (detailed) this.addEntrance(x, z, w, d, style);
    if (detailed && style === 'residential') this.addBalconies(x, z, w, d, h);
    if (style === 'industrial') this.addIndustrialDetail(x, z, w, d, h, profile.roofY, variant);
    if (detailed && style !== 'industrial') this.addStreetLevelDetail(x, z, w, d, style, variant);
    this.addRoofEquipment(x, z, w, d, h, profile.roofY, style, variant);
    if (style === 'downtown' && h > 48 && variant % 4 === 0) this.addRoofSign(x, z, w, d, profile.roofY, variant);
    this.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, height: h });
  }

  private addLedge(x: number, z: number, w: number, d: number, y: number): void {
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.24, d), new THREE.MeshStandardMaterial({ color: 0xd0cec1, roughness: 0.76 })); ledge.position.set(x, y, z); ledge.castShadow = true; this.group.add(ledge);
  }

  private addEntrance(x: number, z: number, w: number, d: number, style: BuildingStyle): void {
    const glass = new THREE.MeshPhysicalMaterial({ color: style === 'industrial' ? 0x4a5353 : 0x3a6672, roughness: 0.16, metalness: 0.18, clearcoat: 0.6 });
    const doorW = Math.min(5.5, w * 0.32); const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, 3.1, 0.12), glass); door.position.set(x, 1.72, z + d / 2 + 0.08); this.group.add(door);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(doorW + 1.2, 0.18, 1.5), new THREE.MeshStandardMaterial({ color: 0x30383a, metalness: 0.45, roughness: 0.42 })); canopy.position.set(x, 3.35, z + d / 2 + 0.72); canopy.castShadow = true; this.group.add(canopy);
  }

  private addBalconies(x: number, z: number, w: number, d: number, h: number): void {
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x3c4546, metalness: 0.58, roughness: 0.4 });
    for (let y = 4.4; y < h - 1; y += 3.2) {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(w * 0.38, 0.14, 1.35), new THREE.MeshStandardMaterial({ color: 0xbdb9aa, roughness: 0.85 })); floor.position.set(x + w * 0.22, y, z + d / 2 + 0.62); floor.castShadow = true; this.group.add(floor);
      for (const px of [-w * 0.18, 0, w * 0.18]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), railMaterial); rail.position.set(x + w * 0.22 + px, y + 0.45, z + d / 2 + 1.16); this.group.add(rail); }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 0.07, 0.07), railMaterial); bar.position.set(x + w * 0.22, y + 0.84, z + d / 2 + 1.16); this.group.add(bar);
    }
  }

  private addIndustrialDetail(x: number, z: number, w: number, d: number, h: number, roofY: number, variant: number): void {
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, Math.min(5, h * 0.48), 0.14), new THREE.MeshStandardMaterial({ color: 0x5e6868, roughness: 0.52, metalness: 0.45 })); shutter.position.set(x, Math.min(5, h * 0.48) / 2 + 0.2, z + d / 2 + 0.09); this.group.add(shutter);
    for (const side of [-1, 1]) { const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.58, 1.7, 16), new THREE.MeshStandardMaterial({ color: 0x555e60, metalness: 0.6, roughness: 0.48 })); vent.position.set(x + side * w * 0.24, h + 1, z); this.group.add(vent); }
    if (variant % 3 === 0) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.05, Math.min(10, h * 0.7), 20), new THREE.MeshStandardMaterial({ color: 0x7a665d, roughness: 0.72, metalness: 0.16 })); stack.position.set(x - w * 0.28, h + Math.min(10, h * 0.7) / 2, z - d * 0.18); stack.castShadow = true; this.group.add(stack);
      for (let band = 0; band < 3; band++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.91 - band * 0.05, 0.08, 8, 20), new THREE.MeshStandardMaterial({ color: 0x363f42, metalness: 0.7, roughness: 0.38 })); ring.rotation.x = Math.PI / 2; ring.position.set(stack.position.x, h + 2.2 + band * 2.2, stack.position.z); this.group.add(ring); }
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
      const window = new THREE.Mesh(new THREE.BoxGeometry(Math.min(3.2, w / bays * 0.62), style === 'downtown' ? 2.35 : 1.65, 0.09), glass); window.position.set(px, style === 'downtown' ? 1.55 : 1.65, z + d / 2 + 0.075); this.group.add(window);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(Math.min(3.5, w / bays * 0.68), 0.1, 0.18), frame); sill.position.set(px, 0.4, z + d / 2 + 0.13); this.group.add(sill);
    }
    if (style === 'downtown' || variant % 3 === 0) {
      const colors = [0xc8503f, 0x2f7774, 0xd4a438, 0x586f91];
      const awning = new THREE.Mesh(new THREE.BoxGeometry(w * 0.46, 0.15, 1.25), new THREE.MeshStandardMaterial({ color: colors[variant % colors.length], roughness: 0.7 }));
      awning.position.set(x + w * 0.22, 3.1, z + d / 2 + 0.58); awning.rotation.x = -0.12; awning.castShadow = true; this.group.add(awning);
    }
  }

  private addRoofEquipment(x: number, z: number, w: number, d: number, h: number, roofY: number, style: BuildingStyle, variant: number): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x596467, metalness: 0.62, roughness: 0.46 });
    const units = style === 'downtown' ? 2 : style === 'industrial' ? 1 : 0;
    for (let index = 0; index < units; index++) {
      const unit = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.05, 1.35), metal); unit.position.set(x - w * 0.18 + index * 2.4, roofY + 0.52, z - d * 0.2); unit.castShadow = true; this.group.add(unit);
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 16), new THREE.MeshStandardMaterial({ color: 0x263033, metalness: 0.75, roughness: 0.35 })); fan.rotation.x = Math.PI / 2; fan.position.set(unit.position.x, roofY + 0.54, unit.position.z - 0.7); this.group.add(fan);
    }
    if (h > 42 && variant % 3 === 1) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.1, 8, 10), metal); mast.position.set(x + w * 0.2, roofY + 4, z); this.group.add(mast);
      const beaconMaterial = new THREE.MeshStandardMaterial({ color: 0xff4b3e, emissive: 0xff1f16, emissiveIntensity: 2 });
      registerPowered(beaconMaterial, 0xff4b3e, 0x3a1a16);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), beaconMaterial); beacon.position.set(mast.position.x, roofY + 8.05, z); this.group.add(beacon);
    }
  }

  private addRoofSign(x: number, z: number, w: number, d: number, h: number, variant: number): void {
    const names = ['CHICKEN LEKKER', 'MR VRRR PHAA', 'PIK-A-PAY', 'DEBONERS']; const accent = variant % 2 ? '#72d8d2' : '#f0ae43';
    const sign = createSignMesh(new THREE.PlaneGeometry(Math.min(12, w * 0.7), 3), names[variant % names.length] ?? 'CHICKEN LEKKER', accent, { powered: true }); sign.position.set(x, h + 3.2, z + d / 2 + 0.1); this.group.add(sign);
    for (const px of [-3, 3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 8), new THREE.MeshStandardMaterial({ color: 0x343b3d, metalness: 0.7 })); post.position.set(x + px, h + 1.5, z + d / 2); this.group.add(post); }
  }

  private addParkTree(x: number, z: number, variant: number): void {
    if (this.isOnRoad(x, z, 2.4)) return; // parks can overlap roads: no trunks on the tar
    this.props.register('tree', x, z, 0.5, 5.1);
    const tree = new THREE.Group(); tree.position.set(x, 0, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.55, 5.1, 16), new THREE.MeshStandardMaterial({ color: 0x60442f, roughness: 0.95 })); trunk.position.y = 2.55; trunk.castShadow = true; tree.add(trunk);
    const colors = [0x326d43, 0x3d7c49, 0x4b8650];
    const clusters: Array<[number, number, number, number]> = [[0, 6.2, 0, 2.2], [-1.35, 5.7, 0.25, 1.7], [1.2, 5.75, -0.2, 1.8], [0.2, 5.7, 1.1, 1.55]];
    clusters.forEach(([ox, oy, oz, scale], index) => { const crown = new THREE.Mesh(new THREE.SphereGeometry(scale, 20, 14), new THREE.MeshStandardMaterial({ color: colors[(variant + index) % colors.length], roughness: 0.9 })); crown.scale.y = 0.82; crown.position.set(ox, oy, oz); crown.castShadow = true; crown.receiveShadow = true; tree.add(crown); }); this.group.add(tree);
  }

  // ---- Landmarks -----------------------------------------------------------

  private buildPonte(): void {
    const x = PONTE_SPOT.x; const z = PONTE_SPOT.z; const height = 105; const radius = 24;
    const ponte = new THREE.Group(); ponte.position.set(x, 0, z);
    ponte.userData.far = true; // skyline landmark: merged into the never-culled far bucket so the silhouette doesn't pop at the chunk radius
    const facadeTexture = this.facades[0]?.clone(); if (facadeTexture) { facadeTexture.repeat.set(8, 6); facadeTexture.needsUpdate = true; }
    const facade = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, map: facadeTexture, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40, 1, true), facade); shell.position.y = height / 2; shell.castShadow = true; shell.receiveShadow = true;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, height, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c3336, roughness: 0.9, side: THREE.DoubleSide })); core.position.y = height / 2;
    const roof = new THREE.Mesh(new THREE.RingGeometry(15, radius, 40), new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, side: THREE.DoubleSide })); roof.rotation.x = -Math.PI / 2; roof.position.y = height;
    const crown = createSignMesh(new THREE.CylinderGeometry(radius + 1, radius + 1, 8, 40, 1, true, 0, Math.PI), 'VODACOMB', '#e4372e', { doubleSide: true, powered: true }); crown.position.y = height + 4;
    ponte.add(shell, core, roof, crown); this.group.add(ponte);
    this.colliders.push({ minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, height });
  }

  private buildHillbrowTower(): void {
    const x = HILLBROW_TOWER_SPOT.x; const z = HILLBROW_TOWER_SPOT.z; const height = 90;
    const tower = new THREE.Group(); tower.position.set(x, 0, z);
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
    const tower = new THREE.Group(); tower.position.set(WATER_TOWER_SPOT.x, 0, WATER_TOWER_SPOT.z);
    for (const x of [-2.4, 2.4]) for (const z of [-2.4, 2.4]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.25, 14, 10), metal); leg.position.set(x, 7, z); leg.rotation.z = x * 0.014; tower.add(leg); this.props.register('post', tower.position.x + x, tower.position.z + z, 0.3, 14); }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 3.8, 5.2, 32), new THREE.MeshStandardMaterial({ color: 0x738b8d, metalness: 0.42, roughness: 0.52 })); tank.position.y = 15.3; tank.castShadow = true; tower.add(tank);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(4.6, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x80999a, metalness: 0.38, roughness: 0.5 })); cap.position.y = 17.9; cap.castShadow = true; tower.add(cap);
    const label = createSignMesh(new THREE.PlaneGeometry(6.8, 1.7), 'JOBURG WATER', '#e5c15b'); label.position.set(0, 15.8, 4.7); tower.add(label);
    const subLabel = createSignMesh(new THREE.PlaneGeometry(4.4, 1.1), '(EMPTY)', '#e5c15b'); subLabel.position.set(0, 14.3, 4.72); tower.add(subLabel); this.group.add(tower);
  }
}
