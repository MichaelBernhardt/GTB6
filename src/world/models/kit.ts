/**
 * Shared toolkit for the structure-model library (src/world/models/*).
 *
 * Every model is a pure function of (seed, options): primitive THREE geometry grouped at a local
 * origin (ground plane y=0, street-facing front toward +z), a declared honest footprint, and
 * axis-aligned collider tiers in the same local MassingTier convention BuildingArchitecture uses —
 * City.tierToWorldCollider can transform them under any quarter-snapped heading unchanged.
 *
 * Materials are module-level singletons (or cached by colour) so the per-material GeometryBaker
 * merge collapses a whole cell of models into a handful of draw calls. Canvas textures are guarded
 * for DOM-less test runs: in node the materials fall back to plain colours.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { MassingTier } from '../BuildingArchitecture';
import { createSignMesh } from '../ProceduralMaterials';

export type ModelCategory = 'rural' | 'commercial' | 'industrial' | 'coastal' | 'residential' | 'civic';

export interface BuiltModel {
  /** Meshes in model-local space: origin at footprint centre, ground at y=0, front faces +z. */
  group: THREE.Group;
  /** Honest XZ bounds — everything the builder added fits inside w×d centred on the origin. */
  footprint: { w: number; d: number };
  /** Local-space collider boxes; the placement pass maps them through tierToWorldCollider. */
  tiers: MassingTier[];
}

export interface BuildOptions {
  /** Massing/dressing variant; defaults to a seeded pick over the model's variant count. */
  variant?: number;
  /** 0..1 lerp across the model's size range; defaults to a seeded value. */
  size?: number;
}

export type ModelBuilder = (seed: number, options?: BuildOptions) => BuiltModel;

export interface ModelDef {
  name: string;
  category: ModelCategory;
  /** Placement-affinity tags (a model may suit several zones). */
  zones: string[];
  variants: number;
  /** Upper bound on the footprint any (seed, options) build can return. */
  maxFootprint: { w: number; d: number };
  /** True when at least one collider tier tops out on a walkable roof/platform. */
  standable: boolean;
  /** Tall/unique silhouettes the placement pass should spread out as landmarks. */
  landmark?: boolean;
  /** Suggested minimum centre-to-centre spacing between instances of this model. */
  spacing: number;
  build: ModelBuilder;
}

/** Deterministic hash in [0,1): same (seed, salt) always yields the same value. */
export const hash = (seed: number, salt: number): number => {
  const value = Math.sin(seed * 127.1 + salt * 311.7 + 74.7) * 43758.5453;
  return value - Math.floor(value);
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ---- Shared materials -------------------------------------------------------------------------

const painted = new Map<string, THREE.MeshStandardMaterial>();

/** Cached flat-colour material — one instance per (colour, roughness, metalness) so merges stay fat. */
export function paint(color: number, roughness = 0.85, metalness = 0): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let material = painted.get(key);
  if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness, metalness }); painted.set(key, material); }
  return material;
}

let corrugationMap: THREE.CanvasTexture | undefined;
/** Vertical ridge-shading stripes shared by every corrugated-iron material (undefined in node). */
function corrugation(): THREE.CanvasTexture | undefined {
  if (typeof document === 'undefined') return undefined;
  if (corrugationMap) return corrugationMap;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d'); if (!context) return undefined;
  for (let x = 0; x < 64; x += 8) {
    const ramp = context.createLinearGradient(x, 0, x + 8, 0);
    ramp.addColorStop(0, '#9a9a9a'); ramp.addColorStop(0.4, '#f2f2f2'); ramp.addColorStop(1, '#8d8d8d');
    context.fillStyle = ramp; context.fillRect(x, 0, 8, 64);
  }
  corrugationMap = new THREE.CanvasTexture(canvas);
  corrugationMap.wrapS = corrugationMap.wrapT = THREE.RepeatWrapping; corrugationMap.repeat.set(2, 2);
  return corrugationMap;
}

