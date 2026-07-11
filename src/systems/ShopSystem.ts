import * as THREE from 'three';
import { createSignMesh } from '../world/ProceduralMaterials';
import type { City } from '../world/City';

export type ShopKind = 'weapons' | 'spray' | 'garage' | 'hotdog';
export interface ShopPlace { kind: ShopKind; name: string; pad: THREE.Vector3; radius: number; driveIn: boolean; }

export const SHOP_ICON_COLOR = '#3fd1c4'; // teal diamonds — distinct from gold mission blips even for colour-blind players
export const SHOPS: ShopPlace[] = [
  { kind: 'weapons', name: 'Jozi Arms', pad: new THREE.Vector3(12, 0, 220), radius: 3.6, driveIn: false },
  { kind: 'spray', name: 'Pik-’n’-Spray', pad: new THREE.Vector3(236, 0, 60), radius: 5, driveIn: true },
  { kind: 'garage', name: 'Jan Smuts Garage', pad: new THREE.Vector3(-38, 0, 272), radius: 5, driveIn: true },
  { kind: 'hotdog', name: 'Boerie Stand', pad: new THREE.Vector3(25.5, 0, 77), radius: 3.2, driveIn: false },
];
/** Where a stored vehicle sits inside the garage, nose pointing out the door. */
export const GARAGE_PARK = { x: -46.5, z: 272, heading: Math.PI / 2 };

export class ShopSystem {
  group = new THREE.Group();
  private discs: THREE.Mesh[] = [];
  private phase = 0;

  constructor(scene: THREE.Scene, city: City) {
    this.group.name = 'Shops'; scene.add(this.group);
    this.buildWeaponsShop(city); this.buildSpray(city); this.buildGarage(city); this.buildHotdogStand(city);
    for (const object of this.group.children) object.position.y += city.terrainHeightAt(object.position.x, object.position.z);
    for (const shop of SHOPS) { shop.pad.y = city.surfaceHeightAt(shop.pad.x, shop.pad.z); this.addPadMarker(shop); }
  }

  update(dt: number): void {
    this.phase += dt;
    const pulse = 0.42 + Math.sin(this.phase * 2.6) * 0.16;
    for (const disc of this.discs) { (disc.material as THREE.MeshBasicMaterial).opacity = pulse; disc.rotation.y += dt * 0.9; }
  }

  shopNear(position: THREE.Vector3): ShopPlace | undefined {
    let best: ShopPlace | undefined; let bestDistance = Infinity;
    for (const shop of SHOPS) {
      const distance = Math.hypot(position.x - shop.pad.x, position.z - shop.pad.z);
      if (distance < shop.radius && distance < bestDistance) { best = shop; bestDistance = distance; }
    }
    return best;
  }

  mapIcons(): Array<{ x: number; z: number; color: string; shape: 'diamond' }> {
    return SHOPS.map((shop) => ({ x: shop.pad.x, z: shop.pad.z, color: SHOP_ICON_COLOR, shape: 'diamond' as const }));
  }

