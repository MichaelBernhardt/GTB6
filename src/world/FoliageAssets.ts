import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { hash, type BuildOptions, type BuiltModel } from './models/kit';

export const TREE_LIBRARY_URL = '/models/foliage/joburg-trees.glb';
export const TREE_SPECIES = ['jacaranda', 'shade-tree', 'gum', 'pine', 'acacia', 'palm', 'landmark-tree'] as const;
export type TreeSpecies = typeof TREE_SPECIES[number];
type TreeLoad = (url: string) => Promise<GLTF>;

interface TreeRecord {
  source: THREE.Object3D;
  size: THREE.Vector3;
  trunkCollider: readonly [number, number, number];
  instanceParts: readonly TreeInstancePart[];
}

/** One reusable mesh below an authored tree root. The matrix is relative to that root, so callers can
 *  combine it with a per-tree placement matrix and keep thousands of trees genuinely instanced. */
export interface TreeInstancePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  matrix: THREE.Matrix4;
  /** True for foliage parts: instanced callers pass the per-tree canopy tint for these (and only these). */
  canopy: boolean;
}

/** The authored foliage materials, by Blender name. Everything else on a tree is wood and stays untinted. */
const CANOPY_MATERIALS = new Set([
  'LeafGreen', 'LeafDark', 'LeafDusty', 'LeafOlive', 'PineNeedles',
  'JacarandaBloom', 'JacarandaDeep', 'CoralBloom', 'PalmFrond', 'PalmDry',
]);

const isCanopyMaterial = (material: THREE.Material | THREE.Material[]): material is THREE.Material =>
  !Array.isArray(material) && CANOPY_MATERIALS.has(material.name);

/** Bakes a vertical light gradient into a canopy part's vertex colours (dark underside, lit crown) —
 *  free depth at zero extra triangles. Runs once per library part; clones inherit and multiply it. */
function bakeCanopyShading(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute('color')) return;
  const position = geometry.getAttribute('position');
  let minY = Infinity; let maxY = -Infinity;
  for (let index = 0; index < position.count; index++) { const y = position.getY(index); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const span = Math.max(maxY - minY, 1e-6);
  const colors = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const shade = 0.72 + 0.28 * ((position.getY(index) - minY) / span);
    colors[index * 3] = colors[index * 3 + 1] = colors[index * 3 + 2] = shade;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Deterministic per-tree canopy tint: a subtle warm/cool + lightness spread around the authored leaf
 *  colour, so an avenue of one species stops reading as copy-paste. Multiplies the baked shading. */
export function canopyTint(seed: number): THREE.Color {
  const warm = hash(seed, 73) - 0.5;
  const light = 0.84 + hash(seed, 74) * 0.2;
  return new THREE.Color(
    Math.max(0, light * (1 + 0.26 * warm)),
    Math.max(0, light * (1 + 0.05 * warm)),
    Math.max(0, light * (1 - 0.2 * warm)),
  );
}

/** Lightweight authored-tree placement data. Unlike buildTreeAsset(), this deliberately retains the
 *  library geometry because InstancedMesh owns no disposable per-tree clone. */
export interface TreeInstance {
  variant: number;
  scale: number;
  trunkRadius: number;
  trunkHeight: number;
  /** True when this trunk is thick enough to be a wall (see SOLID_TRUNK_MIN_DIAMETER). */
  trunkSolid: boolean;
  /** Deterministic canopy tint for this tree: pass as the instance colour of every canopy part. */
  tint: THREE.Color;
  parts: readonly TreeInstancePart[];
}

/**
 * WHERE FOLIAGE STOPS BEING SCENERY.
 *
 * Trunk diameter (metres, as authored) at or above which a tree gets a collider. Half a metre is the
 * line because it is the line a body reads: you brush past a sapling or a shrub, and you do not walk
 * through something you cannot get your arms around. Every species in the library clears it — the
 * slimmest authored trunk is a 0.52 m palm — so the whole authored library is solid wood and the
 * procedural undergrowth (aloe 0.32 m, agave, bougainvillea, veld grass, clipped hedge) stays
 * passable, which is what a hedge should be.
 *
 * Measured on the AUTHORED trunk, deliberately, not on the per-tree ±16% scale jitter: a rule read
 * off the jitter would make two visually identical gums behave differently, and unpredictable
 * collision is worse than none. So the answer is per species-variant and every instance agrees.
 */
export const SOLID_TRUNK_MIN_DIAMETER = 0.5;

/** Whether an authored trunk footprint earns a collider. One rule, so the roadside, park and
 *  scattered tree paths cannot disagree about which trees are solid. */
export const trunkIsSolid = (colliderW: number, colliderD: number): boolean =>
  Math.max(colliderW, colliderD) >= SOLID_TRUNK_MIN_DIAMETER;

export class TreeLibraryError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'TreeLibraryError'; }
}

