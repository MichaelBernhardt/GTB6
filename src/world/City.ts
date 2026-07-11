import * as THREE from 'three';
import { COLORS, WORLD_SIZE } from '../config';
import type { District } from '../types';
import { BuildingArchitecture, type BuildingStyle } from './BuildingArchitecture';
import { createFacadeGlowTexture, createFacadeTexture, createGeneratedSurfaceTexture, createSignMesh, createSurfaceTexture, FACADE_VARIANTS } from './ProceduralMaterials';
import { mergeStaticGeometry } from './StaticGeometry';
import { bridgeIslands, buildNavGraph, type NavGraph, type NavPath } from '../systems/NavGraph';
import { PropRegistry } from '../systems/PropSystem';
import { CITY_JUNCTIONS, UrbanInfrastructure } from './UrbanInfrastructure';
import { registerPowered } from './powerGrid';

export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; height: number; }
export interface RoadPoint { x: number; z: number; }
export interface RoadsidePoint extends RoadPoint { inwardX: number; inwardZ: number; }
export interface RoadPose { position: THREE.Vector3; heading: number; }
export interface RoadDefinition { name: string; width: number; closed?: boolean; points: RoadPoint[]; }

export interface ParkDefinition { x: number; z: number; width: number; depth: number; kind: 'civic' | 'garden' | 'recreation'; name: string; }

/** Pure district lookup: Braamfontein owns the deep south, the far flanks are City Deep and Sandton,
 *  the central park belt is Zoo Lake, and everything else answers to the CBD. */
export function districtAt(x: number, z: number): District {
  if (z < -180) return 'Braamfontein';
  if (x < -145) return 'City Deep';
  if (x > 145) return 'Sandton';
  if (Math.abs(x) < 115 && Math.abs(z) < 115) return 'Zoo Lake';
  return 'Joburg CBD';
}

export const PARK_AREAS: ParkDefinition[] = [
  { x: 0, z: 0, width: 76, depth: 72, kind: 'civic', name: 'Zoo Lake Park' },
  { x: 245, z: 198, width: 52, depth: 38, kind: 'garden', name: 'Mushroom Farm Park' },
  { x: -118, z: -132, width: 58, depth: 40, kind: 'recreation', name: 'Pieter Roos Courts' },
];

export const ROAD_NETWORK: RoadDefinition[] = [
  { name: 'Jan Smuts Ave', width: 26, points: [{ x: -30, z: 350 }, { x: -24, z: 275 }, { x: -8, z: 205 }, { x: 14, z: 135 }, { x: 5, z: 65 }, { x: -12, z: -5 }, { x: -5, z: -80 }, { x: 22, z: -160 }, { x: 55, z: -245 }] },
  { name: 'William Nicol Dr', width: 24, points: [{ x: -350, z: 245 }, { x: -275, z: 230 }, { x: -205, z: 238 }, { x: -130, z: 225 }, { x: -50, z: 242 }, { x: 35, z: 230 }, { x: 115, z: 205 }, { x: 210, z: 190 }, { x: 300, z: 150 }, { x: 350, z: 110 }] },
  { name: 'Main Reef Rd', width: 22, points: [{ x: -350, z: 125 }, { x: -270, z: 115 }, { x: -205, z: 78 }, { x: -130, z: 50 }, { x: -60, z: 30 }, { x: 5, z: 12 }, { x: 75, z: -5 }, { x: 150, z: -35 }, { x: 225, z: -65 }, { x: 325, z: -110 }] },
  { name: 'Commissioner St', width: 26, points: [{ x: -350, z: -215 }, { x: -280, z: -198 }, { x: -210, z: -207 }, { x: -135, z: -225 }, { x: -55, z: -240 }, { x: 35, z: -252 }, { x: 130, z: -248 }, { x: 225, z: -232 }, { x: 305, z: -205 }, { x: 350, z: -175 }] },
  { name: 'Empire Rd', width: 18, points: [{ x: -190, z: 177 }, { x: -125, z: 135 }, { x: -60, z: 110 }, { x: 10, z: 105 }, { x: 80, z: 120 }, { x: 150, z: 158 }] },
  { name: 'Bree St Loop', width: 18, closed: true, points: [{ x: -122, z: 195 }, { x: -30, z: 200 }, { x: 75, z: 162 }, { x: 108, z: 82 }, { x: 82, z: 12 }, { x: 12, z: -22 }, { x: -76, z: 20 }, { x: -128, z: 98 }] },
  { name: 'Rivonia Rd', width: 18, closed: true, points: [{ x: 165, z: 265 }, { x: 250, z: 282 }, { x: 322, z: 225 }, { x: 334, z: 138 }, { x: 285, z: 65 }, { x: 220, z: 45 }, { x: 158, z: 105 }] },
  { name: 'Grayston Dr', width: 16, points: [{ x: 155, z: 5 }, { x: 215, z: -25 }, { x: 282, z: -8 }, { x: 338, z: 52 }] },
  { name: 'Louis Botha Ave', width: 21, closed: true, points: [{ x: -332, z: 58 }, { x: -262, z: 88 }, { x: -190, z: 45 }, { x: -175, z: -48 }, { x: -220, z: -132 }, { x: -310, z: -148 }, { x: -346, z: -62 }] },
  { name: 'Vilakazi St', width: 17, points: [{ x: -262, z: 88 }, { x: -278, z: 164 }, { x: -245, z: 235 }] },
  { name: 'Oxford Rd', width: 15, closed: true, points: [{ x: -88, z: 42 }, { x: -42, z: 88 }, { x: 25, z: 90 }, { x: 82, z: 46 }, { x: 84, z: -20 }, { x: 36, z: -72 }, { x: -35, z: -76 }, { x: -88, z: -35 }] },
  { name: 'Marshall St', width: 16, points: [{ x: 78, z: -246 }, { x: 138, z: -290 }, { x: 215, z: -315 }, { x: 292, z: -304 }, { x: 350, z: -268 }] },
];
const seeded = (x: number, z: number, salt = 0): number => {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
};

