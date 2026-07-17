import * as THREE from 'three';
import { createSignMesh } from './ProceduralMaterials';
import { registerPowered } from './powerGrid';
import { KELVIN_FENCE_RADIUS, KELVIN_GATE_SPOT, KELVIN_OFFICE_SPOT, KELVIN_YARD_CENTER } from './placements';
import { placedCollider } from '../systems/ShopSystem';
import type { City } from './City';

/**
 * Kelvin Yard: the cartel's fenced depot (flagship mission "Dark House"). Visual truth for
 * the DepotSecurity model — a fence ring on KELVIN_FENCE_RADIUS, a solid vehicle gate that
 * never opens for you, ONE rear breach (a bent post the fence never got fixed), four
 * floodlight masts whose heads are mains-fed (registerPowered: they die with the grid,
 * like every lit sign in the city), and the records office at the back.
 */
export function buildKelvinYard(scene: THREE.Scene, city: City): void {
  const group = new THREE.Group();
  group.name = 'Kelvin Yard';
  const gateAngle = Math.atan2(KELVIN_GATE_SPOT.x - KELVIN_YARD_CENTER.x, KELVIN_GATE_SPOT.z - KELVIN_YARD_CENTER.z);
  const breachAngle = gateAngle + Math.PI; // the cut is at the back, far from the floodlit gate

  const steel = new THREE.MeshStandardMaterial({ color: 0x5a6166, roughness: 0.55, metalness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c3237, roughness: 0.7, metalness: 0.3 });

  // Fence ring: 16 tangent panels; skip 2 for the gate span and 1 for the rear breach.
  const SEGMENTS = 16;
  const step = (Math.PI * 2) / SEGMENTS;
  const angleOf = (index: number): number => index * step + step / 2;
  const near = (a: number, b: number, tolerance: number): boolean => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < tolerance;
  const panelLength = 2 * KELVIN_FENCE_RADIUS * Math.tan(step / 2) + 0.4;
  for (let index = 0; index < SEGMENTS; index++) {
    const angle = angleOf(index);
    if (near(angle, gateAngle, step)) continue; // gate span (filled by the gate itself)
    const breach = near(angle, breachAngle, step * 0.55);
    const x = KELVIN_YARD_CENTER.x + Math.sin(angle) * KELVIN_FENCE_RADIUS;
    const z = KELVIN_YARD_CENTER.z + Math.cos(angle) * KELVIN_FENCE_RADIUS;
    const heading = angle + Math.PI / 2; // panel runs along the tangent
    if (breach) {
      // The breach: one leaning post and a curl of dropped mesh — the way in, if you can use it.
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 0.18), steel);
      post.position.set(x + Math.sin(angle + Math.PI / 2) * (panelLength / 2 - 0.4), city.surfaceHeightAt(x, z) + 1.0, z + Math.cos(angle + Math.PI / 2) * (panelLength / 2 - 0.4));
      post.rotation.z = 0.6; post.castShadow = true;
      group.add(post);
      continue; // no panel, no collider: this is the gap
    }
    const panel = new THREE.Mesh(new THREE.BoxGeometry(panelLength, 2.6, 0.14), steel);
    const y = city.surfaceHeightAt(x, z);
    panel.position.set(x, y + 1.3, z); panel.rotation.y = heading; panel.castShadow = true; panel.receiveShadow = true;
    group.add(panel);
    city.colliders.push(placedCollider({ x, z, heading }, -panelLength / 2, panelLength / 2, -0.15, 0.15, 2.6));
  }

  // Vehicle gate: two solid panels across the gate span. Mains maglock — it does not open for you.
  const gateX = KELVIN_YARD_CENTER.x + Math.sin(gateAngle) * KELVIN_FENCE_RADIUS;
  const gateZ = KELVIN_YARD_CENTER.z + Math.cos(gateAngle) * KELVIN_FENCE_RADIUS;
  const gateY = city.surfaceHeightAt(gateX, gateZ);
  const gateWidth = panelLength * 2.1;
  const gate = new THREE.Mesh(new THREE.BoxGeometry(gateWidth, 2.4, 0.2), dark);
  gate.position.set(gateX, gateY + 1.2, gateZ); gate.rotation.y = gateAngle + Math.PI / 2; gate.castShadow = true;
  group.add(gate);
  city.colliders.push(placedCollider({ x: gateX, z: gateZ, heading: gateAngle + Math.PI / 2 }, -gateWidth / 2, gateWidth / 2, -0.2, 0.2, 2.4));
  const board = new THREE.Mesh(new THREE.BoxGeometry(6.4, 1.5, 0.2), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 }));
  board.position.set(gateX, gateY + 3.4, gateZ); board.rotation.y = gateAngle;
  const sign = createSignMesh(new THREE.PlaneGeometry(6, 1.3), 'KELVIN YARD', '#e8b23c');
  sign.position.set(gateX + Math.sin(gateAngle) * 0.12, gateY + 3.4, gateZ + Math.cos(gateAngle) * 0.12); sign.rotation.y = gateAngle;
  group.add(board, sign);

  // Four floodlight masts on the diagonals: mains-fed heads that die with the grid.
  const headMaterial = new THREE.MeshStandardMaterial({ color: 0xf7f0da, emissive: 0xfff3cf, emissiveIntensity: 2.2, roughness: 0.4 });
  registerPowered(headMaterial, 0xf7f0da);
  for (const diagonal of [0.25, 0.75, 1.25, 1.75]) {
    const angle = gateAngle + Math.PI * diagonal;
    const x = KELVIN_YARD_CENTER.x + Math.sin(angle) * (KELVIN_FENCE_RADIUS - 2);
    const z = KELVIN_YARD_CENTER.z + Math.cos(angle) * (KELVIN_FENCE_RADIUS - 2);
    const y = city.surfaceHeightAt(x, z);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.24, 7.5, 0.24), steel);
    mast.position.set(x, y + 3.75, z); mast.castShadow = true;
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.6), headMaterial);
    head.position.set(x, y + 7.4, z); head.rotation.y = angle + Math.PI; // heads look into the yard
    group.add(mast, head);
  }

  // Records office: a squat shack at the back with the only thing in the yard worth stealing.
  const officeY = city.surfaceHeightAt(KELVIN_OFFICE_SPOT.x, KELVIN_OFFICE_SPOT.z);
  const officeHeading = gateAngle; // door faces the gate
  const office = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 4.6), new THREE.MeshStandardMaterial({ color: 0x6e6a5e, roughness: 0.85 }));
  office.position.set(KELVIN_OFFICE_SPOT.x, officeY + 1.5, KELVIN_OFFICE_SPOT.z); office.rotation.y = officeHeading;
  office.castShadow = true; office.receiveShadow = true;
  const officeBoard = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.9, 0.16), new THREE.MeshStandardMaterial({ color: 0x171d20, roughness: 0.55 }));
  officeBoard.position.set(KELVIN_OFFICE_SPOT.x + Math.sin(officeHeading) * 2.4, officeY + 2.6, KELVIN_OFFICE_SPOT.z + Math.cos(officeHeading) * 2.4);
  officeBoard.rotation.y = officeHeading;
  const officeSign = createSignMesh(new THREE.PlaneGeometry(3.2, 0.8), 'RECORDS', '#c8cdd2');
  officeSign.position.copy(officeBoard.position).add(new THREE.Vector3(Math.sin(officeHeading) * 0.1, 0, Math.cos(officeHeading) * 0.1));
  officeSign.rotation.y = officeHeading;
  group.add(office, officeBoard, officeSign);
  city.colliders.push(placedCollider({ x: KELVIN_OFFICE_SPOT.x, z: KELVIN_OFFICE_SPOT.z, heading: officeHeading }, -3, 3, -2.3, 2.3, 3));

  scene.add(group);
}