let brickMap: THREE.CanvasTexture | undefined;
/** Running-bond mortar courses shared by every brick material (undefined in node). */
function brickCourses(): THREE.CanvasTexture | undefined {
  if (typeof document === 'undefined') return undefined;
  if (brickMap) return brickMap;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d'); if (!context) return undefined;
  context.fillStyle = '#e8e0d4'; context.fillRect(0, 0, 128, 128);
  for (let row = 0; row < 16; row++) {
    for (let column = -1; column < 4; column++) {
      const x = column * 40 + (row % 2 ? 20 : 0);
      const shade = 215 + Math.floor(hash(row * 7 + column, 3) * 40);
      context.fillStyle = `rgb(${shade}, ${shade - 8}, ${shade - 18})`;
      context.fillRect(x + 2, row * 8 + 1.5, 36, 5.5);
    }
  }
  brickMap = new THREE.CanvasTexture(canvas);
  brickMap.wrapS = brickMap.wrapT = THREE.RepeatWrapping; brickMap.repeat.set(3, 3);
  return brickMap;
}

const textured = new Map<string, THREE.MeshStandardMaterial>();
function texturedMaterial(kind: 'corr' | 'brick', color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  const key = `${kind}|${color}`;
  let material = textured.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness, metalness, map: kind === 'corr' ? corrugation() : brickCourses() });
    textured.set(key, material);
  }
  return material;
}

/** Corrugated-iron sheeting tinted per colour; all instances share one stripe texture. */
export const corrugated = (color: number): THREE.MeshStandardMaterial => texturedMaterial('corr', color, 0.55, 0.38);
/** Face-brick walling tinted per colour; all instances share one course texture. */
export const brick = (color: number): THREE.MeshStandardMaterial => texturedMaterial('brick', color, 0.9, 0);

/** The named palette every model file draws from — fixed instances so material merges span models. */
export const M = {
  plaster: paint(0xe8e2d2, 0.9),
  whitewash: paint(0xf2efe6, 0.88),
  cream: paint(0xe6d9b4, 0.9),
  tan: paint(0xcdb894, 0.9),
  concrete: paint(0xb0aea3, 0.92),
  paving: paint(0x9c9d96, 0.9),
  tar: paint(0x2c3134, 0.95),
  dirt: paint(0xa08a58, 0.98),
  grassDry: paint(0x8a7b45, 0.97),
  faceBrick: brick(0xa05c3e),
  redBrick: brick(0x8a4634),
  galv: corrugated(0xc6cbcd),
  corrRust: corrugated(0x96683f),
  corrGreen: corrugated(0x49664f),
  corrRed: corrugated(0x8e4036),
  corrCharcoal: corrugated(0x4a5054),
  corrBlue: corrugated(0x3f5a74),
  tileCharcoal: paint(0x474d50, 0.8),
  tileTerracotta: paint(0xa14b36, 0.82),
  timber: paint(0x7a5236, 0.85),
  darkTimber: paint(0x54382a, 0.85),
  bleached: paint(0xbfae94, 0.8),
  thatch: paint(0x8a7648, 1),
  steel: paint(0x8b9498, 0.45, 0.6),
  darkMetal: paint(0x2c3538, 0.35, 0.7),
  whiteMetal: paint(0xe6e8e6, 0.4, 0.5),
  jojo: paint(0x3f5c46, 0.75),
  pool: paint(0x2f8fb8, 0.2, 0.1),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x35606c, roughness: 0.14, metalness: 0.2, clearcoat: 0.7 }),
  glassDark: new THREE.MeshPhysicalMaterial({ color: 0x22333a, roughness: 0.2, metalness: 0.25, clearcoat: 0.5 }),
};

// ---- Roof geometry ----------------------------------------------------------------------------

/** Simple box-projected UVs so striped roof materials shade believably on custom prisms. */
function roofUvs(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    uv[index * 2] = (position.getX(index) + position.getZ(index)) * 0.25;
    uv[index * 2 + 1] = (position.getZ(index) + position.getY(index)) * 0.25;
  }
  return uv;
}