  private addPadMarker(shop: ShopPlace): void {
    const radius = shop.driveIn ? 2.7 : 1.9;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.06, 26), new THREE.MeshBasicMaterial({ color: 0xe8b64c, transparent: true, opacity: 0.5 }));
    disc.position.set(shop.pad.x, shop.pad.y + 0.32, shop.pad.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius + 0.28, 0.09, 8, 26), new THREE.MeshBasicMaterial({ color: 0xf5c451 }));
    ring.rotation.x = Math.PI / 2; ring.position.set(shop.pad.x, shop.pad.y + 0.34, shop.pad.z);
    this.discs.push(disc); this.group.add(disc, ring);
  }

  private buildWeaponsShop(city: City): void {
    const x = 12; const z = 212; // storefront faces +z toward William Nicol Dr
    const body = new THREE.Mesh(new THREE.BoxGeometry(12, 4.6, 7), new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.68, metalness: 0.14 }));
    body.position.set(x, 2.3, z); body.castShadow = true; body.receiveShadow = true;
    const glass = new THREE.Mesh(new THREE.BoxGeometry(7.6, 2, 0.12), new THREE.MeshPhysicalMaterial({ color: 0x2e5560, roughness: 0.14, metalness: 0.2, clearcoat: 0.7 }));
    glass.position.set(x, 1.5, z + 3.56);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.16, 1.3), new THREE.MeshStandardMaterial({ color: 0x8e2f2a, roughness: 0.6 }));
    canopy.position.set(x, 2.9, z + 4.1); canopy.castShadow = true;
    const board = new THREE.Mesh(new THREE.BoxGeometry(9.6, 2.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 }));
    board.position.set(x, 5.5, z + 3.42);
    const sign = createSignMesh(new THREE.PlaneGeometry(9.2, 1.8), 'JOZI ARMS', '#f0ae43'); sign.position.set(x, 5.5, z + 3.56);
    this.group.add(body, glass, canopy, board, sign);
    city.colliders.push({ minX: x - 6, maxX: x + 6, minZ: z - 3.5, maxZ: z + 3.5, height: 4.6 });
  }

  private buildSpray(city: City): void {
    const x = 236; const z = 69; // roll door faces -z toward Rivonia Rd
    const body = new THREE.Mesh(new THREE.BoxGeometry(13, 5, 10), new THREE.MeshStandardMaterial({ color: 0x8f8574, roughness: 0.82, metalness: 0.05 }));
    body.position.set(x, 2.5, z); body.castShadow = true; body.receiveShadow = true;
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.4, 0.14), new THREE.MeshStandardMaterial({ color: 0x5e6868, roughness: 0.5, metalness: 0.45 }));
    shutter.position.set(x, 1.9, z - 5.06);
    const stripes = new THREE.Mesh(new THREE.BoxGeometry(13.05, 0.7, 10.05), new THREE.MeshStandardMaterial({ color: 0x2f9e94, roughness: 0.6 }));
    stripes.position.set(x, 4.1, z);
    const board = new THREE.Mesh(new THREE.BoxGeometry(8.4, 2.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 }));
    board.position.set(x, 6, z - 4.9);
    const sign = createSignMesh(new THREE.PlaneGeometry(8, 1.8), 'PIK-N-SPRAY', '#72d8d2'); sign.rotation.y = Math.PI; sign.position.set(x, 6, z - 5.04);
    this.group.add(body, shutter, stripes, board, sign);
    city.colliders.push({ minX: x - 6.5, maxX: x + 6.5, minZ: z - 5, maxZ: z + 5, height: 5 });
  }

  private buildGarage(city: City): void {
    const x = -46; const z = 272; // open door faces +x toward Jan Smuts Ave and the spawn
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8f9295, roughness: 0.88 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(10, 0.12, 9.4), concrete); slab.position.set(x, 0.06, z); slab.receiveShadow = true;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.4, 9), concrete); back.position.set(x - 4.8, 1.7, z); back.castShadow = true;
    const sideA = new THREE.Mesh(new THREE.BoxGeometry(9.6, 3.4, 0.5), concrete); sideA.position.set(x, 1.7, z - 4.25); sideA.castShadow = true;
    const sideB = sideA.clone(); sideB.position.z = z + 4.25;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.35, 9.8), new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86 })); roof.position.set(x, 3.75, z); roof.castShadow = true;
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, 9.6), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 })); fascia.position.set(x + 4.9, 4.35, z);
    const sign = createSignMesh(new THREE.PlaneGeometry(6.6, 1.5), 'GARAGE', '#f0ae43'); sign.rotation.y = Math.PI / 2; sign.position.set(x + 5.06, 4.35, z);
    this.group.add(slab, back, sideA, sideB, roof, fascia, sign);
    city.colliders.push(
      { minX: x - 5.05, maxX: x - 4.55, minZ: z - 4.5, maxZ: z + 4.5, height: 3.4 },
      { minX: x - 4.8, maxX: x + 4.8, minZ: z - 4.5, maxZ: z - 4, height: 3.4 },
      { minX: x - 4.8, maxX: x + 4.8, minZ: z + 4, maxZ: z + 4.5, height: 3.4 },
    );
  }

  private buildHotdogStand(city: City): void {
    const x = 24; const z = 75; const facing = 0.65; // counter angled toward the Commons Ring sidewalk
    const stand = new THREE.Group(); stand.position.set(x, 0, z); stand.rotation.y = facing;
    const cart = new THREE.Mesh(new THREE.BoxGeometry(2, 1.15, 1.3), new THREE.MeshStandardMaterial({ color: 0xd6cfc0, roughness: 0.65, metalness: 0.2 })); cart.position.y = 0.78; cart.castShadow = true;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.5), new THREE.MeshStandardMaterial({ color: 0x8a5c33, roughness: 0.7 })); counter.position.set(0, 1.4, 0.85);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x3c4546, metalness: 0.6 })); pole.position.set(-0.6, 1.9, -0.2);
    const umbrella = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.75, 10), new THREE.MeshStandardMaterial({ color: 0xd75844, roughness: 0.7, side: THREE.DoubleSide })); umbrella.position.set(-0.6, 3.05, -0.2); umbrella.castShadow = true;
    const sign = createSignMesh(new THREE.PlaneGeometry(2.1, 0.6), 'BOERIE R25', '#e94d46'); sign.position.set(0, 1.85, 0.68);
    stand.add(cart, counter, pole, umbrella, sign); this.group.add(stand);
    city.colliders.push({ minX: x - 1.2, maxX: x + 1.2, minZ: z - 0.9, maxZ: z + 0.9, height: 1.6 });
  }
}
