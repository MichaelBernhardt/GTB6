import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export const TAXI_MODEL_URL = '/models/vehicles/quantum-express.glb';
const TRIANGLE_RANGE = [12_000, 25_000] as const;
const REQUIRED_NODES = [
  'body', 'cabin', 'glass', 'roof', 'grille', 'bumper_front', 'bumper_rear',
  'mirror_left', 'mirror_right', 'headlight_left', 'headlight_right',
  'brakelight_left', 'brakelight_right', 'plate_front', 'plate_rear',
  'livery_left', 'livery_right', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr',
] as const;
const REQUIRED_MATERIALS = [
  'TaxiBody', 'TaxiLivery', 'TaxiGlass', 'TaxiTrim', 'TaxiChrome',
  'TaxiTire', 'TaxiLight', 'TaxiBrake', 'TaxiPlate',
] as const;
type TaxiLoad = (url: string) => Promise<GLTF>;

export class TaxiAssetError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'TaxiAssetError'; }
}

interface TaxiTemplate { root: THREE.Object3D; }
let template: TaxiTemplate | undefined;
let loading: Promise<void> | undefined;
const readyListeners = new Set<() => void>();

export interface TaxiModelInstance {
  root: THREE.Object3D;
  wheels: readonly [THREE.Object3D, THREE.Object3D, THREE.Object3D, THREE.Object3D];
  headLights: readonly [THREE.Mesh, THREE.Mesh];
  brakeLights: readonly [THREE.Mesh, THREE.Mesh];
  cabinParts: readonly [THREE.Object3D];
  sharedGeometries: ReadonlySet<THREE.BufferGeometry>;
  ownedMaterials: ReadonlySet<THREE.Material>;
}

const meshAt = (root: THREE.Object3D, name: string): THREE.Mesh => {
  const object = root.getObjectByName(name);
  if (!(object instanceof THREE.Mesh)) throw new TaxiAssetError(`Taxi node ${name} must be a mesh.`);
  return object;
};

/** Validate the browser-loaded GLB before it can enter the shared instance cache. */
export function validateTaxiGltf(gltf: GLTF): THREE.Object3D {
  const root = gltf.scene.getObjectByName('Taxi_QuantumExpress');
  const contract = root?.userData.taxiContract as Record<string, unknown> | undefined;
  if (!root || contract?.version !== 1 || contract.units !== 'metres' || contract.forwardAxis !== '+Z' || contract.upAxis !== '+Y' || contract.grounded !== true
    || contract.textureSize !== 2048 || contract.sharedGeometry !== true || contract.mutableMaterialsPerInstance !== true) {
    throw new TaxiAssetError('The Blender taxi contract is missing or invalid.');
  }
  if (!Array.isArray(contract.boundsMetres) || contract.boundsMetres.length !== 3 || contract.boundsMetres.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new TaxiAssetError('The taxi bounds metadata is invalid.');
  for (const name of REQUIRED_NODES) if (!root.getObjectByName(name)) throw new TaxiAssetError(`The Blender taxi is missing ${name}.`);
  const hidden = contract.firstPersonHiddenNodes;
  if (!Array.isArray(hidden) || hidden.length !== 1 || hidden[0] !== 'cabin') throw new TaxiAssetError('The taxi first-person hierarchy is invalid.');

  let triangles = 0; const materials = new Set<THREE.Material>(); const textureImages = new Set<unknown>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position'); const normals = object.geometry.getAttribute('normal');
    if (!positions || !normals || normals.count !== positions.count) throw new TaxiAssetError(`${object.name} has invalid render geometry.`);
    triangles += (object.geometry.index?.count ?? positions.count) / 3;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial) || material.transparent || material.opacity !== 1 || material.alphaTest > 0) throw new TaxiAssetError(`${material.name} must be opaque PBR.`);
      materials.add(material); if (material.map) textureImages.add(material.map.image);
    }
  });
  if (!Number.isInteger(triangles) || triangles < TRIANGLE_RANGE[0] || triangles > TRIANGLE_RANGE[1]) throw new TaxiAssetError(`Taxi has ${triangles} triangles; expected ${TRIANGLE_RANGE.join('–')}.`);
  const names = [...materials].map((material) => material.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...REQUIRED_MATERIALS].sort())) throw new TaxiAssetError('The taxi material set is invalid.');
  if (textureImages.size !== 1) throw new TaxiAssetError('The taxi must use one shared base-colour image.');
  const image = [...textureImages][0] as { width?: number; height?: number } | undefined;
  if (!image || image.width !== 2048 || image.height !== 2048) throw new TaxiAssetError('The taxi base-colour texture must be 2048x2048.');

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root); const size = bounds.getSize(new THREE.Vector3()); const center = bounds.getCenter(new THREE.Vector3());
  if (bounds.min.y < -0.02 || bounds.min.y > 0.03 || Math.abs(center.x) > 0.04 || Math.abs(center.z) > 0.09
    || size.x < 2 || size.x > 2.5 || size.y < 2.2 || size.y > 2.4 || size.z < 5 || size.z > 5.35) throw new TaxiAssetError('The taxi scale, grounding, or centred origin is invalid.');
  const front = root.getObjectByName('headlight_left')!; const rear = root.getObjectByName('brakelight_left')!;
  if (front.getWorldPosition(new THREE.Vector3()).z <= 0 || rear.getWorldPosition(new THREE.Vector3()).z >= 0) throw new TaxiAssetError('The taxi does not face +Z.');
  return root;
}