let records: ReadonlyMap<string, TreeRecord> | undefined;
let loading: Promise<void> | undefined;
const key = (species: TreeSpecies, variant: number): string => `${species}__${variant}`;

function numericTuple(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return undefined;
  return value as number[];
}

/** Validate and install the required Blender tree hierarchy. Invalid libraries never partially install. */
export function installTreeLibrary(gltf: GLTF): void {
  const library = gltf.scene.getObjectByName('JohannesburgTreeLibrary');
  const contract = library?.userData.treeContract as Record<string, unknown> | undefined;
  if (!library || contract?.version !== 1 || contract.units !== 'metres' || contract.upAxis !== '+Y' || contract.grounded !== true) {
    throw new TreeLibraryError('The Blender tree library contract is missing or invalid.');
  }
  const installed = new Map<string, TreeRecord>();
  for (const species of TREE_SPECIES) for (let variant = 0; variant < 2; variant++) {
    const name = key(species, variant); const source = library.children.find((child) => child.name === name);
    const metadata = source?.userData.treeAsset as Record<string, unknown> | undefined;
    const maxFootprint = numericTuple(metadata?.maxFootprint, 2);
    const trunkCollider = numericTuple(metadata?.trunkCollider, 3);
    if (!source || metadata?.species !== species || metadata.variant !== variant || !maxFootprint || !trunkCollider) {
      throw new TreeLibraryError(`The Blender tree library is missing a valid ${name} asset.`);
    }
    if (maxFootprint.some((value) => value <= 0) || trunkCollider.some((value) => value <= 0) || trunkCollider[0]! > 3 || trunkCollider[1]! > 3) {
      throw new TreeLibraryError(`${name} contains invalid footprint or trunk metadata.`);
    }
    let meshCount = 0;
    source.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshCount++;
      if (!object.geometry.getAttribute('position') || !object.geometry.getAttribute('normal')) {
        throw new TreeLibraryError(`${name} contains incomplete mesh geometry.`);
      }
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial) || material.transparent || material.opacity !== 1) {
          throw new TreeLibraryError(`${name} must use opaque PBR materials.`);
        }
      }
    });
    if (meshCount === 0) throw new TreeLibraryError(`${name} contains no meshes.`);
    const bounds = new THREE.Box3().setFromObject(source); const size = bounds.getSize(new THREE.Vector3());
    if (Math.abs(bounds.min.x + bounds.max.x) > 0.08 || Math.abs(bounds.min.z + bounds.max.z) > 0.08 || bounds.min.y < -0.02 || bounds.min.y > 0.08) {
      throw new TreeLibraryError(`${name} is not centred and grounded.`);
    }
    if (size.x > maxFootprint[0] || size.z > maxFootprint[1] || size.y < 4 || trunkCollider[2]! > size.y) {
      throw new TreeLibraryError(`${name} exceeds its footprint or has an invalid height.`);
    }
    source.updateWorldMatrix(true, true);
    const inverseRoot = source.matrixWorld.clone().invert();
    const instanceParts: TreeInstancePart[] = [];
    source.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const canopy = isCanopyMaterial(object.material);
      if (canopy) {
        // Shared library material + shared geometry: bake the shading once, switch the material to
        // vertex colours once. Instanced trees multiply their tint in via instanceColor; cloned trees
        // (parks, scatter) multiply theirs into the cloned attribute (see buildTreeAsset).
        bakeCanopyShading(object.geometry as THREE.BufferGeometry);
        (object.material as THREE.MeshStandardMaterial).vertexColors = true;
        (object.material as THREE.MeshStandardMaterial).needsUpdate = true;
      }
      instanceParts.push({
        geometry: object.geometry,
        material: object.material,
        matrix: inverseRoot.clone().multiply(object.matrixWorld),
        canopy,
      });
    });
    installed.set(name, { source, size, trunkCollider: trunkCollider as [number, number, number], instanceParts });
  }
  if (library.children.length !== installed.size) throw new TreeLibraryError('The Blender tree library contains unexpected root assets.');
  records = installed;
}

