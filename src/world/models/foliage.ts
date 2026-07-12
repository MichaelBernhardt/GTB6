/**
 * Foliage set: SA trees and plants built for heavy instancing — icosahedron canopy blobs
 * (20 tris each at detail 0), low-segment cones, and shared paint() materials so the per-material
 * GeometryBaker merge collapses thousands of plants into a handful of draw calls. Trunks register
 * slim collider tiers where a plant is solid; canopies never collide, so the player brushes
 * through leaves but not through wood.
 */
import * as THREE from 'three';
import { Kit, M, paint, type BuildOptions, type BuiltModel } from './kit';

const TAU = Math.PI * 2;

/** Foliage palette — paint() caches per colour, so every plant shares these material instances. */
const F = {
  bark: paint(0x6a5136, 0.95),
  barkDark: paint(0x4b3b2b, 0.95),
  barkPale: paint(0xc8bda6, 0.9),
  leaf: paint(0x55793c, 0.95),
  leafDark: paint(0x3d5c31, 0.95),
  leafOlive: paint(0x74804a, 0.95),
  leafDusty: paint(0x88946f, 0.95),
  pine: paint(0x33523a, 0.95),
  jacBloom: paint(0x8f74c8, 0.9),
  jacCarpet: paint(0x7e66b5, 0.95),
  bougMagenta: paint(0xc03f78, 0.9),
  bougPurple: paint(0x8e4a9e, 0.9),
  aloe: paint(0x5f7f52, 0.85),
  aloeFlower: paint(0xd2652a, 0.85),
  agave: paint(0x7fa08c, 0.85),
  mastBloom: paint(0xd9c86b, 0.85),
  frond: paint(0x4d7a3d, 0.9),
  grassDry: paint(0xa39050, 0.98),
  grassGreen: paint(0x7d8a4e, 0.98),
  hedge: paint(0x3f6136, 0.95),
  coral: paint(0xc4472e, 0.9),
};

/** Low-poly canopy blob: an icosahedron squashed vertically to taste. Never collides. */
function blob(kit: Kit, material: THREE.Material, r: number, x: number, y: number, z: number, squash = 0.8, detail = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), material);
  mesh.position.set(x, y, z); mesh.scale.y = squash;
  mesh.castShadow = true; mesh.receiveShadow = true;
  return kit.add(mesh);
}

/** Cone leaning outward from anchor (x, baseY, z) toward compass angle `a` — the centre offset and
 *  base lift compensate the about-centre rotation so the foot stays on the anchor. Never collides. */
function lean(kit: Kit, material: THREE.Material, rTop: number, rBottom: number, h: number, a: number, tilt: number, x: number, baseY: number, z: number, seg = 5): void {
  const reach = Math.sin(tilt) * h * 0.5;
  const lift = (h / 2) * (1 - Math.cos(tilt));
  kit.cyl(material, rTop, rBottom, h, x + Math.sin(a) * reach, baseY - lift, z + Math.cos(a) * reach, {
    seg, rx: Math.cos(a) * tilt, rz: -Math.sin(a) * tilt,
  });
}

/** Canopy crown: one core blob plus `count` satellites ringed at `ring` with seeded jitter.
 *  Horizontal extent is bounded by ring + 1.1 * blobR (core: 1.25 * blobR). */
function crown(kit: Kit, material: THREE.Material, count: number, ring: number, blobR: number, y: number, squash: number, salt: number): void {
  blob(kit, material, blobR * 1.25, 0, y + blobR * 0.15, 0, squash);
  for (let sat = 0; sat < count; sat++) {
    const a = (sat / count) * TAU + kit.rnd(salt + sat) * 1.1;
    const r = blobR * (0.75 + kit.rnd(salt + 10 + sat) * 0.35);
    blob(kit, material, r, Math.sin(a) * ring, y + (kit.rnd(salt + 20 + sat) - 0.5) * blobR * 0.7, Math.cos(a) * ring, squash);
  }
}

/** Jacaranda: Joburg's street tree — forked limbs under a wide dome; the bloom variant turns the
 *  canopy purple and drops a petal carpet under the tree. */
