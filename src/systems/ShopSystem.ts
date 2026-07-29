import * as THREE from 'three';
import { createSignMesh } from '../world/ProceduralMaterials';
import { ARMS_SITE, BOTTLE_STORES, GARAGE_EXIT, GARAGE_PARK as GARAGE_PARK_SITE, GARAGE_SITE, HOTDOG_SITE, SPRAY_SITE, type PlacedSite } from '../world/placements';
import type { City, Collider } from '../world/City';

export type ShopKind = 'weapons' | 'spray' | 'garage' | 'hotdog' | 'bottle';
export interface ShopPlace { kind: ShopKind; name: string; pad: THREE.Vector3; radius: number; driveIn: boolean; }

export const SHOP_ICON_COLOR = '#3fd1c4'; // teal diamonds — distinct from gold mission blips even for colour-blind players
/** All shops re-anchor from the generated map (placements): CBD storefronts around the spawn blocks. */
export const SHOPS: ShopPlace[] = [
  { kind: 'weapons', name: 'Jozi Arms', pad: new THREE.Vector3(ARMS_SITE.pad.x, 0, ARMS_SITE.pad.z), radius: 3.6, driveIn: false },
  { kind: 'spray', name: 'Pik-’n’-Spray', pad: new THREE.Vector3(SPRAY_SITE.pad.x, 0, SPRAY_SITE.pad.z), radius: 5, driveIn: true },
  { kind: 'garage', name: 'Sisulu Garage', pad: new THREE.Vector3(GARAGE_SITE.pad.x, 0, GARAGE_SITE.pad.z), radius: 5, driveIn: true },
  { kind: 'hotdog', name: 'Boerie Stand', pad: new THREE.Vector3(HOTDOG_SITE.pad.x, 0, HOTDOG_SITE.pad.z), radius: 3.2, driveIn: false },
  ...BOTTLE_STORES.map((store) => ({ kind: 'bottle' as const, name: store.name, pad: new THREE.Vector3(store.site.pad.x, 0, store.site.pad.z), radius: 3.6, driveIn: false })),
];
/** Where a stored vehicle sits inside the garage, nose pointing out the door. */
export const GARAGE_PARK = { x: GARAGE_PARK_SITE.x, z: GARAGE_PARK_SITE.z, heading: GARAGE_PARK_SITE.heading };
/** Where the player steps out after storing a vehicle. */
export const GARAGE_STEP_OUT = { x: GARAGE_EXIT.x, z: GARAGE_EXIT.z };

/** Building-local point to world, matching Three's Y-axis rotation convention used by place(). */
export function placedPoint(site: PlacedSite, localX: number, localZ: number): { x: number; z: number } {
  const c = Math.cos(site.heading); const s = Math.sin(site.heading);
  return { x: site.x + localX * c + localZ * s, z: site.z - localX * s + localZ * c };
}

/** Transform a local-space AABB collider by the site's heading into world space. min/max is the enclosing
 *  AABB (broad phase); a non-quarter heading also carries the true oriented rectangle (heading + local
 *  half-extents hw/hd) so a shop/safehouse aligned to a diagonal street hugs its real walls, not the
 *  corners of an oversized box. Mirrors City.tierToWorldCollider (same rotation convention). */
export function placedCollider(site: PlacedSite, minX: number, maxX: number, minZ: number, maxZ: number, height: number): Collider {
  const c = Math.cos(site.heading); const s = Math.sin(site.heading);
  const lx = (minX + maxX) / 2; const lz = (minZ + maxZ) / 2;
  const hw = (maxX - minX) / 2; const hd = (maxZ - minZ) / 2;
  const wx = site.x + lx * c + lz * s; const wz = site.z - lx * s + lz * c;
  const nx = Math.abs(hw * c) + Math.abs(hd * s); const nz = Math.abs(hw * s) + Math.abs(hd * c);
  const box: Collider = { minX: wx - nx, maxX: wx + nx, minZ: wz - nz, maxZ: wz + nz, height };
  if (Math.abs(c) > 1e-4 && Math.abs(s) > 1e-4) { box.heading = site.heading; box.hw = hw; box.hd = hd; }
  return box;
}

