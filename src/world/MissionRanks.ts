import * as THREE from 'three';
import { createSignMesh } from './ProceduralMaterials';
import { buildTaxiRank } from './models/civic';
import { buildMooredBoat } from './models/coastal';
import { buildSubstation } from './models/industrial';
import { buildPadstal } from './models/rural';
import { placedCollider } from '../systems/ShopSystem';
import {
  NEWTOWN_RANK_SITE, PADSTAL_SITE, PIER_POINT, PIER_SPOT, SUBSTATION_BREAKER, SUBSTATION_SITE,
  WEMMER_RANK_SITE, type PlacedSite,
} from './placements';
import type { City } from './City';

/**
 * The story's promised places, built for real (mission cohesion round 4). Set pieces the campaign
 * copy names but the world never had:
 *
 *  - NEWTOWN RANK — Candice's home rank on Ntemi Piliso Street ("bring it back to me here at the
 *    Newtown rank"). She is a contact ped (invulnerable) standing at the rank mouth; the structure
 *    plus its RESERVED_PADS claim is the owner's "protected mission object".
 *  - WEMMER LONG-DISTANCE TERMINAL — the rival crew's rank on Wemmer Jubilee Road, where Rank
 *    Business actually sends you ("thugs not at a taxi rank despite that being the mission
 *    description" — now they are).
 *  - VAALPUNT SLIPWAY dressing — hard-stand, boat and board at the real dam-side landmark the
 *    Pier Pressure copy names (the pin used to sit on a CBD kerb 9.6 km away).
 *  - OPHIRTON FEEDER — the substation three missions key off, as a real palisade-and-transformers
 *    yard on Booysens Road in Ophirton (the pin used to sit beside a CBD spaza shop 2 km from the
 *    district every line of copy names).
 *  - OUMA SE PADSTAL — the farm stall at its real western landmark, veranda, crates and
 *    hand-painted board (even the landmark was bare veld before).
 *
 * Same pattern as KelvinYard.ts: live scripted props anchored in placements, colliders through
 * placedCollider, procedural neighbours kept away by RESERVED_PADS (re-bake on anchor change —
 * RESERVED_PADS feeds CityGen/ModelScatter, so the bake gate enforces it).
 */

/** Plant one taxi-rank model at a placements site with its own name board over the canopy. */
function plantRank(scene: THREE.Scene, city: City, site: PlacedSite, seed: number, boardText: string, accent: string): void {
  const built = buildTaxiRank(seed, { variant: 1, size: 0.9 }); // vendor-stall variant, near-full span
  const y = city.surfaceHeightAt(site.x, site.z);
  built.group.position.set(site.x, y, site.z);
  built.group.rotation.y = site.heading;
  built.group.name = boardText;
  scene.add(built.group);
  // Ground-level tiers only (benches, stall): the canopy stays a walk-under shade port — a rank
  // you cannot stand inside of is scenery, not a rank.
  for (const tier of built.tiers) {
    if (tier.y0 > 1) continue;
    city.colliders.push(placedCollider(site, tier.minX, tier.maxX, tier.minZ, tier.maxZ, tier.y1));
  }
  // Identity board on masts above the canopy, facing the street — the sign IS the promise kept.
  const steel = new THREE.MeshStandardMaterial({ color: 0x4c565c, roughness: 0.6, metalness: 0.4 });
  const fx = Math.sin(site.heading); const fz = Math.cos(site.heading); // unit vector toward the road
  const boardX = site.x + fx * 2.2; const boardZ = site.z + fz * 2.2;
  for (const side of [-1, 1]) {
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.16, 5.4, 0.16), steel);
    mast.position.set(boardX + fz * side * 3.4, y + 2.7, boardZ - fx * side * 3.4);
    mast.castShadow = true;
    scene.add(mast);
  }
  const board = new THREE.Mesh(new THREE.BoxGeometry(7.2, 1.35, 0.18), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 }));
  board.position.set(boardX, y + 4.9, boardZ);
  board.rotation.y = site.heading;
  const sign = createSignMesh(new THREE.PlaneGeometry(6.8, 1.15), boardText, accent);
  sign.position.set(boardX + fx * 0.12, y + 4.9, boardZ + fz * 0.12);
  sign.rotation.y = site.heading;
  scene.add(board, sign);
}

/** Vaalpunt Slipway: concrete hard-stand, a boat waiting on it, and the name board. The dam's
 *  waterline is ~180u further west — this is the trailer hard-stand end of the slipway, which is
 *  where a bragging fare-skipper and his boat would actually be. */
