import * as THREE from 'three';
import { SAFEHOUSE_SITE } from '../world/placements';
import { createSignMesh } from '../world/ProceduralMaterials';
import { placedCollider, placedPoint } from './ShopSystem';
import type { City } from '../world/City';

export const SAFEHOUSE_IDS = ['brixton'] as const;
export type SafehouseId = (typeof SAFEHOUSE_IDS)[number];
export interface SafehousePlace { id: SafehouseId; name: string; pad: THREE.Vector3; radius: number; spawn: [number, number, number]; }

export const SAFEHOUSE_ICON_COLOR = '#67d17f';
/** Data-driven parcel from the generated map: a face-brick flat on Main Main Street, a block from
 *  the spawn corner. The gate pad faces the road. (The id stays 'brixton' for save compatibility.) */
export const SAFEHOUSES: SafehousePlace[] = [
  {
    id: 'brixton', name: 'Main Main Mansions',
    pad: new THREE.Vector3(SAFEHOUSE_SITE.pad.x, 0, SAFEHOUSE_SITE.pad.z), radius: 3,
    spawn: [SAFEHOUSE_SITE.pad.x, 1, SAFEHOUSE_SITE.pad.z],
  },
];

export const SLEEP_HOURS = 6;
/** Seconds since the last live police sighting before the safehouse door unlocks again. */
export const SIGHTING_GRACE = 6;

/** Sleeping skips ahead a block of game hours, wrapping across midnight into [0, 24). */
export function sleepHour(hour: number, hours = SLEEP_HOURS): number { return (((hour + hours) % 24) + 24) % 24; }

/** The door only locks while JMPD has a live fix: wanted heat plus a sighting fresher than the grace
 *  window. Pending civilian reports still in the dispatch pipeline never block entry. */
export function canEnterSafehouse(wanted: boolean, sightingAge: number | null, grace = SIGHTING_GRACE): boolean {
  return !wanted || sightingAge === null || sightingAge >= grace;
}

/** Fresh spawn tuple for the save file so later mutation cannot corrupt the place definition. */
export function safehouseSpawn(place: SafehousePlace): [number, number, number] { return [place.spawn[0], place.spawn[1], place.spawn[2]]; }

export class SafehouseSystem {
  group = new THREE.Group();
  private discs: THREE.Mesh[] = [];
  private entrance = new THREE.Vector3();
  private phase = 0;

  constructor(scene: THREE.Scene, city: City) {
    this.group.name = 'Safehouses'; scene.add(this.group);
    this.buildFlat(city);
    // Sit the interior pad and respawn point on the ground too — the world has real terrain elevation, so a
    // Y=0 pad/spawn would bury them (and the sleeper) exactly like the flat was before its terrain fit.
    for (const place of SAFEHOUSES) {
      place.pad.y = city.surfaceHeightAt(place.pad.x, place.pad.z);
      place.spawn[1] = city.surfaceHeightAt(place.spawn[0], place.spawn[2]);
      this.addPadMarker(place);
    }
  }

  update(dt: number): void {
    this.phase += dt;
    const pulse = 0.42 + Math.sin(this.phase * 2.6) * 0.16;
    for (const disc of this.discs) { (disc.material as THREE.MeshBasicMaterial).opacity = pulse; disc.rotation.y += dt * 0.9; }
  }

  near(position: THREE.Vector3): SafehousePlace | undefined {
    return SAFEHOUSES.find((place) => Math.hypot(position.x - place.pad.x, position.z - place.pad.z) < place.radius);
  }

  /** Exterior discovery hint for the seamless interior; once indoors, near() owns the interaction. */
  walkInNear(position: THREE.Vector3): SafehousePlace | undefined {
    if (this.near(position)) return undefined;
    const place = SAFEHOUSES[0];
    return place && Math.hypot(position.x - this.entrance.x, position.z - this.entrance.z) < 5.4 ? place : undefined;
  }

  mapIcons(): Array<{ x: number; z: number; color: string; shape: 'house'; label: string }> {
    return SAFEHOUSES.map((place) => ({ x: place.pad.x, z: place.pad.z, color: SAFEHOUSE_ICON_COLOR, shape: 'house', label: place.name }));
  }

