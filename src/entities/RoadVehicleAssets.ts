import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { VehicleKind } from '../config';

export const ROAD_VEHICLE_KINDS = ['compact', 'sport', 'van', 'police'] as const;
export type RoadVehicleKind = typeof ROAD_VEHICLE_KINDS[number];

interface RoadVehicleContract {
  url: string;
  root: string;
  size: readonly [number, number, number];
  triangles: readonly [number, number];
  extraNodes?: readonly string[];
  extraMaterials?: readonly string[];
}

const BASE_NODES = [
  'body', 'cabin', 'glass', 'roof', 'grille', 'bumper_front', 'bumper_rear',
  'mirror_left', 'mirror_right', 'headlight_left', 'headlight_right',
  'brakelight_left', 'brakelight_right', 'plate_front', 'plate_rear',
  'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr',
] as const;
const BASE_MATERIALS = [
  'VehiclePaint', 'VehicleGlass', 'VehicleTrim', 'VehicleChrome',
  'VehicleTire', 'VehicleLight', 'VehicleBrake', 'VehiclePlate',
] as const;

export const ROAD_VEHICLE_CONTRACTS: Record<RoadVehicleKind, RoadVehicleContract> = {
  compact: { url: '/models/vehicles/citi-golf.glb', root: 'Car_CitiGolf', size: [1.8, 1.35, 3.7], triangles: [9_000, 30_000] },
  sport: { url: '/models/vehicles/vrrr-phaa-gti.glb', root: 'Car_VrrrPhaaGTI', size: [1.9, 1.15, 4.15], triangles: [9_000, 32_000] },
  van: { url: '/models/vehicles/hilux-bakkie.glb', root: 'Car_HiluxBakkie', size: [2.15, 2.15, 4.9], triangles: [10_000, 34_000], extraNodes: ['bakkie-bed'] },
  police: {
    url: '/models/vehicles/jmpd-interceptor.glb', root: 'Car_JMPDInterceptor', size: [1.95, 1.4, 4.35], triangles: [9_000, 34_000],
    extraNodes: ['lightbar'], extraMaterials: ['VehicleLivery', 'VehicleBlueLight', 'VehicleRedLight'],
  },
};

type RoadVehicleLoad = (url: string) => Promise<GLTF>;
interface RoadVehicleTemplate { root: THREE.Object3D; }
const templates = new Map<RoadVehicleKind, RoadVehicleTemplate>();
let loading: Promise<void> | undefined;
const readyListeners = new Map<RoadVehicleKind, Set<() => void>>(ROAD_VEHICLE_KINDS.map((kind) => [kind, new Set()]));

export class RoadVehicleAssetError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RoadVehicleAssetError'; }
}

export interface RoadVehicleModelInstance {
  root: THREE.Object3D;
  wheels: readonly [THREE.Object3D, THREE.Object3D, THREE.Object3D, THREE.Object3D];
  headLights: readonly [THREE.Mesh, THREE.Mesh];
  brakeLights: readonly [THREE.Mesh, THREE.Mesh];
  cabinParts: readonly [THREE.Object3D];
  sharedGeometries: ReadonlySet<THREE.BufferGeometry>;
  ownedMaterials: ReadonlySet<THREE.Material>;
}

export function isRoadVehicleKind(kind: VehicleKind): kind is RoadVehicleKind {
  return (ROAD_VEHICLE_KINDS as readonly VehicleKind[]).includes(kind);
}

const meshAt = (root: THREE.Object3D, name: string, kind: RoadVehicleKind): THREE.Mesh => {
  const object = root.getObjectByName(name);
  if (!(object instanceof THREE.Mesh)) throw new RoadVehicleAssetError(`${kind} node ${name} must be a mesh.`);
  return object;
};

/** Validate browser-decoded geometry before it is allowed into the shared fleet cache. */
export function validateRoadVehicleGltf(gltf: GLTF, kind: RoadVehicleKind): THREE.Object3D {
  const expected = ROAD_VEHICLE_CONTRACTS[kind]; const root = gltf.scene.getObjectByName(expected.root);
  const contract = root?.userData.vehicleContract as Record<string, unknown> | undefined;
  if (!root || contract?.version !== 1 || contract.kind !== kind || contract.units !== 'metres'
    || contract.forwardAxis !== '+Z' || contract.upAxis !== '+Y' || contract.grounded !== true
    || contract.paintMaterial !== 'VehiclePaint' || contract.sharedGeometry !== true || contract.mutableMaterialsPerInstance !== true) {
    throw new RoadVehicleAssetError(`The Blender ${kind} contract is missing or invalid.`);
  }
  if (JSON.stringify(contract.boundsMetres) !== JSON.stringify(expected.size)
    || JSON.stringify(contract.firstPersonHiddenNodes) !== JSON.stringify(['cabin'])) throw new RoadVehicleAssetError(`The ${kind} bounds or first-person contract is invalid.`);
  for (const name of [...BASE_NODES, ...(expected.extraNodes ?? [])]) if (!root.getObjectByName(name)) throw new RoadVehicleAssetError(`The Blender ${kind} is missing ${name}.`);

  let triangles = 0; const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position'); const normals = object.geometry.getAttribute('normal');
    if (!positions || !normals || normals.count !== positions.count) throw new RoadVehicleAssetError(`${kind}/${object.name} has invalid render geometry.`);
    triangles += (object.geometry.index?.count ?? positions.count) / 3;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial) || material.transparent || material.opacity !== 1 || material.alphaTest > 0 || material.map) {
        throw new RoadVehicleAssetError(`${kind}/${material.name} must be untextured opaque PBR.`);
      }
      materials.add(material);
    }
  });
  if (!Number.isInteger(triangles) || triangles < expected.triangles[0] || triangles > expected.triangles[1]) {
    throw new RoadVehicleAssetError(`${kind} has ${triangles} triangles; expected ${expected.triangles.join('–')}.`);
  }
  const materialNames = [...materials].map((material) => material.name).sort();
  const expectedMaterials = [...BASE_MATERIALS, ...(expected.extraMaterials ?? [])].sort();
  if (JSON.stringify(materialNames) !== JSON.stringify(expectedMaterials)) throw new RoadVehicleAssetError(`The ${kind} material set is invalid.`);

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root); const size = bounds.getSize(new THREE.Vector3()); const center = bounds.getCenter(new THREE.Vector3());
  if (bounds.min.y < -0.02 || bounds.min.y > 0.03 || Math.abs(center.x) > 0.04 || Math.abs(center.z) > 0.04
    || size.toArray().some((value, index) => Math.abs(value - expected.size[index]!) > 0.08)) throw new RoadVehicleAssetError(`The ${kind} scale, grounding, or centred origin is invalid.`);
  const front = root.getObjectByName('headlight_left')!; const rear = root.getObjectByName('brakelight_left')!;
  if (front.getWorldPosition(new THREE.Vector3()).z <= 0 || rear.getWorldPosition(new THREE.Vector3()).z >= 0) throw new RoadVehicleAssetError(`The ${kind} does not face +Z.`);
  return root;
}