/** Test and startup hook: install only after the entire hierarchy has passed validation. */
export function installTaxiLibrary(gltf: GLTF): void {
  const root = validateTaxiGltf(gltf);
  template = { root };
  for (const listener of [...readyListeners]) listener();
  readyListeners.clear();
}

/** Required startup asset: concurrent callers share one fetch; a failure clears only the pending cache so Retry can load again. */
export function loadTaxiLibrary(load: TaxiLoad = (url) => new GLTFLoader().loadAsync(url)): Promise<void> {
  if (template) return Promise.resolve();
  if (loading) return loading;
  loading = Promise.resolve().then(() => load(TAXI_MODEL_URL)).then((gltf) => { installTaxiLibrary(gltf); }).catch((reason: unknown) => {
    loading = undefined;
    throw reason instanceof TaxiAssetError ? reason : new TaxiAssetError('The required taxi model failed to load.', { cause: reason });
  });
  return loading;
}

/** Vehicles restored before the startup gate keep a neutral placeholder and swap as soon as the cache installs. */
export function onTaxiLibraryReady(listener: () => void): () => void {
  if (template) { listener(); return () => undefined; }
  readyListeners.add(listener);
  return () => { readyListeners.delete(listener); };
}

/** Clone transforms and per-taxi materials while keeping geometry and texture objects immutable/shared. */
export function instantiateTaxiModel(): TaxiModelInstance | undefined {
  if (!template) return undefined;
  const root = template.root.clone(true); const materialClones = new Map<THREE.Material, THREE.Material>();
  const sharedGeometries = new Set<THREE.BufferGeometry>(); const ownedMaterials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    sharedGeometries.add(object.geometry);
    const clone = (material: THREE.Material): THREE.Material => {
      let copied = materialClones.get(material);
      if (!copied) { copied = material.clone(); materialClones.set(material, copied); ownedMaterials.add(copied); }
      return copied;
    };
    object.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
    object.castShadow = true; object.receiveShadow = true;
  });
  root.userData.assetSource = 'blender';
  const object = (name: string): THREE.Object3D => root.getObjectByName(name)!;
  return {
    root,
    wheels: [object('wheel_fl'), object('wheel_fr'), object('wheel_rl'), object('wheel_rr')],
    headLights: [meshAt(root, 'headlight_left'), meshAt(root, 'headlight_right')],
    brakeLights: [meshAt(root, 'brakelight_left'), meshAt(root, 'brakelight_right')],
    cabinParts: [object('cabin')],
    sharedGeometries,
    ownedMaterials,
  };
}

export function taxiLibraryReady(): boolean { return template !== undefined; }

/** Test-only reset. Production keeps the immutable GLB resident for the whole session. */
export function resetTaxiLibraryForTests(): void { template = undefined; loading = undefined; readyListeners.clear(); }