export function buildJacaranda(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const trunkH = 2.4 + size * 1.2; const canopyR = 2.8 + size * 1.2;
  kit.cyl(F.barkDark, 0.16 + size * 0.06, 0.26 + size * 0.1, trunkH, 0, 0, 0, { seg: 6, collide: true });
  for (let limb = 0; limb < 3; limb++) {
    lean(kit, F.barkDark, 0.05, 0.13, trunkH * 0.75, limb * 2.1 + kit.rnd(4 + limb) * 0.9, 0.55, 0, trunkH * 0.85, 0);
  }
  crown(kit, variant === 1 ? F.jacBloom : F.leaf, 4, canopyR * 0.55, canopyR * 0.55, trunkH + canopyR * 0.5, 0.72, 30);
  if (variant === 1) kit.cyl(F.jacCarpet, canopyR * 0.8, canopyR * 0.8, 0.04, 0, 0, 0, { seg: 12, cast: false });
  return kit.done();
}

/** Broad shade tree (oak / plane): stout trunk, deep rounded crown over a whole yard. */
export function buildShadeTree(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const trunkH = 2.2 + size; const canopyR = 3.0 + size * 1.4;
  const bark = variant === 1 ? F.barkPale : F.bark; // plane trees shed to a pale mottled trunk
  kit.cyl(bark, 0.24 + size * 0.08, 0.36 + size * 0.12, trunkH, 0, 0, 0, { seg: 6, collide: true });
  for (let limb = 0; limb < 3; limb++) lean(kit, bark, 0.06, 0.16, trunkH * 0.8, limb * 2.2 + kit.rnd(4 + limb) * 0.7, 0.6, 0, trunkH * 0.8, 0);
  crown(kit, F.leaf, 5, canopyR * 0.6, canopyR * 0.6, trunkH + canopyR * 0.6, 0.85, 30);
  for (let tuck = 0; tuck < 2; tuck++) { // darker under-canopy masses for depth
    const a = kit.rnd(50 + tuck) * TAU;
    blob(kit, F.leafDark, canopyR * 0.3, Math.sin(a) * canopyR * 0.45, trunkH + canopyR * (0.35 + kit.rnd(55 + tuck) * 0.3), Math.cos(a) * canopyR * 0.45, 0.85);
  }
  return kit.done();
}

/** Gum (eucalyptus): tall pale trunk shedding a bark sock, sparse dusty crown way up high. */
export function buildGum(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const trunkH = 8 + size * 4;
  kit.cyl(F.barkPale, 0.14, 0.24 + size * 0.06, trunkH, 0, 0, 0, { seg: 6, collide: true });
  kit.cyl(F.bark, 0.27 + size * 0.06, 0.3 + size * 0.06, 1.8 + size, 0, 0, 0, { seg: 6 }); // shed-bark sock
  if (variant === 1) lean(kit, F.barkPale, 0.09, 0.17, trunkH * 0.62, kit.rnd(3) * TAU, 0.16, 0, 0.2, 0, 6); // twin leader
  for (let limb = 0; limb < 2; limb++) lean(kit, F.barkPale, 0.04, 0.1, 2, limb * 2.8 + kit.rnd(6 + limb), 0.75, 0, trunkH * 0.82, 0);
  for (let tuft = 0; tuft < 4; tuft++) {
    const a = (tuft / 4) * TAU + kit.rnd(20 + tuft) * 1.2;
    blob(kit, F.leafDusty, 1.0 + kit.rnd(30 + tuft) * 0.6, Math.sin(a) * 1.4, trunkH - 1 + tuft * 0.8, Math.cos(a) * 1.4, 0.75);
  }
  return kit.done();
}

