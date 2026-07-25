import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VEHICLE_SPECS } from '../config';
import { instantiateBikeModel, type TwoWheelerKind } from './BikeAssets';
import { Vehicle } from './Vehicle';

const KINDS: TwoWheelerKind[] = ['bicycle', 'motorbike', 'courier', 'superbike'];

const collect = (root: THREE.Object3D): { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material>; meshes: number; tris: number } => {
  const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>();
  let meshes = 0; let tris = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    meshes++; geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    const attribute = object.geometry.attributes.position!;
    tris += (object.geometry.index ? object.geometry.index.count : attribute.count) / 3;
  });
  return { geometries, materials, meshes, tris };
};

describe('two-wheeler asset library', () => {
  it('shares geometry between instances and clones materials (the whole point of the cache)', () => {
    for (const kind of KINDS) {
      const a = collect(instantiateBikeModel(kind, 0x112233).root);
      const b = collect(instantiateBikeModel(kind, 0x445566).root);
      const sharedGeometry = [...a.geometries].filter((geometry) => b.geometries.has(geometry));
      expect(sharedGeometry.length, `${kind} geometry`).toBe(a.geometries.size);
      const sharedMaterial = [...a.materials].filter((material) => b.materials.has(material));
      // Only the city sign-atlas material may be shared, and only on the courier's branded box.
      expect(sharedMaterial.every((material) => material.userData.bikeShared === true), `${kind} materials`).toBe(true);
    }
  });

  it('paints each instance in its own colour without touching its neighbour', () => {
    const red = instantiateBikeModel('motorbike', 0xff0000);
    const blue = instantiateBikeModel('motorbike', 0x0000ff);
    const paintOf = (instance: { root: THREE.Object3D }): number => {
      let hex = -1;
      instance.root.traverse((object) => {
        if (object instanceof THREE.Mesh && (object.material as THREE.Material).userData.bikeTint === 'paint' && hex < 0) {
          hex = (object.material as THREE.MeshStandardMaterial).color.getHex();
        }
      });
      return hex;
    };
    expect(paintOf(red)).toBe(0xff0000);
    expect(paintOf(blue)).toBe(0x0000ff);
  });

  it('resolves every animated handle by name out of the clone', () => {
    for (const kind of KINDS) {
      const instance = instantiateBikeModel(kind, VEHICLE_SPECS[kind].color);
      expect(instance.wheels, `${kind} wheels`).toHaveLength(2);
      for (const wheel of instance.wheels) expect(wheel).toBeInstanceOf(THREE.Object3D);
      expect(instance.steerGroup, `${kind} steer`).toBeInstanceOf(THREE.Group);
      // The front wheel must ride inside the steering group or the bars turn and the wheel does not.
      expect(instance.steerGroup.getObjectByName('wheel_front')).toBe(instance.wheels[0]);
      expect(instance.rider.name).toBe('rider');
      expect(instance.rider.position.toArray()).toEqual([0, VEHICLE_SPECS[kind].saddle![0], VEHICLE_SPECS[kind].saddle![1]]);
      expect(instance.cranks.length, `${kind} cranks`).toBe(kind === 'bicycle' ? 1 : 0);
      // Only the Kasi Cruiser is lampless — Vehicle.headlightsOn and DayNight's beam pool agree.
      expect(instance.headLights.length, `${kind} lamps`).toBe(kind === 'bicycle' ? 0 : 1);
      expect(instance.brakeLights.length, `${kind} tails`).toBe(kind === 'bicycle' ? 0 : 1);
    }
  });

  it('keeps every bike inside its collision box and standing on the ground', () => {
    for (const kind of KINDS) {
      const instance = instantiateBikeModel(kind, 0x808080);
      instance.rider.removeFromParent(); // the NPC dummy's elbows may hang outside the collision box; the bike may not
      const box = new THREE.Box3().setFromObject(instance.root);
      const [width, height] = VEHICLE_SPECS[kind].size;
      expect(box.min.y, `${kind} sinks below the road`).toBeGreaterThan(-0.02);
      expect(box.max.x - box.min.x, `${kind} too wide for spec.size`).toBeLessThanOrEqual(width + 0.01);
      expect(box.max.y, `${kind} taller than spec.size`).toBeLessThanOrEqual(height + 0.12);
    }
  });

  it('stays within a sane per-instance triangle budget (up to ~29 bikes are live at the traffic cap)', () => {
    for (const kind of KINDS) {
      const { tris, meshes } = collect(instantiateBikeModel(kind, 0x808080).root);
      expect(tris, `${kind} tris`).toBeLessThan(14000);
      expect(meshes, `${kind} draws`).toBeLessThan(32);
    }
  });

  it('leaves the shipped Vehicle handles wired up', () => {
    const scene = new THREE.Scene();
    const bike = new Vehicle(scene, 'superbike', new THREE.Vector3());
    expect(bike.group.getObjectByName('steer')).toBeDefined();
    expect(bike.group.getObjectByName('wheel_rear')).toBeDefined();
    expect(Math.abs(bike.group.rotation.z)).toBeCloseTo(0.15); // spawn kickstand tilt survives
  });
});