/** Load the required tree library exactly once. Rejection is deliberate: there is no procedural fallback. */
export function loadTreeLibrary(load: TreeLoad = (url) => new GLTFLoader().loadAsync(url)): Promise<void> {
  if (records) return Promise.resolve();
  if (loading) return loading;
  loading = load(TREE_LIBRARY_URL).then(installTreeLibrary).catch((reason: unknown) => {
    throw reason instanceof TreeLibraryError ? reason : new TreeLibraryError('Unable to load the required Blender tree library.', { cause: reason });
  }).finally(() => { loading = undefined; });
  return loading;
}

function resolveTree(species: TreeSpecies, seed: number, options: BuildOptions): { record: TreeRecord; variant: number; scale: number } {
  if (!records) throw new TreeLibraryError('The required Blender tree library has not been loaded.');
  const variant = Math.abs(Math.trunc(options.variant ?? Math.floor(hash(seed, 71) * 2))) % 2;
  const record = records.get(key(species, variant));
  if (!record) throw new TreeLibraryError(`The required ${key(species, variant)} tree asset is unavailable.`);
  const size = THREE.MathUtils.clamp(options.size ?? hash(seed, 72), 0, 1);
  return { record, variant, scale: 0.84 + size * 0.16 };
}

/** Resolve reusable source geometry plus deterministic scale/collider data for an InstancedMesh placement. */
export function buildTreeInstance(species: TreeSpecies, seed: number, options: BuildOptions = {}): TreeInstance {
  const { record, variant, scale } = resolveTree(species, seed, options);
  const [colliderW, colliderD, colliderH] = record.trunkCollider;
  return {
    variant,
    scale,
    trunkRadius: Math.max(colliderW, colliderD) * scale / 2,
    trunkHeight: colliderH * scale,
    trunkSolid: trunkIsSolid(colliderW, colliderD),
    tint: canopyTint(seed),
    parts: record.instanceParts,
  };
}

/** Clone one Blender-authored variant with deterministic scale variation and disposable geometry. */
export function buildTreeAsset(species: TreeSpecies, seed: number, options: BuildOptions = {}): BuiltModel {
  const { record, variant, scale } = resolveTree(species, seed, options);
  const group = record.source.clone(true) as THREE.Group;
  group.name = `${key(species, variant)}__instance`;
  group.userData.assetSource = 'blender'; group.userData.treeSpecies = species; group.userData.treeVariant = variant;
  group.scale.multiplyScalar(scale);
  const tint = canopyTint(seed);
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // City streaming disposes each unmerged source geometry after baking; never dispose the library template.
    object.geometry = object.geometry.clone();
    if (isCanopyMaterial(object.material)) {
      // The clone inherits the baked shading; multiply this tree's tint in so merged park and
      // scattered trees vary exactly like their instanced roadside siblings.
      const color = object.geometry.getAttribute('color');
      for (let index = 0; index < color.count; index++) {
        color.setXYZ(index, color.getX(index) * tint.r, color.getY(index) * tint.g, color.getZ(index) * tint.b);
      }
    }
    object.castShadow = true; object.receiveShadow = true;
  });
  const [colliderW, colliderD, colliderH] = record.trunkCollider;
  // A trunk under SOLID_TRUNK_MIN_DIAMETER declares no tier at all, so nothing downstream has to
  // re-derive the rule: no tier means walk on through.
  const trunk = { minX: -colliderW * scale / 2, maxX: colliderW * scale / 2, minZ: -colliderD * scale / 2, maxZ: colliderD * scale / 2, y0: 0, y1: colliderH * scale };
  return {
    group,
    footprint: { w: record.size.x * scale, d: record.size.z * scale },
    tiers: trunkIsSolid(colliderW, colliderD) ? [trunk] : [],
  };
}

/** Test-only reset; production deliberately keeps the required library resident for the session. */
export function resetTreeLibraryForTests(): void { records = undefined; loading = undefined; }
