/**
 * Turns an InteriorLayout into three.js. Everything is built on FIRST ENTRY and disposed on exit —
 * nothing here is reachable from City.buildStages or prepareAssets, so an interior costs boot
 * exactly nothing.
 *
 * THE SHELL IS INSIDE-OUT ON PURPOSE. City's camera boom only shortens against City.colliders
 * (CameraController probes city.collidesAt), and a feature cannot register a collider — so in a room
 * 6 m across the boom WILL swing out through a wall. A front-faced shell would put an opaque wall
 * between the camera and the player. A THREE.BackSide shell disappears from outside instead, so the
 * worst case degrades to a dollhouse cutaway rather than a black screen. The dark void cylinder
 * around it hides the veld and the sky from the same outside camera, so the cutaway reads as an
 * interior rather than a shed in a field.
 *
 * Load shedding is polled from api.blackout() by the caller rather than registered with
 * world/powerGrid.registerPowered: that registry is module-global with no way to unregister, so a
 * room that registered its lamps would leak an entry every time you walked through the door.
 */
import * as THREE from 'three';
import { createSignMesh } from '../../world/ProceduralMaterials';
import type { InteriorLayout, InteriorProp } from './grammar';
import { PLOT_RADIUS, type StagePlot } from './stage';

export interface BuiltInterior {
  readonly group: THREE.Group;
  readonly lamps: readonly THREE.PointLight[];
  /** Emissive materials that die with the grid (lamp shades, the TV, the window glow), each with
   *  the intensity it was built at so load shedding is a multiplier and never a one-way ratchet. */
  readonly powered: readonly { material: THREE.MeshStandardMaterial; base: number }[];
  dispose(): void;
}

const WALL_T = 0.16;

/** Local room point -> world, for the caller's clamp and the fixture spawn. group.rotation.y = h
 *  maps local (lx, lz) to world (lx·cos h + lz·sin h, −lx·sin h + lz·cos h). */
export function toWorld(plot: StagePlot, heading: number, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(heading); const s = Math.sin(heading);
  return { x: plot.x + lx * c + lz * s, z: plot.z - lx * s + lz * c };
}