export class ShopSystem {
  group = new THREE.Group();
  private discs: THREE.Mesh[] = [];
  private weaponsEntrance = new THREE.Vector3();
  private phase = 0;

  constructor(scene: THREE.Scene, city: City) {
    this.group.name = 'Shops'; scene.add(this.group);
    this.buildWeaponsShop(city); this.buildSpray(city); this.buildGarage(city); this.buildHotdogStand(city);
    for (const store of BOTTLE_STORES) this.buildBottleStore(city, store.site.building, store.sign);
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

  /** Exterior discovery hint for the one seamless shop interior; it disappears across the threshold
   * so the actual Browse prompt can take over without competing text. */
  walkInNear(position: THREE.Vector3): ShopPlace | undefined {
    const weapons = SHOPS.find((shop) => shop.kind === 'weapons');
    if (!weapons || this.shopNear(position) === weapons) return undefined;
    return Math.hypot(position.x - this.weaponsEntrance.x, position.z - this.weaponsEntrance.z) < 5.2 ? weapons : undefined;
  }

  mapIcons(): Array<{ x: number; z: number; color: string; shape: 'diamond'; label: string }> {
    return SHOPS.map((shop) => ({ x: shop.pad.x, z: shop.pad.z, color: SHOP_ICON_COLOR, shape: 'diamond' as const, label: shop.name }));
  }

  private addPadMarker(shop: ShopPlace): void {
    const radius = shop.driveIn ? 2.7 : shop.kind === 'weapons' ? 1.3 : 1.9;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.06, 26), new THREE.MeshBasicMaterial({ color: 0x3fd1c4, transparent: true, opacity: 0.42 }));
    disc.position.set(shop.pad.x, shop.pad.y + 0.32, shop.pad.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius + 0.28, 0.09, 8, 26), new THREE.MeshBasicMaterial({ color: 0x72d8d2 }));
    ring.rotation.x = Math.PI / 2; ring.position.set(shop.pad.x, shop.pad.y + 0.34, shop.pad.z);
    this.discs.push(disc); this.group.add(disc, ring);
  }

  /** Places a locally-built assembly at its site (door faces local +z, which the heading points at the road). */
  private place(site: PlacedSite, assembly: THREE.Group): void {
    assembly.position.set(site.x, 0, site.z); assembly.rotation.y = site.heading;
    this.group.add(assembly);
  }

  private buildWeaponsShop(city: City): void {
    const site = ARMS_SITE.building;
    const shop = new THREE.Group();
    shop.name = 'Jozi Arms Interior';
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x39424a, emissive: 0x15191b, emissiveIntensity: 0.38, roughness: 0.68, metalness: 0.14 });
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x8b8d86, emissive: 0x24241f, emissiveIntensity: 0.32, roughness: 0.92 });
    const glassMaterial = new THREE.MeshPhysicalMaterial({ color: 0x2e5560, roughness: 0.1, metalness: 0.16, clearcoat: 0.72, transparent: true, opacity: 0.58 });
    const timber = new THREE.MeshStandardMaterial({ color: 0x6d432b, roughness: 0.78 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x242c2e, metalness: 0.68, roughness: 0.38 });

    // A real shell rather than a solid box: the centre doorway is physically open, the glass
    // storefront reveals the counter, and the player walks in without a loading screen.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(11.7, 0.16, 7.7), floorMaterial); floor.position.y = 0.08; floor.receiveShadow = true;
    const back = new THREE.Mesh(new THREE.BoxGeometry(12, 5.2, 0.36), wallMaterial); back.position.set(0, 2.6, -3.82);
    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.36, 5.2, 7.8), wallMaterial); sideL.position.set(-5.82, 2.6, 0);
    const sideR = sideL.clone(); sideR.position.x = 5.82;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(12.35, 0.3, 8.15), new THREE.MeshStandardMaterial({ color: 0x282f31, roughness: 0.86, metalness: 0.12 })); roof.position.set(0, 5.35, 0);
    for (const object of [back, sideL, sideR, roof]) { object.castShadow = true; object.receiveShadow = true; }

    const frontage: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const x = side * 3.55;
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.85, 0.3), wallMaterial); plinth.position.set(x, 0.43, 3.82);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(4.55, 2.25, 0.12), glassMaterial); pane.position.set(x, 1.95, 3.84);
      const header = new THREE.Mesh(new THREE.BoxGeometry(4.7, 1.15, 0.3), wallMaterial); header.position.set(x, 4.58, 3.82);
      frontage.push(plinth, pane, header);
    }
    const doorFrame = new THREE.Group();
    for (const x of [-1.18, 1.18]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.45, 0.18), darkMetal); post.position.set(x, 1.73, 3.88); doorFrame.add(post); }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.48, 0.14, 0.18), darkMetal); lintel.position.set(0, 3.45, 3.88); doorFrame.add(lintel);

    const canopy = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.16, 1.55), new THREE.MeshStandardMaterial({ color: 0x8e2f2a, roughness: 0.6 }));
    canopy.position.set(0, 3.68, 4.42); canopy.castShadow = true;
    const board = new THREE.Mesh(new THREE.BoxGeometry(9.6, 2.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 }));
    board.position.set(0, 6.15, 3.68);
    const sign = createSignMesh(new THREE.PlaneGeometry(9.2, 1.8), 'JOZI ARMS', '#f0ae43'); sign.position.set(0, 6.15, 3.81);

    // Interior counter, pegboard and deliberately local retail wisdom.
    const counter = new THREE.Mesh(new THREE.BoxGeometry(8.2, 1.05, 0.82), timber); counter.position.set(0, 0.6, -2.35); counter.castShadow = true;
    const counterTop = new THREE.Mesh(new THREE.BoxGeometry(8.55, 0.12, 1.05), darkMetal); counterTop.position.set(0, 1.16, -2.28);
    const pegboard = new THREE.Mesh(new THREE.BoxGeometry(9.4, 2.55, 0.16), new THREE.MeshStandardMaterial({ color: 0x7a6043, emissive: 0x2b1d11, emissiveIntensity: 0.32, roughness: 0.9 })); pegboard.position.set(0, 2.75, -3.58);
    const weaponShapes: THREE.Object3D[] = [];
    for (const [index, y] of [2.15, 2.85, 3.55].entries()) {
      const long = new THREE.Mesh(new THREE.BoxGeometry(index === 1 ? 3.2 : 2.6, 0.16, 0.12), darkMetal); long.position.set(index % 2 ? 1.7 : -1.8, y, -3.46);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.12), darkMetal); grip.position.set(long.position.x + 0.5, y - 0.25, -3.45); grip.rotation.z = -0.25;
      weaponShapes.push(long, grip);
    }
    const policy = createSignMesh(new THREE.PlaneGeometry(3.2, 0.8), 'NO EFT? EISH.', '#f0ae43'); policy.position.set(3.65, 4.25, -3.47);
    const shelfL = new THREE.Mesh(new THREE.BoxGeometry(0.55, 2.7, 3.2), darkMetal); shelfL.position.set(-5.35, 1.4, -0.6);
    const shelfR = shelfL.clone(); shelfR.position.x = 5.35;
    const lightPanel = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.08, 0.7), new THREE.MeshStandardMaterial({ color: 0xfff1c4, emissive: 0xffd77a, emissiveIntensity: 3.2 })); lightPanel.position.set(0, 5.12, -0.2);
    const interiorLight = new THREE.PointLight(0xffdca0, 11, 17, 1.35); interiorLight.position.set(0, 4.45, 0);

    shop.add(floor, back, sideL, sideR, roof, ...frontage, doorFrame, canopy, board, sign, counter, counterTop, pegboard, ...weaponShapes, policy, shelfL, shelfR, lightPanel, interiorLight);
    this.place(site, shop);

    // Move the actual interaction pad behind the open doorway. From outside, the player sees the
    // teal disc and counter but must cross the threshold before E opens the catalogue.
    const inside = placedPoint(site, 0, -0.75);
    const entrance = placedPoint(site, 0, 4.55);
    this.weaponsEntrance.set(entrance.x, 0, entrance.z);
    const weapons = SHOPS.find((entry) => entry.kind === 'weapons');
    if (weapons) { weapons.pad.x = inside.x; weapons.pad.z = inside.z; weapons.radius = 3.2; }

    city.colliders.push(
      placedCollider(site, -6, 6, -4, -3.64, 5.2),
      placedCollider(site, -6, -5.64, -3.82, 3.82, 5.2),
      placedCollider(site, 5.64, 6, -3.82, 3.82, 5.2),
      placedCollider(site, -5.9, -1.18, 3.64, 4, 5.2),
      placedCollider(site, 1.18, 5.9, 3.64, 4, 5.2),
      placedCollider(site, -4.3, 4.3, -2.78, -1.86, 1.2), // counter
      placedCollider(site, -5.65, -5.05, -2.2, 1, 2.8),
      placedCollider(site, 5.05, 5.65, -2.2, 1, 2.8),
    );
  }

  private buildSpray(city: City): void {
    const site = SPRAY_SITE.building;
    const shop = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(13, 5, 10), new THREE.MeshStandardMaterial({ color: 0x8f8574, roughness: 0.82, metalness: 0.05 }));
    body.position.set(0, 2.5, 0); body.castShadow = true; body.receiveShadow = true;
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.4, 0.14), new THREE.MeshStandardMaterial({ color: 0x5e6868, roughness: 0.5, metalness: 0.45 }));
    shutter.position.set(0, 1.9, 5.06); // roll door faces the road pad
    const stripes = new THREE.Mesh(new THREE.BoxGeometry(13.05, 0.7, 10.05), new THREE.MeshStandardMaterial({ color: 0x2f9e94, roughness: 0.6 }));
    stripes.position.set(0, 4.1, 0);
    const board = new THREE.Mesh(new THREE.BoxGeometry(8.4, 2.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 }));
    board.position.set(0, 6, 4.9);
    const sign = createSignMesh(new THREE.PlaneGeometry(8, 1.8), 'PIK-N-SPRAY', '#72d8d2'); sign.position.set(0, 6, 5.04);
    shop.add(body, shutter, stripes, board, sign);
    this.place(site, shop);
    city.colliders.push(placedCollider(site, -6.5, 6.5, -5, 5, 5));
  }

  private buildGarage(city: City): void {
    const site = GARAGE_SITE.building;
    const garage = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8f9295, roughness: 0.88 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.12, 10), concrete); slab.position.set(0, 0.06, 0); slab.receiveShadow = true;
    const back = new THREE.Mesh(new THREE.BoxGeometry(9, 3.4, 0.5), concrete); back.position.set(0, 1.7, -4.8); back.castShadow = true;
    const sideA = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.4, 9.6), concrete); sideA.position.set(-4.25, 1.7, 0); sideA.castShadow = true;
    const sideB = sideA.clone(); sideB.position.x = 4.25;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.35, 10.4), new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86 })); roof.position.set(0, 3.75, 0); roof.castShadow = true;
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(9.6, 1.1, 0.3), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 })); fascia.position.set(0, 4.35, 4.9);
    const sign = createSignMesh(new THREE.PlaneGeometry(6.6, 1.5), 'GARAGE', '#f0ae43'); sign.position.set(0, 4.35, 5.06);
    garage.add(slab, back, sideA, sideB, roof, fascia, sign);
    this.place(site, garage);
    city.colliders.push(
      placedCollider(site, -4.5, 4.5, -5.05, -4.55, 3.4), // back wall
      placedCollider(site, -4.5, -4, -4.8, 4.8, 3.4), // side walls
      placedCollider(site, 4, 4.5, -4.8, 4.8, 3.4),
    );
  }

  private buildHotdogStand(city: City): void {
    const site = HOTDOG_SITE.building;
    const stand = new THREE.Group();
    const cart = new THREE.Mesh(new THREE.BoxGeometry(2, 1.15, 1.3), new THREE.MeshStandardMaterial({ color: 0xd6cfc0, roughness: 0.65, metalness: 0.2 })); cart.position.y = 0.78; cart.castShadow = true;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.5), new THREE.MeshStandardMaterial({ color: 0x8a5c33, roughness: 0.7 })); counter.position.set(0, 1.4, 0.85);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x3c4546, metalness: 0.6 })); pole.position.set(-0.6, 1.9, -0.2);
    const umbrella = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.75, 10), new THREE.MeshStandardMaterial({ color: 0xd75844, roughness: 0.7, side: THREE.DoubleSide })); umbrella.position.set(-0.6, 3.05, -0.2); umbrella.castShadow = true;
    const sign = createSignMesh(new THREE.PlaneGeometry(2.1, 0.6), 'BOERIE R25', '#e94d46'); sign.position.set(0, 1.85, 0.68);
    stand.add(cart, counter, pole, umbrella, sign);
    this.place(site, stand);
    city.colliders.push(placedCollider(site, -1.2, 1.2, -0.9, 0.9, 1.6));
  }

  private buildBottleStore(city: City, site: PlacedSite, signText: string): void {
    const shop = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(12, 4.6, 7), new THREE.MeshStandardMaterial({ color: 0x6a2530, roughness: 0.72, metalness: 0.08 }));
    body.position.set(0, 2.3, 0); body.castShadow = true; body.receiveShadow = true;
    const glass = new THREE.Mesh(new THREE.BoxGeometry(7.6, 2, 0.12), new THREE.MeshPhysicalMaterial({ color: 0x243a2c, roughness: 0.16, metalness: 0.2, clearcoat: 0.65 }));
    glass.position.set(0, 1.5, 3.56);
    // Fridge glow behind the glass, plus a couple of bottle silhouettes on the sill.
    const fridge = new THREE.Mesh(new THREE.BoxGeometry(7.4, 1.9, 0.06), new THREE.MeshStandardMaterial({ color: 0x2f6f4a, emissive: 0x2f6f4a, emissiveIntensity: 0.55, roughness: 0.4 }));
    fridge.position.set(0, 1.5, 3.48);
    for (let i = -3; i <= 3; i++) {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.62, 10), new THREE.MeshStandardMaterial({ color: i % 2 === 0 ? 0x3a5a2a : 0x8a6a2a, roughness: 0.35, metalness: 0.3 }));
      bottle.position.set(i * 0.95, 0.95, 3.5); shop.add(bottle);
    }
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.16, 1.3), new THREE.MeshStandardMaterial({ color: 0xd9a021, roughness: 0.55 }));
    canopy.position.set(0, 2.9, 4.1); canopy.castShadow = true;
    const board = new THREE.Mesh(new THREE.BoxGeometry(9.6, 2.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.55 }));
    board.position.set(0, 5.5, 3.42);
    const sign = createSignMesh(new THREE.PlaneGeometry(9.2, 1.8), signText, '#f2c14e'); sign.position.set(0, 5.5, 3.56);
    shop.add(body, glass, fridge, canopy, board, sign);
    this.place(site, shop);
    city.colliders.push(placedCollider(site, -6, 6, -3.5, 3.5, 4.6));
  }
}
