import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InputManager } from '../core/InputManager';
import type { City } from '../world/City';
import {
  instantiateTaxiModel, installTaxiLibrary, loadTaxiLibrary, resetTaxiLibraryForTests,
  TAXI_MODEL_URL, taxiLibraryReady, validateTaxiGltf,
} from './TaxiAsset';
import { Vehicle } from './Vehicle';

class FakeImage {
  width = 2048; height = 2048;
  private listeners = new Map<string, () => void>();
  addEventListener(name: string, callback: () => void): void { this.listeners.set(name, callback); }
  removeEventListener(): void { /* loader cleanup */ }
  set src(_value: string) { queueMicrotask(() => this.listeners.get('load')?.call(this)); }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { createElementNS: () => new FakeImage() }, configurable: true });
});
afterEach(() => { resetTaxiLibraryForTests(); THREE.Cache.clear(); });

async function actualTaxi(): Promise<GLTF> {
  const file = await readFile('public/models/vehicles/quantum-express.glb');
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new GLTFLoader().parseAsync(buffer, '/models/vehicles/');
}
const material = (root: THREE.Object3D, name: string): THREE.MeshStandardMaterial => (root.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial;
const flatCity = {
  clampMove: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone(),
  roadHeightAt: () => 0,
  surfaceNormalAt: () => new THREE.Vector3(0, 1, 0),
  props: undefined,
} as unknown as City;

describe('required Blender taxi asset', () => {
  it('validates the hierarchy, render contract, scale, texture, and triangle budget', async () => {
    const gltf = await actualTaxi(); const root = validateTaxiGltf(gltf);
    expect(root.name).toBe('Taxi_QuantumExpress'); expect(root.getObjectByName('wheel_fl')).toBeDefined();
    expect(new THREE.Box3().setFromObject(root).min.y).toBeCloseTo(0, 2);
  });

  it('fetches once for concurrent callers and retries after a failed required load', async () => {
    const gltf = await actualTaxi(); const load = vi.fn(async (url: string) => { expect(url).toBe(TAXI_MODEL_URL); return gltf; });
    await Promise.all([loadTaxiLibrary(load), loadTaxiLibrary(load)]);
    expect(load).toHaveBeenCalledTimes(1); expect(taxiLibraryReady()).toBe(true);
    resetTaxiLibraryForTests();
    await expect(loadTaxiLibrary(async () => { throw new Error('offline'); })).rejects.toThrow('required taxi model');
    await loadTaxiLibrary(async () => actualTaxi()); expect(taxiLibraryReady()).toBe(true);
  });

  it('shares immutable geometry and texture images while cloning mutable materials per taxi', async () => {
    installTaxiLibrary(await actualTaxi()); const first = instantiateTaxiModel()!; const second = instantiateTaxiModel()!;
    const firstBody = first.root.getObjectByName('body') as THREE.Mesh; const secondBody = second.root.getObjectByName('body') as THREE.Mesh;
    expect(firstBody.geometry).toBe(secondBody.geometry); expect(firstBody.material).not.toBe(secondBody.material);
    const firstLivery = material(first.root, 'livery_left'); const secondLivery = material(second.root, 'livery_left');
    expect(firstLivery.map).toBe(secondLivery.map);
    const original = secondLivery.color.getHex(); firstLivery.color.setHex(0x101010); expect(secondLivery.color.getHex()).toBe(original);
  });

  it('swaps the loading placeholder, binds wheels/lights/cabin, and keeps taxi state independent', async () => {
    const scene = new THREE.Scene(); const first = new Vehicle(scene, 'taxi', new THREE.Vector3());
    expect(first.group.getObjectByName('taxi-loading-placeholder')).toBeDefined();
    installTaxiLibrary(await actualTaxi());
    expect(first.group.getObjectByName('taxi-loading-placeholder')).toBeUndefined(); expect(first.group.getObjectByName('Taxi_QuantumExpress')).toBeDefined();
    const second = new Vehicle(scene, 'taxi', new THREE.Vector3(8, 0, 0));
    const firstHeadlight = material(first.group, 'headlight_left'); const secondHeadlight = material(second.group, 'headlight_left');
    first.setHeadlightGlow(1); second.setHeadlightGlow(0); expect(firstHeadlight.emissiveIntensity).toBeGreaterThan(secondHeadlight.emissiveIntensity);
    const firstBrake = material(first.group, 'brakelight_left'); const secondBrake = material(second.group, 'brakelight_left'); const secondBrakeColor = secondBrake.color.getHex();
    first.playerControlled = true; first.speed = 10;
    first.updatePlayer(1 / 60, { down: (key: string) => key === 'KeyS' } as unknown as InputManager, flatCity);
    expect(firstBrake.color.getHex()).not.toBe(secondBrakeColor); expect(secondBrake.color.getHex()).toBe(secondBrakeColor);

    const beforeSecond = material(second.group, 'body').color.getHex(); first.wreck();
    expect(material(first.group, 'body').color.getHex()).not.toBe(beforeSecond); expect(material(second.group, 'body').color.getHex()).toBe(beforeSecond);
    first.restore(); expect(material(first.group, 'body').color.getHex()).toBe(beforeSecond);
    first.setFirstPerson(true); expect(first.group.getObjectByName('cabin')!.visible).toBe(false); expect(second.group.getObjectByName('cabin')!.visible).toBe(true);
  });

  it('steers the front pivots, spins all wheel pivots, and never disposes shared GLB geometry on despawn', async () => {
    installTaxiLibrary(await actualTaxi()); const taxi = new Vehicle(new THREE.Scene(), 'taxi', new THREE.Vector3()); taxi.playerControlled = true; taxi.speed = 20;
    const wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map((name) => taxi.group.getObjectByName(name)!);
    const before = wheels.map((wheel) => wheel.rotation.x); const input = { down: (key: string) => key === 'KeyW' || key === 'KeyD' } as unknown as InputManager;
    for (let index = 0; index < 20; index++) taxi.updatePlayer(1 / 60, input, flatCity);
    expect(wheels[0]!.rotation.y).not.toBe(0); expect(wheels[1]!.rotation.y).not.toBe(0);
    for (const [index, wheel] of wheels.entries()) expect(wheel.rotation.x).not.toBe(before[index]);
    const geometry = (taxi.group.getObjectByName('body') as THREE.Mesh).geometry; const dispose = vi.spyOn(geometry, 'dispose');
    taxi.dispose(); expect(dispose).not.toHaveBeenCalled();
  });

  it('rejects incomplete libraries without partially installing them', async () => {
    const gltf = await actualTaxi(); gltf.scene.getObjectByName('cabin')?.removeFromParent();
    expect(() => installTaxiLibrary(gltf)).toThrow('cabin'); expect(taxiLibraryReady()).toBe(false);
  });
});