/** Pine: plantation conifer (stacked cones) or a Cape stone-pine umbrella on a bare trunk. */
export function buildPine(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  if (variant === 0) {
    const trunkH = 1.6 + size * 0.8; const baseR = 1.9 + size * 0.8;
    kit.cyl(F.bark, 0.18, 0.26 + size * 0.08, trunkH + 1, 0, 0, 0, { seg: 6, collide: true });
    for (let tier = 0; tier < 3; tier++) {
      kit.cyl(F.pine, 0.03, baseR * (1 - tier * 0.28), 2.1 + size * 0.5, 0, trunkH + tier * (1.5 + size * 0.5), 0, { seg: 7 });
    }
  } else {
    const trunkH = 4 + size * 1.6; const canopyR = 2.2 + size * 0.9;
    kit.cyl(F.bark, 0.2, 0.3 + size * 0.08, trunkH, 0, 0, 0, { seg: 6, collide: true });
    lean(kit, F.bark, 0.07, 0.14, trunkH * 0.5, kit.rnd(5) * TAU, 0.7, 0, trunkH * 0.78, 0);
    blob(kit, F.pine, canopyR, 0, trunkH + canopyR * 0.1, 0, 0.45);
    blob(kit, F.leafDark, canopyR * 0.55, kit.rnd(7) * 1.4 - 0.7, trunkH - 0.4, kit.rnd(8) * 1.4 - 0.7, 0.5);
  }
  return kit.done();
}

/** Acacia thorn tree: short forked trunk under the flat bushveld canopy pads. */
export function buildAcacia(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const trunkH = 1.7 + size * 0.6; const padR = 2.4 + size * 0.9; const padY = trunkH + 2.1;
  kit.cyl(F.barkDark, 0.13, 0.2 + size * 0.06, trunkH, 0, 0, 0, { seg: 5, collide: true });
  if (variant === 1) lean(kit, F.barkDark, 0.1, 0.16, trunkH + 1.4, kit.rnd(3) * TAU, 0.5, 0, 0, 0);
  for (let limb = 0; limb < 4; limb++) lean(kit, F.barkDark, 0.04, 0.11, 2.4, limb * 1.6 + kit.rnd(6 + limb) * 0.8, 0.85, 0, trunkH * 0.9, 0, 4);
  blob(kit, F.leafOlive, padR, 0, padY, 0, 0.26);
  for (let pad = 0; pad < 2; pad++) {
    const a = kit.rnd(20 + pad) * TAU;
    blob(kit, F.leafOlive, padR * 0.55, Math.sin(a) * padR * 0.55, padY - 0.5 + kit.rnd(25 + pad) * 0.9, Math.cos(a) * padR * 0.55, 0.3);
  }
  return kit.done();
}

/** Coastal palm: curved segmented trunk under a crown of drooping fronds; only the vertical base
 *  segment collides. Variant 1 leans hard into the sea breeze and carries coconuts. */
export function buildPalm(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const segH = 1.8 + size * 0.7; const dir = kit.rnd(3) * TAU;
  const tilt = variant === 1 ? 0.16 : 0.06;
  kit.cyl(F.bark, 0.15, 0.22, segH, 0, 0, 0, { seg: 5, collide: true });
  let disp = 0;
  for (let s = 1; s < 3; s++) {
    const tiltS = tilt * (s + 0.5);
    const reach = disp + Math.sin(tiltS) * segH * 0.5;
    kit.cyl(F.bark, 0.12, 0.16, segH, Math.sin(dir) * reach, segH * s * 0.96, Math.cos(dir) * reach, { seg: 5, rx: Math.cos(dir) * tiltS, rz: -Math.sin(dir) * tiltS });
    disp += Math.sin(tiltS) * segH;
  }
  const topX = Math.sin(dir) * disp; const topZ = Math.cos(dir) * disp; const topY = segH * 2.85;
  blob(kit, F.leafDark, 0.42, topX, topY - 0.1, topZ, 0.8); // crown boss the fronds hang off
  for (let f = 0; f < 7; f++) {
    const a = (f / 7) * TAU + kit.rnd(20 + f) * 0.6;
    const droop = 0.3 + kit.rnd(30 + f) * 0.45;
    const len = 2 + size * 0.6;
    const frond = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, len), F.frond);
    frond.position.set(topX + Math.sin(a) * len * 0.42, topY + 0.3 - Math.sin(droop) * len * 0.25, topZ + Math.cos(a) * len * 0.42);
    frond.rotateY(a); frond.rotateX(droop);
    frond.castShadow = true; frond.receiveShadow = true;
    kit.add(frond);
  }
  if (variant === 1) for (const side of [-1, 1]) blob(kit, F.leafOlive, 0.16, topX + side * 0.25, topY - 0.35, topZ, 1);
  return kit.done();
}

