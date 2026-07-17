import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildTreeAsset, buildTreeInstance, installTreeLibrary, loadTreeLibrary, resetTreeLibraryForTests, TREE_LIBRARY_URL, TreeLibraryError } from './FoliageAssets';

async function actualLibrary() {
  const file = await readFile(resolve('public/models/foliage/joburg-trees.glb'));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new GLTFLoader().parseAsync(buffer, '/models/foliage/');
}

afterEach(() => resetTreeLibraryForTests());

describe('required Blender tree library', () => {
  it('has no construction fallback before the GLB is installed', () => {
    expect(() => buildTreeAsset('jacaranda', 7)).toThrowError(TreeLibraryError);
    expect(() => buildTreeAsset('jacaranda', 7)).toThrow('has not been loaded');
  });

  it('loads once, validates all variants, and produces deterministic Blender instances', async () => {
    const gltf = await actualLibrary(); const load = vi.fn(async (url: string) => {
      expect(url).toBe(TREE_LIBRARY_URL); return gltf;
    });
    await Promise.all([loadTreeLibrary(load), loadTreeLibrary(load)]);
    expect(load).toHaveBeenCalledTimes(1);
    const first = buildTreeAsset('shade-tree', 42); const second = buildTreeAsset('shade-tree', 42);
    expect(first.group.userData.assetSource).toBe('blender');
    expect(first.group.userData.treeVariant).toBe(second.group.userData.treeVariant);
    expect(first.group.scale.toArray()).toEqual(second.group.scale.toArray());
    expect(first.footprint).toEqual(second.footprint);

    const instanced = buildTreeInstance('shade-tree', 42);
    expect(instanced.variant).toBe(first.group.userData.treeVariant);
    expect(instanced.scale).toBe(first.group.scale.x);
    expect(instanced.parts.length).toBeGreaterThan(0);
    expect(instanced.parts.every((part) => part.geometry.getAttribute('position').count > 0)).toBe(true);
    expect(buildTreeInstance('shade-tree', 42).parts[0]!.geometry).toBe(instanced.parts[0]!.geometry);
  });

  it('rejects an incomplete library instead of partially installing it', async () => {
    const gltf = await actualLibrary();
    gltf.scene.getObjectByName('gum__1')?.removeFromParent();
    expect(() => installTreeLibrary(gltf)).toThrow('gum__1');
    expect(() => buildTreeAsset('gum', 1)).toThrow('has not been loaded');
  });
});
