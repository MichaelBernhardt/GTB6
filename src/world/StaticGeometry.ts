import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FAR_CHUNK, type ChunkStore } from './ChunkVisibility';

interface Bucket { material: THREE.Material; geometries: THREE.BufferGeometry[]; castShadow: boolean; receiveShadow: boolean; cell: string; }

export const materialKey = (material: THREE.Material): string => {
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

/**
 * Splits a non-indexed world-space geometry into one geometry per chunk cell, bucketing each
 * triangle by its centroid. World-spanning ribbons (roads, sidewalks, park lawns) would otherwise
 * collapse into a single mega-mesh that neither frustum nor distance culling could ever discard.
 * Geometry that fits inside one cell takes a fast path and is returned untouched.
 */
export function splitGeometryByCell(geometry: THREE.BufferGeometry, cellSize: number): Map<string, THREE.BufferGeometry> {
  const position = geometry.getAttribute('position');
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const minCellX = Math.floor(box.min.x / cellSize); const maxCellX = Math.floor(box.max.x / cellSize);
  const minCellZ = Math.floor(box.min.z / cellSize); const maxCellZ = Math.floor(box.max.z / cellSize);
  if (minCellX === maxCellX && minCellZ === maxCellZ) return new Map([[`${minCellX},${minCellZ}`, geometry]]);

  const cells = new Map<string, number[]>();
  for (let triangle = 0; triangle < position.count / 3; triangle++) {
    const vertex = triangle * 3;
    const cellX = Math.floor((position.getX(vertex) + position.getX(vertex + 1) + position.getX(vertex + 2)) / 3 / cellSize);
    const cellZ = Math.floor((position.getZ(vertex) + position.getZ(vertex + 1) + position.getZ(vertex + 2)) / 3 / cellSize);
    const key = `${cellX},${cellZ}`;
    const list = cells.get(key);
    if (list) list.push(triangle); else cells.set(key, [triangle]);
  }
  if (cells.size === 1) return new Map([[cells.keys().next().value!, geometry]]);

  const output = new Map<string, THREE.BufferGeometry>();
  for (const [key, triangles] of cells) {
    const part = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const itemSize = attribute.itemSize;
      const source = attribute.array as Float32Array;
      const stride = 3 * itemSize;
      const data = new Float32Array(triangles.length * stride);
      triangles.forEach((triangle, index) => data.set(source.subarray(triangle * stride, (triangle + 1) * stride), index * stride));
      part.setAttribute(name, new THREE.BufferAttribute(data, itemSize));
    }
    output.set(key, part);
  }
  return output;
}

/**
 * Incremental sibling of mergeStaticGeometry for the on-demand building tier. The heavy per-mesh
 * work (toNonIndexed + world-transform bake) is done a few buildings at a time via addObject() so it
 * spreads across frames within the generation budget; finalize() then does one cheap mergeGeometries
 * per material. Meshes with identical material properties merge together (keyed like the static path),
 * so a whole cell of buildings collapses to a handful of draw calls. No per-cell grid split is needed:
 * every object handed in already belongs to one chunk cell.
 */
interface BakeBucket { material: THREE.Material; geometries: THREE.BufferGeometry[]; cast: boolean; receive: boolean; }

export class GeometryBaker {
  private buckets = new Map<string, BakeBucket>();

  /** Bake every static mesh under `object` (its world transform is applied) into per-material buckets. */
  addObject(object: THREE.Object3D): void {
    object.updateWorldMatrix(true, true);
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || node instanceof THREE.InstancedMesh || node.userData.dynamic) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const source = (node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone()) as THREE.BufferGeometry;
      source.applyMatrix4(node.matrixWorld);
      const parts = materials.length > 1 && source.groups.length > 0
        ? source.groups.map((group) => ({ material: materials[group.materialIndex ?? 0] ?? materials[0]!, geometry: extractRange(source, group.start, group.count) }))
        : [{ material: materials[0]!, geometry: source }];
      for (const part of parts) {
        part.geometry.clearGroups();
        const key = `${materialKey(part.material)}#${Object.keys(part.geometry.attributes).sort().join(',')}`;
        const bucket: BakeBucket = this.buckets.get(key) ?? { material: part.material, geometries: [], cast: false, receive: false };
        bucket.cast ||= node.castShadow; bucket.receive ||= node.receiveShadow;
        bucket.geometries.push(part.geometry); this.buckets.set(key, bucket);
      }
    });
  }

  /** Merge every bucket into one mesh per material and add it under `target`; resets the baker. */
  finalize(target: THREE.Object3D): void {
    for (const bucket of this.buckets.values()) {
      const merged = bucket.geometries.length === 1 ? bucket.geometries[0]! : mergeGeometries(bucket.geometries, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.castShadow = bucket.cast; mesh.receiveShadow = bucket.receive; mesh.matrixAutoUpdate = false;
      target.add(mesh);
    }
    this.buckets.clear();
  }
}

const underFarFlag = (object: THREE.Object3D, root: THREE.Object3D): boolean => {
  for (let node: THREE.Object3D | null = object; node && node !== root; node = node.parent) if (node.userData.far) return true;
  return false;
};

/** Merges every static Mesh under root into one Mesh per distinct material, baking world transforms.
 *  Skips InstancedMesh and anything flagged userData.dynamic. Pass a `chunkSize` to split geometry
 *  per world-grid cell (triangle-level, so no merged mesh spans the map) — with a `store`, each
 *  merged mesh lands in its cell's chunk group for distance culling. Subtrees flagged userData.far
 *  merge into the store's never-culled far bucket (ground plane, skyline landmarks). */
export function mergeStaticGeometry(root: THREE.Object3D, chunkSize?: number, store?: ChunkStore): void {
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
    const far = underFarFlag(object, root);
    for (const part of parts) {
      part.geometry.clearGroups();
      const cells = !chunkSize || far
        ? new Map([[far ? FAR_CHUNK : '', part.geometry]])
        : splitGeometryByCell(part.geometry, chunkSize);
      for (const [cell, geometry] of cells) {
        const key = `${materialKey(part.material)}#${Object.keys(geometry.attributes).sort().join(',')}@${cell}`;
        const bucket: Bucket = buckets.get(key) ?? { material: part.material, geometries: [], castShadow: false, receiveShadow: false, cell };
        bucket.castShadow ||= object.castShadow; bucket.receiveShadow ||= object.receiveShadow;
        bucket.geometries.push(geometry); buckets.set(key, bucket);
      }
    }
    victims.push(object);
  });
  for (const mesh of victims) { mesh.parent?.remove(mesh); mesh.geometry.dispose(); }
  for (let pass = 0; pass < 4; pass++) {
    const empties: THREE.Object3D[] = [];
    root.traverse((object) => { if (object !== root && !(object instanceof THREE.Mesh) && !object.userData.chunk && object.children.length === 0) empties.push(object); });
    if (empties.length === 0) break;
    for (const empty of empties) empty.parent?.remove(empty);
  }
  for (const bucket of buckets.values()) {
    const merged = bucket.geometries.length === 1 ? bucket.geometries[0]! : mergeGeometries(bucket.geometries, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = bucket.castShadow; mesh.receiveShadow = bucket.receiveShadow; mesh.matrixAutoUpdate = false;
    if (store && bucket.cell) store.groupForKey(bucket.cell).add(mesh); else root.add(mesh);
  }
}
