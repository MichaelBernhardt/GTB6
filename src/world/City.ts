import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BLOCK_SIZE, COLORS, WORLD_SIZE } from '../config';
import type { District } from '../types';
import { createFacadeTexture, createGeneratedSurfaceTexture, createSignTexture, createSurfaceTexture } from './ProceduralMaterials';

export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; height: number; }
export interface RoadPoint { x: number; z: number; }
export interface RoadPose { position: THREE.Vector3; heading: number; }
export interface RoadDefinition { name: string; width: number; closed?: boolean; points: RoadPoint[]; }

export const ROAD_NETWORK: RoadDefinition[] = [
  { name: 'Avenida Cordova', width: 26, points: [{ x: -30, z: 350 }, { x: -24, z: 275 }, { x: -8, z: 205 }, { x: 14, z: 135 }, { x: 5, z: 65 }, { x: -12, z: -5 }, { x: -5, z: -80 }, { x: 22, z: -160 }, { x: 55, z: -245 }] },
  { name: 'Libertad Boulevard', width: 24, points: [{ x: -350, z: 245 }, { x: -275, z: 230 }, { x: -205, z: 238 }, { x: -130, z: 225 }, { x: -50, z: 242 }, { x: 35, z: 230 }, { x: 115, z: 205 }, { x: 210, z: 190 }, { x: 300, z: 150 }, { x: 350, z: 110 }] },
  { name: 'Mercado Way', width: 22, points: [{ x: -350, z: 125 }, { x: -270, z: 115 }, { x: -205, z: 78 }, { x: -130, z: 50 }, { x: -60, z: 30 }, { x: 5, z: 12 }, { x: 75, z: -5 }, { x: 150, z: -35 }, { x: 225, z: -65 }, { x: 325, z: -110 }] },
  { name: 'Harbor Drive', width: 26, points: [{ x: -350, z: -215 }, { x: -280, z: -198 }, { x: -210, z: -207 }, { x: -135, z: -225 }, { x: -55, z: -240 }, { x: 35, z: -252 }, { x: 130, z: -248 }, { x: 225, z: -232 }, { x: 305, z: -205 }, { x: 350, z: -175 }] },
  { name: 'Civic Avenue', width: 18, points: [{ x: -190, z: 177 }, { x: -125, z: 135 }, { x: -60, z: 110 }, { x: 10, z: 105 }, { x: 80, z: 120 }, { x: 150, z: 158 }] },
  { name: 'Centro Loop', width: 18, closed: true, points: [{ x: -122, z: 195 }, { x: -30, z: 200 }, { x: 75, z: 162 }, { x: 108, z: 82 }, { x: 82, z: 12 }, { x: 12, z: -22 }, { x: -76, z: 20 }, { x: -128, z: 98 }] },
  { name: 'Las Palmas Ring', width: 18, closed: true, points: [{ x: 165, z: 265 }, { x: 250, z: 282 }, { x: 322, z: 225 }, { x: 334, z: 138 }, { x: 285, z: 65 }, { x: 220, z: 45 }, { x: 158, z: 105 }] },
  { name: 'Palmera Crescent', width: 16, points: [{ x: 155, z: 5 }, { x: 215, z: -25 }, { x: 282, z: -8 }, { x: 338, z: 52 }] },
  { name: 'Mercado Ring', width: 21, closed: true, points: [{ x: -332, z: 58 }, { x: -262, z: 88 }, { x: -190, z: 45 }, { x: -175, z: -48 }, { x: -220, z: -132 }, { x: -310, z: -148 }, { x: -346, z: -62 }] },
  { name: 'Foundry Road', width: 17, points: [{ x: -262, z: 88 }, { x: -278, z: 164 }, { x: -245, z: 235 }] },
  { name: 'Commons Ring', width: 15, closed: true, points: [{ x: -88, z: 42 }, { x: -42, z: 88 }, { x: 25, z: 90 }, { x: 82, z: 46 }, { x: 84, z: -20 }, { x: 36, z: -72 }, { x: -35, z: -76 }, { x: -88, z: -35 }] },
  { name: 'Costa Crescent', width: 16, points: [{ x: 78, z: -246 }, { x: 138, z: -290 }, { x: 215, z: -315 }, { x: 292, z: -304 }, { x: 350, z: -268 }] },
];
const seeded = (x: number, z: number, salt = 0): number => {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
};