export const ROAD_SAMPLE_SPACING = 12;
export const VEHICLE_NAV_JOIN = 15;
export const PED_NAV_JOIN = 18;

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

const FACADE_RANGES: Record<BuildingStyle, [number, number]> = { downtown: [0, 6], residential: [6, 4], industrial: [10, 2] };
const BUILDING_PALETTES: Record<BuildingStyle, number[]> = {
  downtown: [0x9db1ba, 0xa3563f, 0xd0c4a4, 0x99a4a9, 0x93a9b0],
  residential: [0xdfb094, 0x8f4f3a, 0xe6d1a2, 0xa8bcc4, 0xa3563f],
  industrial: [0xa2a6a2, 0xb5924c, 0xb5a28c],
};

export class City {
  group = new THREE.Group();
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
  private buildingMaterial = new Map<string, THREE.MeshStandardMaterial>();
  private asphalt = createGeneratedSurfaceTexture('/textures/asphalt-gpt.jpg', 'asphalt', 1);
  private concrete = createGeneratedSurfaceTexture('/textures/concrete-gpt.jpg', 'concrete', 10);
  private grass = createSurfaceTexture('grass', 22);
  private sand = createSurfaceTexture('sand', 14);
  private water = createSurfaceTexture('water', 7);
  private facades = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeTexture(style));
  private facadeGlows = Array.from({ length: FACADE_VARIANTS }, (_, style) => createFacadeGlowTexture(style));
  private roofMaterial = new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, metalness: 0.08 });
  private waterMaterial?: THREE.MeshPhysicalMaterial;
  private architecture: BuildingArchitecture;
  private infrastructure: UrbanInfrastructure;

  constructor(scene: THREE.Scene) {
    this.group.name = 'Joburg'; scene.add(this.group);
    this.architecture = new BuildingArchitecture(this.group);
    this.buildGround(); this.buildRoads(); this.buildDistricts(); this.buildWaterfront();
    this.infrastructure = new UrbanInfrastructure(
      this.group,
      this.sidewalkPoints,
      this.roadsidePoints,
      (x, z, radius) => this.collides(x, z, radius),
      (x, z, margin) => this.isOnRoad(x, z, margin),
      this.props,
    );
    mergeStaticGeometry(this.group);
  }

  update(dt: number): void {
    if (this.waterMaterial?.map) this.waterMaterial.map.offset.x = (this.waterMaterial.map.offset.x + dt * 0.006) % 1;
    this.infrastructure.update(dt);
  }

  districtAt(x: number, z: number): District { return districtAt(x, z); }

  /** Shared facade materials (buildings are merged per material): the day/night cycle animates their emissiveIntensity for lit windows. */
  facadeMaterials(): THREE.MeshStandardMaterial[] { return [...this.buildingMaterial.values()]; }

  streetlightLampsXZ(): Float32Array { return this.infrastructure.lampsXZ; }

  setStreetlightGlow(factor: number): void { this.infrastructure.setLampGlow(factor); }

  isPark(x: number, z: number): boolean {
    return PARK_AREAS.some((park) => Math.abs(x - park.x) < park.width / 2 && Math.abs(z - park.z) < park.depth / 2);
  }

  collides(x: number, z: number, radius: number): boolean {
    if (Math.abs(x) > WORLD_SIZE / 2 - radius || Math.abs(z) > WORLD_SIZE / 2 - radius) return true;
    if (this.props.blocked(x, z, radius)) return true;
    return this.colliders.some((box) => x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ);
  }

  clampMove(from: THREE.Vector3, desired: THREE.Vector3, radius: number): THREE.Vector3 {
    const output = desired.clone();
    if (this.collides(output.x, from.z, radius)) output.x = from.x;
    if (this.collides(output.x, output.z, radius)) output.z = from.z;
    return output;
  }

  private buildGround(): void {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE), new THREE.MeshStandardMaterial({ color: COLORS.grass, map: this.grass, roughness: 0.96 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.group.add(ground);
  }

  private buildRoads(): void {
    const roadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.asphalt, roughness: 0.9, metalness: 0.02 });
    const centerMat = new THREE.MeshStandardMaterial({ color: 0xe7c564, roughness: 0.74 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xdedbc9, roughness: 0.8 });
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xa9aaa2, map: this.concrete, roughness: 0.92 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xc8c7bb, map: this.concrete, roughness: 0.88 });
    const dashTransforms: THREE.Matrix4[] = []; const edgeTransforms: THREE.Matrix4[] = [];
    for (const definition of ROAD_NETWORK) {
      const sampled = this.samplePath(definition.points, definition.closed ?? false, ROAD_SAMPLE_SPACING);
      this.roadSurfaces.push({ points: sampled, width: definition.width, closed: definition.closed ?? false });
      const mapPath = sampled.map((point) => ({ ...point }));
      if (definition.closed && mapPath[0]) mapPath.push({ ...mapPath[0] });
      this.roadPaths.push(mapPath);
      const sidewalk = this.createRoadStrip(sampled, definition.width + 7, sidewalkMat, 0.025, definition.closed ?? false); sidewalk.receiveShadow = true; this.group.add(sidewalk);
      const road = this.createRoadStrip(sampled, definition.width, roadMat, 0.055, definition.closed ?? false); road.receiveShadow = true; road.name = definition.name; this.group.add(road);
      this.addRoadMarkings(sampled, definition.width, definition.closed ?? false, dashTransforms, edgeTransforms);
      const leftLane = this.offsetPath(sampled, -definition.width * 0.23, definition.closed ?? false);
      const rightLane = this.offsetPath(sampled, definition.width * 0.23, definition.closed ?? false).reverse();
      this.trafficRoutes.push(leftLane, rightLane);
      this.roadPoints.push(...leftLane, ...rightLane);
      const leftWalk = this.offsetPath(sampled, -(definition.width / 2 + 2.2), definition.closed ?? false);
      const rightWalk = this.offsetPath(sampled, definition.width / 2 + 2.2, definition.closed ?? false);
      this.sidewalkPoints.push(...leftWalk.filter((_, index) => index % 2 === 0), ...rightWalk.filter((_, index) => index % 2 === 0));
      this.addRoadsidePoints(sampled, definition.width, definition.closed ?? false);
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addInstanced(box, centerMat, dashTransforms, false);
    this.addInstanced(box, edgeMat, edgeTransforms, false);
    const curbTransforms: THREE.Matrix4[] = [];
    for (const surface of this.roadSurfaces) this.addCurbs(surface.points, surface.width, surface.closed, curbTransforms);
    this.addInstanced(box, curbMat, curbTransforms, true);
    this.buildIntersections();
    this.buildPotholes();
  }

  private buildPotholes(): void {
    for (const point of this.roadPoints) {
      if (seeded(point.x, point.z, 55) <= 0.94) continue;
      const x = point.x + (seeded(point.x, point.z, 56) - 0.5) * 3;
      const z = point.z + (seeded(point.x, point.z, 57) - 0.5) * 3;
      if (!this.isOnRoad(x, z, -2)) continue;
      if (CITY_JUNCTIONS.some((junction) => Math.hypot(x - junction.x, z - junction.z) < 16)) continue;
      this.potholes.push({ x, z, r: 1.1 + seeded(point.x, point.z, 58) * 0.9 });
    }
    const holes = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 14), new THREE.MeshBasicMaterial({ color: 0x0d1113 }), this.potholes.length);
    const rims = new THREE.InstancedMesh(new THREE.RingGeometry(1, 1.22, 14), new THREE.MeshBasicMaterial({ color: 0x3f4649 }), this.potholes.length);
    const matrix = new THREE.Matrix4(); const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    this.potholes.forEach((pothole, index) => {
      matrix.compose(new THREE.Vector3(pothole.x, 0.07, pothole.z), flat, new THREE.Vector3(pothole.r, pothole.r, 1)); holes.setMatrixAt(index, matrix);
      matrix.compose(new THREE.Vector3(pothole.x, 0.072, pothole.z), flat, new THREE.Vector3(pothole.r, pothole.r, 1)); rims.setMatrixAt(index, matrix);
    });
    holes.instanceMatrix.needsUpdate = true; rims.instanceMatrix.needsUpdate = true;
    this.group.add(holes, rims);
  }

  private addInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, transforms: THREE.Matrix4[], shadows: boolean): void {
    const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
    transforms.forEach((transform, index) => mesh.setMatrixAt(index, transform));
    mesh.instanceMatrix.needsUpdate = true;
    if (shadows) { mesh.castShadow = true; mesh.receiveShadow = true; }
    this.group.add(mesh);
  }

  private buildIntersections(): void {
    const paint = new THREE.MeshStandardMaterial({ color: 0xe9e6d6, roughness: 0.78 });
    for (const { x, z, angle } of CITY_JUNCTIONS) for (let stripe = -7; stripe <= 7; stripe += 2.5) {
      const crossing = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.025, 6.2), paint); crossing.position.set(x + Math.cos(angle) * stripe, 0.09, z - Math.sin(angle) * stripe); crossing.rotation.y = angle; this.group.add(crossing);
    }
    this.buildTactileCorners();
  }

  isOnRoad(x: number, z: number, margin = 0): boolean {
    return this.roadSurfaces.some((surface) => this.distanceToPath(x, z, surface.points, surface.closed) <= surface.width / 2 + margin);
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
    const point = candidates[Math.floor(Math.random() * candidates.length)] ?? this.roadPoints[0] ?? { x: -300, z: 250 };
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
        this.roadsidePoints.push({ x: point.x, z: point.z, inwardX: -normalX * side, inwardZ: -normalZ * side });
      });
    }
  }

  private addCurbs(points: RoadPoint[], width: number, closed: boolean, transforms: THREE.Matrix4[]): void {
    const segmentCount = closed ? points.length : points.length - 1;
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion();
    for (let index = 0; index < segmentCount; index++) {
      const start = points[index]; const end = points[(index + 1) % points.length]; if (!start || !end) continue;
      const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz); if (length < 0.5) continue;
      const midX = (start.x + end.x) / 2; const midZ = (start.z + end.z) / 2;
      if (CITY_JUNCTIONS.some((junction) => Math.hypot(midX - junction.x, midZ - junction.z) < 14)) continue;
      const normalX = -dz / length; const normalZ = dx / length; quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
      for (const side of [-1, 1]) {
        const offset = side * (width / 2 + 0.22);
        const samples = [0, 0.5, 1].map((t) => ({ x: THREE.MathUtils.lerp(start.x, end.x, t) + normalX * offset, z: THREE.MathUtils.lerp(start.z, end.z, t) + normalZ * offset }));
        const crossesRoad = this.roadSurfaces.some((surface) => surface.points !== points && samples.some((sample) => this.distanceToPath(sample.x, sample.z, surface.points, surface.closed) <= surface.width / 2 + 1.2));
        if (crossesRoad) continue;
        matrix.compose(new THREE.Vector3(midX + normalX * offset, 0.15, midZ + normalZ * offset), quaternion, new THREE.Vector3(0.38, 0.22, length + 0.35)); transforms.push(matrix.clone());
      }
    }
  }

  private buildTactileCorners(): void {
    const patchTransforms: THREE.Matrix4[] = []; const bumpTransforms: THREE.Matrix4[] = [];
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion();
    for (const junction of CITY_JUNCTIONS) {
      const forward = new THREE.Vector3(Math.sin(junction.angle), 0, Math.cos(junction.angle)); const right = new THREE.Vector3(forward.z, 0, -forward.x);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), junction.angle);
      for (const forwardSide of [-1, 1]) for (const rightSide of [-1, 1]) {
        const center = new THREE.Vector3(junction.x, 0.24, junction.z).addScaledVector(forward, forwardSide * 14.7).addScaledVector(right, rightSide * 14.7);
        matrix.compose(center, quaternion, new THREE.Vector3(2.5, 0.09, 1.65)); patchTransforms.push(matrix.clone());
        for (let row = -1; row <= 1; row++) for (let column = -2; column <= 2; column++) {
          const local = new THREE.Vector3(column * 0.38, 0.09, row * 0.38).applyQuaternion(quaternion);
          matrix.makeTranslation(center.x + local.x, center.y + local.y, center.z + local.z); bumpTransforms.push(matrix.clone());
        }
      }
    }
    const tactile = new THREE.MeshStandardMaterial({ color: 0xd0a744, roughness: 0.82 });
    const patches = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), tactile, patchTransforms.length); patchTransforms.forEach((transform, index) => patches.setMatrixAt(index, transform));
    const bumps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.11, 0.07, 10), tactile, bumpTransforms.length); bumpTransforms.forEach((transform, index) => bumps.setMatrixAt(index, transform));
    patches.instanceMatrix.needsUpdate = true; bumps.instanceMatrix.needsUpdate = true; patches.receiveShadow = true; this.group.add(patches, bumps);
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

  private addRoadMarkings(points: RoadPoint[], width: number, closed: boolean, dashTransforms: THREE.Matrix4[], edgeTransforms: THREE.Matrix4[]): void {
    const segmentCount = closed ? points.length : points.length - 1;
    const quaternion = new THREE.Quaternion(); const matrix = new THREE.Matrix4();
    for (let index = 0; index < segmentCount; index++) {
      const start = points[index]; const end = points[(index + 1) % points.length]; if (!start || !end) continue;
      const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz); if (length < 0.5) continue;
      const angle = Math.atan2(dx, dz); const midX = (start.x + end.x) / 2; const midZ = (start.z + end.z) / 2;
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      if (index % 2 === 0) { matrix.compose(new THREE.Vector3(midX, 0.088, midZ), quaternion, new THREE.Vector3(0.24, 0.025, Math.min(6.4, length * 0.64))); dashTransforms.push(matrix.clone()); }
      const normalX = -dz / length; const normalZ = dx / length;
      for (const side of [-1, 1]) { matrix.compose(new THREE.Vector3(midX + normalX * side * (width / 2 - 0.72), 0.084, midZ + normalZ * side * (width / 2 - 0.72)), quaternion, new THREE.Vector3(0.13, 0.018, length + 0.35)); edgeTransforms.push(matrix.clone()); }
    }
  }

  private buildDistricts(): void {
    const districts: Array<{ style: 'downtown' | 'residential' | 'industrial'; centers: Array<[number, number]> }> = [
      { style: 'industrial', centers: [[-315, 185], [-255, 188], [-320, 108], [-235, 130], [-305, 15], [-230, -8], [-315, -85], [-245, -105], [-155, -145]] },
      { style: 'downtown', centers: [[-175, 305], [-105, 292], [-35, 305], [50, 292], [120, 260], [-170, 238], [-95, 192], [-18, 178], [72, 180], [142, 142], [-160, 142], [-95, 92], [-22, 72], [65, 65], [130, 22], [-142, 12], [-75, -28], [78, -58], [135, -105]] },
      { style: 'residential', centers: [[175, 325], [255, 330], [320, 290], [195, 252], [278, 238], [345, 205], [180, 180], [265, 150], [325, 105], [185, 92], [255, 42], [330, -10], [205, -72], [292, -105], [340, -155]] },
      { style: 'residential', centers: [[-145, -178], [-75, -188], [2, -192], [82, -188], [160, -175], [240, -160], [315, -145]] },
    ];
    this.buildPonte();
    let variant = 0;
    for (const district of districts) for (const [anchorX, anchorZ] of district.centers) {
      const industrial = district.style === 'industrial'; const residential = district.style === 'residential';
      const w = industrial ? 28 + seeded(anchorX, anchorZ, 2) * 16 : residential ? 14 + seeded(anchorX, anchorZ, 3) * 13 : 19 + seeded(anchorX, anchorZ, 4) * 20;
      const d = industrial ? 24 + seeded(anchorX, anchorZ, 5) * 18 : residential ? 13 + seeded(anchorX, anchorZ, 6) * 12 : 18 + seeded(anchorX, anchorZ, 7) * 18;
      const h = industrial ? 10 + seeded(anchorX, anchorZ, 8) * 13 : residential ? 7 + seeded(anchorX, anchorZ, 9) * 12 : 30 + seeded(anchorX, anchorZ, 10) * 67;
      const position = this.findParcelPosition(anchorX, anchorZ, Math.hypot(w, d) * 0.5 + 4, variant);
      if (!position) continue;
      this.addBuilding(position.x, position.z, w, d, h, district.style, variant++);
    }
    variant = this.buildInfillBuildings(variant);
    PARK_AREAS.forEach((park) => this.buildPark(park));
    this.buildCivicLandmarks();
    this.buildParkingAreas();
  }

  private buildInfillBuildings(startVariant: number): number {
    let variant = startVariant; let placed = 0;
    for (let gridZ = -310; gridZ <= 330 && placed < 72; gridZ += 38) for (let gridX = -330; gridX <= 340 && placed < 72; gridX += 38) {
      const anchorX = gridX + (seeded(gridX, gridZ, 70) - 0.5) * 19;
      const anchorZ = gridZ + (seeded(gridX, gridZ, 71) - 0.5) * 19;
      if (anchorZ < -245 || this.distanceToRoad(anchorX, anchorZ) > 58) continue;
      const district = this.districtAt(anchorX, anchorZ);
      const style = district === 'City Deep' ? 'industrial' : district === 'Sandton' || district === 'Braamfontein' ? 'residential' : 'downtown';
      const residential = style === 'residential'; const industrial = style === 'industrial';
      const w = residential ? 11 + seeded(anchorX, anchorZ, 72) * 10 : industrial ? 18 + seeded(anchorX, anchorZ, 73) * 13 : 14 + seeded(anchorX, anchorZ, 74) * 16;
      const d = residential ? 11 + seeded(anchorX, anchorZ, 75) * 9 : industrial ? 17 + seeded(anchorX, anchorZ, 76) * 14 : 14 + seeded(anchorX, anchorZ, 77) * 15;
      const h = residential ? 7 + seeded(anchorX, anchorZ, 78) * 10 : industrial ? 9 + seeded(anchorX, anchorZ, 79) * 13 : 18 + seeded(anchorX, anchorZ, 80) * 44;
      const position = this.findParcelPosition(anchorX, anchorZ, Math.hypot(w, d) * 0.5 + 2, variant);
      if (!position) continue;
      this.addBuilding(position.x, position.z, w, d, h, style, variant++); placed++;
    }
    return variant;
  }

  private findParcelPosition(anchorX: number, anchorZ: number, radius: number, salt: number): RoadPoint | undefined {
    for (let attempt = 0; attempt < 9; attempt++) {
      const x = anchorX + (seeded(anchorX + attempt, anchorZ, salt + 20) - 0.5) * 32; const z = anchorZ + (seeded(anchorX, anchorZ + attempt, salt + 21) - 0.5) * 32;
      if (this.distanceToRoad(x, z) < radius + 15) continue;
      if (PARK_AREAS.some((park) => Math.abs(x - park.x) < park.width / 2 + radius + 4 && Math.abs(z - park.z) < park.depth / 2 + radius + 4)) continue;
      if (this.colliders.some((box) => x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ)) continue;
      return { x, z };
    }
    return undefined;
  }

  private distanceToRoad(x: number, z: number): number {
    let nearest = Infinity;
    for (const surface of this.roadSurfaces) nearest = Math.min(nearest, this.distanceToPath(x, z, surface.points, surface.closed));
    return nearest;
  }

  private distanceToPath(x: number, z: number, path: RoadPoint[], closed: boolean): number {
    let nearest = Infinity; const segmentCount = closed ? path.length : path.length - 1;
    for (let index = 0; index < segmentCount; index++) {
      const start = path[index]; const end = path[(index + 1) % path.length]; if (!start || !end) continue;
      const dx = end.x - start.x; const dz = end.z - start.z; const lengthSquared = dx * dx + dz * dz || 1;
      const t = THREE.MathUtils.clamp(((x - start.x) * dx + (z - start.z) * dz) / lengthSquared, 0, 1);
      nearest = Math.min(nearest, Math.hypot(x - (start.x + dx * t), z - (start.z + dz * t)));
    }
    return nearest;
  }

  private buildParkingAreas(): void {
    const material = new THREE.MeshStandardMaterial({ color: 0x6f7371, map: this.asphalt, roughness: 0.92 }); const paint = new THREE.MeshStandardMaterial({ color: 0xe5e1ca, roughness: 0.8 });
    const lots: Array<[number, number, number, number, number]> = [[-300, -170, 48, 30, -0.12], [-150, 270, 42, 28, 0.18], [300, 178, 44, 30, -0.28], [155, -140, 50, 26, 0.08]];
    for (const [x, z, w, d, rotation] of lots) {
      const lot = new THREE.Mesh(new THREE.BoxGeometry(w, 0.13, d), material); lot.position.set(x, 0.1, z); lot.rotation.y = rotation; lot.receiveShadow = true; this.group.add(lot);
      for (let stall = -w / 2 + 4; stall < w / 2 - 2; stall += 4.5) { const line = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.02, d * 0.42), paint); line.position.set(stall, 0.18, 0); lot.add(line); }
    }
  }

  private addBuilding(x: number, z: number, w: number, d: number, h: number, style: BuildingStyle, variant: number): void {
    const parcel = new THREE.Mesh(new THREE.BoxGeometry(w + 6, 0.2, d + 6), new THREE.MeshStandardMaterial({ color: 0xb4b3aa, map: this.concrete, roughness: 0.92 })); parcel.position.set(x, 0.1, z); parcel.receiveShadow = true; this.group.add(parcel);
    const [rangeBase, rangeCount] = FACADE_RANGES[style];
    const facadeIndex = rangeBase + variant % rangeCount;
    const palette = BUILDING_PALETTES[style];
    const color = palette[facadeIndex % palette.length] ?? 0x9aa4a8;
    const key = `${style}-${facadeIndex}`; let facade = this.buildingMaterial.get(key);
    if (!facade) { facade = new THREE.MeshStandardMaterial({ color, map: this.facades[facadeIndex], emissive: 0xffffff, emissiveMap: this.facadeGlows[facadeIndex], emissiveIntensity: 0, roughness: 0.72, metalness: style === 'downtown' ? 0.12 : 0.02 }); this.buildingMaterial.set(key, facade); }
    const profile = this.architecture.build({ x, z, width: w, depth: d, height: h, style, variant, facade, roof: this.roofMaterial });
    this.addLedge(x, z, w * 1.025, d * 1.025, Math.min(h - 0.5, 3.6));
    this.addEntrance(x, z, w, d, style);
    if (style === 'residential') this.addBalconies(x, z, w, d, h);
    if (style === 'industrial') this.addIndustrialDetail(x, z, w, d, h, profile.roofY, variant);
    if (style !== 'industrial') this.addStreetLevelDetail(x, z, w, d, style, variant);
    this.addRoofEquipment(x, z, w, d, h, profile.roofY, style, variant);
    if (style === 'downtown' && h > 48 && variant % 2 === 0) this.addRoofSign(x, z, w, d, profile.roofY, variant);
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
    if (variant % 2 === 0) this.addRoofSign(x, z, w, d, roofY, variant);
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

  private buildPark(definition: ParkDefinition): void {
    const { x, z, width, depth, kind, name } = definition;
    const border = new THREE.Mesh(new THREE.BoxGeometry(width + 2.4, 0.3, depth + 2.4), new THREE.MeshStandardMaterial({ color: 0xb6b3a5, map: this.concrete, roughness: 0.9 })); border.position.set(x, 0.08, z); border.receiveShadow = true; this.group.add(border);
    const park = new THREE.Mesh(new THREE.BoxGeometry(width, 0.24, depth, 12, 1, 12), new THREE.MeshStandardMaterial({ color: kind === 'garden' ? 0x5f7a44 : 0x8a8149, map: this.grass, roughness: 0.96 })); park.position.set(x, 0.2, z); park.receiveShadow = true; this.group.add(park);
    const pathMat = new THREE.MeshStandardMaterial({ color: 0xd1c6a1, map: this.concrete, roughness: 0.91 });
    const pathA = new THREE.Mesh(new THREE.PlaneGeometry(5.2, depth), pathMat); pathA.rotation.x = -Math.PI / 2; pathA.position.set(x, 0.34, z); this.group.add(pathA);
    const pathB = new THREE.Mesh(new THREE.PlaneGeometry(width, 5.2), pathMat); pathB.rotation.x = -Math.PI / 2; pathB.position.set(x, 0.345, z); this.group.add(pathB);
    const nameBoard = createSignMesh(new THREE.PlaneGeometry(5.8, 1.25), name.toUpperCase(), '#d9b64b', { doubleSide: true }); nameBoard.position.set(x - width / 2 + 5.5, 1.7, z + depth / 2 - 1); this.group.add(nameBoard);
    for (const px of [-2.3, 2.3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.4, 10), new THREE.MeshStandardMaterial({ color: 0x354143, metalness: 0.62 })); post.position.set(nameBoard.position.x + px, 1.2, nameBoard.position.z); this.group.add(post); }
    if (kind === 'civic') this.addCivicParkFeature(x, z, width, depth);
    if (kind === 'garden') this.addGardenFeature(x, z, width, depth);
    if (kind === 'recreation') this.addRecreationFeature(x, z, width, depth);
    const treeSites: Array<[number, number]> = [[-0.37, -0.35], [0.37, -0.34], [-0.38, 0.34], [0.38, 0.35], [-0.12, 0.38], [0.14, -0.39]];
    treeSites.forEach(([nx, nz], index) => this.addParkTree(x + nx * width, z + nz * depth, index + Math.round(x)));
  }

  private addCivicParkFeature(x: number, z: number, width: number, depth: number): void {
    const stone = new THREE.MeshStandardMaterial({ color: 0xb9bbb3, roughness: 0.62 });
    const fountain = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.8, 0.72, 40), stone); fountain.position.set(x + width * 0.25, 0.62, z - depth * 0.23); fountain.castShadow = true; this.group.add(fountain);
    this.props.register('fountain', fountain.position.x, fountain.position.z, 5.8, 1.8);
    const pool = new THREE.Mesh(new THREE.CylinderGeometry(4.7, 4.7, 0.1, 40), new THREE.MeshPhysicalMaterial({ color: 0x4c9fac, roughness: 0.1, clearcoat: 1 })); pool.position.set(fountain.position.x, 1.01, fountain.position.z); this.group.add(pool);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.9, 3.2, 24), stone); column.position.set(fountain.position.x, 2.1, fountain.position.z); column.castShadow = true; this.group.add(column);
    const sculpture = new THREE.Mesh(new THREE.TorusKnotGeometry(0.75, 0.18, 80, 12), new THREE.MeshStandardMaterial({ color: 0x4a7777, metalness: 0.72, roughness: 0.28 })); sculpture.position.set(fountain.position.x, 4.05, fountain.position.z); sculpture.castShadow = true; this.group.add(sculpture);
  }

  private addGardenFeature(x: number, z: number, width: number, depth: number): void {
    const pond = new THREE.Mesh(new THREE.CircleGeometry(Math.min(width, depth) * 0.18, 40), new THREE.MeshPhysicalMaterial({ color: 0x397e83, roughness: 0.12, clearcoat: 0.85, side: THREE.DoubleSide })); pond.rotation.x = -Math.PI / 2; pond.position.set(x + width * 0.22, 0.39, z - depth * 0.18); this.group.add(pond);
    const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x76766b, roughness: 0.92 });
    for (let index = 0; index < 11; index++) { const angle = index / 11 * Math.PI * 2; const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.65 + (index % 3) * 0.17, 1), rockMaterial); rock.scale.y = 0.65; rock.position.set(pond.position.x + Math.cos(angle) * width * 0.2, 0.46, pond.position.z + Math.sin(angle) * depth * 0.2); this.group.add(rock); }
    const pergola = new THREE.Group(); pergola.position.set(x - width * 0.24, 0, z + depth * 0.2);
    const timber = new THREE.MeshStandardMaterial({ color: 0x765339, roughness: 0.76 });
    for (const px of [-3, 3]) for (const pz of [-2, 2]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.1, 0.22), timber); post.position.set(px, 1.55, pz); pergola.add(post); this.props.register('post', pergola.position.x + px, pergola.position.z + pz, 0.2, 3.1); }
    for (let pz = -2; pz <= 2; pz += 0.7) { const slat = new THREE.Mesh(new THREE.BoxGeometry(7, 0.16, 0.18), timber); slat.position.set(0, 3.1, pz); pergola.add(slat); } this.group.add(pergola);
    const flowerColors = [0xd95462, 0xf0c74a, 0xe9e5db, 0xb85f9e];
    for (let index = 0; index < 32; index++) { const flower = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 7), new THREE.MeshStandardMaterial({ color: flowerColors[index % flowerColors.length] })); flower.position.set(x - width * 0.37 + (index % 8) * 0.65, 0.58, z - depth * 0.34 + Math.floor(index / 8) * 0.65); this.group.add(flower); }
  }

  private addRecreationFeature(x: number, z: number, width: number, depth: number): void {
    const court = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.68, depth * 0.72), new THREE.MeshStandardMaterial({ color: 0x39706c, roughness: 0.88 })); court.rotation.x = -Math.PI / 2; court.position.set(x + width * 0.08, 0.38, z); this.group.add(court);
    const paint = new THREE.MeshBasicMaterial({ color: 0xe9e5d3 });
    const center = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.52, 32), paint); center.rotation.x = -Math.PI / 2; center.position.set(court.position.x, 0.4, z); this.group.add(center);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.12, depth * 0.72), paint); line.rotation.x = -Math.PI / 2; line.position.set(court.position.x, 0.405, z); this.group.add(line);
    for (const side of [-1, 1]) {
      const hoop = new THREE.Group(); hoop.position.set(court.position.x + side * width * 0.29, 0, z); hoop.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, 3.5, 12), new THREE.MeshStandardMaterial({ color: 0x303b3e, metalness: 0.7 })); pole.position.y = 1.75;
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 0.09), new THREE.MeshStandardMaterial({ color: 0xe7e4d8, roughness: 0.6 })); board.position.set(0, 3.2, 0.8);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 10, 24), new THREE.MeshStandardMaterial({ color: 0xd65b32, metalness: 0.45 })); rim.rotation.x = Math.PI / 2; rim.position.set(0, 2.85, 1.18); hoop.add(pole, board, rim); this.group.add(hoop);
      this.props.register('post', hoop.position.x, hoop.position.z, 0.2, 3.5);
    }
  }

  private addParkTree(x: number, z: number, variant: number): void {
    this.props.register('tree', x, z, 0.5, 5.1);
    const tree = new THREE.Group(); tree.position.set(x, 0, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.55, 5.1, 16), new THREE.MeshStandardMaterial({ color: 0x60442f, roughness: 0.95 })); trunk.position.y = 2.55; trunk.castShadow = true; tree.add(trunk);
    const colors = [0x326d43, 0x3d7c49, 0x4b8650];
    const clusters: Array<[number, number, number, number]> = [[0, 6.2, 0, 2.2], [-1.35, 5.7, 0.25, 1.7], [1.2, 5.75, -0.2, 1.8], [0.2, 5.7, 1.1, 1.55]];
    clusters.forEach(([ox, oy, oz, scale], index) => { const crown = new THREE.Mesh(new THREE.SphereGeometry(scale, 20, 14), new THREE.MeshStandardMaterial({ color: colors[(variant + index) % colors.length], roughness: 0.9 })); crown.scale.y = 0.82; crown.position.set(ox, oy, oz); crown.castShadow = true; crown.receiveShadow = true; tree.add(crown); }); this.group.add(tree);
  }

  private buildPonte(): void {
    const x = 112; const z = -138; const height = 105; const radius = 24;
    const ponte = new THREE.Group(); ponte.position.set(x, 0, z);
    const facadeTexture = this.facades[0]?.clone(); if (facadeTexture) { facadeTexture.repeat.set(8, 6); facadeTexture.needsUpdate = true; }
    const facade = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, map: facadeTexture, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40, 1, true), facade); shell.position.y = height / 2; shell.castShadow = true; shell.receiveShadow = true;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, height, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c3336, roughness: 0.9, side: THREE.DoubleSide })); core.position.y = height / 2;
    const roof = new THREE.Mesh(new THREE.RingGeometry(15, radius, 40), new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, side: THREE.DoubleSide })); roof.rotation.x = -Math.PI / 2; roof.position.y = height;
    const crown = createSignMesh(new THREE.CylinderGeometry(radius + 1, radius + 1, 8, 40, 1, true, 0, Math.PI), 'VODACOMB', '#e4372e', { doubleSide: true, powered: true }); crown.position.y = height + 4;
    ponte.add(shell, core, roof, crown); this.group.add(ponte);
    this.colliders.push({ minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, height });
  }

  private buildCivicLandmarks(): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x3d4b4e, metalness: 0.72, roughness: 0.38 });
    const tower = new THREE.Group(); tower.position.set(-338, 0, -165);
    for (const x of [-2.4, 2.4]) for (const z of [-2.4, 2.4]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.25, 14, 10), metal); leg.position.set(x, 7, z); leg.rotation.z = x * 0.014; tower.add(leg); this.props.register('post', tower.position.x + x, tower.position.z + z, 0.3, 14); }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 3.8, 5.2, 32), new THREE.MeshStandardMaterial({ color: 0x738b8d, metalness: 0.42, roughness: 0.52 })); tank.position.y = 15.3; tank.castShadow = true; tower.add(tank);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(4.6, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x80999a, metalness: 0.38, roughness: 0.5 })); cap.position.y = 17.9; cap.castShadow = true; tower.add(cap);
    const label = createSignMesh(new THREE.PlaneGeometry(6.8, 1.7), 'JOBURG WATER', '#e5c15b'); label.position.set(0, 15.8, 4.7); tower.add(label);
    const subLabel = createSignMesh(new THREE.PlaneGeometry(4.4, 1.1), '(EMPTY)', '#e5c15b'); subLabel.position.set(0, 14.3, 4.72); tower.add(subLabel); this.group.add(tower);

    const sculpture = new THREE.Group(); sculpture.position.set(318, 0, -273);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 1.1, 32), new THREE.MeshStandardMaterial({ color: 0xb5afa0, roughness: 0.72 })); base.position.y = 0.65;
    const sail = new THREE.Mesh(new THREE.ConeGeometry(3.2, 13, 3), new THREE.MeshStandardMaterial({ color: 0xd8d7c9, metalness: 0.18, roughness: 0.42, side: THREE.DoubleSide })); sail.position.set(0, 7.4, 0); sail.rotation.z = 0.18; sail.castShadow = true; sculpture.add(base, sail); this.group.add(sculpture);
    this.props.register('monument', sculpture.position.x, sculpture.position.z, 4, 1.5);
  }

  private buildWaterfront(): void {
    this.waterMaterial = new THREE.MeshPhysicalMaterial({ color: COLORS.water, map: this.water, roughness: 0.16, metalness: 0.05, clearcoat: 0.85, clearcoatRoughness: 0.16, transparent: true, opacity: 0.94 });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(470, 90, 24, 8), this.waterMaterial); water.rotation.x = -Math.PI / 2; water.position.set(135, 0.1, -340); water.userData.dynamic = true; this.group.add(water);
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(460, 48), new THREE.MeshStandardMaterial({ color: 0xcdb35e, map: this.sand, roughness: 0.96 })); sand.rotation.x = -Math.PI / 2; sand.position.set(140, 0.06, -286); sand.receiveShadow = true; this.group.add(sand);
    for (let x = -330; x < -190; x += 35) {
      const material = new THREE.MeshStandardMaterial({ color: x % 2 ? 0xb84f45 : 0x3d7381, roughness: 0.65, metalness: 0.32 });
      const container = new THREE.Mesh(new THREE.BoxGeometry(26, 5, 9, 13, 1, 1), material); container.position.set(x, 2.5, -270); container.castShadow = true; this.group.add(container);
      for (let ridge = -11; ridge <= 11; ridge += 2) { const rib = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.7, 0.14), new THREE.MeshStandardMaterial({ color: 0x343c3d, metalness: 0.55, roughness: 0.45 })); rib.position.set(x + ridge, 2.5, -265.45); this.group.add(rib); }
      this.colliders.push({ minX: x - 13, maxX: x + 13, minZ: -274.5, maxZ: -265.5, height: 5 });
    }
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(13, 1, 22), new THREE.MeshStandardMaterial({ color: 0x8b8f8b, map: this.concrete, roughness: 0.87 })); ramp.position.set(-185, 1, -225); ramp.rotation.x = -0.08; ramp.castShadow = true; this.group.add(ramp);
    const boardwalk = new THREE.Mesh(new THREE.BoxGeometry(190, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x8d6e4f, roughness: 0.86 })); boardwalk.position.set(150, 0.25, -307); boardwalk.receiveShadow = true; this.group.add(boardwalk);
    this.buildPromenadeDetails();
    this.buildPortCranes();
  }

  private buildPromenadeDetails(): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x334346, metalness: 0.74, roughness: 0.36 });
    const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, 1.25, 10), metal, 39);
    const rails = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.045, 0.045, 4.9, 8), metal, 38);
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    for (let index = 0; index < 39; index++) { const x = 55 + index * 5; matrix.makeTranslation(x, 0.92, -311.2); posts.setMatrixAt(index, matrix); }
    for (let index = 0; index < 38; index++) { matrix.compose(new THREE.Vector3(57.5 + index * 5, 1.3, -311.2), quaternion, new THREE.Vector3(1, 1, 1)); rails.setMatrixAt(index, matrix); }
    posts.castShadow = true; rails.castShadow = true; this.group.add(posts, rails);

    const kioskColors = [0x2f7775, 0xc65e45, 0xd6a33c];
    for (let index = 0; index < 3; index++) {
      const kiosk = new THREE.Group(); kiosk.position.set(92 + index * 58, 0.3, -299);
      const body = new THREE.Mesh(new THREE.BoxGeometry(7.5, 3.2, 4.8), new THREE.MeshStandardMaterial({ color: kioskColors[index], roughness: 0.7 })); body.position.y = 1.6; body.castShadow = true;
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 4.8, 0.25, 3), new THREE.MeshStandardMaterial({ color: 0xe3d8bd, roughness: 0.78 })); roof.rotation.y = Math.PI / 2; roof.scale.z = 0.9; roof.position.y = 3.85; roof.castShadow = true;
      const counter = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.2, 1), metal); counter.position.set(0, 1.45, 2.85); kiosk.add(body, roof, counter); this.group.add(kiosk);
      this.props.register('shelter', kiosk.position.x, kiosk.position.z, 3.6, 3.2);
    }

    const lifeguard = new THREE.Group(); lifeguard.position.set(258, 0.25, -286);
    for (const x of [-1.3, 1.3]) for (const z of [-1.1, 1.1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.4, 0.16), metal); leg.position.set(x, 1.2, z); lifeguard.add(leg); }
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.5, 3.3), new THREE.MeshStandardMaterial({ color: 0xe8d7b2, roughness: 0.78 })); cabin.position.y = 3.2;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.2, 1.3, 4), new THREE.MeshStandardMaterial({ color: 0xd75844, roughness: 0.67 })); roof.position.y = 5.05; roof.rotation.y = Math.PI / 4; lifeguard.add(cabin, roof); this.group.add(lifeguard);
    this.props.register('shelter', lifeguard.position.x, lifeguard.position.z, 2.3, 4.5);
  }

  private buildPortCranes(): void {
    const steel = new THREE.MeshStandardMaterial({ color: 0xd2a82f, metalness: 0.58, roughness: 0.42 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x303a3d, metalness: 0.72, roughness: 0.34 });
    for (const x of [-302, -225]) {
      const crane = new THREE.Group(); crane.position.set(x, 0, -292);
      this.props.register('crane', x, -292, 1.3, 24);
      const tower = new THREE.Mesh(new THREE.BoxGeometry(1.4, 24, 1.4), steel); tower.position.y = 12; tower.castShadow = true;
      const boom = new THREE.Mesh(new THREE.BoxGeometry(30, 0.8, 0.8), steel); boom.position.set(8, 23.6, 0); boom.rotation.z = -0.08; boom.castShadow = true;
      const counter = new THREE.Mesh(new THREE.BoxGeometry(5.5, 3.1, 2.8), dark); counter.position.set(-7.2, 22.4, 0);
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 14, 6), dark); cable.position.set(18, 16.4, 0);
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.09, 8, 14, Math.PI * 1.55), dark); hook.position.set(18, 9.3, 0); crane.add(tower, boom, counter, cable, hook); this.group.add(crane);
    }
  }
}