/** Test hook for one asset. Installation is transactional: validation completes before cache mutation. */
export function installRoadVehicleLibrary(kind: RoadVehicleKind, gltf: GLTF): void {
  const root = validateRoadVehicleGltf(gltf, kind);
  templates.set(kind, { root });
  for (const listener of [...readyListeners.get(kind)!]) listener();
  readyListeners.get(kind)!.clear();
}

/** Required startup fleet: all four fetches share one retryable operation and install atomically. */
export function loadRoadVehicleLibraries(load: RoadVehicleLoad = (url) => new GLTFLoader().loadAsync(url)): Promise<void> {
  if (ROAD_VEHICLE_KINDS.every((kind) => templates.has(kind))) return Promise.resolve();
  if (loading) return loading;
  loading = Promise.all(ROAD_VEHICLE_KINDS.map(async (kind) => {
    if (templates.has(kind)) return undefined;
    const gltf = await load(ROAD_VEHICLE_CONTRACTS[kind].url);
    return { kind, root: validateRoadVehicleGltf(gltf, kind) };
  })).then((validated) => {
    for (const item of validated) if (item) {
      templates.set(item.kind, { root: item.root });
      for (const listener of [...readyListeners.get(item.kind)!]) listener();
      readyListeners.get(item.kind)!.clear();
    }
  }).catch((reason: unknown) => {
    loading = undefined;
    throw reason instanceof RoadVehicleAssetError ? reason : new RoadVehicleAssetError('The required Blender road-car fleet failed to load.', { cause: reason });
  });
  return loading;
}

export function onRoadVehicleLibraryReady(kind: RoadVehicleKind, listener: () => void): () => void {
  if (templates.has(kind)) { listener(); return () => undefined; }
  readyListeners.get(kind)!.add(listener);
  return () => { readyListeners.get(kind)!.delete(listener); };
}

/** Clone per-car materials and transforms; expensive geometry stays shared across traffic churn. */
export function instantiateRoadVehicleModel(kind: RoadVehicleKind, colour: number): RoadVehicleModelInstance | undefined {
  const template = templates.get(kind); if (!template) return undefined;
  const root = template.root.clone(true); const materialClones = new Map<THREE.Material, THREE.Material>();
  const sharedGeometries = new Set<THREE.BufferGeometry>(); const ownedMaterials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    sharedGeometries.add(object.geometry);
    const clone = (material: THREE.Material): THREE.Material => {
      let copied = materialClones.get(material);
      if (!copied) {
        copied = material.clone();
        if (copied.name === 'VehiclePaint' && 'color' in copied) (copied as THREE.MeshStandardMaterial).color.setHex(colour);
        materialClones.set(material, copied); ownedMaterials.add(copied);
      }
      return copied;
    };
    object.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
    object.castShadow = true; object.receiveShadow = true;
  });
  root.userData.assetSource = 'blender'; root.userData.vehicleKind = kind;
  const object = (name: string): THREE.Object3D => root.getObjectByName(name)!;
  return {
    root,
    wheels: [object('wheel_fl'), object('wheel_fr'), object('wheel_rl'), object('wheel_rr')],
    headLights: [meshAt(root, 'headlight_left', kind), meshAt(root, 'headlight_right', kind)],
    brakeLights: [meshAt(root, 'brakelight_left', kind), meshAt(root, 'brakelight_right', kind)],
    cabinParts: [object('cabin')],
    sharedGeometries,
    ownedMaterials,
  };
}

export function roadVehicleLibraryReady(kind?: RoadVehicleKind): boolean {
  return kind ? templates.has(kind) : ROAD_VEHICLE_KINDS.every((candidate) => templates.has(candidate));
}

export function resetRoadVehicleLibrariesForTests(): void {
  templates.clear(); loading = undefined;
  for (const listeners of readyListeners.values()) listeners.clear();
}