export class City {
  group = new THREE.Group();
  colliders: Collider[] = [];
  roadPoints: RoadPoint[] = [];
  sidewalkPoints: RoadPoint[] = [];
  roadPaths: RoadPoint[][] = [];
  trafficRoutes: RoadPoint[][] = [];
  private buildingMaterial = new Map<string, THREE.MeshStandardMaterial>();
  private asphalt = createGeneratedSurfaceTexture('/textures/asphalt-gpt.jpg', 'asphalt', 1);
  private concrete = createGeneratedSurfaceTexture('/textures/concrete-gpt.jpg', 'concrete', 10);
  private grass = createSurfaceTexture('grass', 22);
  private sand = createSurfaceTexture('sand', 14);
  private water = createSurfaceTexture('water', 7);
  private facades = [0, 1, 2, 3].map(createFacadeTexture);
  private waterMaterial?: THREE.MeshPhysicalMaterial;

  constructor(scene: THREE.Scene) {
    this.group.name = 'San Cordova'; scene.add(this.group);
    this.buildGround(); this.buildRoads(); this.buildDistricts(); this.buildProps(); this.buildWaterfront();
  }

  update(dt: number): void {
    if (this.waterMaterial?.map) this.waterMaterial.map.offset.x = (this.waterMaterial.map.offset.x + dt * 0.006) % 1;
  }

  districtAt(x: number, z: number): District {
    if (z < -180) return 'Costa Azul';
    if (x < -145) return 'Mercado Industrial';
    if (x > 145) return 'Las Palmas';
    if (Math.abs(x) < 115 && Math.abs(z) < 115) return 'Cordova Commons';
    return 'Downtown';
  }

  collides(x: number, z: number, radius: number): boolean {
    if (Math.abs(x) > WORLD_SIZE / 2 - radius || Math.abs(z) > WORLD_SIZE / 2 - radius) return true;
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
    for (const definition of ROAD_NETWORK) {
      const sampled = this.samplePath(definition.points, definition.closed ?? false, 12);
      const mapPath = sampled.map((point) => ({ ...point }));
      if (definition.closed && mapPath[0]) mapPath.push({ ...mapPath[0] });
      this.roadPaths.push(mapPath);
      const sidewalk = this.createRoadStrip(sampled, definition.width + 7, sidewalkMat, 0.025, definition.closed ?? false); sidewalk.receiveShadow = true; this.group.add(sidewalk);
      const road = this.createRoadStrip(sampled, definition.width, roadMat, 0.055, definition.closed ?? false); road.receiveShadow = true; road.name = definition.name; this.group.add(road);
      this.addRoadMarkings(sampled, definition.width, centerMat, edgeMat, definition.closed ?? false);
      const leftLane = this.offsetPath(sampled, -definition.width * 0.23, definition.closed ?? false);
      const rightLane = this.offsetPath(sampled, definition.width * 0.23, definition.closed ?? false).reverse();
      this.trafficRoutes.push(leftLane, rightLane);
      this.roadPoints.push(...leftLane, ...rightLane);
      const leftWalk = this.offsetPath(sampled, -(definition.width / 2 + 2.2), definition.closed ?? false);
      const rightWalk = this.offsetPath(sampled, definition.width / 2 + 2.2, definition.closed ?? false);
      this.sidewalkPoints.push(...leftWalk.filter((_, index) => index % 2 === 0), ...rightWalk.filter((_, index) => index % 2 === 0));
    }
    this.buildIntersections();
  }