/** World point -> local room space. Exact inverse of toWorld. */
export function toLocal(plot: StagePlot, heading: number, x: number, z: number): { x: number; z: number } {
  const c = Math.cos(heading); const s = Math.sin(heading);
  const dx = x - plot.x; const dz = z - plot.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

export function buildInterior(layout: InteriorLayout, plot: StagePlot, heading: number): BuiltInterior {
  const group = new THREE.Group();
  group.name = `Interior:${layout.id}`;
  group.position.set(plot.x, plot.y, plot.z);
  group.rotation.y = heading;

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const lamps: THREE.PointLight[] = [];
  const powered: { material: THREE.MeshStandardMaterial; base: number }[] = [];
  const keep = <T extends THREE.BufferGeometry>(geometry: T): T => { geometries.push(geometry); return geometry; };
  const mat = <T extends THREE.Material>(material: T): T => { materials.push(material); return material; };
  const solid = (color: number, roughness = 0.82): THREE.MeshStandardMaterial => mat(new THREE.MeshStandardMaterial({ color, roughness }));
  const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), material);
    mesh.position.set(x, y, z); group.add(mesh); return mesh;
  };

  // ---- the void: everything outside this room is black, whichever way the boom swings ----------
  const voidMaterial = mat(new THREE.MeshBasicMaterial({ color: 0x05070a, side: THREE.BackSide, fog: false }));
  const shroud = new THREE.Mesh(keep(new THREE.CylinderGeometry(PLOT_RADIUS, PLOT_RADIUS, 26, 20, 1, false)), voidMaterial);
  // Bottom cap one centimetre under the floor plane: above every blade of terrain inside the plot
  // (findStagePlot pins the floor to the highest ground it sampled), so no veld leaks in.
  shroud.position.y = 13 - 0.01;
  group.add(shroud);

  // ---- the shell: one inside-out box, six faces, three colours --------------------------------
  const { width, depth, height, palette } = layout;
  const wall = mat(new THREE.MeshStandardMaterial({ color: palette.wall, roughness: 0.92, side: THREE.BackSide }));
  const floor = mat(new THREE.MeshStandardMaterial({ color: palette.floor, roughness: 0.95, side: THREE.BackSide }));
  const ceiling = mat(new THREE.MeshStandardMaterial({ color: palette.ceiling, roughness: 0.95, side: THREE.BackSide }));
  const shell = new THREE.Mesh(keep(new THREE.BoxGeometry(width, height, depth)), [wall, wall, ceiling, floor, wall, wall]);
  shell.position.y = height / 2;
  group.add(shell);

  const trim = solid(palette.trim, 0.7);
  // Skirting all the way round, so the wall/floor join reads as a room and not as a texture change.
  box(width, 0.12, WALL_T, trim, 0, 0.06, depth / 2 - WALL_T / 2);
  box(width, 0.12, WALL_T, trim, 0, 0.06, -depth / 2 + WALL_T / 2);
  box(WALL_T, 0.12, depth, trim, width / 2 - WALL_T / 2, 0.06, 0);
  box(WALL_T, 0.12, depth, trim, -width / 2 + WALL_T / 2, 0.06, 0);

  // ---- the way out: a recessed dark opening in the front wall with a steel gate over it --------
  const doorW = 1.24; const doorH = 2.12;
  const mouth = mat(new THREE.MeshBasicMaterial({ color: 0x0a0d10, fog: false }));
  box(doorW, doorH, 0.05, mouth, 0, doorH / 2, -depth / 2 + 0.03);
  const frame = solid(0x37403f, 0.6);
  box(0.14, doorH + 0.16, 0.16, frame, -doorW / 2 - 0.07, (doorH + 0.16) / 2, -depth / 2 + 0.1);
  box(0.14, doorH + 0.16, 0.16, frame, doorW / 2 + 0.07, (doorH + 0.16) / 2, -depth / 2 + 0.1);
  box(doorW + 0.28, 0.16, 0.16, frame, 0, doorH + 0.08, -depth / 2 + 0.1);
  const bar = solid(0x6d7679, 0.5);
  for (let i = 0; i < 5; i++) box(0.05, doorH, 0.05, bar, -doorW / 2 + 0.14 + i * (doorW - 0.28) / 4, doorH / 2, -depth / 2 + 0.14);
  // The mat you stand on to leave — the only visual cue that this square metre is the exit.
  const matMaterial = solid(0x3b3530, 0.98);
  box(1.5, 0.03, 0.9, matMaterial, 0, 0.02, -depth / 2 + 0.85);

  // ---- a window that glows rather than sees: no view out, honestly, in v1 ----------------------
  const glow = mat(new THREE.MeshStandardMaterial({ color: 0xdcc79a, emissive: 0xdcc79a, emissiveIntensity: 0.85, roughness: 0.5 }));
  powered.push({ material: glow, base: glow.emissiveIntensity });
  const windowSide = layout.kind === 'spaza' ? 1 : -1;
  box(0.06, 1.05, 1.5, glow, windowSide * (width / 2 - 0.05), 1.55, depth * 0.1);
  for (let i = 0; i < 5; i++) box(0.06, 1.12, 0.05, bar, windowSide * (width / 2 - 0.09), 1.55, depth * 0.1 - 0.68 + i * 0.34);
  box(0.06, 0.06, 1.6, bar, windowSide * (width / 2 - 0.09), 1.55, depth * 0.1);

  // ---- props ----------------------------------------------------------------------------------
  for (const prop of layout.props) buildProp(prop, { box, solid, mat, keep, group, powered });

  // ---- light -----------------------------------------------------------------------------------
  const shade = mat(new THREE.MeshStandardMaterial({ color: 0xfff0cf, emissive: 0xfff0cf, emissiveIntensity: 1.1, roughness: 0.6 }));
  powered.push({ material: shade, base: shade.emissiveIntensity });
  for (const spot of layout.lamps) {
    const lamp = new THREE.PointLight(spot.color, 12, 16, 1.7);
    lamp.position.set(spot.x, spot.y, spot.z);
    group.add(lamp); lamps.push(lamp);
    box(0.05, 0.34, 0.05, trim, spot.x, spot.y + 0.17, spot.z);
    const bulb = new THREE.Mesh(keep(new THREE.SphereGeometry(0.11, 10, 8)), shade);
    bulb.position.set(spot.x, spot.y - 0.04, spot.z); group.add(bulb);
  }
  // A dim fill so the corners are never pure black even with the grid down — you must always be
  // able to find the door.
  const fill = new THREE.PointLight(0x6f7f9a, 2.2, 22, 1.2);
  fill.position.set(0, height * 0.75, -depth * 0.25);
  group.add(fill);

  group.traverse((object) => { object.castShadow = false; object.receiveShadow = false; });

  return {
    group, lamps, powered,
    dispose: () => {
      group.removeFromParent();
      group.traverse((object) => { if (object instanceof THREE.Light) object.dispose(); });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
}

interface Kit {
  box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh;
  solid(color: number, roughness?: number): THREE.MeshStandardMaterial;
  mat<T extends THREE.Material>(material: T): T;
  keep<T extends THREE.BufferGeometry>(geometry: T): T;
  group: THREE.Group;
  powered: { material: THREE.MeshStandardMaterial; base: number }[];
}

function buildProp(prop: InteriorProp, kit: Kit): void {
  const { box, solid, mat, keep, group, powered } = kit;
  const body = solid(prop.color, 0.8);
  const base = prop.y;
  switch (prop.shape) {
    case 'counter': {
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
      box(prop.w + 0.1, 0.06, prop.d + 0.12, solid(0xd8cdb6, 0.55), prop.x, base + prop.h + 0.03, prop.z);
      break;
    }
    case 'shelf': {
      box(prop.w, prop.h, prop.d, solid(0x6f6a5e, 0.9), prop.x, base + prop.h / 2, prop.z);
      const tins = solid(prop.color, 0.55);
      for (let shelf = 0; shelf < 3; shelf++) {
        const y = base + 0.35 + shelf * (prop.h - 0.4) / 3;
        for (let i = 0; i < 4; i++) box(0.16, 0.2, 0.16, tins, prop.x - prop.w / 2 + 0.2 + i * (prop.w - 0.4) / 3, y + 0.1, prop.z - 0.1); // proud of the shelf on the ROOM side
      }
      break;
    }
    case 'cage': {
      const wire = solid(prop.color, 0.5);
      const bars = Math.max(3, Math.round(prop.w / 0.32));
      for (let i = 0; i < bars; i++) box(0.035, prop.h, 0.035, wire, prop.x - prop.w / 2 + i * prop.w / (bars - 1), base + prop.h / 2, prop.z);
      box(prop.w, 0.045, 0.045, wire, prop.x, base + prop.h - 0.05, prop.z);
      box(prop.w, 0.045, 0.045, wire, prop.x, base + prop.h / 2, prop.z);
      break;
    }
    case 'bed': {
      box(prop.w, prop.h, prop.d, solid(0x5a4a3c, 0.9), prop.x, base + prop.h / 2, prop.z);
      box(prop.w - 0.1, 0.16, prop.d - 0.1, body, prop.x, base + prop.h + 0.08, prop.z);
      box(0.5, 0.12, prop.d - 0.4, solid(0xe6ded0, 0.9), prop.x - prop.w / 2 + 0.3, base + prop.h + 0.2, prop.z);
      break;
    }
    case 'stove': {
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
      const plate = mat(new THREE.MeshStandardMaterial({ color: 0x6a2a22, emissive: 0x8a2010, emissiveIntensity: 0.7, roughness: 0.5 }));
      powered.push({ material: plate, base: plate.emissiveIntensity });
      for (let i = 0; i < 2; i++) {
        const ring = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.12, 0.12, 0.03, 12)), plate);
        ring.position.set(prop.x - 0.16 + i * 0.32, base + prop.h + 0.02, prop.z); group.add(ring);
      }
      break;
    }
    case 'tv': {
      box(prop.w, prop.h, prop.d, solid(0x1b1f22, 0.6), prop.x, base + prop.h / 2, prop.z);
      const screen = mat(new THREE.MeshStandardMaterial({ color: 0x9fc4d8, emissive: 0x6f9fc4, emissiveIntensity: 0.9, roughness: 0.4 }));
      powered.push({ material: screen, base: screen.emissiveIntensity });
      box(prop.w * 0.4, prop.h - 0.1, prop.d - 0.1, screen, prop.x - prop.w * 0.35, base + prop.h / 2, prop.z);
      break;
    }
    case 'bucket': case 'drum': case 'stool': {
      const radius = prop.w / 2;
      const mesh = new THREE.Mesh(keep(new THREE.CylinderGeometry(radius, radius * 0.86, prop.h, 12)), body);
      mesh.position.set(prop.x, base + prop.h / 2, prop.z); group.add(mesh);
      break;
    }
    case 'notice': {
      // createSignMesh's material is a globally cached atlas shared with every street sign in the
      // city — the geometry is ours to dispose, the material emphatically is not.
      const sign = createSignMesh(keep(new THREE.PlaneGeometry(prop.w < prop.d ? prop.d : prop.w, prop.h)), prop.text ?? '', '#f0d9a4', { background: '#20262b' });
      sign.position.set(prop.x, base + prop.h / 2, prop.z);
      if (prop.w < prop.d) sign.rotation.y = prop.x > 0 ? -Math.PI / 2 : Math.PI / 2;
      group.add(sign);
      break;
    }
    case 'curtain': {
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
      box(prop.w + 0.04, 0.05, prop.d + 0.1, solid(0x4a4a48, 0.7), prop.x, base + prop.h, prop.z);
      break;
    }
    default:
      box(prop.w, prop.h, prop.d, body, prop.x, base + prop.h / 2, prop.z);
  }
}