/** Aloe (ferox-style): stubby trunk, succulent rosette, orange candle flowers; variant clumps. */
export function buildAloe(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const head = (x: number, z: number, scale: number, salt: number, flowers: number): void => {
    const trunkH = (0.7 + size * 0.4) * scale;
    kit.cyl(F.bark, 0.11 * scale, 0.16 * scale, trunkH, x, 0, z, { seg: 5, collide: scale === 1 });
    for (let leaf = 0; leaf < (scale === 1 ? 7 : 5); leaf++) {
      const a = (leaf / 7) * TAU + kit.rnd(salt + leaf) * 0.9;
      lean(kit, F.aloe, 0.02, 0.08 * scale, (0.75 + kit.rnd(salt + 10 + leaf) * 0.3) * scale, a, 0.7 + kit.rnd(salt + 20 + leaf) * 0.45, x, trunkH - 0.15 * scale, z, 3);
    }
    for (let spike = 0; spike < flowers; spike++) {
      const a = kit.rnd(salt + 30 + spike) * TAU;
      const sx = x + Math.sin(a) * 0.12; const sz = z + Math.cos(a) * 0.12;
      kit.cyl(F.leafOlive, 0.02, 0.03, 0.75 * scale, sx, trunkH + 0.1, sz, { seg: 3 });
      kit.cyl(F.aloeFlower, 0.02, 0.07, 0.3 * scale, sx, trunkH + 0.1 + 0.72 * scale, sz, { seg: 4 });
    }
  };
  head(0, 0, 1, 5, 2);
  if (variant === 1) { head(0.72, 0.2, 0.65, 60, 1); head(-0.5, -0.55, 0.55, 90, 0); }
  return kit.done();
}

/** Agave: ground rosette of thick blue-grey blades; the century-plant variant sends up a mast. */
export function buildAgave(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const bladeL = 1.3 + size * 0.4;
  for (let leaf = 0; leaf < 9; leaf++) {
    const a = (leaf / 9) * TAU + kit.rnd(4 + leaf) * 0.8;
    const tilt = 0.3 + (leaf % 3) * 0.3 + kit.rnd(15 + leaf) * 0.15; // inner blades upright, outer splayed
    lean(kit, F.agave, 0.02, 0.14, bladeL * (1 - (leaf % 3) * 0.12), a, tilt, 0, 0, 0, 3);
  }
  kit.tier(-0.35, 0.35, -0.35, 0.35, 0, 0.8); // solid succulent core
  if (variant === 1) {
    kit.cyl(F.leafOlive, 0.04, 0.09, 3.4 + size * 1.2, 0, 0.4, 0, { seg: 4 });
    for (let panicle = 0; panicle < 3; panicle++) {
      const a = kit.rnd(40 + panicle) * TAU;
      blob(kit, F.mastBloom, 0.28, Math.sin(a) * 0.45, 2.6 + panicle * 0.6 + size, Math.cos(a) * 0.45, 0.7);
    }
  }
  return kit.done();
}

/** Bougainvillea: woody sprawl buried under masses of papery bloom — magenta or purple. */
export function buildBougainvillea(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const bloom = variant === 1 ? F.bougPurple : F.bougMagenta;
  const coreR = 0.95 + size * 0.35;
  for (const side of [-1, 1]) lean(kit, F.barkDark, 0.04, 0.09, 1, kit.rnd(3 + side) * TAU, 0.55, 0, 0, 0, 4);
  blob(kit, bloom, coreR, 0, coreR * 0.75, 0, 0.8);
  for (let tuft = 0; tuft < 3; tuft++) {
    const a = (tuft / 3) * TAU + kit.rnd(10 + tuft) * 1.3;
    blob(kit, bloom, coreR * (0.5 + kit.rnd(20 + tuft) * 0.2), Math.sin(a) * coreR * 0.75, coreR * (0.55 + kit.rnd(30 + tuft) * 0.5), Math.cos(a) * coreR * 0.75, 0.8);
  }
  blob(kit, F.leafDark, coreR * 0.5, kit.rnd(40) * 0.8 - 0.4, coreR * 0.35, kit.rnd(41) * 0.8 - 0.4, 0.8);
  kit.tier(-coreR * 0.7, coreR * 0.7, -coreR * 0.7, coreR * 0.7, 0, coreR * 1.2); // shrub body is solid
  return kit.done();
}