  private buildIntersections(): void {
    const paint = new THREE.MeshStandardMaterial({ color: 0xe9e6d6, roughness: 0.78 });
    const junctions: Array<[number, number, number]> = [[-8, 205, 0.2], [5, 12, -0.2], [75, -5, -0.35], [-262, 88, 0.18], [-130, 50, -0.28], [115, 205, 0.32], [78, -246, 0.65]];
    for (const [x, z, angle] of junctions) for (let stripe = -7; stripe <= 7; stripe += 2.5) {
      const crossing = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.025, 6.2), paint); crossing.position.set(x + Math.cos(angle) * stripe, 0.09, z - Math.sin(angle) * stripe); crossing.rotation.y = angle; this.group.add(crossing);
    }
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

  private samplePath(points: RoadPoint[], closed: boolean, spacing: number): RoadPoint[] {
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

  private offsetPath(points: RoadPoint[], offset: number, closed: boolean): RoadPoint[] {
    return points.map((point, index) => {
      const previous = points[index === 0 ? (closed ? points.length - 1 : 0) : index - 1] ?? point;
      const next = points[index === points.length - 1 ? (closed ? 0 : points.length - 1) : index + 1] ?? point;
      const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
      return { x: point.x - dz / length * offset, z: point.z + dx / length * offset };
    });
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

  private addRoadMarkings(points: RoadPoint[], width: number, center: THREE.Material, edge: THREE.Material, closed: boolean): void {
    const segmentCount = closed ? points.length : points.length - 1;
    const dashTransforms: THREE.Matrix4[] = []; const edgeTransforms: THREE.Matrix4[] = [];
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
    const box = new THREE.BoxGeometry(1, 1, 1);
    const dashes = new THREE.InstancedMesh(box, center, dashTransforms.length); dashTransforms.forEach((transform, index) => dashes.setMatrixAt(index, transform)); dashes.instanceMatrix.needsUpdate = true;
    const edges = new THREE.InstancedMesh(box, edge, edgeTransforms.length); edgeTransforms.forEach((transform, index) => edges.setMatrixAt(index, transform)); edges.instanceMatrix.needsUpdate = true;
    this.group.add(dashes, edges);
  }

  private buildDistricts(): void {
    const districts: Array<{ style: 'downtown' | 'residential' | 'industrial'; centers: Array<[number, number]> }> = [
      { style: 'industrial', centers: [[-315, 185], [-255, 188], [-320, 108], [-235, 130], [-305, 15], [-230, -8], [-315, -85], [-245, -105], [-155, -145]] },
      { style: 'downtown', centers: [[-175, 305], [-105, 292], [-35, 305], [50, 292], [120, 260], [-170, 238], [-95, 192], [-18, 178], [72, 180], [142, 142], [-160, 142], [-95, 92], [-22, 72], [65, 65], [130, 22], [-142, 12], [-75, -28], [78, -58], [135, -105]] },
      { style: 'residential', centers: [[175, 325], [255, 330], [320, 290], [195, 252], [278, 238], [345, 205], [180, 180], [265, 150], [325, 105], [185, 92], [255, 42], [330, -10], [205, -72], [292, -105], [340, -155]] },
      { style: 'residential', centers: [[-145, -178], [-75, -188], [2, -192], [82, -188], [160, -175], [240, -160], [315, -145]] },
    ];
    let variant = 0;
    for (const district of districts) for (const [anchorX, anchorZ] of district.centers) {
      const industrial = district.style === 'industrial'; const residential = district.style === 'residential';
      const w = industrial ? 28 + seeded(anchorX, anchorZ, 2) * 16 : residential ? 14 + seeded(anchorX, anchorZ, 3) * 13 : 19 + seeded(anchorX, anchorZ, 4) * 20;
      const d = industrial ? 24 + seeded(anchorX, anchorZ, 5) * 18 : residential ? 13 + seeded(anchorX, anchorZ, 6) * 12 : 18 + seeded(anchorX, anchorZ, 7) * 18;
      const h = industrial ? 10 + seeded(anchorX, anchorZ, 8) * 13 : residential ? 7 + seeded(anchorX, anchorZ, 9) * 12 : 30 + seeded(anchorX, anchorZ, 10) * 67;
      const position = this.findParcelPosition(anchorX, anchorZ, Math.hypot(w, d) * 0.5 + 4, variant);
      if (!position) continue;
      const palette = industrial ? [0x8d918d, 0x777f82, 0xa28c73] : residential ? [0xd59a79, 0xaec3b0, 0xe0c587, 0x91a8b1] : [0x8aa0aa, 0xb77d74, 0xc8b98e, 0x818b91];
      this.addBuilding(position.x, position.z, w, d, h, palette[variant % palette.length] ?? 0x8a9498, district.style, variant++);
    }
    this.buildPark(0, 0); this.buildParkingAreas();
  }

  private findParcelPosition(anchorX: number, anchorZ: number, radius: number, salt: number): RoadPoint | undefined {
    for (let attempt = 0; attempt < 9; attempt++) {
      const x = anchorX + (seeded(anchorX + attempt, anchorZ, salt + 20) - 0.5) * 32; const z = anchorZ + (seeded(anchorX, anchorZ + attempt, salt + 21) - 0.5) * 32;
      if (this.distanceToRoad(x, z) < radius + 15) continue;
      if (this.colliders.some((box) => x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ)) continue;
      return { x, z };
    }
    return undefined;
  }

  private distanceToRoad(x: number, z: number): number {
    let nearest = Infinity;
    for (const path of this.roadPaths) for (let index = 0; index < path.length - 1; index++) {
      const start = path[index]; const end = path[index + 1]; if (!start || !end) continue;
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

  private addBuilding(x: number, z: number, w: number, d: number, h: number, color: number, style: string, variant: number): void {
    const parcel = new THREE.Mesh(new THREE.BoxGeometry(w + 6, 0.2, d + 6), new THREE.MeshStandardMaterial({ color: 0xb4b3aa, map: this.concrete, roughness: 0.92 })); parcel.position.set(x, 0.1, z); parcel.receiveShadow = true; this.group.add(parcel);
    const facadeIndex = (variant + (style === 'industrial' ? 3 : style === 'residential' ? 2 : 0)) % this.facades.length;
    const key = `${color}-${facadeIndex}`; let facade = this.buildingMaterial.get(key);
    if (!facade) { facade = new THREE.MeshStandardMaterial({ color, map: this.facades[facadeIndex], roughness: 0.72, metalness: style === 'downtown' ? 0.12 : 0.02 }); this.buildingMaterial.set(key, facade); }
    const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86, metalness: 0.08 });
    if (style === 'downtown' && h > 34) {
      const lowerH = h * 0.68; const lower = new THREE.Mesh(new THREE.BoxGeometry(w, lowerH, d), [facade, facade, roofMaterial, roofMaterial, facade, facade]); lower.position.set(x, lowerH / 2 + 0.18, z); lower.castShadow = true; lower.receiveShadow = true; this.group.add(lower);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, h - lowerH, d * 0.78), [facade, facade, roofMaterial, roofMaterial, facade, facade]); upper.position.set(x, lowerH + (h - lowerH) / 2 + 0.18, z); upper.castShadow = true; this.group.add(upper);
      this.addLedge(x, z, w * 1.035, d * 1.035, lowerH + 0.2);
    } else {
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [facade, facade, roofMaterial, roofMaterial, facade, facade]); base.position.set(x, h / 2 + 0.18, z); base.castShadow = true; base.receiveShadow = true; this.group.add(base);
    }
    this.addLedge(x, z, w * 1.025, d * 1.025, Math.min(h - 0.5, 3.6));
    const roofH = Math.min(2.3, h * 0.08); const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 0.38, roofH, d * 0.35), roofMaterial); roof.position.set(x, h + roofH / 2 + 0.18, z); roof.castShadow = true; this.group.add(roof);
    this.addEntrance(x, z, w, d, style);
    if (style === 'residential') this.addBalconies(x, z, w, d, h);
    if (style === 'industrial') this.addIndustrialDetail(x, z, w, d, h, variant);
    if (style === 'downtown' && h > 48 && variant % 2 === 0) this.addRoofSign(x, z, w, d, h, variant);
    this.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, height: h });
  }

  private addLedge(x: number, z: number, w: number, d: number, y: number): void {
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.24, d), new THREE.MeshStandardMaterial({ color: 0xd0cec1, roughness: 0.76 })); ledge.position.set(x, y, z); ledge.castShadow = true; this.group.add(ledge);
  }

  private addEntrance(x: number, z: number, w: number, d: number, style: string): void {
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

  private addIndustrialDetail(x: number, z: number, w: number, d: number, h: number, variant: number): void {
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, Math.min(5, h * 0.48), 0.14), new THREE.MeshStandardMaterial({ color: 0x5e6868, roughness: 0.52, metalness: 0.45 })); shutter.position.set(x, Math.min(5, h * 0.48) / 2 + 0.2, z + d / 2 + 0.09); this.group.add(shutter);
    for (const side of [-1, 1]) { const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.58, 1.7, 16), new THREE.MeshStandardMaterial({ color: 0x555e60, metalness: 0.6, roughness: 0.48 })); vent.position.set(x + side * w * 0.24, h + 1, z); this.group.add(vent); }
    if (variant % 2 === 0) this.addRoofSign(x, z, w, d, h, variant);
  }

  private addRoofSign(x: number, z: number, w: number, d: number, h: number, variant: number): void {
    const names = ['CORDOVA', 'MARINA', 'MERCADO', 'SOL']; const accent = variant % 2 ? '#72d8d2' : '#f0ae43';
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(12, w * 0.7), 3), new THREE.MeshBasicMaterial({ map: createSignTexture(names[variant % names.length], accent), transparent: true })); sign.position.set(x, h + 3.2, z + d / 2 + 0.1); this.group.add(sign);
    for (const px of [-3, 3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 8), new THREE.MeshStandardMaterial({ color: 0x343b3d, metalness: 0.7 })); post.position.set(x + px, h + 1.5, z + d / 2); this.group.add(post); }
  }

  private buildPark(x: number, z: number): void {
    const park = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_SIZE + 3, 0.18, BLOCK_SIZE + 3), new THREE.MeshStandardMaterial({ color: 0x628a55, map: this.grass, roughness: 0.98 })); park.position.set(x, 0.06, z); park.receiveShadow = true; this.group.add(park);
    const pathMat = new THREE.MeshStandardMaterial({ color: 0xd1c6a1, map: this.concrete, roughness: 0.91 });
    const pathA = new THREE.Mesh(new THREE.PlaneGeometry(8, BLOCK_SIZE), pathMat); pathA.rotation.x = -Math.PI / 2; pathA.position.set(x, 0.18, z); this.group.add(pathA);
    const pathB = pathA.clone(); pathB.rotation.z = Math.PI / 2; this.group.add(pathB);
    const fountain = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 5.2, 0.65, 32), new THREE.MeshStandardMaterial({ color: 0xb7b9b2, roughness: 0.64 })); fountain.position.set(x + 19, 0.45, z - 18); fountain.castShadow = true; this.group.add(fountain);
    const pool = new THREE.Mesh(new THREE.CylinderGeometry(4.25, 4.25, 0.08, 32), new THREE.MeshPhysicalMaterial({ color: 0x4d9aaa, roughness: 0.15, clearcoat: 0.8 })); pool.position.set(x + 19, 0.82, z - 18); this.group.add(pool);
  }

  private buildProps(): void {
    const positions: Array<[number, number]> = this.sidewalkPoints.filter((point, index) => index % 7 === 0 && !this.collides(point.x, point.z, 3)).map((point) => [point.x, point.z]);
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.52, 4.2, 12); const crownGeo = new THREE.SphereGeometry(1.9, 12, 9);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x60452f, roughness: 0.98 }), positions.length);
    const crownMaterial = new THREE.MeshStandardMaterial({ color: 0x3e7650, roughness: 0.92 });
    const crowns = new THREE.InstancedMesh(crownGeo, crownMaterial, positions.length * 3); const matrix = new THREE.Matrix4();
    positions.forEach(([x, z], i) => {
      matrix.makeTranslation(x, 2.1, z); trunks.setMatrixAt(i, matrix);
      const offsets = [[0, 5.2, 0], [-1.1, 4.7, 0.35], [1, 4.8, -0.3]];
      offsets.forEach(([ox, oy, oz], j) => { matrix.compose(new THREE.Vector3(x + ox, oy, z + oz), new THREE.Quaternion(), new THREE.Vector3(1, 0.88 + j * 0.05, 1)); crowns.setMatrixAt(i * 3 + j, matrix); });
    });
    trunks.castShadow = true; crowns.castShadow = true; this.group.add(trunks, crowns);
    this.buildStreetlights(positions); this.buildStreetFurniture();
  }

  private buildStreetlights(positions: Array<[number, number]>): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x2e3739, roughness: 0.38, metalness: 0.76 }); const glow = new THREE.MeshBasicMaterial({ color: 0xffe4ae });
    for (const [x, z] of positions.filter((_, index) => index % 2 === 0)) {
      const lamp = new THREE.Group(); lamp.position.set(x - 29, 0, z - 29);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.18, 5.8, 10), metal); pole.position.y = 2.9;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.45, 8), metal); arm.rotation.z = Math.PI / 2; arm.position.set(0.62, 5.62, 0);
      const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.18, 0.34), metal); fixture.position.set(1.28, 5.57, 0);
      const bulb = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18), glow); bulb.rotation.x = Math.PI / 2; bulb.position.set(1.28, 5.46, 0);
      lamp.add(pole, arm, fixture, bulb); lamp.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(lamp);
    }
  }

  private buildStreetFurniture(): void {
    const wood = new THREE.MeshStandardMaterial({ color: 0x765038, roughness: 0.78 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x313b3d, metalness: 0.68, roughness: 0.38 });
    const utility = new THREE.MeshStandardMaterial({ color: 0x9c3230, metalness: 0.38, roughness: 0.54 });
    const sites = this.sidewalkPoints.filter((point, index) => index % 23 === 0 && !this.collides(point.x, point.z, 2));
    sites.forEach((site, index) => {
      const bench = new THREE.Group(); bench.position.set(site.x, 0.3, site.z); bench.rotation.y = (index * 1.7) % Math.PI;
      const seat = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.12, 0.58, 2, 0.04), wood); seat.position.y = 0.52;
      const back = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.62, 0.1, 2, 0.03), wood); back.position.set(0, 0.87, -0.24); back.rotation.x = -0.12;
      for (const x of [-0.75, 0.75]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.44), metal); leg.position.set(x, 0.26, 0); bench.add(leg); }
      bench.add(seat, back); bench.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(bench);
      const next = this.sidewalkPoints[(index * 23 + 9) % this.sidewalkPoints.length] ?? site;
      const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.92, 16), metal); bin.position.set(next.x, 0.48, next.z); bin.castShadow = true; this.group.add(bin);
      const hydrant = new THREE.Group(); hydrant.position.set(site.x + 2.4, 0, site.z + 1.1);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.23, 0.72, 14), utility); stem.position.y = 0.38;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 8), utility); cap.position.y = 0.78;
      const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 10), utility); valve.rotation.z = Math.PI / 2; valve.position.y = 0.49; hydrant.add(stem, cap, valve); hydrant.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(hydrant);
    });
  }

  private buildWaterfront(): void {
    this.waterMaterial = new THREE.MeshPhysicalMaterial({ color: COLORS.water, map: this.water, roughness: 0.16, metalness: 0.05, clearcoat: 0.85, clearcoatRoughness: 0.16, transparent: true, opacity: 0.94 });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(470, 90, 24, 8), this.waterMaterial); water.rotation.x = -Math.PI / 2; water.position.set(135, 0.1, -340); this.group.add(water);
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(460, 48), new THREE.MeshStandardMaterial({ color: 0xd6c486, map: this.sand, roughness: 0.96 })); sand.rotation.x = -Math.PI / 2; sand.position.set(140, 0.06, -286); sand.receiveShadow = true; this.group.add(sand);
    for (let x = -330; x < -190; x += 35) {
      const material = new THREE.MeshStandardMaterial({ color: x % 2 ? 0xb84f45 : 0x3d7381, roughness: 0.65, metalness: 0.32 });
      const container = new THREE.Mesh(new THREE.BoxGeometry(26, 5, 9, 13, 1, 1), material); container.position.set(x, 2.5, -270); container.castShadow = true; this.group.add(container);
      for (let ridge = -11; ridge <= 11; ridge += 2) { const rib = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.7, 0.14), new THREE.MeshStandardMaterial({ color: 0x343c3d, metalness: 0.55, roughness: 0.45 })); rib.position.set(x + ridge, 2.5, -265.45); this.group.add(rib); }
      this.colliders.push({ minX: x - 13, maxX: x + 13, minZ: -274.5, maxZ: -265.5, height: 5 });
    }
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(13, 1, 22), new THREE.MeshStandardMaterial({ color: 0x8b8f8b, map: this.concrete, roughness: 0.87 })); ramp.position.set(-185, 1, -225); ramp.rotation.x = -0.08; ramp.castShadow = true; this.group.add(ramp);
    const boardwalk = new THREE.Mesh(new THREE.BoxGeometry(190, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x8d6e4f, roughness: 0.86 })); boardwalk.position.set(150, 0.25, -307); boardwalk.receiveShadow = true; this.group.add(boardwalk);
  }
}
