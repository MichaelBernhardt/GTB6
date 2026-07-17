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
}

/** Lightweight authored-tree placement data. Unlike buildTreeAsset(), this deliberately retains the
 *  library geometry because InstancedMesh owns no disposable per-tree clone. */
export interface TreeInstance {
  variant: number;
  scale: number;
  trunkRadius: number;
  trunkHeight: number;
  parts: readonly TreeInstancePart[];
}

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
      instanceParts.push({
        geometry: object.geometry,
        material: object.material,
        matrix: inverseRoot.clone().multiply(object.matrixWorld),
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
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // City streaming disposes each unmerged source geometry after baking; never dispose the library template.
    object.geometry = object.geometry.clone();
    object.castShadow = true; object.receiveShadow = true;
  });
  const [colliderW, colliderD, colliderH] = record.trunkCollider;
  return {
    group,
    footprint: { w: record.size.x * scale, d: record.size.z * scale },
    tiers: [{ minX: -colliderW * scale / 2, maxX: colliderW * scale / 2, minZ: -colliderD * scale / 2, maxZ: colliderD * scale / 2, y0: 0, y1: colliderH * scale }],
  };
}

/** Test-only reset; production deliberately keeps the required library resident for the session. */
export function resetTreeLibraryForTests(): void { records = undefined; loading = undefined; }
