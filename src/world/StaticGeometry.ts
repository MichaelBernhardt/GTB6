import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

interface Bucket { material: THREE.Material; geometries: THREE.BufferGeometry[]; castShadow: boolean; receiveShadow: boolean; }

const materialKey = (material: THREE.Material): string => {
  const m = material as THREE.MeshPhysicalMaterial;
  return [material.type, m.color?.getHexString(), m.map?.uuid ?? '', m.roughness, m.metalness, m.emissive?.getHexString(), m.emissiveIntensity, material.transparent, material.opacity, material.side, m.clearcoat ?? '', m.clearcoatRoughness ?? '', material.depthWrite].join('|');
};

const extractRange = (geometry: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry => {
  const output = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const size = attribute.itemSize;
    output.setAttribute(name, new THREE.BufferAttribute((attribute.array as Float32Array).slice(start * size, (start + count) * size), size));
  }
  return output;
};

/** Merges every static Mesh under root into one Mesh per distinct material, baking world transforms. Skips InstancedMesh and anything flagged userData.dynamic. */
export function mergeStaticGeometry(root: THREE.Object3D): void {
  root.updateWorldMatrix(true, true);
  const buckets = new Map<string, Bucket>();
  const victims: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || object.userData.dynamic) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const source = (object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()) as THREE.BufferGeometry;
    source.applyMatrix4(object.matrixWorld);
    const parts = materials.length > 1 && source.groups.length > 0
      ? source.groups.map((group) => ({ material: materials[group.materialIndex ?? 0] ?? materials[0]!, geometry: extractRange(source, group.start, group.count) }))
      : [{ material: materials[0]!, geometry: source }];
    for (const part of parts) {
      part.geometry.clearGroups();
      const key = `${materialKey(part.material)}#${Object.keys(part.geometry.attributes).sort().join(',')}`;
      const bucket: Bucket = buckets.get(key) ?? { material: part.material, geometries: [], castShadow: false, receiveShadow: false };
      bucket.castShadow ||= object.castShadow; bucket.receiveShadow ||= object.receiveShadow;
      bucket.geometries.push(part.geometry); buckets.set(key, bucket);
    }
    victims.push(object);
  });
  for (const mesh of victims) { mesh.parent?.remove(mesh); mesh.geometry.dispose(); }
  for (let pass = 0; pass < 4; pass++) {
    const empties: THREE.Object3D[] = [];
    root.traverse((object) => { if (object !== root && !(object instanceof THREE.Mesh) && object.children.length === 0) empties.push(object); });
    if (empties.length === 0) break;
    for (const empty of empties) empty.parent?.remove(empty);
  }
  for (const bucket of buckets.values()) {
    const merged = bucket.geometries.length === 1 ? bucket.geometries[0]! : mergeGeometries(bucket.geometries, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = bucket.castShadow; mesh.receiveShadow = bucket.receiveShadow; mesh.matrixAutoUpdate = false;
    root.add(mesh);
  }
}
