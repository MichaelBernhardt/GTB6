import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { loadRoadVehicleLibraries } from './RoadVehicleAssets';
import { loadTaxiLibrary } from './TaxiAsset';

type VehicleLoad = (url: string) => Promise<GLTF>;

/** One startup gate for the complete five-car Blender fleet. */
export async function loadVehicleLibraries(load?: VehicleLoad): Promise<void> {
  await Promise.all([loadRoadVehicleLibraries(load), loadTaxiLibrary(load)]);
}
