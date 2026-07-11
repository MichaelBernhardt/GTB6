import * as THREE from 'three';
import type { City } from '../world/City';

export const SAFEHOUSE_IDS = ['brixton'] as const;
export type SafehouseId = (typeof SAFEHOUSE_IDS)[number];
export interface SafehousePlace { id: SafehouseId; name: string; pad: THREE.Vector3; radius: number; spawn: [number, number, number]; }

export const SAFEHOUSE_ICON_COLOR = '#67d17f';
/** Parcel verified free of roads, buildings, shops and mission markers: a face-brick flat one block
 *  north of William Nicol Dr, ~36m east of the street spawn. The gate pad faces the road. */
export const SAFEHOUSES: SafehousePlace[] = [
  { id: 'brixton', name: 'Brixton Flat', pad: new THREE.Vector3(16, 0, 251.8), radius: 3, spawn: [16, 1, 251.8] },
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
  private phase = 0;

  constructor(scene: THREE.Scene, city: City) {
    this.group.name = 'Safehouses'; scene.add(this.group);
    this.buildBrixtonFlat(city);
    for (const place of SAFEHOUSES) this.addPadMarker(place);
  }

  update(dt: number): void {
    this.phase += dt;
    const pulse = 0.42 + Math.sin(this.phase * 2.6) * 0.16;
    for (const disc of this.discs) { (disc.material as THREE.MeshBasicMaterial).opacity = pulse; disc.rotation.y += dt * 0.9; }
  }

  near(position: THREE.Vector3): SafehousePlace | undefined {
    return SAFEHOUSES.find((place) => Math.hypot(position.x - place.pad.x, position.z - place.pad.z) < place.radius);
  }

  mapIcons(): Array<{ x: number; z: number; color: string; shape: 'house' }> {
    return SAFEHOUSES.map((place) => ({ x: place.pad.x, z: place.pad.z, color: SAFEHOUSE_ICON_COLOR, shape: 'house' }));
  }

  private addPadMarker(place: SafehousePlace): void {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.06, 26), new THREE.MeshBasicMaterial({ color: 0x58c97a, transparent: true, opacity: 0.5 }));
    disc.position.set(place.pad.x, 0.32, place.pad.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.18, 0.09, 8, 26), new THREE.MeshBasicMaterial({ color: 0x74e392 }));
    ring.rotation.x = Math.PI / 2; ring.position.set(place.pad.x, 0.34, place.pad.z);
    this.discs.push(disc); this.group.add(disc, ring);
  }

  private buildBrixtonFlat(city: City): void {
    const x = 16; const z = 259; // stoep, gate and pad face -z toward William Nicol Dr
    const body = new THREE.Mesh(new THREE.BoxGeometry(10, 3.6, 7), new THREE.MeshStandardMaterial({ color: 0x9a5a43, roughness: 0.85, metalness: 0.02 }));
    body.position.set(x, 1.8, z); body.castShadow = true; body.receiveShadow = true;
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x77463a, roughness: 0.58, metalness: 0.34 });
    const slopeA = new THREE.Mesh(new THREE.BoxGeometry(10.8, 0.16, 4.15), roofMat); slopeA.position.set(x, 4.3, z - 1.78); slopeA.rotation.x = 0.38; slopeA.castShadow = true;
    const slopeB = slopeA.clone(); slopeB.position.z = z + 1.78; slopeB.rotation.x = -0.38;
    const stoep = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.24, 1.7), new THREE.MeshStandardMaterial({ color: 0xb8b1a2, roughness: 0.9 })); stoep.position.set(x, 0.12, z - 4.3); stoep.receiveShadow = true;
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.35, 0.12), new THREE.MeshStandardMaterial({ color: 0x2f7774, roughness: 0.55 })); door.position.set(x, 1.28, z - 3.55);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x37525c, roughness: 0.18, metalness: 0.15, clearcoat: 0.6 });
    const windowA = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.25, 0.1), glass); windowA.position.set(x - 3.1, 1.85, z - 3.54);
    const windowB = windowA.clone(); windowB.position.x = x + 3.1;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffdf9e, emissive: 0xffc966, emissiveIntensity: 1.6 })); lamp.position.set(x + 1, 2.85, z - 3.56);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb3a48c, roughness: 0.92 });
    const wallL = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.05, 0.3), wallMat); wallL.position.set(x - 3.3, 0.52, z - 6.2); wallL.castShadow = true;
    const wallR = wallL.clone(); wallR.position.x = x + 3.3;
    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.05, 9.5), wallMat); sideL.position.set(x - 5, 0.52, z - 1.5); sideL.castShadow = true;
    const sideR = sideL.clone(); sideR.position.x = x + 5;
    this.group.add(body, slopeA, slopeB, stoep, door, windowA, windowB, lamp, wallL, wallR, sideL, sideR);
    city.colliders.push(
      { minX: x - 5, maxX: x + 5, minZ: z - 3.5, maxZ: z + 3.5, height: 3.6 },
      { minX: x - 5, maxX: x - 1.6, minZ: z - 6.35, maxZ: z - 6.05, height: 1.05 },
      { minX: x + 1.6, maxX: x + 5, minZ: z - 6.35, maxZ: z - 6.05, height: 1.05 },
      { minX: x - 5.15, maxX: x - 4.85, minZ: z - 6.25, maxZ: z + 3.25, height: 1.05 },
      { minX: x + 4.85, maxX: x + 5.15, minZ: z - 6.25, maxZ: z + 3.25, height: 1.05 },
    );
  }
}