/** Veld grass: a dry tuft cluster — pure dressing, no collider, a handful of 3-seg cones. */
export function buildVeldGrass(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const grass = variant === 1 ? F.grassGreen : F.grassDry;
  const tufts = [[0, 0, 1], [0.58, 0.28, 0.7], [-0.42, -0.48, 0.62]] as const;
  tufts.forEach(([tx, tz, scale], tuft) => {
    for (let bladeIdx = 0; bladeIdx < 3; bladeIdx++) {
      const a = kit.rnd(tuft * 10 + bladeIdx) * TAU;
      lean(kit, grass, 0.012, 0.05, (1.15 + size * 0.35) * scale, a, 0.1 + kit.rnd(tuft * 10 + bladeIdx + 40) * 0.22, tx, 0, tz, 3);
    }
  });
  return kit.done();
}

/** Clipped hedge segment: tileable row unit on a soil strip; topiary-ball ends on variant 1. */
export function buildHedgeUnit(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 3.6 + size * 0.8; const h = 1.3 + size * 0.5; const d = 0.8 + size * 0.25;
  kit.box(M.dirt, w, 0.12, d + 0.3, 0, 0, 0, { cast: false });
  kit.box(F.hedge, w, h, d, 0, 0.06, 0, { collide: true }); // plain box — rounded corners cost ~50x the tris
  for (let sprig = 0; sprig < 4; sprig++) { // unclipped growth softening the box silhouette
    blob(kit, F.hedge, 0.22 + kit.rnd(40 + sprig) * 0.1, (sprig / 3 - 0.5) * (w - 1), h * (0.75 + kit.rnd(20 + sprig) * 0.3), (kit.rnd(30 + sprig) - 0.5) * (d - 0.4), 1);
  }
  if (variant === 1) for (const end of [-1, 1]) blob(kit, F.hedge, 0.42 + size * 0.08, end * (w / 2 - 0.5), h + 0.25, 0, 1);
  return kit.done();
}

/** Landmark tree: a giant wild fig — buttress roots, huge limbs, a canopy that reads from blocks
 *  away. Variant 1 is a flowering coral tree with red blooms through the crown. */
export function buildLandmarkTree(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const trunkH = 3.2 + size * 1.2; const trunkR = 0.8 + size * 0.3; const canopyR = 6.2 + size * 2;
  kit.cyl(F.bark, trunkR * 0.7, trunkR, trunkH, 0, 0, 0, { seg: 8, collide: true });
  for (let root = 0; root < 4; root++) lean(kit, F.bark, 0.09, 0.4, 1.9, root * 1.65 + kit.rnd(4 + root) * 0.7, 1.02, 0, 0, 0);
  for (let limb = 0; limb < 4; limb++) lean(kit, F.bark, 0.14, trunkR * 0.42, canopyR * 0.55, limb * 1.5 + kit.rnd(10 + limb) * 0.9, 0.8, 0, trunkH * 0.8, 0, 6);
  blob(kit, F.leafDark, canopyR * 0.62, 0, trunkH + canopyR * 0.42, 0, 0.7, 1);
  for (let lobe = 0; lobe < 5; lobe++) {
    const a = (lobe / 5) * TAU + kit.rnd(20 + lobe) * 0.9;
    blob(kit, F.leaf, canopyR * (0.3 + kit.rnd(30 + lobe) * 0.12), Math.sin(a) * canopyR * 0.55, trunkH + canopyR * (0.3 + kit.rnd(40 + lobe) * 0.25), Math.cos(a) * canopyR * 0.55, 0.7, 1);
  }
  if (variant === 1) {
    for (let bloomIdx = 0; bloomIdx < 3; bloomIdx++) {
      const a = kit.rnd(50 + bloomIdx) * TAU;
      blob(kit, F.coral, canopyR * 0.18, Math.sin(a) * canopyR * 0.5, trunkH + canopyR * 0.55, Math.cos(a) * canopyR * 0.5, 0.8);
    }
  }
  return kit.done();
}
