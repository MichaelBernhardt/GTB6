import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteAvatar, RemoteVehicle } from './OnlineSession';
import type { NetPlayer, NetVehicle } from './protocol';

const vehicleState = (overrides: Partial<NetVehicle> = {}): NetVehicle => ({ id: 'hot-bakkie', kind: 'bakkie', x: 10, y: 0, z: 20, heading: 0, speed: 0, health: 145, isHot: true, ...overrides });
const playerState = (overrides: Partial<NetPlayer> = {}): NetPlayer => ({
  id: 'remote', name: 'Remote', appearance: 'rosebank-athlete', runs: 0, x: 1, y: 0, z: 2, heading: 0, health: 100,
  kills: 0, deaths: 0, ammo: 12, reserve: 84, reloading: false, locomotion: 'idle', aiming: false, dead: false, protected: false, ...overrides,
});
const originalDocument = globalThis.document;
afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
  else Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
});

describe('online visual lifecycle', () => {
  it('uses the existing Hilux-style Vehicle presentation and disposes owned resources', () => {
    const scene = new THREE.Scene(); const remote = new RemoteVehicle(scene, vehicleState());
    expect(remote.group.getObjectByName('bakkie-bed')).toBeDefined(); expect(scene.getObjectByName('OnlineVehicle:hot-bakkie')).toBe(remote.group);
    const wheels = (remote.vehicle as unknown as { wheels: THREE.Object3D[] }).wheels; const wheelRotation = wheels[0]?.rotation.x ?? 0;
    remote.setState(vehicleState({ heading: 0.2, speed: 12 })); remote.update(0.1);
    expect(wheels[0]?.rotation.x).not.toBe(wheelRotation); expect(Math.abs(remote.vehicle.steeringVisual)).toBeGreaterThan(0);
    const mesh = remote.group.getObjectByName('bakkie-bed')?.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    const disposeGeometry = vi.spyOn(mesh!.geometry, 'dispose'); const material = Array.isArray(mesh!.material) ? mesh!.material[0]! : mesh!.material; const disposeMaterial = vi.spyOn(material, 'dispose');
    remote.dispose(scene); expect(remote.group.parent).toBeNull(); expect(disposeGeometry).toHaveBeenCalled(); expect(disposeMaterial).toHaveBeenCalled();
  });

  it('creates a rigged authored avatar instead of capsule geometry and cleans up its label', () => {
    const context = { fillStyle: '', font: '', textAlign: '', textBaseline: '', roundRect: vi.fn(), fill: vi.fn(), fillText: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context };
    Object.defineProperty(globalThis, 'document', { value: { createElement: () => canvas }, configurable: true });
    const scene = new THREE.Scene(); const avatar = new RemoteAvatar(scene, 'remote', 'Lerato', 'rosebank-athlete');
    avatar.setState(playerState({ locomotion: 'sprint' })); avatar.update(0.1);
    expect(avatar.group.children.some((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CapsuleGeometry)).toBe(false);
    expect(avatar.group.getObjectByName('RiggedPedestrianVisual:rosebank-athlete')).toBeDefined();
    const label = avatar.group.children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite)!; const disposeTexture = vi.spyOn(label.material.map!, 'dispose'); const disposeMaterial = vi.spyOn(label.material, 'dispose');
    avatar.dispose(scene); expect(avatar.group.parent).toBeNull(); expect(disposeTexture).toHaveBeenCalled(); expect(disposeMaterial).toHaveBeenCalled();
  });
});