function plantSlipway(scene: THREE.Scene, city: City): void {
  const y = city.surfaceHeightAt(PIER_POINT.x, PIER_POINT.z);
  const group = new THREE.Group();
  group.name = 'Vaalpunt Slipway';
  // Hard-stand slab, gently proud of the veld.
  const slab = new THREE.Mesh(new THREE.BoxGeometry(22, 0.22, 14), new THREE.MeshStandardMaterial({ color: 0x9c9a90, roughness: 0.92 }));
  slab.position.set(PIER_POINT.x - 6, y + 0.06, PIER_POINT.z); slab.receiveShadow = true;
  group.add(slab);
  // The fare-skipper's boat, up on the stand (deterministic seed, mast variant reads "leaving soon").
  const boat = buildMooredBoat(4707, { variant: 1, size: 0.9 });
  boat.group.position.set(PIER_POINT.x - 9, y + 0.62, PIER_POINT.z - 3);
  boat.group.rotation.y = Math.PI / 2 + 0.18; // bow toward the dam
  group.add(boat.group);
  city.colliders.push(placedCollider({ x: PIER_POINT.x - 9, z: PIER_POINT.z - 3, heading: Math.PI / 2 + 0.18 }, -1.2, 1.2, -3.4, 3.4, 1.4));
  // Board at the road end, facing back up Sloepbaai Road.
  const heading = Math.atan2(PIER_SPOT.x - PIER_POINT.x, PIER_SPOT.z - PIER_POINT.z);
  const steel = new THREE.MeshStandardMaterial({ color: 0x4c565c, roughness: 0.6, metalness: 0.4 });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.4, 0.14), steel);
    post.position.set(PIER_POINT.x + Math.cos(heading) * side * 2.6, y + 1.7, PIER_POINT.z - Math.sin(heading) * side * 2.6);
    post.castShadow = true;
    group.add(post);
  }
  const board = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.1, 0.16), new THREE.MeshStandardMaterial({ color: 0x1a2226, roughness: 0.55 }));
  board.position.set(PIER_POINT.x, y + 3.1, PIER_POINT.z);
  board.rotation.y = heading;
  const sign = createSignMesh(new THREE.PlaneGeometry(5.3, 0.95), 'VAALPUNT SLIPWAY', '#7fd0e8');
  sign.position.set(PIER_POINT.x + Math.sin(heading) * 0.1, y + 3.1, PIER_POINT.z + Math.cos(heading) * 0.1);
  sign.rotation.y = heading;
  group.add(board, sign);
  scene.add(group);
}

/** The Ophirton feeder: a full substation model (palisade, transformers, gantry) with a name board
 *  and the throwable main-breaker cabinet on the OUTSIDE of the fence — the yard is fenced solid,
 *  so the thing a hand must reach lives on the road-side apron where the mission pin points. */
function plantSubstation(scene: THREE.Scene, city: City): void {
  const built = buildSubstation(3303, { variant: 1, size: 1 });
  const y = city.surfaceHeightAt(SUBSTATION_SITE.x, SUBSTATION_SITE.z);
  built.group.position.set(SUBSTATION_SITE.x, y, SUBSTATION_SITE.z);
  built.group.rotation.y = SUBSTATION_SITE.heading;
  built.group.name = 'Ophirton feeder substation';
  scene.add(built.group);
  for (const tier of built.tiers) {
    city.colliders.push(placedCollider(SUBSTATION_SITE, tier.minX, tier.maxX, tier.minZ, tier.maxZ, tier.y1));
  }
  // The main breaker cabinet at its own mission anchor, handle out.
  const cabinetY = city.surfaceHeightAt(SUBSTATION_BREAKER.x, SUBSTATION_BREAKER.z);
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x5a6168, roughness: 0.5, metalness: 0.5 }));
  cabinet.position.set(SUBSTATION_BREAKER.x, cabinetY + 0.75, SUBSTATION_BREAKER.z);
  cabinet.rotation.y = SUBSTATION_SITE.heading;
  cabinet.castShadow = true;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.12), new THREE.MeshStandardMaterial({ color: 0xc23a2f, roughness: 0.45 }));
  handle.position.set(
    SUBSTATION_BREAKER.x + Math.sin(SUBSTATION_SITE.heading) * 0.28,
    cabinetY + 1.05,
    SUBSTATION_BREAKER.z + Math.cos(SUBSTATION_SITE.heading) * 0.28,
  );
  handle.rotation.y = SUBSTATION_SITE.heading;
  scene.add(cabinet, handle);
  // Identity board on the palisade, facing the street.
  const steel = new THREE.MeshStandardMaterial({ color: 0x4c565c, roughness: 0.6, metalness: 0.4 });
  const fx = Math.sin(SUBSTATION_SITE.heading); const fz = Math.cos(SUBSTATION_SITE.heading);
  const boardX = SUBSTATION_SITE.x + fx * 7.4; const boardZ = SUBSTATION_SITE.z + fz * 7.4;
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.2, 0.14), steel);
    post.position.set(boardX + fz * side * 2.4, y + 1.6, boardZ - fx * side * 2.4);
    post.castShadow = true;
    scene.add(post);
  }
  const board = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.05, 0.16), new THREE.MeshStandardMaterial({ color: 0x1a2226, roughness: 0.55 }));
  board.position.set(boardX, y + 2.9, boardZ);
  board.rotation.y = SUBSTATION_SITE.heading;
  const sign = createSignMesh(new THREE.PlaneGeometry(4.9, 0.9), 'OPHIRTON FEEDER', '#e8c832');
  sign.position.set(boardX + fx * 0.1, y + 2.9, boardZ + fz * 0.1);
  sign.rotation.y = SUBSTATION_SITE.heading;
  scene.add(board, sign);
}

/** Ouma se Padstal: the farm stall itself at the real landmark, door facing the Rooibos Route. */
function plantPadstal(scene: THREE.Scene, city: City): void {
  const built = buildPadstal(4404, { variant: 2, size: 1.4, signName: 'OUMA SE PADSTAL' });
  const site = PADSTAL_SITE.building;
  const y = city.surfaceHeightAt(site.x, site.z);
  built.group.position.set(site.x, y, site.z);
  built.group.rotation.y = site.heading;
  built.group.name = 'Ouma se Padstal';
  scene.add(built.group);
  for (const tier of built.tiers) {
    city.colliders.push(placedCollider(site, tier.minX, tier.maxX, tier.minZ, tier.maxZ, tier.y1));
  }
}

export function buildMissionRanks(scene: THREE.Scene, city: City): void {
  plantRank(scene, city, NEWTOWN_RANK_SITE, 1101, 'NEWTOWN RANK', '#f0c02f');
  plantRank(scene, city, WEMMER_RANK_SITE, 2202, 'WEMMER LONG-DISTANCE', '#7fd0e8');
  plantSlipway(scene, city);
  plantSubstation(scene, city);
  plantPadstal(scene, city);
}