  private addPadMarker(place: SafehousePlace): void {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.06, 26), new THREE.MeshBasicMaterial({ color: 0x58c97a, transparent: true, opacity: 0.5 }));
    disc.position.set(place.pad.x, place.pad.y + 0.32, place.pad.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.18, 0.09, 8, 26), new THREE.MeshBasicMaterial({ color: 0x74e392 }));
    ring.rotation.x = Math.PI / 2; ring.position.set(place.pad.x, place.pad.y + 0.34, place.pad.z);
    this.discs.push(disc); this.group.add(disc, ring);
  }

  private buildFlat(city: City): void {
    const site = SAFEHOUSE_SITE.building; // stoep, gate and pad face local +z toward the road
    const flat = new THREE.Group();
    flat.name = 'Main Main Mansions Interior';
    const brick = new THREE.MeshStandardMaterial({ color: 0x9a5a43, emissive: 0x24130e, emissiveIntensity: 0.2, roughness: 0.85, metalness: 0.02 });
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x786b58, emissive: 0x211d17, emissiveIntensity: 0.25, roughness: 0.92 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x4b3024, roughness: 0.82 });
    const fabric = new THREE.MeshStandardMaterial({ color: 0x315f5b, roughness: 0.92 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(9.7, 0.16, 6.7), floorMat); floor.position.y = 0.08; floor.receiveShadow = true;
    const back = new THREE.Mesh(new THREE.BoxGeometry(10, 3.6, 0.3), brick); back.position.set(0, 1.8, -3.35);
    const houseSideL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.6, 7), brick); houseSideL.position.set(-4.85, 1.8, 0);
    const houseSideR = houseSideL.clone(); houseSideR.position.x = 4.85;
    const frontL = new THREE.Mesh(new THREE.BoxGeometry(4.08, 3.6, 0.3), brick); frontL.position.set(-2.96, 1.8, 3.35);
    const frontR = frontL.clone(); frontR.position.x = 2.96;
    const lintelWall = new THREE.Mesh(new THREE.BoxGeometry(1.84, 1.08, 0.3), brick); lintelWall.position.set(0, 3.06, 3.35);
    for (const object of [back, houseSideL, houseSideR, frontL, frontR, lintelWall]) { object.castShadow = true; object.receiveShadow = true; }

    const roofMat = new THREE.MeshStandardMaterial({ color: 0x77463a, roughness: 0.58, metalness: 0.34 });
    // Gable roof: both panels rise toward the central ridge (z=0) and fall to the eaves, forming a ^ peak
    // (not a ∨ valley). rotation.x sign is what sets which edge lifts — the ridge-side edge must go up.
    const slopeA = new THREE.Mesh(new THREE.BoxGeometry(10.8, 0.16, 4.15), roofMat); slopeA.position.set(0, 4.3, 1.78); slopeA.rotation.x = 0.38; slopeA.castShadow = true;
    const slopeB = slopeA.clone(); slopeB.position.z = -1.78; slopeB.rotation.x = -0.38;
    const stoep = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.24, 1.7), new THREE.MeshStandardMaterial({ color: 0xb8b1a2, roughness: 0.9 })); stoep.position.set(0, 0.12, 4.3); stoep.receiveShadow = true;
    const doorFrame = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2f7774, roughness: 0.55 });
    for (const x of [-0.92, 0.92]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.55, 0.16), frameMat); post.position.set(x, 1.28, 3.48); doorFrame.add(post); }
    const doorLintel = new THREE.Mesh(new THREE.BoxGeometry(1.96, 0.12, 0.16), frameMat); doorLintel.position.set(0, 2.55, 3.48); doorFrame.add(doorLintel);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x37525c, roughness: 0.18, metalness: 0.15, clearcoat: 0.6 });
    const windowA = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.25, 0.1), glass); windowA.position.set(-3.1, 1.85, 3.54);
    const windowB = windowA.clone(); windowB.position.x = 3.1;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffdf9e, emissive: 0xffc966, emissiveIntensity: 1.6 })); lamp.position.set(1, 2.85, 3.56);
    const nameplate = createSignMesh(new THREE.PlaneGeometry(4.5, 0.78), 'MAIN MAIN', '#74e392'); nameplate.position.set(0, 3.72, 3.5);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb3a48c, roughness: 0.92 });
    const wallL = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.05, 0.3), wallMat); wallL.position.set(-3.3, 0.52, 6.2); wallL.castShadow = true;
    const wallR = wallL.clone(); wallR.position.x = 3.3;
    const gardenSideL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.05, 9.5), wallMat); gardenSideL.position.set(-5, 0.52, 1.5); gardenSideL.castShadow = true;
    const gardenSideR = gardenSideL.clone(); gardenSideR.position.x = 5;

    // Small but readable lived-in room: bed, sofa, coffee table and the kind of wall wisdom you
    // only get in a Joburg flat. These are visible through the always-open front door at night.
    const bedBase = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.45, 2.15), darkWood); bedBase.position.set(-2.65, 0.32, -1.65);
    const mattress = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.32, 1.95), new THREE.MeshStandardMaterial({ color: 0xd4c9b3, roughness: 0.96 })); mattress.position.set(-2.65, 0.7, -1.65);
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.2, 0.48), new THREE.MeshStandardMaterial({ color: 0xe7dfcf, roughness: 1 })); pillow.position.set(-2.65, 0.96, -2.25);
    const sofa = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.72, 1.05), fabric); sofa.position.set(2.75, 0.45, -1.7);
    const sofaBack = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.05, 0.28), fabric); sofaBack.position.set(2.75, 0.82, -2.14);
    const table = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.18, 1.05), darkWood); table.position.set(2.4, 0.65, 0.2);
    for (const x of [1.72, 3.08]) for (const z of [-0.14, 0.54]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.58, 0.12), darkWood); leg.position.set(x, 0.35, z); flat.add(leg); }
    const homeSign = createSignMesh(new THREE.PlaneGeometry(3.8, 0.82), 'NO LOAD? NO SHED.', '#74e392'); homeSign.position.set(1.45, 2.55, -3.19);
    const lightPanel = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.08, 0.55), new THREE.MeshStandardMaterial({ color: 0xfff0c7, emissive: 0xffd16c, emissiveIntensity: 3 })); lightPanel.position.set(0, 3.38, 0);
    const interiorLight = new THREE.PointLight(0xffdca0, 8, 13, 1.35); interiorLight.position.set(0, 3.05, 0);

    flat.add(floor, back, houseSideL, houseSideR, frontL, frontR, lintelWall, slopeA, slopeB, stoep, doorFrame, windowA, windowB, lamp, nameplate, wallL, wallR, gardenSideL, gardenSideR, bedBase, mattress, pillow, sofa, sofaBack, table, homeSign, lightPanel, interiorLight);
    // Sit the flat on the terrain (the world has real elevation now); its wall colliders already sample
    // terrain via colliderBase, so only the mesh needed lifting off Y=0.
    flat.position.set(site.x, city.terrainHeightAt(site.x, site.z), site.z); flat.rotation.y = site.heading; this.group.add(flat);

    // The save/sleep interaction is now physically indoors. The green marker remains visible through
    // the doorway, but neither the menu nor a respawn can be triggered from the pavement.
    const inside = placedPoint(site, 0, 0.25);
    const spawn = placedPoint(site, 0, 1.15);
    const entrance = placedPoint(site, 0, 4.55);
    this.entrance.set(entrance.x, 0, entrance.z);
    const place = SAFEHOUSES[0];
    if (place) {
      place.pad.set(inside.x, 0, inside.z); place.radius = 2.25;
      place.spawn[0] = spawn.x; place.spawn[2] = spawn.z;
    }

    city.colliders.push(
      placedCollider(site, -5, 5, -3.5, -3.2, 3.6), // back wall
      placedCollider(site, -5, -4.7, -3.5, 3.5, 3.6), // house side walls
      placedCollider(site, 4.7, 5, -3.5, 3.5, 3.6),
      placedCollider(site, -5, -0.92, 3.2, 3.5, 3.6), // split frontage leaves a walk-in door
      placedCollider(site, 0.92, 5, 3.2, 3.5, 3.6),
      placedCollider(site, -4.2, -1.1, -2.75, -0.55, 1.05), // bed
      placedCollider(site, 1.3, 4.2, -2.3, -1.1, 1.4), // sofa
      placedCollider(site, 1.5, 3.3, -0.4, 0.75, 0.9), // coffee table
      placedCollider(site, -5, -1.6, 6.05, 6.35, 1.05), // front garden walls (gate gap in the middle)
      placedCollider(site, 1.6, 5, 6.05, 6.35, 1.05),
      placedCollider(site, -5.15, -4.85, -3.25, 6.25, 1.05), // side walls
      placedCollider(site, 4.85, 5.15, -3.25, 6.25, 1.05),
    );
  }
}
