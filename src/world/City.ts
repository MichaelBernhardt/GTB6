import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BLOCK_SIZE, COLORS, ROAD_WIDTH, WORLD_SIZE } from '../config';
import type { District } from '../types';
import { createFacadeTexture, createGeneratedSurfaceTexture, createSignTexture, createSurfaceTexture } from './ProceduralMaterials';

export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; height: number; }
export interface RoadPoint { x: number; z: number; }

const grid = [-300, -200, -100, 0, 100, 200, 300];
const seeded = (x: number, z: number, salt = 0): number => {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
};

export class City {
  group = new THREE.Group();
  colliders: Collider[] = [];
  roadPoints: RoadPoint[] = [];
  sidewalkPoints: RoadPoint[] = [];
  private buildingMaterial = new Map<string, THREE.MeshStandardMaterial>();
  private asphalt = createGeneratedSurfaceTexture('/textures/asphalt-gpt.jpg', 'asphalt', 34);
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
    for (const value of grid) for (const vertical of [true, false]) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(vertical ? ROAD_WIDTH : WORLD_SIZE, vertical ? WORLD_SIZE : ROAD_WIDTH), roadMat);
      road.rotation.x = -Math.PI / 2; road.position.set(vertical ? value : 0, 0.018, vertical ? 0 : value); road.receiveShadow = true; this.group.add(road);
      for (let marker = -350; marker <= 350; marker += 18) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(vertical ? 0.28 : 6.5, vertical ? 6.5 : 0.28), centerMat);
        line.rotation.x = -Math.PI / 2; line.position.set(vertical ? value : marker, 0.042, vertical ? marker : value); this.group.add(line);
      }
      for (const edge of [-9.9, 9.9]) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(vertical ? 0.18 : WORLD_SIZE, vertical ? WORLD_SIZE : 0.18), edgeMat);
        line.rotation.x = -Math.PI / 2; line.position.set(vertical ? value + edge : 0, 0.041, vertical ? 0 : value + edge); this.group.add(line);
      }
    }
    this.buildIntersections();
    for (const x of grid) for (const z of grid) {
      this.roadPoints.push({ x: x - 5.5, z }, { x: x + 5.5, z }, { x, z: z - 5.5 }, { x, z: z + 5.5 });
      this.sidewalkPoints.push({ x: x + 16, z: z + 16 }, { x: x - 16, z: z - 16 });
    }
  }

  private buildIntersections(): void {
    const paint = new THREE.MeshStandardMaterial({ color: 0xe9e6d6, roughness: 0.78 });
    for (let g = 0; g < grid.length; g += 2) for (let h = 1; h < grid.length; h += 2) {
      const x = grid[g]; const z = grid[h]; if (x === undefined || z === undefined) continue;
      for (let stripe = -8; stripe <= 8; stripe += 2.7) {
        const crossing = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 6.5), paint); crossing.rotation.x = -Math.PI / 2; crossing.position.set(x + stripe, 0.048, z + 15); this.group.add(crossing);
        const crossingB = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 1.5), paint); crossingB.rotation.x = -Math.PI / 2; crossingB.position.set(x + 15, 0.048, z + stripe); this.group.add(crossingB);
      }
    }
  }

  private buildDistricts(): void {
    const centers = [-250, -150, -50, 50, 150, 250];
    for (const x of centers) for (const z of centers) {
      if (Math.abs(x) < 85 && Math.abs(z) < 85) { this.buildPark(x, z); continue; }
      if (z < -210) continue;
      this.addBlockPad(x, z);
      const industrial = x < -145; const residential = x > 145; const downtown = !industrial && !residential && z > -180;
      const style = industrial ? 'industrial' : residential ? 'residential' : 'downtown';
      const count = industrial ? 2 : residential ? 3 : 2 + Math.floor(seeded(x, z) * 3);
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + seeded(x, z, i) * 0.5; const spread = count > 2 ? 22 : 18;
        const bx = x + Math.cos(angle) * spread; const bz = z + Math.sin(angle) * spread;
        const w = industrial ? 28 + seeded(x, z, i + 2) * 18 : residential ? 18 : 18 + seeded(x, z, i + 3) * 18;
        const d = industrial ? 24 + seeded(x, z, i + 4) * 16 : residential ? 16 : 18 + seeded(x, z, i + 5) * 18;
        const h = industrial ? 10 + seeded(x, z, i + 6) * 10 : residential ? 7 + seeded(x, z, i + 6) * 8 : downtown ? 25 + seeded(x, z, i + 6) * 66 : 18;
        const color = industrial ? 0x8d918d : residential ? [0xd59a79, 0xaec3b0, 0xe0c587][i % 3] : [0x8aa0aa, 0xb77d74, 0xc8b98e, 0x818b91][i % 4];
        this.addBuilding(bx, bz, w, d, h, color, style, i);
      }
    }
  }

  private addBlockPad(x: number, z: number): void {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_SIZE + 4, 0.22, BLOCK_SIZE + 4), new THREE.MeshStandardMaterial({ color: 0xb3b2a9, map: this.concrete, roughness: 0.92 }));
    pad.position.set(x, 0.06, z); pad.receiveShadow = true; this.group.add(pad);
  }

  private addBuilding(x: number, z: number, w: number, d: number, h: number, color: number, style: string, variant: number): void {
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
    const positions: Array<[number, number]> = [];
    for (let x = -330; x <= 330; x += 50) for (let z = -330; z <= 330; z += 50) if (!this.collides(x + 15, z + 15, 3)) positions.push([x + 15, z + 15]);
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
    for (let index = 0; index < grid.length; index++) {
      const value = grid[index]; if (value === undefined) continue;
      for (const direction of [-1, 1]) {
        const bench = new THREE.Group(); bench.position.set(value + direction * 17, 0.3, grid[(index + 2) % grid.length] ?? 0); bench.rotation.y = direction > 0 ? Math.PI / 2 : -Math.PI / 2;
        const seat = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.12, 0.58, 2, 0.04), wood); seat.position.y = 0.52;
        const back = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.62, 0.1, 2, 0.03), wood); back.position.set(0, 0.87, -0.24); back.rotation.x = -0.12;
        for (const x of [-0.75, 0.75]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.44), metal); leg.position.set(x, 0.26, 0); bench.add(leg); }
        bench.add(seat, back); bench.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(bench);
        const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.92, 16), metal); bin.position.set(value - direction * 17, 0.48, grid[(index + 4) % grid.length] ?? 0); bin.castShadow = true; this.group.add(bin);
      }
      const hydrant = new THREE.Group(); hydrant.position.set((index % 2 ? -1 : 1) * 15.5, 0, value + 15.5);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.23, 0.72, 14), utility); stem.position.y = 0.38;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 8), utility); cap.position.y = 0.78;
      const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 10), utility); valve.rotation.z = Math.PI / 2; valve.position.y = 0.49; hydrant.add(stem, cap, valve); hydrant.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(hydrant);
    }
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