/** Classic gable prism (ridge along x, base at y=0) with closed vertical ends. */
export function gableGeometry(width: number, depth: number, rise: number): THREE.BufferGeometry {
  const halfW = width / 2; const halfD = depth / 2;
  const vertices = [
    -halfW, 0, -halfD, halfW, 0, -halfD, 0, rise, -halfD,
    -halfW, 0, halfD, halfW, 0, halfD, 0, rise, halfD,
  ];
  const indices = [0, 1, 2, 3, 5, 4, 0, 2, 5, 0, 5, 3, 2, 1, 4, 2, 4, 5, 1, 0, 3, 1, 3, 4];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(roofUvs(geometry.getAttribute('position')), 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** Hip roof (ridge of `ridge` length along x, base at y=0). ridge≈0 gives a pyramid. Every face
 *  slopes upward, so triangles are auto-oriented by the y sign of their normal — no winding math. */
export function hipGeometry(width: number, depth: number, rise: number, ridge: number): THREE.BufferGeometry {
  const halfW = width / 2; const halfD = depth / 2; const halfR = Math.min(ridge, width * 0.9) / 2;
  const v: number[][] = [
    [-halfW, 0, -halfD], [halfW, 0, -halfD], [halfW, 0, halfD], [-halfW, 0, halfD],
    [-halfR, rise, 0], [halfR, rise, 0],
  ];
  const faces = [[0, 1, 5, 4], [2, 3, 4, 5], [1, 2, 5], [3, 0, 4]];
  const position: number[] = [];
  for (const face of faces) {
    for (let index = 1; index + 1 < face.length; index++) {
      const a = v[face[0]!]!; const b = v[face[index]!]!; const c = v[face[index + 1]!]!;
      const ny = (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!);
      for (const vertex of ny >= 0 ? [a, b, c] : [a, c, b]) position.push(vertex[0]!, vertex[1]!, vertex[2]!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(roofUvs(geometry.getAttribute('position')), 2));
  geometry.computeVertexNormals();
  return geometry;
}

// ---- Kit --------------------------------------------------------------------------------------

interface MeshOptions {
  ry?: number; rx?: number; rz?: number;
  /** Register the mesh's (y-rotation-expanded) AABB as a collider tier. */
  collide?: boolean;
  /** RoundedBoxGeometry corner radius (boxes only). */
  rounded?: number;
  cast?: boolean; receive?: boolean;
}

/** Per-build accumulator: seeded randomness, mesh helpers that share palette materials, and the
 *  collider-tier list. One Kit per builder call; finish with done(w, d). */
export class Kit {
  readonly group = new THREE.Group();
  readonly tiers: MassingTier[] = [];

  constructor(private readonly seed: number) {}

  rnd(salt: number): number { return hash(this.seed, salt); }
  range(salt: number, min: number, max: number): number { return lerp(min, max, this.rnd(salt)); }
  int(salt: number, min: number, max: number): number { return min + Math.floor(this.rnd(salt) * (max - min + 1)) % (max - min + 1); }
  pick<T>(salt: number, items: readonly T[]): T { return items[Math.floor(this.rnd(salt) * items.length) % items.length]!; }

  add<T extends THREE.Object3D>(object: T): T { this.group.add(object); return object; }

  /** Explicit collider tier (for volumes approximated by several meshes, e.g. fence runs). */
  tier(minX: number, maxX: number, minZ: number, maxZ: number, y0: number, y1: number): void {
    this.tiers.push({ minX, maxX, minZ, maxZ, y0, y1 });
  }

  private place(mesh: THREE.Mesh, x: number, y: number, z: number, options: MeshOptions): THREE.Mesh {
    mesh.position.set(x, y, z);
    if (options.rx) mesh.rotation.x = options.rx;
    if (options.ry) mesh.rotation.y = options.ry;
    if (options.rz) mesh.rotation.z = options.rz;
    mesh.castShadow = options.cast ?? true; mesh.receiveShadow = options.receive ?? true;
    return this.add(mesh);
  }

  /** Box with its base at baseY. collide expands the footprint by |cos/sin| of ry (quarter turns exact). */
  box(material: THREE.Material | THREE.Material[], w: number, h: number, d: number, x: number, baseY: number, z: number, options: MeshOptions = {}): THREE.Mesh {
    const geometry = options.rounded
      ? new RoundedBoxGeometry(w, h, d, 3, Math.min(options.rounded, w / 3, h / 3, d / 3))
      : new THREE.BoxGeometry(w, h, d);
    if (options.collide) {
      const c = Math.abs(Math.cos(options.ry ?? 0)); const s = Math.abs(Math.sin(options.ry ?? 0));
      const nx = (w / 2) * c + (d / 2) * s; const nz = (w / 2) * s + (d / 2) * c;
      this.tier(x - nx, x + nx, z - nz, z + nz, baseY, baseY + h);
    }
    return this.place(new THREE.Mesh(geometry, material), x, baseY + h / 2, z, options);
  }

  /** Vertical cylinder with its base at baseY (or tilted via rx/rz; tilted cylinders never collide). */
  cyl(material: THREE.Material, rTop: number, rBottom: number, h: number, x: number, baseY: number, z: number, options: MeshOptions & { seg?: number } = {}): THREE.Mesh {
    const radius = Math.max(rTop, rBottom);
    if (options.collide && !options.rx && !options.rz) this.tier(x - radius, x + radius, z - radius, z + radius, baseY, baseY + h);
    return this.place(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, options.seg ?? 14), material), x, baseY + h / 2, z, options);
  }

  /** Gable roof sitting on the eaves plane at y (ridge along x unless ry rotates it). */
  gable(material: THREE.Material, w: number, d: number, rise: number, x: number, y: number, z: number, options: MeshOptions = {}): THREE.Mesh {
    return this.place(new THREE.Mesh(gableGeometry(w, d, rise), material), x, y, z, options);
  }

  /** Hip roof (ridgeRatio scales the ridge length; 0 = pyramid) on the eaves plane at y. */
  hip(material: THREE.Material, w: number, d: number, rise: number, x: number, y: number, z: number, ridgeRatio = 0.45, options: MeshOptions = {}): THREE.Mesh {
    return this.place(new THREE.Mesh(hipGeometry(w, d, rise, w * ridgeRatio), material), x, y, z, options);
  }

  /** Canvas-atlas sign quad (node-safe: falls back to a plain dark plane without a DOM). */
  sign(text: string, accent: string, w: number, h: number, x: number, y: number, z: number, options: { ry?: number; background?: string; doubleSide?: boolean } = {}): THREE.Mesh {
    const mesh = createSignMesh(new THREE.PlaneGeometry(w, h), text, accent, { background: options.background, doubleSide: options.doubleSide });
    mesh.position.set(x, y, z); if (options.ry) mesh.rotation.y = options.ry;
    return this.add(mesh);
  }

  /** Measure the built group, recentre it (and the tiers) on the XZ origin, and return the exact
   *  footprint (+padding per side). Builders never hand-book footprints, so they cannot lie; the
   *  catalog's maxFootprint stays the declared upper bound the tests verify per seed. */
  done(padding = 0): BuiltModel {
    const bounds = new THREE.Box3().setFromObject(this.group);
    for (const tier of this.tiers) { // collider boxes can outreach faceted meshes (cylinder tiers) — footprint honours both
      bounds.min.x = Math.min(bounds.min.x, tier.minX); bounds.max.x = Math.max(bounds.max.x, tier.maxX);
      bounds.min.z = Math.min(bounds.min.z, tier.minZ); bounds.max.z = Math.max(bounds.max.z, tier.maxZ);
    }
    const cx = (bounds.min.x + bounds.max.x) / 2; const cz = (bounds.min.z + bounds.max.z) / 2;
    for (const child of this.group.children) { child.position.x -= cx; child.position.z -= cz; }
    for (const tier of this.tiers) { tier.minX -= cx; tier.maxX -= cx; tier.minZ -= cz; tier.maxZ -= cz; }
    return {
      group: this.group,
      footprint: { w: bounds.max.x - bounds.min.x + padding * 2, d: bounds.max.z - bounds.min.z + padding * 2 },
      tiers: this.tiers,
    };
  }
}
