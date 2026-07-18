import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instantiateRoadVehicleModel, installRoadVehicleLibrary, loadRoadVehicleLibraries,
  resetRoadVehicleLibrariesForTests, ROAD_VEHICLE_CONTRACTS, ROAD_VEHICLE_KINDS,
  roadVehicleLibraryReady, validateRoadVehicleGltf, type RoadVehicleKind,
} from './RoadVehicleAssets';
import { Vehicle } from './Vehicle';

const actualRoadCar = async (kind: RoadVehicleKind): Promise<GLTF> => {
  const file = await readFile(`public${ROAD_VEHICLE_CONTRACTS[kind].url}`);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new GLTFLoader().parseAsync(buffer, '/models/vehicles/');
};

afterEach(() => { resetRoadVehicleLibrariesForTests(); THREE.Cache.clear(); });

describe('required Blender road-car fleet', () => {
  it('validates every hierarchy, render contract, orientation, and gameplay footprint', async () => {
    for (const kind of ROAD_VEHICLE_KINDS) {
      const root = validateRoadVehicleGltf(await actualRoadCar(kind), kind);
      expect(root.name).toBe(ROAD_VEHICLE_CONTRACTS[kind].root);
      expect(root.getObjectByName('wheel_fl')).toBeDefined();
      expect(new THREE.Box3().setFromObject(root).min.y).toBeCloseTo(0, 2);
    }
  });

  it('fetches the catalog once for concurrent callers, installs atomically, and retries failures', async () => {
    const byUrl = new Map(ROAD_VEHICLE_KINDS.map((kind) => [ROAD_VEHICLE_CONTRACTS[kind].url, kind]));
    const load = vi.fn(async (url: string) => actualRoadCar(byUrl.get(url)!));
    await Promise.all([loadRoadVehicleLibraries(load), loadRoadVehicleLibraries(load)]);
    expect(load).toHaveBeenCalledTimes(4); expect(roadVehicleLibraryReady()).toBe(true);

    resetRoadVehicleLibrariesForTests();
    await expect(loadRoadVehicleLibraries(async () => { throw new Error('offline'); })).rejects.toThrow('road-car fleet');
    expect(roadVehicleLibraryReady()).toBe(false);
    await loadRoadVehicleLibraries(load); expect(roadVehicleLibraryReady()).toBe(true);
  });

  it('shares geometry, clones mutable materials, and applies independent paint colours', async () => {
    installRoadVehicleLibrary('compact', await actualRoadCar('compact'));
    const first = instantiateRoadVehicleModel('compact', 0x112233)!; const second = instantiateRoadVehicleModel('compact', 0xd4a229)!;
    const firstBody = first.root.getObjectByName('body') as THREE.Mesh; const secondBody = second.root.getObjectByName('body') as THREE.Mesh;
    expect(firstBody.geometry).toBe(secondBody.geometry); expect(firstBody.material).not.toBe(secondBody.material);
    expect((firstBody.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x112233);
    expect((secondBody.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xd4a229);
  });

  it('swaps a pre-load placeholder and does not dispose shared geometry on despawn', async () => {
    const car = new Vehicle(new THREE.Scene(), 'sport', new THREE.Vector3());
    expect(car.group.getObjectByName('road-car-loading-placeholder')).toBeDefined();
    installRoadVehicleLibrary('sport', await actualRoadCar('sport'));
    expect(car.group.getObjectByName('road-car-loading-placeholder')).toBeUndefined();
    const geometry = (car.group.getObjectByName('body') as THREE.Mesh).geometry; const dispose = vi.spyOn(geometry, 'dispose');
    car.dispose(); expect(dispose).not.toHaveBeenCalled();
  });

  it('rejects incomplete assets without partially installing them', async () => {
    const gltf = await actualRoadCar('police'); gltf.scene.getObjectByName('lightbar')?.removeFromParent();
    expect(() => installRoadVehicleLibrary('police', gltf)).toThrow('lightbar');
    expect(roadVehicleLibraryReady('police')).toBe(false);
  });
});
